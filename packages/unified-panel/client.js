window.__ModuleLoader__.load({
  id: 'dsh-unified-panel',
  factory: require => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require('react');
    let h = react.createElement;

    const listeners = new Set();
    let open = false;
    let loading = false;
    let data = { rows: [], errors: [] };
    let remoteView = null;
    let hostCtx = null;
    const expanded = new Set();
    function notify() { for (const f of listeners) f(); }
    function useTick() { const [, set] = react.useState(0); react.useEffect(() => { const f = () => set(n => n + 1); listeners.add(f); return () => listeners.delete(f); }, []); return null; }

    async function refresh() {
      if (loading) return;
      loading = true; notify();
      try { const r = await fetch('/api/unified/sessions'); data = await r.json(); }
      catch (e) { data = { rows: [], errors: [String(e.message)] }; }
      loading = false; notify();
      rebuildFakes();
      republish();
    }
    // --- fake Sessions injected into the native Workspace tree -------------
    const fakes = new Map()
    const fakeWorkspaces = new Map()
    let injected = false
    function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'remote' }
    function fakeId(host, id) {
      let a = 2166136261, b = 0
      const text = host + '|' + id
      for (let i = 0; i < text.length; i++) { a ^= text.charCodeAt(i); a = Math.imul(a, 16777619); b = (Math.imul(b, 31) + text.charCodeAt(i)) | 0 }
      const hex = n => (n >>> 0).toString(16).padStart(8, '0')
      const h = hex(a) + hex(b)
      return 'session-' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32)
    }
    let fakesVersion = 0
    function rebuildFakes() {
      fakes.clear(); fakeWorkspaces.clear(); fakesVersion += 1
      for (const row of data.rows || []) {
        if (isLocalRow(row)) continue
        const host = row.host || '远端'
        const raw = String(row.cwd || row.project || '~').replace(/\/+$/, '')
        const segments = raw.split('/').filter(Boolean)
        const rootKey = host + '|'
        if (!fakeWorkspaces.has(rootKey)) {
          const digest = fakeId(host, '~').slice(-12)
          fakeWorkspaces.set(rootKey, { workspaceId: 'workspace-unified-' + digest, path: '/__unified__/' + digest, title: host, sessionIds: [], createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), sortKey: host + '|0' })
        }
        let nestedPath = fakeWorkspaces.get(rootKey).path
        for (let depth = 1; depth <= segments.length; depth++) {
          const prefix = segments.slice(0, depth).join('/')
          const key = host + '|' + prefix
          nestedPath = nestedPath + '/' + segments[depth - 1]
          if (!fakeWorkspaces.has(key)) {
            const digest = fakeId(host, prefix).slice(-12)
            fakeWorkspaces.set(key, { workspaceId: 'workspace-unified-' + digest, path: nestedPath, title: segments[depth - 1], sessionIds: [], createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), sortKey: host + '|' + String(depth).padStart(3, '0') + '|' + prefix })
          }
        }
        const workspace = fakeWorkspaces.get(host + '|' + segments.join('/')) || fakeWorkspaces.get(rootKey)
        const id = fakeId(host, row.id)
        row.fakeId = id
        workspace.sessionIds.push(id)
        fakes.set(id, {
          id, title: row.title || '', displayTitle: (row.title || '(无标题)'),
          cwd: workspace.path, running: row.state === 'running', blank: false,
          updatedAt: row.mtime, retainedBy: {},
        })
      }
    }
    function installFakes(ctx) {
      if (injected) return
      injected = true
      const sessions = ctx.sessions
      const workspaces = ctx.workspaces
      if (!sessions || !workspaces) return
      const sessionsGet = sessions.list.getSnapshot.bind(sessions.list)
      const workspacesGet = workspaces.list.getSnapshot.bind(workspaces.list)
      let sessionsCache = null, sessionsBase = null, sessionsVersion = -1
      let workspacesCache = null, workspacesBase = null, workspacesVersion = -1
      sessions.list.getSnapshot = () => {
        const snap = sessionsGet()
        if (!fakes.size) return snap
        if (sessionsCache !== null && sessionsBase === snap && sessionsVersion === fakesVersion) return sessionsCache
        const byId = Object.assign({}, snap.byId)
        for (const [id, row] of fakes) byId[id] = row
        sessionsCache = Object.assign({}, snap, { ids: [...fakes.keys(), ...snap.ids], byId })
        sessionsBase = snap; sessionsVersion = fakesVersion
        return sessionsCache
      }
      workspaces.list.getSnapshot = () => {
        const snap = workspacesGet()
        if (!fakeWorkspaces.size) return snap
        if (workspacesCache !== null && workspacesBase === snap && workspacesVersion === fakesVersion) return workspacesCache
        const fakesOrdered = [...fakeWorkspaces.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
        workspacesCache = Object.assign({}, snap, { items: [...snap.items, ...fakesOrdered] })
        workspacesBase = snap; workspacesVersion = fakesVersion
        return workspacesCache
      }
      const ui = ctx.uiWorkspace
      if (ui && ui.__unifiedPatched !== true) {
        const original = ui.openSession.bind(ui)
        ui.openSession = target => {
          const id = typeof target === 'string' ? target : String(target)
          if (fakes.has(id)) { openFake(id); return }
          return original(target)
        }
        ui.__unifiedPatched = true
      }
    }
    function republish() {
      if (!hostCtx) return
      installFakes(hostCtx)
      Promise.resolve().then(() => Promise.all([
        hostCtx.sessions && hostCtx.sessions.refresh ? hostCtx.sessions.refresh() : null,
        hostCtx.workspaces && hostCtx.workspaces.refresh ? hostCtx.workspaces.refresh() : null,
      ])).catch(() => {})
    }
    function ago(ms) { const s = (Date.now() - ms) / 1000; if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return Math.round(s / 3600) + 'h'; return Math.round(s / 86400) + 'd'; }

    /** host -> project -> rows, each level ordered by the newest session. */
    function tree() {
      const hosts = new Map();
      for (const r of data.rows || []) {
        const host = r.host || '?';
        const project = r.project || '~';
        if (!hosts.has(host)) hosts.set(host, new Map());
        const projects = hosts.get(host);
        if (!projects.has(project)) projects.set(project, []);
        projects.get(project).push(r);
      }
      const out = [];
      for (const [host, projects] of hosts) {
        const groups = [];
        let newest = 0;
        for (const [project, list] of projects) {
          list.sort((a, b) => b.mtime - a.mtime);
          groups.push({ project, rows: list });
          newest = Math.max(newest, list[0].mtime);
        }
        groups.sort((a, b) => b.rows[0].mtime - a.rows[0].mtime);
        out.push({ host, groups, newest });
      }
      out.sort((a, b) => b.newest - a.newest);
      return out;
    }

    function tag(state) {
      const map = { running: ['●', '#7bd88f'], approval: ['!', '#ff8686'], idle: ['·', '#7d8496'] };
      const [t, c] = map[state] || map.idle;
      return h('span', { style: { color: c, width: 12, display: 'inline-block', flex: 'none' } }, t);
    }
    function caret(open) { return h('span', { style: { width: 12, opacity: .7, flex: 'none' } }, open ? '▾' : '▸'); }

    function isLocalRow(row) { return row.local === true || row.host === 'local' }
    function openSession(row) {
      if (isLocalRow(row)) {
        try { hostCtx.uiWorkspace.openSession(row.id); open = false; notify(); }
        catch (e) { alert('打开本机会话失败: ' + e.message); }
        return;
      }
      const web = row.web;
      if (!web) { console.warn('unified-panel: no web.url for ' + row.host); return; }
      const base = String(web).replace(/\/$/, '');
      remoteView = {
        url: base + '/?embed=1&session=' + encodeURIComponent(String(row.id).replace(/^session-/, '')),
        title: row.title || '(无标题)',
        host: row.host || '?',
        project: row.project || '~',
      };
      open = false;
      try { hostCtx.layout.selectPanel('unified-remote'); } catch (e) { console.error('unified-panel: selectPanel failed', e); }
      notify();
    }

    function Leaf(r) {
      return h('div', {
        key: r.id,
        onClick: () => openSession(r),
        title: isLocalRow(r) ? '打开本机会话' : (r.web ? '在应用内打开远端会话' : '未配置 web 地址'),
        style: { display: 'flex', gap: 6, alignItems: 'baseline', padding: '4px 8px 4px 30px', cursor: 'pointer', background: r.state === 'approval' ? 'rgba(255,80,80,.08)' : 'transparent' },
      },
        tag(r.state),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 } }, r.title || '(无标题)'),
          h('div', { style: { fontSize: 10, opacity: .55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            ago(r.mtime) + (r.state === 'running' && r.tool ? ' · ' + r.tool : '') + (r.state === 'approval' && r.approval ? ' · ' + r.approval.tool : ''))));
    }

    function Tree() {
      useTick();
      if (loading && !(data.rows || []).length) return h('div', { style: { padding: 8, fontSize: 11, opacity: .6 } }, '刷新中…');
      const hosts = tree();
      const nodes = [];
      for (const host of hosts) {
        const hostOpen = expanded.has('h:' + host.host);
        nodes.push(h('div', {
          key: 'h:' + host.host,
          onClick: () => { const k = 'h:' + host.host; expanded.has(k) ? expanded.delete(k) : expanded.add(k); notify(); },
          style: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', cursor: 'pointer', fontWeight: 600, fontSize: 12 },
        }, caret(hostOpen), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, host.host),
           h('span', { style: { marginLeft: 'auto', opacity: .45, fontWeight: 400, fontSize: 10 } }, host.groups.reduce((n, g) => n + g.rows.length, 0))));
        if (!hostOpen) continue;
        for (const group of host.groups) {
          const gkey = 'g:' + host.host + '/' + group.project;
          const gOpen = expanded.has(gkey);
          nodes.push(h('div', {
            key: gkey,
            onClick: () => { expanded.has(gkey) ? expanded.delete(gkey) : expanded.add(gkey); notify(); },
            style: { display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px 3px 18px', cursor: 'pointer', fontSize: 11, opacity: .85 },
          }, caret(gOpen), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.project),
             h('span', { style: { marginLeft: 'auto', opacity: .5, fontSize: 10 } }, group.rows.length)));
          if (!gOpen) continue;
          for (const r of group.rows) nodes.push(Leaf(r));
        }
      }
      const errs = (data.errors || []).length ? h('div', { style: { padding: 8, fontSize: 10, color: '#ff9b9b' } }, data.errors.join('; ')) : null;
      return h('div', { style: { maxHeight: 320, overflow: 'auto', borderTop: '1px solid #23262e', marginTop: 4 } }, nodes, errs);
    }

    function Button() {
      useTick();
      return h('div', null,
        h('button', {
          onClick: () => { if (!open) refresh(); open = !open; notify(); },
          title: '所有设备 · 机器 / 工作区 / 会话',
          style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '5px 6px' },
        }, h('span', null, open ? '▾' : '▸'), h('span', null, '设备'),
           h('span', { style: { opacity: .5, marginLeft: 'auto' } }, (data.rows || []).length || '')),
        open ? h(Tree) : null);
    }

    /** Center panel that renders one remote Session through the Host's embed view. */
    function RemotePanel() {
      useTick();
      const rv = remoteView;
      if (!rv) return h('div', { style: { padding: 24, fontSize: 12, opacity: .7 } }, '没有选择远端会话');
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #23262e', fontSize: 12, flex: 'none' } },
          h('button', { onClick: () => { remoteView = null; try { hostCtx.layout.selectPanel(null); } catch {} notify(); }, style: { fontSize: 11 } }, '← 返回会话'),
          h('span', { style: { opacity: .75 } }, rv.host + ' / ' + rv.project),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, rv.title),
          h('span', { style: { flex: 1 } }),
          h('button', { onClick: () => { const f = document.querySelector('iframe[title="remote-session"]'); if (f) f.src = f.src; }, style: { fontSize: 11 } }, '重载')),
        h('iframe', { title: 'remote-session', src: rv.url, style: { flex: 1, border: 0, width: '100%', minHeight: 0, background: '#fff' }, allow: 'clipboard-read; clipboard-write' }));
    }

    function openFake(id) {
      for (const row of data.rows || []) {
        if (row.fakeId === id) {
          if (!row.web) { console.warn('unified-panel: fake session without web.url', row.host, row.id); return }
          const base = String(row.web).replace(/\/$/, '')
          remoteView = { url: base + '/?embed=1&session=' + encodeURIComponent(String(row.id).replace(/^session-/, '')), title: row.title || '(无标题)', host: row.host || '?', project: row.project || '~' }
          try { hostCtx.layout.selectPanel('unified-remote') } catch (e) { console.error('unified-panel: selectPanel failed', e) }
          notify()
          return
        }
      }
    }
    function installClickGuard() {
      if (window.__unifiedClickGuard) return
      window.__unifiedClickGuard = true
      document.addEventListener('click', event => {
        const row = event.target && event.target.closest ? event.target.closest('[data-row-key^="session:"]') : null
        if (!row) return
        const id = String(row.getAttribute('data-row-key')).slice('session:'.length)
        if (!fakes.has(id)) return
        event.preventDefault(); event.stopPropagation()
        openFake(id)
      }, true)
    }
    function apply(ctx) {
      hostCtx = ctx;
      installFakes(ctx);
      installClickGuard();
      setTimeout(() => { refresh() }, 0);
      setInterval(() => { if (!document.hidden) refresh() }, 120000);
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'unified-remote' }, RemotePanel));
    }
    exports.apply = apply;
    exports.inject = ['slots', 'layout', 'uiWorkspace', 'sessions', 'workspaces'];
    return module.exports;
  }
});