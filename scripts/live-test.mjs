// dsh-ssh-tunnel 真实链路验证（不装 profile、不改任何生产配置）：
// 用插件自己的 TunnelManager（真实 spawn/probe）连真实 ECS：
//   1) 拉起 13082→3080 隧道并验证本地端口可达 + HTTP 200
//   2) ssh_run 执行远程命令（hostname / systemctl）
//   3) ssh_push 上传小文件并远程验证
//   4) 断线模拟：kill ssh 进程 → 插件自动重连
//   5) stop 清理
// 端口用 13082 独立端口，避免与用户现有 13080/13081 隧道冲突。
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as cp from 'node:child_process'
import { TunnelManager } from '../lib/index.js'

const HOST = '47.112.205.98'
const KEY = 'C:\\Users\\PC\\.ssh\\dsh-server'
const PORT = 13082
const STATE_FILE = path.join(os.tmpdir(), 'ssh-tunnel-live-state.json')

let passed = 0
let failed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + detail : '')) }
}

// 预检：13082 必须空闲（避免误杀用户进程）
function portFree(p) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: p })
    s.once('connect', () => { s.destroy(); resolve(false) })
    s.once('error', () => resolve(true))
  })
}

async function httpStatus(url, timeoutMs) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    return r.status
  } catch { return null }
  finally { clearTimeout(t) }
}

async function main() {
  console.log('== L1 预检 ==')
  if (!fs.existsSync(KEY)) { console.log('FAIL 密钥不存在 ' + KEY); process.exit(1) }
  if (!(await portFree(PORT))) { console.log('FAIL 端口 ' + PORT + ' 已被占用，中止（避免误杀现有进程）'); process.exit(1) }
  fs.rmSync(STATE_FILE, { force: true }) // 计数从 0 开始
  console.log('  PASS 密钥存在 + 端口空闲')

  const keepAlive = setInterval(() => {}, 1000)
  const m = new TunnelManager({ logger: { info: (...a) => console.log('  [log] ' + a.join(' ')), warn: (...a) => console.log('  [warn] ' + a.join(' ')), error: (...a) => console.log('  [err] ' + a.join(' ')) } }, {
    tunnels: [{
      id: 'live-13082', name: 'Live 13082', host: HOST, user: 'root', identityFile: KEY,
      localPort: PORT, remoteHost: '127.0.0.1', remotePort: 3080, autoRestart: true, keepAlive: true,
    }],
    probeIntervalMs: 3000, probeTimeoutMs: 2000, connectTimeoutSec: 15, commandTimeoutMs: 30000,
    stateFile: STATE_FILE, connectHint: '',
  })

  console.log('== L2 拉起隧道（真实 ssh -N -L） ==')
  const t = m.tunnels[0]
  const started = Date.now()
  const r = await m.ensure(t)
  console.log('  ensure 结果:', JSON.stringify(r))
  check('L2.1 隧道 up', r.status === 'up', JSON.stringify(r))
  const status = await httpStatus('http://127.0.0.1:' + PORT + '/', 8000)
  check('L2.2 隧道内 HTTP 200（远端 dsh web）', status === 200, 'status=' + status)
  check('L2.3 拉起耗时 < 30s', Date.now() - started < 30000)
  console.log('  view:', JSON.stringify(m.view().tunnels[0], null, 2))

  console.log('== L3 ssh_run 远程命令 ==')
  const r1 = await m.runCommand(t, 'echo TUNNEL_OK && hostname && systemctl is-active dsh-web')
  console.log('  exitCode=' + r1.exitCode)
  console.log('  stdout=' + JSON.stringify(r1.stdout))
  check('L3.1 exitCode 0', r1.exitCode === 0, JSON.stringify(r1))
  check('L3.2 输出含 TUNNEL_OK', (r1.stdout || '').includes('TUNNEL_OK'))
  check('L3.3 dsh-web active', (r1.stdout || '').includes('active'))
  const r2 = await m.runCommand(t, 'echo 引号测试; ls /nonexistent-xyz 2>&1 | head -1')
  console.log('  r2 exitCode=' + r2.exitCode + ' stdout=' + JSON.stringify(r2.stdout) + ' stderr=' + JSON.stringify(r2.stderr))
  check('L3.4 分号/管道多命令正常', (r2.stdout || '').includes('引号测试') && (r2.stdout || '').includes('No such file'))

  console.log('== L4 ssh_push 上传 + 远程核验 ==')
  const tmp = path.join(os.tmpdir(), 'ssh-tunnel-live-push.txt')
  fs.writeFileSync(tmp, 'dsh-ssh-tunnel live test ' + Date.now() + '\n', 'utf8')
  const rp = await m.pushFile(t, tmp, '/tmp/dsh-ssh-tunnel-live.txt', false)
  console.log('  push exitCode=' + rp.exitCode + ' stderr=' + JSON.stringify(rp.stderr))
  check('L4.1 push exitCode 0', rp.exitCode === 0, JSON.stringify(rp))
  const rv = await m.runCommand(t, 'cat /tmp/dsh-ssh-tunnel-live.txt')
  check('L4.2 远端文件内容一致', (rv.stdout || '').includes('live test'), JSON.stringify(rv.stdout))

  console.log('== L5 断线自动重连（真实 kill ssh 进程） ==')
  const pid = t.pid
  check('L5.1 有 ssh pid', Number(pid) > 0, String(pid))
  // 模拟断线：taskkill ssh 进程（插件应探到 down 并自动重连）
  const killed = await new Promise((resolve) => {
    const k = cp.spawn('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' })
    k.on('close', () => resolve(true))
  })
  console.log('  taskkill ssh pid=' + pid + ' -> ' + killed)
  // 退避 3s + 重连约 1-2s，等 12s 再断言
  await new Promise(r => setTimeout(r, 12000))
  const s5 = m.view().tunnels[0]
  console.log('  12s 后 status=' + s5.status + ' restartCount=' + s5.restartCount)
  check('L5.2 自动重连后隧道恢复 up', s5.status === 'up', JSON.stringify(s5))
  check('L5.3 重启计数 >= 2', s5.restartCount >= 2, String(s5.restartCount))
  const status5 = await httpStatus('http://127.0.0.1:' + PORT + '/', 8000)
  check('L5.4 重连后 HTTP 仍可达', status5 === 200, 'status=' + status5)

  console.log('== L6 清理 ==')
  await m.stop(t)
  const up6 = await portFree(PORT)
  check('L6.1 stop 后端口释放', up6 === true, 'portFree=' + up6)
  fs.rmSync(tmp, { force: true })
  m.stopAll()
  clearInterval(keepAlive)

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  // 注意：不要 process.exit()——Windows libuv 下 exit() 与仍在关闭的句柄（子进程/socket）竞争会
  // 触发 Assertion failed: src\win\async.c (0xC0000409)。设置 exitCode 后自然退出即可。
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch(err => { console.error('live test 异常:', err); process.exit(1) })
