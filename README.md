# dsh-ssh-tunnel

DSH（DeepSeek Harness）插件：**SSH 隧道托盘**（端口转发生命周期管理，**双向**）。

- **双向隧道**：`-N -L` 正向（本机监听 → 远端目标）/ `-N -R` 反向（远端监听 → 回本机目标），每条隧道用 `direction: local | remote` 声明；
- 隧道**断线自动重连**（supervisor 循环 + keepalive 参数），宿主重启后**自动收养**孤儿 ssh 进程（不重复起隧道）；
- 会话头部 **SSH 状态胶囊**（绿=全部 up / 红=有 down / 灰=未配置），点开面板看每条隧道状态并可启动/重启/停止；
- 4 个 Agent 工具 + 回环 HTTP API（非回环 403）。

> 分工：本包**只管隧道连接生命周期**；远程命令 `ssh_run`/文件上传 `ssh_push`（直控实例）已拆到
> **[dsh-ssh-pool](https://github.com/GammaChineYov/dsh-ssh-pool)**。Agent 访问远程主机走 `ssh_pool_status` + `ssh_run(instance=...)`。

> 背景：开发 dsh-message-branch 等插件时，裸 `ssh -N -L` 隧道反复断线（`client_loop: send disconnect: Connection reset`），
> 且手工在 pwsh 拼 ssh/scp 命令频繁踩 PowerShell 嵌套引号（ParserError）与 scp 静默挂起。本插件把这两件事变成
> 「配好隧道 → 调工具」，由插件负责拉起、保活、重连与超时。

## 安装

```bash
dsh plugin --profile web add git+https://github.com/GammaChineYov/dsh-ssh-tunnel.git
# 或本地开发：dsh plugin --profile web add link:C:/Users/PC/dsh-ssh-tunnel
```

装完后在 `~/.dsh/profiles/web/cordis.patch.yml` 加配置段（示例）：

```yaml
# dsh-ssh-tunnel：SSH 隧道托盘（断线自动重连 + 双向 -L/-R）
# 生效条件：重启 dsh web。identityFile 为私钥绝对路径；direction 缺省 local。
# local：本机监听 localPort → 转发到 remoteHost:remotePort；
# remote：远端监听 remotePort → 转发回 localHost:localPort。
- id: ssh-tunnel
  config:
    tunnels:
      # 正向：本机 13080 → 远端 127.0.0.1:3080（浏览器访问 http://127.0.0.1:13080）
      - id: ecs-3080
        name: 'ECS 主环境 3080'
        host: 47.112.205.98
        user: root
        identityFile: 'C:\Users\PC\.ssh\dsh-server'
        direction: local
        localPort: 13080
        remoteHost: 127.0.0.1
        remotePort: 3080
        autoRestart: true
        keepAlive: true
      # 反向：远端监听 17890 → 回本机 127.0.0.1:8080（让远端访问本机服务）
      - id: rev-8080
        name: '反向回本机 8080'
        host: 47.112.205.98
        user: root
        identityFile: 'C:\Users\PC\.ssh\dsh-server'
        direction: remote
        remotePort: 17890
        localHost: 127.0.0.1
        localPort: 8080
        autoRestart: true
        keepAlive: true
    probeIntervalMs: 10000
    probeTimeoutMs: 2000
    connectTimeoutSec: 15
    connectHint: '隧道 down 时调 ssh_tunnel_start 拉起（插件自动重连）。'
```

重启 dsh web 生效。之后浏览器 http://127.0.0.1:13080 即远端 dsh GUI（隧道 down 时插件自动拉起）。

## Agent 工具

| 工具 | 作用 |
|------|------|
| `ssh_tunnel_status` | 查看每条隧道 up/down/starting、方向（local/remote）、是否收养（adopted）、运行时长、重启次数、探活延迟、最后错误/退出码 |
| `ssh_tunnel_start` | 拉起指定隧道（tunnelId 缺省取第一条），等待端口就绪 |
| `ssh_tunnel_stop` | 停止指定隧道（本插件 spawn 的 ssh 直接 kill；收养的孤儿按本地端口定位 PID 后 taskkill，remote 方向按其进程 pid kill） |
| `ssh_tunnel_restart` | 先停再拉起 |

直控实例（远程命令/文件）见 `ssh_pool_status` / `ssh_run` / `ssh_push`（dsh-ssh-pool）。

使用示例：

```
ssh_tunnel_status                    # 看隧道状态
ssh_tunnel_start tunnelId="ecs-3080" # 拉起
ssh_tunnel_restart tunnelId="ecs-3080"
```

## HTTP API（回环 only，非回环 403）

- `GET  /ssh-tunnel/api/status` — 状态视图
- `POST /ssh-tunnel/api/start   {tunnelId?}` — 拉起
- `POST /ssh-tunnel/api/stop    {tunnelId}` — 停止
- `POST /ssh-tunnel/api/restart {tunnelId?}` — 重启

## 设计要点

- **重连**：ssh 子进程退出即按退避（3s→6s→12s→24s→60s 封顶）自动重连；`ServerAliveInterval=25 / ServerAliveCountMax=4` 保活；
- **双向**：`direction: local` 用 `-N -L local:remoteH:remoteP`（本机监听，探本地端口）；`direction: remote` 用 `-N -R remote:localH:localP`（远端监听，本地无端口可探→用**进程存活 + keepalive + 退出重连**判活）；
- **收养**：local 方向宿主重启后按本地端口 TCP 探活，端口已通则标记 `adopted` 不重复 spawn（避免 `Address already in use`）；remote 方向按其进程 pid 探活。停止收养隧道时 local 按端口 `netstat -ano` 找 PID、remote 按进程 pid 杀；
- **持久化**：`~/.dsh/ssh-tunnel-state.json` 记录 pid/startedAt/restartCount，跨宿主重启累计；
- **非 22 端口**（v0.1.1）：隧道条目可配 `port`（默认 22），ssh 用 `-p`；
- **host key 处理**（v0.1.1）：统一加 `StrictHostKeyChecking=accept-new`——BatchMode 下新主机 host key 首次连接自动接受，不再出现 `Host key verification failed`，也无需手工 ssh-keyscan 写 known_hosts；
- **无 PowerShell**：所有 spawn 都用参数数组直传（`ssh -i key -o BatchMode=yes ...`）；
- **分工**（v0.2.0）：`ssh_run`/`ssh_push`（直控实例）拆到 `dsh-ssh-pool`，本包只保留 `ssh_tunnel_*` 隧道工具；
- **样式**：client 全部 React 行内 style，零全局副作用（不注入 `<style>`，避免跨插件污染）。

## 开发

```bash
node --check lib/index.js && node --check lib/client.js   # 语法
node scripts/smoke-test.mjs                                # 冒烟（fake spawn/probe，不碰真实网络）
```

冒烟测试覆盖：配置默认值 / 收养 / 拉起参数（keepalive、ExitOnForwardFailure、-N -L / -N -R）/ 断线自动重连与退避 /
停止（含 orphan taskkill、remote 进程 pid 杀）/ apply 装配（工具、系统提示、HTTP 路由、回环 403）。

## License

MIT
