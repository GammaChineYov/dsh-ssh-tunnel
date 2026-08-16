// dsh-ssh-tunnel — SSH 隧道管理 + 远程命令执行（host half）。
//
// 解决的问题（来自「dsh分支插件开发」会话实测痛点）：
//  - 裸 `ssh -N -L` 隧道断线（client_loop: send disconnect: Connection reset）后无人拉起，
//    导致后续 scp/ssh 命令超时、GUI 测试全部 ERR_CONNECTION_REFUSED；
//  - 手工在 pwsh 里拼 ssh/scp 命令：PowerShell 嵌套引号地狱（ParserError）、
//    scp 挂起无输出、后台 job 与 run_code 会话绑定（job belongs to another session）。
// 方案（参考自研 dsh-unity-pool 的池/探活/工具/HTTP/UI 模式）：
//  - 每个隧道一个 supervisor：ssh 子进程退出即自动重连（退避），keepalive 参数保活；
//  - 宿主重启后按本地端口探活「收养」孤儿 ssh 进程，不重复起隧道（避免 Address already in use）；
//  - ssh_run / ssh_push 用 Node spawn 参数数组直接调 ssh/scp（不经 PowerShell），
//    带超时与清晰的 stderr 回传，终结引号地狱与静默挂起；
//  - 6 个 Agent 工具 + 回环 HTTP API + 会话头部 SSH 状态胶囊（client half）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as cp from 'node:child_process'
import * as net from 'node:net'

export const name = 'ssh-tunnel'
export const inject = ['tools', 'webServer', 'systemPrompt']

export const Config = z.object({
  /** 隧道条目：每条 = 一个 SSH 本地端口转发（ssh -N -L）。 */
  tunnels: z.array(z.object({
    id: z.string(),
    name: z.string(),
    host: z.string(),
    user: z.string().default('root'),
    identityFile: z.string(),
    /** 本地监听端口（浏览器/Agent 访问 http://127.0.0.1:<localPort>）。 */
    localPort: z.number(),
    remoteHost: z.string().default('127.0.0.1'),
    remotePort: z.number(),
    /** 断线后自动重连（默认开）。 */
    autoRestart: z.boolean().default(true),
    /** keepalive 保活（ServerAliveInterval=25, CountMax=4）。 */
    keepAlive: z.boolean().default(true),
  })).default([]),
  /** 端口探活间隔（毫秒）。 */
  probeIntervalMs: z.number().default(10000),
  /** 单次端口探活超时（毫秒）。 */
  probeTimeoutMs: z.number().default(2000),
  /** ssh 连接超时（秒，ConnectTimeout）。 */
  connectTimeoutSec: z.number().default(15),
  /** ssh_run 默认超时（毫秒）。 */
  commandTimeoutMs: z.number().default(60000),
  /** 隧道 pid/统计持久化文件（宿主重启后用于收养）。 */
  stateFile: z.string().default(path.join(homedir(), '.dsh', 'ssh-tunnel-state.json')),
  connectHint: z.string().default(''),
})

const DEFAULT_CONNECT_HINT = '隧道 down 时调 ssh_tunnel_start 拉起（插件自动重连）；远程命令用 ssh_run，上传文件用 ssh_push。'

const RETRY_BASE_MS = 3000
const RETRY_MAX_MS = 60000

function formatError(err) {
  return String((err && err.message) || err || 'unknown')
}

/** 过滤 OpenSSH 良性警告（服务器旧版 key exchange 的 post-quantum 提示等），避免噪音污染错误信息。 */
function cleanSshStderr(text) {
  if (!text) return text
  return text.split(/\r?\n/)
    .filter(line => !/post-quantum|store now, decrypt later|server may need to be upgraded/i.test(line))
    .join('\n')
}

/** 端口探活：TCP 连 127.0.0.1:<port>，成功返回耗时 ms，失败抛错。 */
function probePort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = net.connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, Math.max(300, timeoutMs))
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(Date.now() - started)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** 查监听 <port> 的 PID（netstat -ano），用于收养/停止孤儿隧道。 */
function pidOfLocalPort(port) {
  return new Promise((resolve) => {
    const want = ':' + String(port)
    let out = ''
    let child
    try {
      child = cp.spawn('netstat', ['-ano'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 5000)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', () => {
      clearTimeout(timer)
      const re = new RegExp('^TCP\\s+\\S+' + want + '\\s+\\S+\\s+LISTENING\\s+(\\d+)$')
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(re)
        if (m) { resolve(Number(m[1])); return }
      }
      resolve(null)
    })
  })
}

