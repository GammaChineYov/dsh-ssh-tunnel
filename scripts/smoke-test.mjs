// dsh-ssh-tunnel 冒烟测试（参考 dsh-unity-pool 的 smoke-test-v2.mjs 风格）。
// 全部用注入的 fake spawn / fake probe / fake pidOfPort，不碰真实网络与真实 ssh。
// 运行：node scripts/smoke-test.mjs（需仓库内 node_modules Junction → profiles/node_modules）
import { EventEmitter } from 'node:events'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { TunnelManager, apply } from '../lib/index.js'

let passed = 0
let failed = 0
const failures = []

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  PASS ' + name) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + detail : '')) }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** fake ssh 子进程：可手动 emitExit / 写 stdout/stderr / emitClose。 */
function fakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  child.emitExit = (code, signal) => child.emit('exit', code, signal || null)
  child.emitClose = (code) => child.emit('close', code)
  child.writeOut = (s) => child.stdout.emit('data', Buffer.from(s, 'utf8'))
  child.writeErr = (s) => child.stderr.emit('data', Buffer.from(s, 'utf8'))
  return child
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-tunnel-test-'))

function makeCfg(over = {}) {
  return {
    tunnels: [
      { id: 'ecs-3080', name: 'ECS 3080', host: '47.112.205.98', user: 'root', identityFile: 'C:/Users/PC/.ssh/dsh-server', localPort: 13080, remotePort: 3080 },
      { id: 'ecs-3081', name: 'ECS 3081', host: '47.112.205.98', user: 'root', identityFile: 'C:/Users/PC/.ssh/dsh-server', localPort: 13081, remotePort: 3081, autoRestart: false },
    ],
    probeIntervalMs: 1000,
    probeTimeoutMs: 500,
    connectTimeoutSec: 2,
    commandTimeoutMs: 5000,
    stateFile: path.join(tmpDir, 'state.json'),
    connectHint: '测试提示',
    ...over,
  }
}

