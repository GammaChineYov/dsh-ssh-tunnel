// dsh-ssh-tunnel — browser half（全行内样式，零全局副作用）。
//
// 注册到会话头部 utilities 槽（conversation.session.header.utilities）：
// 「SSH」状态胶囊（绿=全部隧道 up / 红=有 down / 灰=未配置），点击展开浮窗：
// 每条隧道一行（状态点 + 名称 + local→remote + 运行时长 + 重启次数 + 探活延迟 +
// 收养徽标 + 最后错误），带「启动 / 重启 / 停止 / 刷新」操作。
// 样式全部用 React 行内 style（v3 教训：全局 <style> 注入会跨插件污染，禁用）。
window.__ModuleLoader__.load({
  id: 'dsh-ssh-tunnel',
  factory: function (require) {
    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    // ---- 行内样式（与 --dsw-* 主题变量一致的 fallback 值） ----
    var S = {
      chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 999, background: 'transparent', color: 'var(--dsw-alias-label-secondary,#999)', cursor: 'pointer', font: 'inherit', fontSize: 12, lineHeight: 1.8, whiteSpace: 'nowrap', position: 'relative' },
      dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
      panel: { position: 'fixed', zIndex: 2000, maxWidth: '92vw', maxHeight: '70vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1,#1f1f1f)', border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,.4)', padding: '10px 12px', font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-primary,inherit)', textAlign: 'left' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--dsw-alias-border-l1,#88888866)' },
      ttl: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary,inherit)' },
      close: { font: 'inherit', fontSize: 14, lineHeight: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#88888866)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#bbb)', cursor: 'pointer' },
      row: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', borderRadius: 6, margin: '1px 0', borderBottom: '1px solid var(--dsw-alias-border-l1,#88888866)' },
      rowBody: { flex: '1 1 auto', minWidth: 0 },
      nm: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-label-primary,inherit)', fontWeight: 600 },
      sub: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary,#888)', marginTop: 2, wordBreak: 'break-all' },
      badge: { fontSize: 10, padding: '1px 5px', borderRadius: 999, flex: '0 0 auto' },
      btn: { flex: '0 0 auto', font: 'inherit', fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#88888866)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#bbb)', cursor: 'pointer', marginLeft: 4 },
      btnDisabled: { opacity: 0.4, cursor: 'default' },
      actions: { display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0 2px' },
      hint: { marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1,#88888866)', color: 'var(--dsw-alias-label-tertiary,#888)', fontSize: 11, wordBreak: 'break-all' },
      empty: { color: 'var(--dsw-alias-label-tertiary,#888)', padding: '8px 4px', fontSize: 11 },
      err: { color: '#e5484d', fontSize: 11, marginTop: 4, wordBreak: 'break-all' },
      upBadge: { background: 'var(--dsw-alias-state-success-primary,#16a34a)', color: '#fff' },
      downBadge: { background: 'var(--dsw-alias-state-danger-primary,#e5484d)', color: '#fff' },
      startingBadge: { background: 'var(--dsw-alias-state-warning-primary,#f5a623)', color: '#111' },
    }

    function fmtUptime(ms) {
      if (!ms || ms <= 0) return '-'
      var s = Math.floor(ms / 1000)
      if (s < 60) return s + 's'
      if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60) + 's'
      return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm'
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }

    function SshTunnelUtility(props) {
      var wrapRef = useRef(null)
      var [state, setState] = useState({ phase: 'loading', data: null, open: false, error: null, pos: null })

      var refresh = useCallback(function () {
        fetch('/ssh-tunnel/api/status')
          .then(function (r) { return r.json() })
          .then(function (res) {
            if (res && res.ok === true) {
              setState(function (s) { return { phase: 'done', data: res.value, error: null, open: s.open, pos: s.pos } })
            } else {
              setState(function (s) { return { phase: 'done', data: s.data, error: ((res && res.error && res.error.message) || 'status failed'), open: s.open, pos: s.pos } })
            }
          })
          .catch(function () {
            setState(function (s) { return { phase: 'done', data: null, error: 'host api unavailable', open: s.open, pos: s.pos } })
          })
      }, [])

      // 挂载时拉一次；数据更新靠「刷新」按钮（不轮询，避免高频重渲染）
      useEffect(function () {
        refresh()
      }, [refresh])

      function toggle() { setState(function (s) { return { ...s, open: !s.open } }) }

      // 打开时计算一次贴近按钮的位置
      useEffect(function () {
        if (!state.open) return
        function measurePos() {
          var chip = wrapRef.current
          if (!chip) return null
          var r = chip.getBoundingClientRect()
          var width = 460
          var left = r.right - width
          if (left < 8) left = 8
          return { top: r.bottom + 6, left: left, width: width }
        }
        setState(function (s) { return { ...s, pos: measurePos() } })
      }, [state.open])

      function post(path, body) {
        postJson(path, body || {}).then(function (res) {
          if (res && res.ok === true) {
            setState(function (s) { return { phase: 'done', data: res.value.view, error: null, open: true } })
          } else {
            setState(function (s) { return { ...s, error: ((res && res.error && res.error.message) || 'failed') } })
          }
        })
      }
      function start(id) { post('/ssh-tunnel/api/start', { tunnelId: id }) }
      function restart(id) { post('/ssh-tunnel/api/restart', { tunnelId: id }) }
      function stop(id) { post('/ssh-tunnel/api/stop', { tunnelId: id }) }

      if (state.phase === 'loading') return null
      var data = state.data
      var close = function () { setState(function (s) { return { ...s, open: false } }) }

      // 胶囊状态：绿=全部 up，红=任一 down/starting，灰=未配置
      var tunnels = (data && Array.isArray(data.tunnels)) ? data.tunnels : []
      var hasDown = tunnels.some(function (t) { return t.status === 'down' })
      var anyUp = tunnels.some(function (t) { return t.status === 'up' })
      var dotColor = '#888'
      if (tunnels.length > 0) dotColor = hasDown ? '#e5484d' : (anyUp ? '#30a46c' : '#888')

      return h('div', { ref: wrapRef, style: S.chip, onClick: toggle, title: 'SSH 隧道：点击展开/收起' },
        h('span', { style: Object.assign({ background: dotColor }, S.dot) }),
        h('span', null, 'SSH'),
        state.open && state.pos && h('div', { style: Object.assign({ top: state.pos.top, left: state.pos.left, width: state.pos.width }, S.panel), onClick: function (e) { e.stopPropagation() } },
          h('div', { style: S.head },
            h('span', { style: S.ttl }, 'SSH 隧道管理'),
            h('button', { style: S.close, onClick: close, title: '关闭' }, '✕')
          ),
          renderPanel(data, state.error, start, restart, stop, refresh)
        )
      )
    }

    function renderPanel(data, error, start, restart, stop, refresh) {
      var tunnels = (data && Array.isArray(data.tunnels)) ? data.tunnels : []
      var rows = []
      if (tunnels.length === 0) {
        rows.push(h('div', { key: 'none', style: S.empty }, '未配置隧道（profile cordis.patch.yml 的 ssh-tunnel.config.tunnels）'))
      }
      tunnels.forEach(function (t) {
        var up = t.status === 'up'
        var starting = t.status === 'starting'
        var dotColor = up ? '#30a46c' : (starting ? '#f5a623' : '#e5484d')
        var badgeStyle = up ? S.upBadge : (starting ? S.startingBadge : S.downBadge)
        var badgeText = up ? (t.adopted ? 'UP·收养' : 'UP') : (starting ? '启动中' : 'DOWN')
        var meta = t.localPort + '→' + t.remoteHost + ':' + t.remotePort + ' · ' + t.host
        var extra = []
        if (t.uptimeMs) extra.push(fmtUptime(t.uptimeMs))
        if (t.restartCount) extra.push('重启 ' + t.restartCount + ' 次')
        if (t.probeMs !== null && t.probeMs !== undefined) extra.push('延迟 ' + t.probeMs + 'ms')
        rows.push(
          h('div', { key: t.id, style: S.row },
            h('span', { style: Object.assign({ background: dotColor }, S.dot) }),
            h('div', { style: S.rowBody },
              h('div', { style: S.nm },
                h('span', null, t.name),
                h('span', { style: Object.assign({}, S.badge, badgeStyle) }, badgeText)
              ),
              h('div', { style: S.sub }, meta),
              extra.length > 0 && h('div', { style: S.sub }, extra.join(' · ')),
              t.lastError && h('div', { style: S.err, title: t.lastError }, '最后错误：' + t.lastError),
              t.lastExit && !t.lastError && h('div', { style: S.sub }, '上次退出 code=' + t.lastExit.code + (t.lastExit.signal ? ' signal=' + t.lastExit.signal : ''))
            ),
            starting
              ? h('span', { style: Object.assign({}, S.btn, S.btnDisabled) }, '启动中…')
              : up
                ? h('button', { style: S.btn, onClick: function () { restart(t.id) }, title: '重启（先停再拉起）' }, '重启')
                : h('button', { style: S.btn, onClick: function () { start(t.id) }, title: '启动隧道' }, '启动'),
            up && h('button', { style: S.btn, onClick: function () { stop(t.id) }, title: '停止隧道' }, '停止')
          )
        )
      })
      return h('div', null,
        rows,
        error && h('div', { style: S.err }, error),
        h('div', { style: S.actions },
          h('button', { style: S.btn, onClick: refresh }, '刷新')
        ),
        data && data.connectHint ? h('div', { style: S.hint, title: data.connectHint }, '提示：' + data.connectHint) : null
      )
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        // 零全局副作用：不注入 <style>，全部行内样式
        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'ssh-tunnel', order: 115, label: 'SSH' },
            SshTunnelUtility
          )
        })
      },
    }
  },
})