export class TunnelManager {
  /**
   * @param ctx  {logger?}
   * @param cfg  归一化配置
   * @param opts {spawnFn?, probeFn?, pidOfPortFn?, sleepMs?} 测试注入点
   */
  constructor(ctx, cfg, opts = {}) {
    this.ctx = ctx || {}
    this.cfg = {
      probeIntervalMs: Number(cfg.probeIntervalMs) || 10000,
      probeTimeoutMs: Number(cfg.probeTimeoutMs) || 2000,
      connectTimeoutSec: Number(cfg.connectTimeoutSec) || 15,
      commandTimeoutMs: Number(cfg.commandTimeoutMs) || 60000,
      stateFile: cfg.stateFile || path.join(homedir(), '.dsh', 'ssh-tunnel-state.json'),
      connectHint: typeof cfg.connectHint === 'string' ? cfg.connectHint : '',
    }
    this.opts = opts || {}
    this.spawnFn = this.opts.spawnFn || defaultSpawn
    this.probeFn = this.opts.probeFn || probePort
    this.pidOfPortFn = this.opts.pidOfPortFn || pidOfLocalPort
    this.sleepMs = typeof this.opts.sleepMs === 'number' ? this.opts.sleepMs : 1
    this.tunnels = (Array.isArray(cfg.tunnels) ? cfg.tunnels : []).map(t => ({
      id: String(t.id),
      name: String(t.name || t.id),
      host: String(t.host),
      user: String(t.user || 'root'),
      identityFile: String(t.identityFile || ''),
      localPort: Number(t.localPort),
      remoteHost: String(t.remoteHost || '127.0.0.1'),
      remotePort: Number(t.remotePort),
      autoRestart: t.autoRestart !== false,
      keepAlive: t.keepAlive !== false,
      // 运行态
      status: 'down',        // up | down | starting
      pid: null,             // 本进程 spawn 的 ssh pid
      adopted: false,        // true = 收养了孤儿 ssh（宿主重启后端口已被占用）
      startedAt: 0,
      uptimeMs: 0,
      restartCount: 0,
      lastError: null,
      lastExit: null,
      probeMs: null,
      child: null,
      stopping: false,
      retryTimer: null,
      consecutiveFailures: 0,
    }))
    this.byId = new Map(this.tunnels.map(t => [t.id, t]))
    this.probeTimer = null
    this._loadState()
  }

  // ---- 持久化 ----

  _loadState() {
    try {
      const raw = fs.readFileSync(this.cfg.stateFile, 'utf8')
      const data = JSON.parse(raw)
      const map = (data && data.tunnels) || {}
      for (const t of this.tunnels) {
        const s = map[t.id]
        if (s && typeof s === 'object') {
          t.restartCount = Number(s.restartCount) || 0
          if (Number(s.pid)) t.pid = Number(s.pid)
          if (Number(s.startedAt)) t.startedAt = Number(s.startedAt)
        }
      }
    } catch { /* 首次运行或文件损坏 */ }
  }

  _saveState() {
    try {
      const file = this.cfg.stateFile
      const payload = JSON.stringify({
        tunnels: Object.fromEntries(this.tunnels.map(t => [t.id, {
          pid: t.pid || null,
          startedAt: t.startedAt || 0,
          restartCount: t.restartCount || 0,
        }])),
      }, null, 2)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp-' + process.pid
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      this.ctx?.logger?.warn?.('[ssh-tunnel] 持久化失败: ' + formatError(err))
    }
  }

  // ---- 探活 ----

  async probeTunnel(t) {
    const started = Date.now()
    try {
      const ms = await this.probeFn(t.localPort, this.cfg.probeTimeoutMs)
      t.probeMs = ms
      if (t.status !== 'up') {
        // 端口已通但状态未知：收养（可能是宿主重启后的孤儿 ssh）
        t.status = 'up'
        t.adopted = true
        t.startedAt = t.startedAt || Date.now()
        t.lastError = null
        t.consecutiveFailures = 0
        this._saveState()
      }
      return true
    } catch {
      t.probeMs = null
      return false
    }
  }