async function main() {
  // 插件内部定时器全部 unref（宿主环境正确），独立测试进程需自己保活事件循环
  const keepAlive = setInterval(() => {}, 1000)

  console.log('== T1 配置解析与默认值 ==')
  {
    const m = new TunnelManager({}, makeCfg(), { sleepMs: 0.01 })
    const t = m.tunnels[0]
    check('T1.1 两条隧道', m.tunnels.length === 2, String(m.tunnels.length))
    check('T1.2 默认 remoteHost/user/autoRestart/keepAlive', t.remoteHost === '127.0.0.1' && t.user === 'root' && t.autoRestart === true && t.keepAlive === true)
    check('T1.3 关闭 autoRestart 生效', m.tunnels[1].autoRestart === false)
    check('T1.4 初始 status down', t.status === 'down' && t.restartCount === 0)
    const v = m.view()
    check('T1.5 view 形状', Array.isArray(v.tunnels) && v.tunnels.length === 2 && v.connectHint === '测试提示')
    m.stopAll()
  }

  console.log('== T2 收养：端口已 up 不重复 spawn ==')
  {
    let spawned = 0
    const m = new TunnelManager({}, makeCfg(), {
      sleepMs: 0.01,
      probeFn: async () => 3,
      spawnFn: () => { spawned += 1; return fakeChild(999) },
    })
    await m.probe()
    check('T2.1 探活即收养', m.tunnels[0].status === 'up' && m.tunnels[0].adopted === true)
    await m.ensure(m.tunnels[0])
    check('T2.2 up 时 ensure 不 spawn', spawned === 0, 'spawned=' + spawned)
    m.stopAll()
  }

  console.log('== T3 拉起：down → spawn ssh → 端口 up ==')
  {
    const spawned = []
    let probeUp = false
    const m = new TunnelManager({}, makeCfg(), {
      sleepMs: 0.01,
      probeFn: async () => { if (!probeUp) throw new Error('down'); return 5 },
      spawnFn: (cmd, args) => {
        spawned.push({ cmd, args })
        const child = fakeChild(7001)
        setTimeout(() => { probeUp = true }, 20)
        return child
      },
    })
    const r = await m.ensure(m.tunnels[0])
    check('T3.1 ensure 返回 up', r.status === 'up', JSON.stringify(r))
    check('T3.2 spawn 了一次 ssh', spawned.length === 1 && spawned[0].cmd === 'ssh', JSON.stringify(spawned.map(s => s.cmd)))
    const args = spawned[0].args.join(' ')
    check('T3.3 参数含 -i/密钥', args.includes('-i') && args.includes('dsh-server'))
    check('T3.4 参数含 keepalive', args.includes('ServerAliveInterval=25') && args.includes('ServerAliveCountMax=4'))
    check('T3.5 参数含 ExitOnForwardFailure + -N -L', args.includes('ExitOnForwardFailure=yes') && args.includes('-N') && args.includes('-L') && args.includes('13080:127.0.0.1:3080'))
    check('T3.6 目标 user@host', args.includes('root@47.112.205.98'))
    check('T3.7 状态与统计', m.tunnels[0].status === 'up' && m.tunnels[0].restartCount === 1 && m.tunnels[0].pid === 7001 && !m.tunnels[0].adopted)
    const state = JSON.parse(fs.readFileSync(makeCfg().stateFile, 'utf8'))
    check('T3.8 状态持久化', state.tunnels['ecs-3080'].pid === 7001 && state.tunnels['ecs-3080'].restartCount === 1)
    check('T3.9 StrictHostKeyChecking=accept-new', args.includes('StrictHostKeyChecking=accept-new'))
    m.stopAll()
  }

  console.log('== T3b 非 22 端口：ssh 用 -p / scp 用 -P ==')
  {
    const spawned = []
    const children = []
    let probeUp = false
    const cfg = makeCfg({ tunnels: [{
      id: 'cont-2222', name: 'Container sshd', host: '127.0.0.1', user: 'root',
      identityFile: '/root/.ssh/dsh-container', port: 2222, localPort: 13022, remotePort: 2222,
    }] })
    const m = new TunnelManager({}, cfg, {
      sleepMs: 0.01,
      probeFn: async () => { if (!probeUp) throw new Error('down'); return 2 },
      spawnFn: (cmd, args) => {
        spawned.push({ cmd, args })
        const child = fakeChild(7301 + spawned.length)
        children.push(child)
        if (cmd === 'ssh' && args.includes('-N')) setTimeout(() => { probeUp = true }, 10)
        return child
      },
    })
    await m.ensure(m.tunnels[0])
    const sshArgs = spawned[0].args.join(' ')
    check('T3b.1 隧道 ssh 用 -p 2222', sshArgs.includes('-p 2222') && !sshArgs.includes('-P 2222'), sshArgs)
    // ssh_run
    const p1 = m.runCommand(m.tunnels[0], 'hostname', undefined)
    setTimeout(() => children[1].emitClose(0), 5)
    await p1
    const runArgs = spawned[1].args.join(' ')
    check('T3b.2 ssh_run 用 -p 2222', runArgs.includes('-p 2222') && !runArgs.includes('-P 2222'), runArgs)
    // ssh_push → scp 用 -P 2222
    const p2 = m.pushFile(m.tunnels[0], 'a.txt', '/tmp/a.txt', false)
    setTimeout(() => children[2].emitClose(0), 5)
    await p2
    const scpArgs = spawned[2].args.join(' ')
    check('T3b.3 ssh_push(scp) 用 -P 2222', scpArgs.includes('-P 2222') && !scpArgs.includes('-p 2222'), scpArgs)
    check('T3b.4 view 含 port', m.view().tunnels[0].port === 2222)
    m.stopAll()
  }

  console.log('== T4 断线自动重连（supervisor） ==')
  {
    const spawned = []
    let childRef = null
    let probeUp = true
    // 独立 state 文件：避免被 T3 写入的 restartCount=1 污染
    const m = new TunnelManager({}, makeCfg({ stateFile: path.join(tmpDir, 'state-t4.json') }), {
      sleepMs: 0.01,
      probeFn: async () => { if (!probeUp) throw new Error('down'); return 2 },
      spawnFn: (cmd, args) => {
        const child = fakeChild(7100 + spawned.length)
        childRef = child
        spawned.push({ cmd, args })
        return child
      },
    })
    await m.ensure(m.tunnels[0])
    check('T4.1 初始 up', m.tunnels[0].status === 'up', m.tunnels[0].status)
    // 模拟 ssh 断线
    probeUp = false
    childRef.emitExit(1, null)
    check('T4.2 退出后 status down', m.tunnels[0].status === 'down')
    check('T4.3 lastExit 记录', m.tunnels[0].lastExit && m.tunnels[0].lastExit.code === 1)
    await sleep(120) // 等退避重连（sleepMs=0.01 → ~30ms）
    check('T4.4 自动重连 spawn 第二次', spawned.length === 2, 'spawned=' + spawned.length)
    check('T4.5 重启计数累计', m.tunnels[0].restartCount === 2, String(m.tunnels[0].restartCount))
    // 起不来时持续重试但不过热
    const before = spawned.length
    probeUp = false
    childRef.emitExit(1, null)
    await sleep(60)
    check('T4.6 失败时不立即风暴重连', spawned.length < before + 3, 'spawned=' + spawned.length)
    m.stopAll()
  }

  console.log('== T5 停止：本进程 spawn 的 child 直接 kill ==')
  {
    let killed = null
    const m = new TunnelManager({}, makeCfg(), {
      sleepMs: 0.01,
      probeFn: async () => { throw new Error('down') },
      spawnFn: (cmd) => {
        const child = fakeChild(7200)
        child.kill = () => { killed = cmd; return true }
        return child
      },
    })
    // 先把 child 挂上（模拟 ensure 中）
    m.tunnels[0].child = fakeChild(7200)
    await m.stop(m.tunnels[0])
    check('T5.1 stop 后 down 且 child 清空', m.tunnels[0].status === 'down' && m.tunnels[0].child === null)
    m.stopAll()
  }

  console.log('== T6 停止：收养的孤儿按端口定位 PID 后 taskkill ==')
  {
    let taskkillArgs = null
    const m = new TunnelManager({}, makeCfg(), {
      sleepMs: 0.01,
      probeFn: async () => 1,
      pidOfPortFn: async () => 4321,
      spawnFn: (cmd, args) => {
        if (cmd === 'taskkill') {
          taskkillArgs = args
          const child = fakeChild(0)
          setTimeout(() => child.emitClose(0), 5)
          return child
        }
        return fakeChild(7300)
      },
    })
    await m.probe()
    check('T6.1 收养 up', m.tunnels[1].status === 'up' && m.tunnels[1].adopted === true)
    await m.stop(m.tunnels[1])
    check('T6.2 taskkill 按 PID', taskkillArgs && taskkillArgs.join(' ') === '/PID 4321 /F', JSON.stringify(taskkillArgs))
    check('T6.3 stop 后 down', m.tunnels[1].status === 'down')
    m.stopAll()
  }

  console.log('== T7 ssh_run：参数、输出、退出码、超时 ==')
  {
    const calls = []
    let childRef = null
    const m = new TunnelManager({}, makeCfg(), {
      sleepMs: 0.01,
      probeFn: async () => { throw new Error('down') },
      spawnFn: (cmd, args) => {
        calls.push({ cmd, args })
        const child = fakeChild(7400)
        childRef = child
        return child
      },
    })
    const t = m.tunnels[0]
    // 正常路径
    const p1 = m.runCommand(t, 'echo hi && hostname', undefined)
    setTimeout(() => {
      childRef.writeOut('hi\nserver1\n')
      childRef.emitClose(0)
    }, 10)
    const r1 = await p1
    check('T7.1 返回 exitCode/stdout', r1.exitCode === 0 && r1.stdout === 'hi\nserver1\n', JSON.stringify(r1))
    const args1 = calls[0].args
    check('T7.2 ssh 参数含 BatchMode/ConnectTimeout/-i', args1.includes('-o') && args1.some(a => a.includes('BatchMode=yes')) && args1.some(a => a.includes('ConnectTimeout=2')))
    check('T7.3 命令作为最后单参数', args1[args1.length - 1] === 'echo hi && hostname')
    check('T7.4 无 -N -L（非隧道）', !args1.includes('-N') && !args1.includes('-L'))
    // 错误路径
    const p2 = m.runCommand(t, 'false', undefined)
    setTimeout(() => childRef.emitClose(1), 10)
    const r2 = await p2
    check('T7.5 非零退出码透传', r2.exitCode === 1)
    // stderr 回传
    const p3 = m.runCommand(t, 'bad', undefined)
    setTimeout(() => { childRef.writeErr('Permission denied (publickey)'); childRef.emitClose(255) }, 10)
    const r3 = await p3
    check('T7.6 stderr 回传', r3.exitCode === 255 && r3.stderr.includes('Permission denied'), JSON.stringify(r3))
    // 超时
    const p4 = m.runCommand(t, 'sleep 999', 100)
    const r4 = await p4
    check('T7.7 超时终止并标记', r4.timedOut === true && r4.exitCode === -1 && r4.stderr.includes('超时'), JSON.stringify(r4))
    m.stopAll()
  }

  console.log('== T8 ssh_push：scp 参数 ==')
  {
    const calls = []
    let childRef = null
    const m = new TunnelManager({}, makeCfg(), {
      sleepMs: 0.01,
      probeFn: async () => { throw new Error('down') },
      spawnFn: (cmd, args) => {
        calls.push({ cmd, args })
        const child = fakeChild(7500)
        childRef = child
        return child
      },
    })
    const t = m.tunnels[0]
    const p = m.pushFile(t, 'C:/x/y.js', '/root/y.js', true)
    setTimeout(() => { childRef.writeErr('y.js 100%'); childRef.emitClose(0) }, 10)
    const r = await p
    check('T8.1 exitCode 0', r.exitCode === 0)
    const args = calls[0].args
    check('T8.2 scp -r -i + 目标', calls[0].cmd === 'scp' && args.includes('-r') && args.includes('-i') && args.some(a => a.includes('dsh-server')), JSON.stringify(args))
    check('T8.3 本地/远程位置', args.some(a => a === 'C:/x/y.js') && args.some(a => a === 'root@47.112.205.98:/root/y.js'))
    m.stopAll()
  }

  console.log('== T9 apply 装配（fake ctx）：工具/系统提示/HTTP API ==')
  {
    const registeredTools = []
    const sections = []
    const routes = []
    const fakeCtx = {
      logger: { info() {}, warn() {}, error() {} },
      effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
      tools: {
        register(def) { registeredTools.push(def) },
      },
      systemPrompt: {
        section(s) { sections.push(s) },
      },
      inject(names, fn) {
        if (names.includes('webServer')) {
          fn({
            effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
            webServer: {
              register(entry) { routes.push(entry) },
            },
          })
        }
      },
    }
    apply(fakeCtx, makeCfg({ tunnels: [] }))
    const names = registeredTools.map(t => t.name)
    check('T9.1 六个工具注册', ['ssh_tunnel_status', 'ssh_tunnel_start', 'ssh_tunnel_stop', 'ssh_tunnel_restart', 'ssh_run', 'ssh_push'].every(n => names.includes(n)), names.join(','))
    check('T9.2 系统提示段注册', sections.length === 1 && sections[0].name === 'ssh-tunnel' && sections[0].text.includes('ssh_tunnel_status'), sections.length + '')
    check('T9.3 HTTP 路由注册', routes.length === 1 && routes[0].path === '/ssh-tunnel/api', JSON.stringify(routes.map(r => r.path)))

    // 工具执行链（用第二个实例验证 execute 逻辑 + 回环守卫）
    const m = new TunnelManager({}, makeCfg(), {
      sleepMs: 0.01,
      probeFn: async () => { throw new Error('down') },
      spawnFn: () => fakeChild(7600),
    })
    const statusTool = registeredTools.find(t => t.name === 'ssh_tunnel_status')
    const startTool = registeredTools.find(t => t.name === 'ssh_tunnel_start')
    const runTool = registeredTools.find(t => t.name === 'ssh_run')
    const s1 = await statusTool.execute({})
    // apply 实例用空隧道配置 → view 应含空 tunnels 数组（形状验证）
    check('T9.4 status 执行返回 view', s1 && Array.isArray(s1.tunnels) && s1.tunnels.length === 0, JSON.stringify(s1))
    const err = await startTool.execute({ tunnelId: 'nope' }).then(() => null, e => e)
    check('T9.5 start 未知隧道报错', err instanceof Error && String(err.message).includes('不存在'))
    const runErr = await runTool.execute({}).then(() => null, e => e)
    check('T9.6 run 缺 command 报错', runErr instanceof Error && String(runErr.message).includes('command'))

    // 回环守卫：非回环 host → 403
    const handler = routes[0].handler
    const res403 = { writeHead(s) { this.status = s }, end(b) { this.body = b } }
    handler({ method: 'GET', url: '/ssh-tunnel/api/status', headers: { host: 'evil.example.com' } }, res403)
    check('T9.7 非回环 host 403', res403.status === 403, String(res403.status))
    // 回环 host → status 200
    const res200 = { writeHead(s) { this.status = s }, end(b) { this.body = b } }
    handler({ method: 'GET', url: '/ssh-tunnel/api/status', headers: { host: '127.0.0.1:3080' } }, res200)
    check('T9.8 回环 host 200 + view JSON', res200.status === 200 && JSON.parse(res200.body).ok === true)
    // 未知路由 → 404
    const res404 = { writeHead(s) { this.status = s }, end(b) { this.body = b } }
    handler({ method: 'GET', url: '/ssh-tunnel/api/nope', headers: { host: '127.0.0.1:3080' } }, res404)
    check('T9.9 未知路由 404', res404.status === 404)
    m.stopAll()
  }

  console.log('== T10 无配置隧道时的 pickTunnel 报错 ==')
  {
    const m = new TunnelManager({}, makeCfg({ tunnels: [] }), { sleepMs: 0.01 })
    let err = null
    try { m.pickTunnel(undefined) } catch (e) { err = e }
    check('T10.1 空池报错', err && String(err.message).includes('未配置'))
    m.stopAll()
  }

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true })
  clearInterval(keepAlive)

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  if (failed > 0) {
    console.log('失败项:')
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
