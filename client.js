window.__ModuleLoader__.load({
  id: 'dsh-utils',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Settings namespaces are the row ids the bundle's patch mounts; the bundle
    // page's configuration cell and each row's own page are keyed by the bundle
    // package name and by `${bundle}#${rowId}`.
    const BUNDLE = 'dsh-utils'
    const SKILL_NS = 'skill-recursive'
    const APPROVAL_NS = 'dsh-approval-policy'
    const NOTIFY_NS = 'dsh-notify'
    const ORIGINS = [
      ['subagent', '子智能体'],
      ['scheduled', '定时任务'],
      ['cron', 'cron 任务'],
      ['all', '全部审批'],
    ]

    const SKILL_FIELDS = [
      { key: 'minDepth', label: '最小深度', kind: 'number', min: 1, hint: '允许出现技能的第一个目录层级（相对技能根）。' },
      { key: 'maxDepth', label: '最大深度', kind: 'number', min: 1, hint: '最深扫描层级，不得小于最小深度。' },
      { key: 'watch', label: '监听变化', kind: 'boolean', hint: '技能文件变化后刷新技能目录。' },
      { key: 'debounceMs', label: '防抖（毫秒）', kind: 'number', min: 0, hint: '监听失效的合并间隔。' },
      { key: 'pollIntervalMs', label: '轮询间隔（毫秒）', kind: 'number', min: 250, hint: '不支持递归监听时的兜底间隔。' },
      { key: 'includeProjectRoots', label: '扫描项目根', kind: 'boolean', hint: '项目的 .dsh/skills 与 .agents/skills。' },
      { key: 'includeUserRoots', label: '扫描用户根', kind: 'boolean', hint: '用户级技能根。' },
      { key: 'followSymlinks', label: '跟随符号链接', kind: 'boolean', hint: '跟随符号链接目录，带环路保护。' },
      { key: 'extraRoots', label: '追加技能根', kind: 'lines', hint: '每行一个绝对路径。' },
      { key: 'ignoreDirs', label: '忽略的目录名', kind: 'lines', hint: '每行一个目录名，永不进入。' },
    ]

    const APPROVAL_FIELDS = [
      { key: 'origins', label: '门控来源', kind: 'origins', hint: '判定为无人值守的来源；“全部审批”是显式全门控。' },
      { key: 'sessions', label: '点名会话', kind: 'lines', hint: '按 agent id 的 glob 点名，命中即门控该会话所有轮次；每行一个。' },
      { key: 'windowSeconds', label: '应答窗口（秒）', kind: 'number', min: 0, max: 86400, hint: '0 = 立即拒绝且不询问下游。' },
      { key: 'defaultOutcome', label: '超时落定值', kind: 'select', options: [['rejected', '拒绝（rejected）'], ['unavailable', '下游不可用（unavailable）']], hint: '没有“本次放行”这一档：无人值守的默认裁决必须 fail-closed。' },
      { key: 'defaultPermissionPreset', label: '新会话权限档', kind: 'text', hint: '留空跟随部署默认；auto = 实验性自动审批（需对应 bundle）。' },
      { key: 'autoReviewContent', label: '回传复核内容', kind: 'boolean', hint: '窗口拒绝的是自动审批发起的请求时，把复核内容附进模型读到的工具结果。' },
    ]

    const REASONS = [
      ['completed', '完成'],
      ['error', '出错'],
      ['aborted', '被中止'],
      ['blocked', '被阻塞'],
    ]

    const NOTIFY_FIELDS = [
      { key: 'enabled', label: '启用', kind: 'boolean', hint: '总开关；关掉后本设备不发任何通知。' },
      { key: 'dryRun', label: '只记日志', kind: 'boolean', hint: '开启时只写日志不发消息，确认配置无误后再关闭。' },
      {
        key: 'transport', label: '出口', kind: 'select',
        options: [['gotify', 'Gotify 网关'], ['onebot', 'OneBot 直连（已废弃）']],
        hint: '默认走公网 Gotify 网关：任何能上网的设备都能发，不依赖本机 NapCat。',
      },
      { key: 'gotifyUrl', label: '网关地址', kind: 'text', hint: '如 https://notify.example.com；配了 targets 后忽略这一项。' },
      { key: 'gotifyToken', label: '网关 token', kind: 'text', hint: '该系列的 Gotify application token；敏感值建议走环境变量。' },
      { key: 'gotifyPriority', label: '默认优先级', kind: 'number', min: 0, hint: 'targets 没单独指定优先级时使用。' },
      { key: 'gotifyHeaders', label: '附加请求头', kind: 'json', empty: {}, hint: 'JSON 对象，用于反代 Basic Auth 等；X-Gotify-Key 始终以目标 token 为准。' },
      {
        key: 'targets', label: '多目标', kind: 'json', empty: [],
        hint: 'JSON 数组：[{"name":"qq-home","url":"https://…","token":"…","priority":3,"devices":["办公本"]}]；非空时忽略上面的单目标字段。',
      },
      { key: 'deviceName', label: '设备名', kind: 'text', hint: '留空取主机名；多设备区分的基础。' },
      { key: 'deviceLabel', label: '设备显示名', kind: 'text', hint: '渲染到 {device} 占位符；留空同设备名。' },
      { key: 'deviceInTitle', label: '标题带设备名', kind: 'boolean', hint: 'true 时 Gotify 标题加 [设备名] 前缀。' },
      { key: 'notifyOnReasons', label: '通知的结束原因', kind: 'checks', options: REASONS, hint: '至少选一个；全不选会回落默认的完成、出错、中止。' },
      { key: 'notifyOnApproval', label: '等待授权时通知', kind: 'boolean', hint: '审批请求挂起时推送；被自动裁决的不会打扰。' },
      { key: 'notifyOnQuestion', label: '等待回答时通知', kind: 'boolean', hint: 'ask_user_question / 计划确认挂起时推送。' },
      { key: 'questionDelayMs', label: '提问去抖（毫秒）', kind: 'number', min: 0, hint: '窗口内已在界面答复就取消推送。' },
      { key: 'approvalDelayMs', label: '审批去抖（毫秒）', kind: 'number', min: 0, hint: '窗口内已自动裁决就取消推送。' },
      { key: 'includeSubagents', label: '包含子会话', kind: 'boolean', hint: '默认只通知根会话，避免主会话 + N 个子会话连发。' },
      { key: 'summaryChars', label: '回复摘要长度', kind: 'number', min: 1, hint: '{reply} 纯文本化后的截断长度。' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', kind: 'number', min: 100, hint: '单次 HTTP 超时；失败自动重试一次。' },
      { key: 'traceFile', label: '诊断轨迹文件', kind: 'text', hint: '可选 JSONL 路径，排障用；留空不记录。' },
      { key: 'template', label: '会话结束模板', kind: 'textarea', hint: '占位符：{status} {kind} {sessionId} {cwd} {reply} {error} {device} {host} {date} {time}；空行删整行，留空用内置默认。' },
      { key: 'questionTemplate', label: '提问模板', kind: 'textarea', hint: '额外可用 {question} {detail} {options}。' },
      { key: 'approvalTemplate', label: '授权模板', kind: 'textarea', hint: '额外可用 {tool} {reason}。' },
    ]

    const STYLE = `
.dsu-root { display: grid; gap: 18px; padding: 4px 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsu-section { display: grid; gap: 12px; }
.dsu-section + .dsu-section { padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsu-sectionHead { display: grid; gap: 4px; }
.dsu-title { margin: 0; font-size: 14px; font-weight: 600; }
.dsu-hint { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsu-row { display: grid; gap: 6px; }
.dsu-check { grid-auto-flow: column; justify-content: start; align-items: center; gap: 8px; }
.dsu-label { color: var(--dsw-alias-label-secondary); }
.dsu-input { width: 100%; box-sizing: border-box; padding: 6px 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; font: inherit; }
.dsu-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsu-input:disabled { opacity: 0.6; }
.dsu-textarea { resize: vertical; min-height: 68px; }
.dsu-choices { display: flex; flex-wrap: wrap; gap: 12px; }
.dsu-actions { display: flex; align-items: center; gap: 10px; }
.dsu-save { padding: 6px 14px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 6px; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; cursor: pointer; }
.dsu-save:disabled { opacity: 0.6; cursor: default; }
.dsu-status { color: var(--dsw-alias-label-secondary); }
.dsu-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsu-error { margin: 0; color: var(--dsw-alias-label-error, #d9534f); font-size: 12px; }
`

    function splitLines(text) {
      return String(text).split('\n').map((line) => line.trim()).filter(Boolean)
    }

    function isList(value) {
      return Array.isArray(value)
    }

    /** Key-order-independent JSON text, for change detection on `json` fields. */
    function stable(value) {
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
      if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
      }
      return JSON.stringify(value)
    }

    /** Turn one component's stored value into editable draft text/booleans. */
    function toDraft(fields, value) {
      const draft = {}
      for (const field of fields) {
        const current = value?.[field.key]
        if (field.kind === 'number') draft[field.key] = current === undefined ? '' : String(current)
        else if (field.kind === 'boolean') draft[field.key] = current === true
        else if (field.kind === 'origins' || field.kind === 'checks') draft[field.key] = new Set(isList(current) ? current : [])
        else if (field.kind === 'lines') draft[field.key] = isList(current) ? current.join('\n') : ''
        else if (field.kind === 'json') {
          draft[field.key] = JSON.stringify(current === undefined ? (field.empty ?? {}) : current, null, 2)
        } else if (field.kind === 'textarea') draft[field.key] = current === undefined ? '' : String(current)
        else draft[field.key] = current === undefined ? '' : String(current)
      }
      return draft
    }

    /** Validate one draft into the value the Host schema accepts. */
    function parseDraft(fields, draft) {
      const next = {}
      for (const field of fields) {
        if (field.kind === 'number') {
          const raw = String(draft[field.key]).trim()
          if (raw === '') throw new Error(`“${field.label}”不能为空。`)
          const number = Number(raw)
          if (!Number.isInteger(number)) throw new Error(`“${field.label}”必须是整数。`)
          if (field.min !== undefined && number < field.min) throw new Error(`“${field.label}”不得小于 ${field.min}。`)
          if (field.max !== undefined && number > field.max) throw new Error(`“${field.label}”不得大于 ${field.max}。`)
          next[field.key] = number
        } else if (field.kind === 'boolean') {
          next[field.key] = draft[field.key] === true
        } else if (field.kind === 'origins') {
          const chosen = [...(draft[field.key] ?? [])]
          next[field.key] = ORIGINS.map(([id]) => id).filter((id) => chosen.includes(id))
        } else if (field.kind === 'checks') {
          const chosen = new Set(draft[field.key] ?? [])
          next[field.key] = field.options.map(([id]) => id).filter((id) => chosen.has(id))
        } else if (field.kind === 'lines') {
          next[field.key] = splitLines(draft[field.key])
        } else if (field.kind === 'json') {
          const raw = String(draft[field.key] ?? '').trim()
          if (raw === '') next[field.key] = field.empty ?? {}
          else {
            try {
              next[field.key] = JSON.parse(raw)
            } catch {
              throw new Error(`“${field.label}”不是合法 JSON。`)
            }
          }
        } else if (field.kind === 'textarea') {
          next[field.key] = String(draft[field.key] ?? '')
        } else if (field.kind === 'select') {
          const allowed = field.options.map(([id]) => id)
          const value = String(draft[field.key])
          if (!allowed.includes(value)) throw new Error(`“${field.label}”取值无效。`)
          next[field.key] = value
        } else {
          next[field.key] = String(draft[field.key]).trim()
        }
      }
      const minDepth = next.minDepth
      const maxDepth = next.maxDepth
      if (typeof minDepth === 'number' && typeof maxDepth === 'number' && maxDepth < minDepth) {
        throw new Error('“最大深度”不得小于“最小深度”。')
      }
      return next
    }

    /** Field-level operations for the entries whose values actually changed. */
    function changesOf(fields, next, current) {
      const ops = []
      for (const field of fields) {
        const before = current?.[field.key]
        const after = next[field.key]
        const changed = field.kind === 'json'
          ? stable(after) !== stable(before === undefined ? (field.empty ?? {}) : before)
          : field.kind === 'origins' || field.kind === 'checks' || field.kind === 'lines'
            ? JSON.stringify(after) !== JSON.stringify(Array.isArray(before) ? before : [])
            : after !== before
        if (changed) ops.push({ op: 'set', path: [field.key], value: after })
      }
      return ops
    }

    /** One component's configuration section: fields, validation, save. */
    function Section({ form, fields, title, intro }) {
      const state = form.getSnapshot()
      const [draft, setDraft] = React.useState(() => toDraft(fields, state.value))
      const [status, setStatus] = React.useState('')

      React.useEffect(() => {
        setDraft(toDraft(fields, state.value))
      }, [state.value])

      if (state.status === 'loading') return h('p', { className: 'dsu-note' }, '正在读取配置…')
      if (state.status === 'unavailable') return h('p', { className: 'dsu-note' }, '当前 dsh 版本没有向浏览器暴露这项配置。')

      const readOnly = state.writable !== true
      const update = (key, value) => {
        setStatus('')
        setDraft((current) => ({ ...current, [key]: value }))
      }
      const toggleOption = (key, id, checked) => {
        setStatus('')
        setDraft((current) => {
          const chosen = new Set(current[key])
          if (checked) chosen.add(id)
          else chosen.delete(id)
          return { ...current, [key]: chosen }
        })
      }
      const save = async () => {
        setStatus('保存中…')
        try {
          const ops = changesOf(fields, parseDraft(fields, draft), state.value ?? {})
          if (ops.length === 0) {
            setStatus('已保存')
            return
          }
          const accepted = await form.mutate(ops, state.revision)
          setStatus(accepted ? '已保存' : '宿主拒绝了这次修改。')
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error))
        }
      }

      return h('section', { className: 'dsu-section' }, [
        h('div', { className: 'dsu-sectionHead', key: 'head' }, [
          h('h4', { className: 'dsu-title', key: 'title' }, title),
          intro === undefined ? null : h('p', { className: 'dsu-hint', key: 'intro' }, intro),
        ]),
        ...fields.map((field) => renderField(field, draft, readOnly, update, toggleOption)),
        h('div', { className: 'dsu-actions', key: 'actions' }, [
          h('button', {
            className: 'dsu-save', key: 'save', type: 'button',
            disabled: readOnly || status === '保存中…', onClick: save,
          }, '保存'),
          status === '' ? null : h('span', { className: 'dsu-status', key: 'status', role: 'status' }, status),
        ]),
      ])
    }

    /** Render one field according to its kind. */
    function renderField(field, draft, readOnly, update, toggleOption) {
      const hint = field.hint === undefined ? null : h('span', { className: 'dsu-hint', key: 'hint' }, field.hint)
      if (field.kind === 'boolean') {
        return h('label', { className: 'dsu-row dsu-check', key: field.key }, [
          h('input', {
            key: 'input', type: 'checkbox', checked: draft[field.key] === true, disabled: readOnly,
            onChange: (event) => update(field.key, event.target.checked),
          }),
          h('span', { className: 'dsu-label', key: 'label' }, field.label),
          hint,
        ])
      }
      if (field.kind === 'origins') {
        const chosen = draft[field.key] ?? new Set()
        return h('div', { className: 'dsu-row', key: field.key }, [
          h('span', { className: 'dsu-label', key: 'label' }, field.label),
          h('div', { className: 'dsu-choices', key: 'choices' }, ORIGINS.map(([id, label]) => h('label', { className: 'dsu-check', key: id }, [
            h('input', {
              key: 'input', type: 'checkbox', checked: chosen.has(id), disabled: readOnly,
              onChange: (event) => toggleOption(field.key, id, event.target.checked),
            }),
            h('span', { className: 'dsu-label', key: 'label' }, label),
          ]))),
          hint,
        ])
      }
      if (field.kind === 'checks') {
        const chosen = draft[field.key] ?? new Set()
        return h('div', { className: 'dsu-row', key: field.key }, [
          h('span', { className: 'dsu-label', key: 'label' }, field.label),
          h('div', { className: 'dsu-choices', key: 'choices' }, field.options.map(([id, label]) => h('label', { className: 'dsu-check', key: id }, [
            h('input', {
              key: 'input', type: 'checkbox', checked: chosen.has(id), disabled: readOnly,
              onChange: (event) => toggleOption(field.key, id, event.target.checked),
            }),
            h('span', { className: 'dsu-label', key: 'label' }, label),
          ]))),
          hint,
        ])
      }
      if (field.kind === 'select') {
        return h('label', { className: 'dsu-row', key: field.key }, [
          h('span', { className: 'dsu-label', key: 'label' }, field.label),
          h('select', {
            className: 'dsu-input', key: 'input', value: draft[field.key] ?? '', disabled: readOnly,
            onChange: (event) => update(field.key, event.target.value),
          }, field.options.map(([id, label]) => h('option', { key: id, value: id }, label))),
          hint,
        ])
      }
      if (field.kind === 'lines') {
        return h('label', { className: 'dsu-row', key: field.key }, [
          h('span', { className: 'dsu-label', key: 'label' }, field.label),
          h('textarea', {
            className: 'dsu-input dsu-textarea', key: 'input', rows: 3, value: draft[field.key] ?? '', disabled: readOnly,
            onChange: (event) => update(field.key, event.target.value),
          }),
          hint,
        ])
      }
      if (field.kind === 'textarea' || field.kind === 'json') {
        return h('label', { className: 'dsu-row', key: field.key }, [
          h('span', { className: 'dsu-label', key: 'label' }, field.label),
          h('textarea', {
            className: 'dsu-input dsu-textarea', key: 'input',
            rows: field.kind === 'json' ? 5 : 4,
            value: draft[field.key] ?? '', disabled: readOnly,
            onChange: (event) => update(field.key, event.target.value),
          }),
          hint,
        ])
      }
      return h('label', { className: 'dsu-row', key: field.key }, [
        h('span', { className: 'dsu-label', key: 'label' }, field.label),
        h('input', {
          className: 'dsu-input', key: 'input',
          type: field.kind === 'number' ? 'number' : 'text',
          ...(field.kind === 'number' ? { min: field.min, max: field.max, step: 1 } : {}),
          value: draft[field.key] ?? '', disabled: readOnly,
          onChange: (event) => update(field.key, event.target.value),
        }),
        hint,
      ])
    }

    /** One component's own configuration page, opened from its row. */
    function RowPage(config) {
      return function ComponentPage() {
        return h('div', { className: 'dsu-root' }, [
          h('style', { key: 'style' }, STYLE),
          h(Section, {
            key: 'section', form: config.form, fields: config.fields,
            title: config.title, intro: config.intro,
          }),
        ])
      }
    }

    function apply(ctx) {
      const skillForm = ctx.configForms.get(SKILL_NS)
      const approvalForm = ctx.configForms.get(APPROVAL_NS)
      const notifyForm = ctx.configForms.get(NOTIFY_NS)
      ctx.effect(() => () => {
        skillForm.dispose()
        approvalForm.dispose()
        notifyForm.dispose()
      }, 'dsh-utils: configuration forms')
      const SkillRowPage = RowPage({
        form: skillForm, fields: SKILL_FIELDS,
        title: '递归技能发现',
        intro: '嵌套目录里的 SKILL.md 递归发现。改动即时生效，并写入 dsh 的配置文档。',
      })
      const ApprovalRowPage = RowPage({
        form: approvalForm, fields: APPROVAL_FIELDS,
        title: '无人值守审批门控',
        intro: '给 subagent／定时／cron 的审批请求设定应答窗口，超时按 fail-closed 落定。',
      })
      const NotifyRowPage = RowPage({
        form: notifyForm, fields: NOTIFY_FIELDS,
        title: '会话通知',
        intro: '会话结束、等待回答或等待授权时推送一条消息；出口是 Gotify 网关，多台设备共用一个 QQ 也能分清是谁。',
      })

      // Each component owns one page, keyed the way the Plugins page addresses a
      // row's configuration: `${bundle}#${rowId}`.
      ctx.effect(() => ctx.configForms.whileServed([SKILL_NS, APPROVAL_NS, NOTIFY_NS], (served) => {
        const offs = []
        if (served.has(SKILL_NS)) {
          offs.push(ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config', key: `${BUNDLE}#${SKILL_NS}`,
          }, SkillRowPage)))
        }
        if (served.has(APPROVAL_NS)) {
          offs.push(ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config', key: `${BUNDLE}#${APPROVAL_NS}`,
          }, ApprovalRowPage)))
        }
        if (served.has(NOTIFY_NS)) {
          offs.push(ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config', key: `${BUNDLE}#${NOTIFY_NS}`,
          }, NotifyRowPage)))
        }
        return () => {
          for (const off of offs) off()
        }
      }))
    }

    return {
      inject: ['slots', 'configForms'],
      apply,
    }
  },
})