  async probe() {
    await Promise.all(this.tunnels.map(t => this.probeTunnel(t)))
  }

  // ---- 隧道生命周期 ----

  sshArgs(t, extra) {
    const args = ['-i', t.identityFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + this.cfg.connectTimeoutSec]
    if (t.keepAlive) {
      args.push('-o', 'ServerAliveInterval=25', '-o', 'ServerAliveCountMax=4')
    }
    if (extra) args.push(...extra)
    return args
  }

  tunnelTarget(t) {
    return t.user + '@' + t.host
  }

  /** 拉起（或重启）一条隧道；等待端口探活成功后返回。 */
  async ensure(t, opts = {}) {
    if (t.status === 'starting') return { id: t.id, status: 'starting' }
    // 已 up 且未被要求重启 → 直接返回
    if (t.status === 'up' && !opts.restart) return { id: t.id, status: 'up', adopted: t.adopted }

    await this.stop(t, { keepState: true })
    t.status = 'starting'
    t.stopping = false
    t.lastError = null
    if (t.retryTimer) { clearTimeout(t.retryTimer); t.retryTimer = null }

    const args = this.sshArgs(t, ['-o', 'ExitOnForwardFailure=yes', '-N', '-L', t.localPort + ':' + t.remoteHost + ':' + t.remotePort])
    args.push(this.tunnelTarget(t))
    let child
    try {
      child = this.spawnFn('ssh', args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (err) {
      t.status = 'down'
      t.lastError = 'spawn ssh 失败: ' + formatError(err)
      this._scheduleRestart(t)
      return { id: t.id, status: 'down', error: t.lastError }
    }
    t.child = child
    t.pid = child.pid || null
    t.startedAt = Date.now()
    t.adopted = false
    t.restartCount += 1

    let stderrBuf = ''
    const capStderr = (d) => {
      stderrBuf += d.toString('utf8')
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096)
    }
    if (child.stderr) child.stderr.on('data', capStderr)

    child.on('exit', (code, signal) => {
      if (t.child !== child) return
      t.child = null
      t.status = 'down'
      t.lastExit = { code, signal: signal || null, at: Date.now() }
      const cleaned = cleanSshStderr(stderrBuf)
      if (cleaned.trim()) t.lastError = cleaned.trim().split(/\r?\n/).slice(-3).join(' | ')
      t.consecutiveFailures += 1
      this._saveState()
      this.ctx?.logger?.info?.('[ssh-tunnel] ' + t.id + ' ssh 退出 code=' + code + ' signal=' + signal + (t.autoRestart ? '，计划重连' : ''))
      if (t.autoRestart && !t.stopping) this._scheduleRestart(t)
    })

    // 等待端口探活（上限 connectTimeoutSec * 2 + 2s）
    const deadline = Date.now() + Math.max(6000, this.cfg.connectTimeoutSec * 2000 + 2000)
    for (;;) {
      await this._sleep(Math.max(10, this.sleepMs * 250))
      if (t.child !== child || t.status !== 'starting') break
      if (await this.probeTunnel(t)) {
        t.status = 'up'
        t.adopted = false
        t.consecutiveFailures = 0
        t.lastError = null
        t.uptimeMs = Date.now() - t.startedAt
        this._saveState()
        this.ctx?.logger?.info?.('[ssh-tunnel] ' + t.id + ' 隧道已就绪（localhost:' + t.localPort + '）')
        return { id: t.id, status: 'up', pid: t.pid, restartCount: t.restartCount }
      }
      if (Date.now() > deadline) break
    }
    if (t.status === 'starting' && t.child === child) {
      // 起不来：杀掉并报错（等 exit 回调安排重连）
      t.status = 'down'
      t.lastError = t.lastError || ('隧道在 ' + this.cfg.connectTimeoutSec + 's 内未就绪（本地端口 ' + t.localPort + ' 未监听）')
      try { child.kill() } catch { /* ignore */ }
      if (!t.child) { /* exit 回调已处理 */ }
    }
    return { id: t.id, status: t.status || 'down', error: t.lastError || undefined }
  }

  _scheduleRestart(t) {
    if (t.retryTimer || t.stopping || !t.autoRestart) return
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.min(4, t.consecutiveFailures - 1)))
    t.retryTimer = setTimeout(() => {
      t.retryTimer = null
      if (t.stopping) return
      if (t.status === 'up') return
      // 端口可能被孤儿进程占着（重连窗口内）：先探一次，通就直接收养
      this.probeTunnel(t).then(ok => {
        if (!ok) this.ensure(t).catch(() => { /* 下次重试 */ })
      })
    }, Math.max(10, delay * this.sleepMs))
    if (t.retryTimer.unref) t.retryTimer.unref()
  }

  async stop(t, opts = {}) {
    if (t.retryTimer) { clearTimeout(t.retryTimer); t.retryTimer = null }
    t.stopping = true
    const child = t.child
    if (child) {
      try { child.kill() } catch { /* ignore */ }
      t.child = null
      t.status = 'down'
    } else if (t.pid && !t.adopted) {
      try { process.kill(t.pid, 0); process.kill(t.pid) } catch { /* 已死 */ }
      t.status = 'down'
    } else if (t.status === 'up' || t.adopted) {
      // 收养的孤儿：按本地端口找 PID 杀掉
      const pid = await this.pidOfPortFn(t.localPort)
      if (pid) {
        try {
          await new Promise((resolve) => {
            const killer = this.spawnFn('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' })
            if (killer.on) killer.on('close', () => resolve())
            else resolve()
            setTimeout(resolve, Math.max(10, 3000 * this.sleepMs)).unref?.()
          })
        } catch { /* ignore */ }
      }
      t.status = 'down'
    } else {
      t.status = 'down'
    }
    t.adopted = false
    if (!opts.keepState) {
      t.pid = null
      t.startedAt = 0
      this._saveState()
    }
    return { id: t.id, status: 'down' }
  }

  async restart(t) {
    await this.stop(t)
    t.stopping = false
    return this.ensure(t, { restart: true })
  }

  // ---- 进程 ----

  start() {
    if (this.probeTimer) return
    // 启动即收养：端口已通的隧道标 up（不重复 spawn）
    this.probe().then(() => {
      for (const t of this.tunnels) {
        if (t.status !== 'up' && t.autoRestart && !t.stopping) {
          this.ensure(t).catch(() => { /* 等重连 */ })
        }
      }
    })
    this.probeTimer = setInterval(() => { this.probe() }, Math.max(1000, this.cfg.probeIntervalMs))
    if (this.probeTimer.unref) this.probeTimer.unref()
  }

  stopAll() {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null }
    for (const t of this.tunnels) {
      t.stopping = true
      if (t.retryTimer) { clearTimeout(t.retryTimer); t.retryTimer = null }
      if (t.child) { try { t.child.kill() } catch { /* ignore */ } t.child = null }
    }
  }

  _sleep(ms) {
    return new Promise(resolve => {
      const h = setTimeout(resolve, ms)
      if (h.unref) h.unref()
    })
  }

  // ---- 查询 / 视图 ----

  tunnelById(id) {
    return this.byId.get(String(id || '')) || null
  }

  pickTunnel(id) {
    if (id !== undefined && id !== null && String(id) !== '') {
      const t = this.tunnelById(id)
      if (!t) throw new Error('隧道 [' + id + '] 不存在（可用: ' + this.tunnels.map(x => x.id).join(', ') + ' 或 none）')
      return t
    }
    if (this.tunnels.length === 0) throw new Error('未配置任何隧道（profile cordis.patch.yml 的 ssh-tunnel.config.tunnels）')
    return this.tunnels[0]
  }

  uptimeOf(t) {
    if (t.status !== 'up' || !t.startedAt) return 0
    return Math.max(0, Date.now() - t.startedAt)
  }

  view() {
    return {
      tunnels: this.tunnels.map(t => ({
        id: t.id,
        name: t.name,
        host: t.host,
        user: t.user,
        localPort: t.localPort,
        remoteHost: t.remoteHost,
        remotePort: t.remotePort,
        status: t.status,
        adopted: t.adopted,
        uptimeMs: this.uptimeOf(t),
        restartCount: t.restartCount,
        lastError: t.lastError,
        lastExit: t.lastExit,
        probeMs: t.probeMs,
      })),
      rules: {
        autoRestart: true,
        probeIntervalMs: this.cfg.probeIntervalMs,
        connectTimeoutSec: this.cfg.connectTimeoutSec,
        commandTimeoutMs: this.cfg.commandTimeoutMs,
      },
      connectHint: this.cfg.connectHint || DEFAULT_CONNECT_HINT,
    }
  }

  // ---- 远程命令 / 文件 ----

  /**
   * 远程执行命令：ssh -i key -o BatchMode ... user@host <command>。
   * 用 spawn 参数数组直传（不经 PowerShell），command 作为单参数交给远端 shell。
   */
  runCommand(t, command, timeoutMs) {
    return new Promise((resolve) => {
      const args = this.sshArgs(t, ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'])
      args.push(this.tunnelTarget(t), String(command))
      const started = Date.now()
      let child
      try {
        child = this.spawnFn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ tunnelId: t.id, host: t.host, exitCode: -1, stdout: '', stderr: formatError(err), durationMs: 0, timedOut: false, spawnError: true })
        return
      }
      let stdout = ''
      let stderr = ''
      const cap = (buf, limit) => {
        if (buf.length > limit) buf = buf.slice(-limit)
        return buf
      }
      if (child.stdout) child.stdout.on('data', d => { stdout = cap(stdout + d.toString('utf8'), 256 * 1024) })
      if (child.stderr) child.stderr.on('data', d => { stderr = cap(stderr + d.toString('utf8'), 64 * 1024) })
      const limit = Math.max(5000, Number(timeoutMs) || this.cfg.commandTimeoutMs)
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        resolve({
          tunnelId: t.id, host: t.host, exitCode: -1, stdout, stderr: cleanSshStderr(stderr) + '\n[已超时 ' + limit + 'ms，进程被终止]',
          durationMs: Date.now() - started, timedOut: true,
        })
      }, limit)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ tunnelId: t.id, host: t.host, exitCode: -1, stdout, stderr: 'spawn ssh 失败: ' + formatError(err), durationMs: Date.now() - started, timedOut: false, spawnError: true })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ tunnelId: t.id, host: t.host, exitCode: code, stdout, stderr: cleanSshStderr(stderr), durationMs: Date.now() - started, timedOut: false })
      })
    })
  }

  /**
   * 上传文件/目录：scp -i key -o BatchMode ... local user@host:remote。
   */
  pushFile(t, localPath, remotePath, recursive) {
    return new Promise((resolve) => {
      const args = this.sshArgs(t, ['-o', 'ServerAliveInterval=15'])
      if (recursive) args.push('-r')
      args.push(String(localPath), this.tunnelTarget(t) + ':' + String(remotePath))
      const started = Date.now()
      let child
      try {
        child = this.spawnFn('scp', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ tunnelId: t.id, host: t.host, exitCode: -1, output: '', stderr: formatError(err), durationMs: 0, timedOut: false, spawnError: true })
        return
      }
      let out = ''
      let stderr = ''
      if (child.stdout) child.stdout.on('data', d => { out = (out + d.toString('utf8')).slice(-256 * 1024) })
      if (child.stderr) child.stderr.on('data', d => { stderr = (stderr + d.toString('utf8')).slice(-64 * 1024) })
      const limit = Math.max(10000, this.cfg.commandTimeoutMs * 3)
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        resolve({ tunnelId: t.id, host: t.host, exitCode: -1, output: out, stderr: cleanSshStderr(stderr) + '\n[已超时 ' + limit + 'ms，进程被终止]', durationMs: Date.now() - started, timedOut: true })
      }, limit)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ tunnelId: t.id, host: t.host, exitCode: -1, output: out, stderr: 'spawn scp 失败: ' + formatError(err), durationMs: Date.now() - started, timedOut: false, spawnError: true })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ tunnelId: t.id, host: t.host, exitCode: code, output: out, stderr: cleanSshStderr(stderr), durationMs: Date.now() - started, timedOut: false })
      })
    })
  }
}

