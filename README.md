# dsh-ssh-tunnel

DSH（DeepSeek Harness）插件：**SSH 隧道管理 + 远程命令执行**。

- 隧道**断线自动重连**（supervisor 循环 + keepalive 参数），宿主重启后**自动收养**孤儿 ssh 进程（不重复起隧道）；
- `ssh_run` / `ssh_push` 用 Node spawn 参数数组直接调 ssh/scp（**不经 PowerShell**），终结引号地狱与静默超时；
- 会话头部 **SSH 状态胶囊**（绿=全部 up / 红=有 down / 灰=未配置），点开面板看每条隧道状态并可启动/重启/停止；
- 6 个 Agent 工具 + 回环 HTTP API（非回环 403）。

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
# dsh-ssh-tunnel：SSH 隧道管理（断线自动重连 + ssh_run/ssh_push）
# 生效条件：重启 dsh web。identityFile 为私钥绝对路径；localPort 为本地监听端口。
- id: ssh-tunnel
  config:
    tunnels:
      - id: ecs-3080
        name: 'ECS 主环境 3080'
        host: 47.112.205.98
        user: root
        identityFile: 'C:\Users\PC\.ssh\dsh-server'
        localPort: 13080
        remoteHost: 127.0.0.1
        remotePort: 3080
        autoRestart: true
        keepAlive: true
      - id: ecs-3081
        name: 'ECS Docker 3081'
        host: 47.112.205.98
        user: root
        identityFile: 'C:\Users\PC\.ssh\dsh-server'
        localPort: 13081
        remoteHost: 127.0.0.1
        remotePort: 3081
    probeIntervalMs: 10000
    probeTimeoutMs: 2000
    connectTimeoutSec: 15
    commandTimeoutMs: 60000
```

重启 dsh web 生效。之后浏览器 http://127.0.0.1:13080 即远端 dsh GUI（隧道 down 时插件自动拉起）。

## Agent 工具

| 工具 | 作用 |
|------|------|
| `ssh_tunnel_status` | 查看每条隧道 up/down/starting、是否收养（adopted）、运行时长、重启次数、探活延迟、最后错误/退出码 |
| `ssh_tunnel_start` | 拉起指定隧道（tunnelId 缺省取第一条），等待本地端口就绪 |
| `ssh_tunnel_stop` | 停止指定隧道（本插件 spawn 的 ssh 直接 kill；收养的孤儿按本地端口定位 PID 后 taskkill） |
| `ssh_tunnel_restart` | 先停再拉起 |
| `ssh_run` | 远程执行命令（BatchMode 免交互、带超时），返回 `{exitCode, stdout, stderr, durationMs}`；命令交给远端 bash 解释 |
| `ssh_push` | 上传本地文件/目录（scp，`recursive` 目录递归），返回 `{exitCode, output, stderr}` |

使用示例：

```
ssh_tunnel_status                    # 看隧道状态
ssh_run command="hostname"           # 默认第一条隧道
ssh_run tunnelId="ecs-3081" command="systemctl status dsh-web --no-pager | head -20"
ssh_push localPath="C:\x\lib\index.js" remotePath="/root/dsh-message-branch/lib/index.js"
```

## HTTP API（回环 only，非回环 403）

- `GET  /ssh-tunnel/api/status` — 状态视图
- `POST /ssh-tunnel/api/start   {tunnelId?}` — 拉起
- `POST /ssh-tunnel/api/stop    {tunnelId}` — 停止
- `POST /ssh-tunnel/api/restart {tunnelId?}` — 重启

## 设计要点

- **重连**：ssh 子进程退出即按退避（3s→6s→12s→24s→60s 封顶）自动重连；`ServerAliveInterval=25 / ServerAliveCountMax=4` 保活；
- **收养**：宿主重启后按本地端口 TCP 探活，端口已通则标记 `adopted` 不重复 spawn（避免 `Address already in use`）；
  停止收养隧道时用 `netstat -ano` 定位监听 PID 再 `taskkill /PID <pid> /F`；
- **持久化**：`~/.dsh/ssh-tunnel-state.json` 记录 pid/startedAt/restartCount，跨宿主重启累计；
- **无 PowerShell**：所有 spawn 都用参数数组直传（`ssh -i key -o BatchMode=yes ...`），命令作为单个参数交给远端 shell；
- **样式**：client 全部 React 行内 style，零全局副作用（不注入 `<style>`，避免跨插件污染）。

## 开发

```bash
node --check lib/index.js && node --check lib/client.js   # 语法
node scripts/smoke-test.mjs                                # 45 项冒烟（fake spawn/probe，不碰真实网络）
```

冒烟测试覆盖：配置默认值 / 收养 / 拉起参数（keepalive、ExitOnForwardFailure、-N -L）/ 断线自动重连与退避 /
停止（含孤儿 taskkill）/ ssh_run 输出·退出码·stderr·超时 / ssh_push 参数 / apply 装配（工具、系统提示、HTTP 路由、回环 403）。

## License

MIT