function defaultSpawn(command, args, opts) {
  return cp.spawn(command, args, opts)
}

export function createManager(ctx, cfg, opts) {
  return new TunnelManager(ctx, cfg, opts)
}

export function apply(ctx, config) {
  const cfg = (config && typeof config === 'object') ? config : {}
  const manager = new TunnelManager(ctx, {
    tunnels: Array.isArray(cfg.tunnels) ? cfg.tunnels : [],
    probeIntervalMs: cfg.probeIntervalMs,
    probeTimeoutMs: cfg.probeTimeoutMs,
    connectTimeoutSec: cfg.connectTimeoutSec,
    commandTimeoutMs: cfg.commandTimeoutMs,
    stateFile: cfg.stateFile,
    connectHint: cfg.connectHint,
  })
  ctx.effect(() => {
    manager.start()
    return () => manager.stopAll()
  }, 'ssh-tunnel: supervisor')

  // ---- 系统提示 ----
  try {
    ctx.systemPrompt.section({
      name: 'ssh-tunnel',
      order: 121,
      text: [
        '<ssh_tunnel_guide>',
        '本机装有 SSH 隧道管理插件（dsh-ssh-tunnel）：自动维护到远程主机的 SSH 本地端口转发隧道（断线自动重连、宿主重启自动收养孤儿进程）。',
        '工作流：',
        '1. 需要访问远程服务或执行远程命令时，先调 ssh_tunnel_status 查看隧道状态（up/down/延迟/重启次数/最后错误）。',
        '2. 隧道 down 时调 ssh_tunnel_start(tunnelId=...) 拉起（或 ssh_tunnel_restart）；插件会自动重连，无需手工跑 ssh。',
        '3. 远程执行命令统一用 ssh_run(tunnelId=..., command="...")——插件用同一密钥 BatchMode 连接，返回 stdout/stderr/exitCode；',
        '   不要再手工拼 ssh 命令（PowerShell 引号地狱 + 静默超时）。',
        '4. 上传文件/目录用 ssh_push(localPath=..., remotePath=..., recursive=?)——内部走 scp，带超时与错误回传。',
        '</ssh_tunnel_guide>',
      ].join('\n'),
    })
  } catch (err) {
    ctx.logger?.warn?.('[ssh-tunnel] 系统提示注册失败: ' + formatError(err))
  }

  // ---- Agent 工具 ----
  try {
    ctx.tools.register(defineTool({
      name: 'ssh_tunnel_status',
      description: '查看 SSH 隧道管理状态：每条隧道（id/名称/主机/本地端口→远程端口）的 up/down/starting 状态、是否收养（adopted）、运行时长、重启次数、端口探活延迟、最后错误/退出码，以及探活间隔等规则与连接提示。需要访问远程主机前先调用本工具。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      execute() {
        return Promise.resolve(manager.view())
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_tunnel_start',
      description: '拉起指定 SSH 隧道（tunnelId 缺省为第一条）：隧道 down 时启动 ssh -N -L 本地端口转发并等待端口就绪；up 时直接返回。返回该隧道最新状态。',
      parameters: {
        tunnelId: { type: 'string', description: '隧道 id（来自 ssh_tunnel_status）；缺省取第一条。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args) {
        const a = args || {}
        const t = manager.pickTunnel(a.tunnelId)
        const result = await manager.ensure(t)
        return { ...result, view: manager.view() }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_tunnel_stop',
      description: '停止指定 SSH 隧道（tunnelId 必填）：杀掉本插件管理的 ssh 进程（收养的孤儿进程按本地端口定位后 taskkill）。返回该隧道最新状态。',
      parameters: {
        tunnelId: { type: 'string', required: true, description: '隧道 id（来自 ssh_tunnel_status）。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args) {
        const a = args || {}
        if (!a.tunnelId) throw new Error('tunnelId 必填')
        const t = manager.pickTunnel(a.tunnelId)
        await manager.stop(t)
        return { ...manager.view() }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_tunnel_restart',
      description: '重启指定 SSH 隧道（tunnelId 缺省为第一条）：先停再拉起并等待端口就绪。返回该隧道最新状态。',
      parameters: {
        tunnelId: { type: 'string', description: '隧道 id（来自 ssh_tunnel_status）；缺省取第一条。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args) {
        const a = args || {}
        const t = manager.pickTunnel(a.tunnelId)
        const result = await manager.restart(t)
        return { ...result, view: manager.view() }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_run',
      description: '在远程主机上执行一条命令（经指定隧道的连接参数，tunnelId 缺省取第一条）：内部用 spawn 参数数组直接调 ssh（不经 PowerShell，无引号地狱），BatchMode 免交互，带超时。返回 {exitCode, stdout, stderr, durationMs}。命令交给远端 shell 解释（bash）；含引号的复杂命令按 bash 语法写。',
      parameters: {
        tunnelId: { type: 'string', description: '隧道 id（来自 ssh_tunnel_status）；缺省取第一条。' },
        command: { type: 'string', required: true, description: '远程命令（远端 bash 解释）。' },
        timeoutMs: { type: 'number', description: '可选：超时毫秒（默认取插件配置 commandTimeoutMs）。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: typeof v.stdout === 'string' && v.stdout ? v.stdout + (v.stderr ? '\n[stderr] ' + v.stderr : '') : JSON.stringify(v, null, 2) }] },
      async execute(args) {
        const a = args || {}
        if (!a.command) throw new Error('command 必填')
        const t = manager.pickTunnel(a.tunnelId)
        return await manager.runCommand(t, String(a.command), a.timeoutMs)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_push',
      description: '上传本地文件/目录到远程主机（经指定隧道的连接参数，tunnelId 缺省取第一条）：内部用 spawn 参数数组直接调 scp，BatchMode 免交互，带超时。返回 {exitCode, output, stderr, durationMs}。',
      parameters: {
        tunnelId: { type: 'string', description: '隧道 id（来自 ssh_tunnel_status）；缺省取第一条。' },
        localPath: { type: 'string', required: true, description: '本地文件/目录绝对路径。' },
        remotePath: { type: 'string', required: true, description: '远程目标路径（如 /root/xxx）。' },
        recursive: { type: 'boolean', description: '目录递归上传（scp -r），默认 false。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.stderr || v.output || JSON.stringify(v, null, 2) }] },
      async execute(args) {
        const a = args || {}
        if (!a.localPath || !a.remotePath) throw new Error('localPath 与 remotePath 必填')
        const t = manager.pickTunnel(a.tunnelId)
        return await manager.pushFile(t, String(a.localPath), String(a.remotePath), Boolean(a.recursive))
      },
    }))
  } catch (err) {
    ctx.logger?.error?.('[ssh-tunnel] 工具注册失败: ' + formatError(err))
    throw err
  }

  // ---- 回环 HTTP API ----
  try {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => sctx.webServer.register({
        kind: 'prefix',
        path: '/ssh-tunnel/api',
        handler: (req, res) => {
          const host = String(req.headers.host ?? '')
          const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)
          if (!loopback) {
            respond(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } })
            return
          }
          const url = new URL(req.url || '/', 'http://' + host)
          const p = url.pathname
          if (req.method === 'GET' && (p === '/ssh-tunnel/api/status' || p === '/ssh-tunnel/api/status/')) {
            respond(res, 200, { ok: true, value: manager.view() })
            return
          }
          if (req.method === 'POST' && (p === '/ssh-tunnel/api/start' || p === '/ssh-tunnel/api/start/')) {
            readJson(req).then(async body => {
              try {
                const t = manager.pickTunnel(body && body.tunnelId)
                const result = await manager.ensure(t)
                respond(res, 200, { ok: true, value: { ...result, view: manager.view() } })
              } catch (err) {
                respond(res, 409, { ok: false, error: { code: 'conflict', message: formatError(err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/ssh-tunnel/api/stop' || p === '/ssh-tunnel/api/stop/')) {
            readJson(req).then(async body => {
              try {
                const t = manager.pickTunnel(body && body.tunnelId)
                await manager.stop(t)
                respond(res, 200, { ok: true, value: manager.view() })
              } catch (err) {
                respond(res, 409, { ok: false, error: { code: 'conflict', message: formatError(err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/ssh-tunnel/api/restart' || p === '/ssh-tunnel/api/restart/')) {
            readJson(req).then(async body => {
              try {
                const t = manager.pickTunnel(body && body.tunnelId)
                const result = await manager.restart(t)
                respond(res, 200, { ok: true, value: { ...result, view: manager.view() } })
              } catch (err) {
                respond(res, 409, { ok: false, error: { code: 'conflict', message: formatError(err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          respond(res, 404, { ok: false, error: { code: 'not-found', message: 'no route: ' + p } })
        },
      }), 'ssh-tunnel: http api')
    })
  } catch (err) {
    ctx.logger?.warn?.('[ssh-tunnel] HTTP API 注册失败: ' + formatError(err))
  }
}

function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}
