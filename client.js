/**
 * Browser half of `@xi4z/dsh-utils`, served from the root package: the
 * `utils-main` row is a package-root row and the package declares `dsh.client`,
 * so DSH's client-module scanner resolves this file from that row.
 *
 * Registers one configuration page per row and the sidebar skill /
 * skill-repository panels. Host routes come from `src/ui-host.ts`.
 */
window.__ModuleLoader__.load({
  id: '@xi4z/dsh-utils',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Settings namespaces are the row ids the bundle's patch mounts; the bundle
    // page's configuration cell and each row's own page are keyed by the bundle
    // package name and by `${bundle}#${rowId}`.
    const BUNDLE = '@xi4z/dsh-utils'
    const SKILL_NS = 'utils-main'
    const APPROVAL_NS = 'dsh-approval-policy'
    const NOTIFY_NS = 'dsh-notify'
    const SKILL_PANEL_NS = 'dsh-skill-panel'
    const WORKBENCH_NS = 'dsh-workbench'
    const WB_TAB = 'utils-workbench'
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

    const WORKBENCH_FIELDS = [
      { key: 'maxBytes', label: '单文件大小上限（字节）', kind: 'number', min: 1024, hint: '读取和写入都受这个上限约束；超过时面板会提示。' },
      { key: 'presetDirs', label: '额外预设目录', kind: 'lines', hint: '每行一个绝对路径；目录下每个子目录视为一个预设。' },
      { key: 'presetSourceDirs', label: '额外共享预设来源', kind: 'lines', hint: '每行一个技能仓库绝对路径；读取其 .dsh 下的预设供同步。' },
      { key: 'extraAgentsFiles', label: '额外 AGENTS 文件', kind: 'lines', hint: '全局视图额外列出的绝对路径；每行一个。' },
      { key: 'scanNestedAgents', label: '递归寻找嵌套 AGENTS.md', kind: 'boolean', hint: '在项目当前目录下继续向下寻找 AGENTS.md / CLAUDE.md。' },
      { key: 'nestedDepth', label: '嵌套扫描深度', kind: 'number', min: 1, hint: '递归寻找嵌套文件的目录深度。' },
      { key: 'defaultRepoUrl', label: '默认技能仓库', kind: 'text', hint: '新预设的仓库地址默认值。' },
      { key: 'defaultBranch', label: '默认仓库分支', kind: 'text', hint: '新预设的仓库分支默认值。' },
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

    /** Render an unknown error for a status line. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
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

    // -------------------------------------------------------- skills panel --
    //
    // The panel lists the Skill catalog the Host resolves for one Session (or
    // the default workspace when the row page opens it without a Session) and
    // turns each model-invocable row into one switch over the `dsh-skill-panel`
    // config namespace. A switch hides the Skill from the model catalog only;
    // /name still loads it manually, which is why the rest render as "仅手动".

    const PANEL_STYLE = `
.dsp-root { display: grid; align-content: start; gap: 12px; box-sizing: border-box; height: 100%; padding: 12px; overflow: auto; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsp-head { display: flex; align-items: center; gap: 8px; }
.dsp-title { margin: 0; font-size: 14px; font-weight: 600; }
.dsp-count { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsp-refresh { padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.dsp-refresh:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsp-refresh:disabled { opacity: 0.6; cursor: default; }
.dsp-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsp-list { display: grid; gap: 8px; }
.dsp-item { display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); }
.dsp-itemHead { display: flex; align-items: center; gap: 8px; }
.dsp-name { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsp-tag { padding: 0 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; }
.dsp-switch { margin-left: auto; width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.dsp-switch:disabled { cursor: default; opacity: 0.6; }
.dsp-desc { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.45; }
.dsp-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; word-break: break-all; }
.dsp-state { margin: 0; color: var(--dsw-alias-label-secondary); }
.dsp-error { margin: 0; color: var(--dsw-alias-label-error, #d9534f); font-size: 12px; }
.dsp-empty { display: grid; gap: 8px; justify-items: start; }
.dsp-host { display: grid; height: 100%; min-height: 0; }
`

    /** Normalize the Host's rows into something the list can trust, sorted by name. */
    function normalizeSkills(body) {
      const rows = body !== null && typeof body === 'object' && Array.isArray(body.skills) ? body.skills : []
      return rows
        .filter((row) => row !== null && typeof row === 'object' && typeof row.name === 'string' && row.name !== '')
        .map((row) => ({
          name: row.name,
          description: typeof row.description === 'string' ? row.description : '',
          source: typeof row.source === 'string' ? row.source : '',
          provider: typeof row.provider === 'string' ? row.provider : '',
          path: typeof row.path === 'string' ? row.path : '',
          modelInvocable: row.modelInvocable === true,
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    }

    /** The disabled list this form currently holds, or null when it cannot say. */
    function formDisabled(form) {
      if (!form || typeof form.getSnapshot !== 'function') return null
      let snapshot
      try {
        snapshot = form.getSnapshot()
      } catch {
        return null
      }
      const value = snapshot?.value
      if (value === null || typeof value !== 'object' || !Array.isArray(value.disabledSkills)) return null
      return value.disabledSkills.filter((name) => typeof name === 'string')
    }

    /** The next disabled array for one row switch, in canonical (sorted) order. */
    function nextDisabled(current, name, enabled) {
      const chosen = new Set(Array.isArray(current) ? current : [])
      if (enabled) chosen.delete(name)
      else chosen.add(name)
      return [...chosen].sort()
    }

    /** The Host's list URL; document.baseURI keeps a sub-path deployment working. */
    function skillPanelUrl(sessionId) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
        ? document.baseURI
        : 'http://localhost/'
      const url = new URL('api/dsh-utils/skill-panel/list', base)
      if (typeof sessionId === 'string' && sessionId !== '') {
        url.searchParams.set('sessionId', sessionId)
      }
      return url
    }

    /** GET one Session's skill catalog, mapping transport and HTTP failures to prose. */
    async function fetchSkillPanel(sessionId) {
      if (typeof fetch !== 'function') throw new Error('当前环境不支持网络请求。')
      let response
      try {
        response = await fetch(skillPanelUrl(sessionId), {
          method: 'GET', headers: { accept: 'application/json' },
        })
      } catch {
        throw new Error('无法连接宿主服务，请检查页面连接后重试。')
      }
      if (response.status === 401) throw new Error('登录状态已过期，请刷新页面后重试。')
      if (response.status === 404) {
        throw new Error('宿主还没有加载技能面板组件（HTTP 404）。请重启 dsh web；如果已重启，请在插件页确认 dsh-skill-panel 行已启用。')
      }
      if (!response.ok) {
        let detail = ''
        try {
          const body = await response.json()
          if (body !== null && typeof body === 'object' && typeof body.error === 'string') detail = body.error
        } catch {
          detail = ''
        }
        throw new Error('技能目录读取失败（HTTP ' + response.status + '）' + (detail === '' ? '' : '：' + detail))
      }
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error('技能目录返回了无法解析的数据。')
      }
      if (body === null || typeof body !== 'object') throw new Error('技能目录返回了无法识别的数据。')
      return { skills: normalizeSkills(body), body }
    }

    /** The Skill catalog panel shared by the right sidebar and the plugin row page. */
    function SkillPanel({ form, sessionId }) {
      // Every hook runs before the first early return: the panel renders a
      // loading, error, empty or populated branch on the same hook layout.
      const [status, setStatus] = React.useState('loading')
      const [skills, setSkills] = React.useState([])
      const [meta, setMeta] = React.useState({})
      const [error, setError] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const [disabled, setDisabled] = React.useState(() => formDisabled(form) ?? [])
      const [writing, setWriting] = React.useState('')
      const [saveError, setSaveError] = React.useState('')

      // The form's snapshot is the source of truth for the switches: it changes
      // when the Host folds a write back, including the rollback after a refusal.
      React.useEffect(() => {
        if (!form || typeof form.subscribe !== 'function') return undefined
        setDisabled(formDisabled(form) ?? [])
        return form.subscribe(() => setDisabled(formDisabled(form) ?? []))
      }, [])

      React.useEffect(() => {
        let cancelled = false
        setStatus('loading')
        setError('')
        fetchSkillPanel(sessionId).then((result) => {
          if (cancelled) return
          setSkills(result.skills)
          setMeta(result.body)
          // The Host's answer is only a fallback: while the config namespace is
          // served the form already carries the authoritative disabled list.
          if (formDisabled(form) === null) {
            const reported = Array.isArray(result.body.disabledSkills) ? result.body.disabledSkills : []
            setDisabled(reported.filter((name) => typeof name === 'string'))
          }
          setStatus('ready')
        }).catch((failure) => {
          if (cancelled) return
          setSkills([])
          setMeta({})
          setError(failure instanceof Error ? failure.message : String(failure))
          setStatus('error')
        })
        return () => {
          cancelled = true
        }
      }, [sessionId, reloadKey, form])

      const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : null
      const readOnly = snapshot === null || snapshot.writable !== true
      const unavailable = form === null || (snapshot !== null && snapshot.status === 'unavailable')
      const disabledSet = new Set(disabled)
      const reload = () => setReloadKey((key) => key + 1)

      const toggle = async (skill, enabled) => {
        if (!skill.modelInvocable || writing !== '') return
        if (!form || typeof form.set !== 'function') {
          setSaveError('当前 dsh 版本没有向浏览器暴露技能开关配置。')
          return
        }
        if (readOnly) {
          setSaveError('当前配置只读，无法修改开关。')
          return
        }
        const before = disabled
        const next = nextDisabled(before, skill.name, enabled)
        setSaveError('')
        setDisabled(next)
        setWriting(skill.name)
        try {
          const accepted = await form.set('disabledSkills', next)
          if (accepted === false) {
            setDisabled(before)
            setSaveError('宿主拒绝了这次修改，开关已还原。')
          }
        } catch (failure) {
          setDisabled(before)
          setSaveError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setWriting('')
        }
      }

      const visible = skills.filter((skill) => skill.modelInvocable && !disabledSet.has(skill.name)).length
      const children = [
        h('div', { className: 'dsp-head', key: 'head' }, [
          h('h3', { className: 'dsp-title', key: 'title' }, '技能'),
          status === 'ready' ? h('span', { className: 'dsp-count', key: 'count' }, '共 ' + skills.length + ' 个 · 模型可见 ' + visible) : null,
          h('button', {
            className: 'dsp-refresh', key: 'refresh', type: 'button',
            disabled: status === 'loading', onClick: reload,
          }, status === 'loading' ? '读取中…' : '刷新'),
        ]),
      ]

      if (typeof meta.cwd === 'string' && meta.cwd !== '') {
        children.push(h('p', { className: 'dsp-note', key: 'cwd' }, '工作目录：' + meta.cwd))
      } else if (typeof sessionId !== 'string' || sessionId === '') {
        children.push(h('p', { className: 'dsp-note', key: 'scope' }, '未绑定会话，显示默认工作目录的技能。'))
      }
      if (unavailable) {
        children.push(h('p', { className: 'dsp-note', key: 'config' }, '当前 dsh 版本没有向浏览器暴露技能开关配置，列表仍可查看。'))
      } else if (readOnly) {
        children.push(h('p', { className: 'dsp-note', key: 'config' }, '配置只读：开关改动不会写入。'))
      }

      if (status === 'loading') {
        children.push(h('p', { className: 'dsp-state', key: 'state' }, '正在读取技能目录…'))
      } else if (status === 'error') {
        children.push(h('div', { className: 'dsp-empty', key: 'state' }, [
          h('p', { className: 'dsp-error', key: 'error', role: 'alert' }, error),
          h('button', { className: 'dsp-refresh', key: 'retry', type: 'button', onClick: reload }, '重试'),
        ]))
      } else if (skills.length === 0) {
        children.push(h('div', { className: 'dsp-empty', key: 'state' }, [
          h('p', { className: 'dsp-note', key: 'empty' }, '当前没有可读取的技能。'),
          h('p', { className: 'dsp-note', key: 'hint' }, '技能从用户级与项目级技能根发现；添加 SKILL.md 后点“刷新”。'),
        ]))
      } else {
        children.push(h('div', { className: 'dsp-list', key: 'list' }, skills.map((skill) => {
          const enabled = !disabledSet.has(skill.name)
          const metaText = [skill.source, skill.provider].filter((part) => part !== '').join(' · ')
          return h('div', { className: 'dsp-item', key: skill.name, 'data-skill': skill.name }, [
            h('div', { className: 'dsp-itemHead', key: 'head' }, [
              h('span', { className: 'dsp-name', key: 'name' }, skill.name),
              skill.modelInvocable ? null : h('span', { className: 'dsp-tag', key: 'tag' }, '仅手动'),
              h('input', {
                className: 'dsp-switch', key: 'switch', type: 'checkbox',
                'data-skill': skill.name,
                checked: skill.modelInvocable ? enabled : false,
                disabled: !skill.modelInvocable || readOnly || writing !== '',
                'aria-label': skill.modelInvocable ? '模型可见：' + skill.name : skill.name + ' 仅手动可调用',
                onChange: (event) => {
                  toggle(skill, event.target.checked)
                },
              }),
            ]),
            skill.description === '' ? null : h('p', { className: 'dsp-desc', key: 'desc' }, skill.description),
            metaText === '' ? null : h('span', { className: 'dsp-meta', key: 'meta' }, metaText),
            skill.path === '' ? null : h('span', { className: 'dsp-meta', key: 'path', title: skill.path }, skill.path),
          ])
        })))
      }

      if (saveError !== '') {
        children.push(h('p', { className: 'dsp-error', key: 'saveError', role: 'status' }, saveError))
      }
      children.push(h('p', { className: 'dsp-note', key: 'foot' }, '关闭后该技能不再出现在模型技能目录中，仍可用“/名称”手动加载。'))
      return h('div', { className: 'dsp-root' }, children)
    }

    // ----------------------------------------------------- utils workbench --
    //
    // One sidebar tab replaces the former 技能 / 技能仓库 / Markdown cards.
    // A preset is one directory under ~/.dsh/.agent-presets; the workbench
    // lists that preset's skills, edits its Markdown, and syncs a Git skill
    // repository into its skills/ directory. The special global target edits
    // the user/project AGENTS.md chain.

    const GLOBAL_PRESET = '__global__'
    const WB_STYLE = [
      '.dswb-root { display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; height: 100%; min-height: 0; padding: 10px; overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 13px; }',
      '.dswb-host { display: grid; height: 100%; min-height: 0; }',
      '.dswb-head { display: flex; align-items: center; gap: 8px; }',
      '.dswb-title { margin: 0; font-size: 14px; font-weight: 600; }',
      '.dswb-count { color: var(--dsw-alias-label-secondary); font-size: 11px; }',
      '.dswb-refresh { margin-left: auto; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }',
      '.dswb-refresh:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.dswb-refresh:disabled { opacity: 0.6; cursor: default; }',
      '.dswb-presetBar { display: flex; align-items: center; gap: 6px; min-width: 0; }',
      '.dswb-select { flex: 1; min-width: 0; padding: 5px 7px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; font: inherit; font-size: 12px; }',
      '.dswb-paths { display: grid; gap: 2px; }',
      '.dswb-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; word-break: break-all; }',
      '.dswb-error { margin: 0; color: var(--dsw-alias-label-error, #d9534f); font-size: 11px; white-space: pre-wrap; }',
      '.dswb-ok { margin: 0; color: var(--dsw-alias-label-success, #2e7d32); font-size: 11px; }',
      '.dswb-tabs { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; }',
      '.dswb-tab { flex: 1; padding: 4px 6px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }',
      '.dswb-tab:hover { color: var(--dsw-alias-label-primary); }',
      '.dswb-tabActive { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 600; }',
      '.dswb-body { display: flex; flex: 1 1 auto; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; }',
      '.dswb-skill { display: grid; gap: 3px; padding: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }',
      '.dswb-skillHead { display: flex; align-items: center; gap: 6px; min-width: 0; }',
      '.dswb-skillName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }',
      '.dswb-badge { padding: 0 5px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 16px; white-space: nowrap; }',
      '.dswb-badgeOn { color: var(--dsw-alias-label-success, #2e7d32); border-color: currentColor; }',
      '.dswb-badgeOff { color: var(--dsw-alias-label-tertiary, #888); }',
      '.dswb-skillPath { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dswb-skillActions { display: flex; flex-wrap: wrap; gap: 6px; }',
      '.dswb-linkBtn { padding: 2px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; cursor: pointer; }',
      '.dswb-linkBtn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.dswb-linkBtn:disabled { opacity: 0.5; cursor: default; }',
      '.dswb-field { display: grid; gap: 4px; }',
      '.dswb-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }',
      '.dswb-input { width: 100%; box-sizing: border-box; padding: 5px 7px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; font: inherit; font-size: 12px; }',
      '.dswb-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.dswb-textarea { width: 100%; box-sizing: border-box; min-height: 56px; resize: vertical; padding: 6px 7px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dswb-check { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; }',
      '.dswb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }',
      '.dswb-btn { padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }',
      '.dswb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.dswb-btn:disabled { opacity: 0.55; cursor: default; }',
      '.dswb-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.dswb-fileBar { display: flex; align-items: center; gap: 6px; min-width: 0; }',
      '.dswb-filePath { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dswb-editor { flex: 1 1 auto; min-height: 150px; width: 100%; box-sizing: border-box; resize: none; padding: 7px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; tab-size: 2; }',
      '.dswb-editor:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.dswb-editor:disabled { opacity: 0.6; }',
      '.dswb-status { color: var(--dsw-alias-label-secondary); font-size: 10px; }',
      '.dswb-kv { display: grid; gap: 2px; padding: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }',
      '.dswb-empty { display: grid; gap: 6px; justify-items: start; }',
    ].join('\n')

    /** One string or ''. */
    function wbText(value) {
      return typeof value === 'string' ? value : ''
    }

    /** Normalize one file row. */
    function wbFile(row, fallback) {
      const value = row !== null && typeof row === 'object' ? row : {}
      const base = fallback !== null && typeof fallback === 'object' ? fallback : {}
      const pick = function (key, type) {
        if (typeof value[key] === type) return value[key]
        if (typeof base[key] === type) return base[key]
        return type === 'number' ? 0 : ''
      }
      return {
        id: wbText(value.id) || wbText(base.id),
        label: pick('label', 'string'),
        path: pick('path', 'string'),
        presetId: pick('presetId', 'string'),
        kind: wbText(value.kind) || wbText(base.kind) || 'reference',
        scope: pick('scope', 'string'),
        exists: value.exists === true,
        editable: value.editable === true,
        size: pick('size', 'number'),
        mtimeMs: typeof value.mtimeMs === 'number' ? value.mtimeMs : null,
      }
    }

    /** Normalize a files payload. */
    function wbFiles(body) {
      const rows = body !== null && typeof body === 'object' && Array.isArray(body.files) ? body.files : []
      return rows
        .filter(function (row) { return row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '' })
        .map(function (row) { return wbFile(row, null) })
    }

    /** Normalize one skill row. */
    function wbSkill(row) {
      const value = row !== null && typeof row === 'object' ? row : {}
      return {
        name: wbText(value.name),
        description: wbText(value.description),
        path: wbText(value.path),
        enabled: value.enabled === true,
        size: typeof value.size === 'number' ? value.size : 0,
        mtimeMs: typeof value.mtimeMs === 'number' ? value.mtimeMs : null,
      }
    }

    /** Normalize the list payload. */
    function wbPresets(body) {
      const rows = body !== null && typeof body === 'object' && Array.isArray(body.presets) ? body.presets : []
      return rows
        .filter(function (row) { return row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '' })
        .map(function (row) {
          return {
            id: row.id,
            name: wbText(row.name) || row.id,
            description: wbText(row.description),
            path: wbText(row.path),
            skills: Array.isArray(row.skills) ? row.skills.map(wbSkill) : [],
            agents: wbFile(row.agents, null),
            registered: row.registered === true,
            broken: wbText(row.broken),
          }
        })
    }

    /** Normalize the repository view. */
    function wbRepo(body) {
      const value = body !== null && typeof body === 'object' ? body : {}
      const state = value.state !== null && typeof value.state === 'object' ? value.state : {}
      const status = value.status !== null && typeof value.status === 'object' ? value.status : {}
      const key = value.key !== null && typeof value.key === 'object' ? value.key : {}
      return {
        state: {
          repoUrl: wbText(state.repoUrl),
          branch: wbText(state.branch),
          targetSubdir: wbText(state.targetSubdir),
          keyPath: wbText(state.keyPath),
          recurseSubmodules: state.recurseSubmodules !== false,
          lastSync: state.lastSync !== null && typeof state.lastSync === 'object' ? state.lastSync : null,
        },
        target: wbText(value.target),
        status: {
          exists: status.exists === true,
          isRepo: status.isRepo === true,
          branch: wbText(status.branch),
          commit: wbText(status.commit),
          dirty: status.dirty === true,
          skills: typeof status.skills === 'number' ? status.skills : 0,
        },
        key: {
          source: wbText(key.source) || 'none',
          hasStoredKey: key.hasStoredKey === true,
        },
      }
    }

    /** Editable repository draft. */
    function wbRepoDraft(repo) {
      if (repo === null || typeof repo !== 'object') return null
      return {
        repoUrl: repo.state.repoUrl,
        branch: repo.state.branch,
        targetSubdir: repo.state.targetSubdir,
        keyPath: repo.state.keyPath,
        recurseSubmodules: repo.state.recurseSubmodules,
      }
    }

    /** Normalize the shared skill repository view. */
    function wbSharedRepo(body) {
      const value = body !== null && typeof body === 'object' ? body : {}
      const state = value.state !== null && typeof value.state === 'object' ? value.state : {}
      const target = value.target !== null && typeof value.target === 'object' ? value.target : {}
      const key = value.key !== null && typeof value.key === 'object' ? value.key : {}
      return {
        state: {
          repoUrl: wbText(state.repoUrl),
          branch: wbText(state.branch),
          targetDir: wbText(state.targetDir),
          keyPath: wbText(state.keyPath),
          recurseSubmodules: state.recurseSubmodules !== false,
          lastSync: state.lastSync !== null && typeof state.lastSync === 'object' ? state.lastSync : null,
        },
        target: {
          exists: target.exists === true,
          isRepo: target.isRepo === true,
          branch: wbText(target.branch),
          commit: wbText(target.commit),
          dirty: target.dirty === true,
          skills: typeof target.skills === 'number' ? target.skills : 0,
        },
        key: {
          source: wbText(key.source) || 'none',
          hasStoredKey: key.hasStoredKey === true,
        },
      }
    }

    /** Editable shared repository draft. */
    function wbSharedRepoDraft(view) {
      if (view === null || typeof view !== 'object') return null
      return {
        repoUrl: view.state.repoUrl,
        branch: view.state.branch,
        targetDir: view.state.targetDir,
        keyPath: view.state.keyPath,
        recurseSubmodules: view.state.recurseSubmodules,
      }
    }

    /** Normalize the shared-preset status. */
    function wbSharedStatus(value) {
      return value === 'new' || value === 'update' || value === 'same' || value === 'invalid' ? value : 'invalid'
    }

    /** Normalize one shared preset row. */
    function wbSharedPreset(row) {
      const value = row !== null && typeof row === 'object' ? row : {}
      return {
        id: wbText(value.id),
        name: wbText(value.name) || wbText(value.id),
        description: wbText(value.description),
        status: wbSharedStatus(value.status),
        sourceKind: wbText(value.sourceKind) || 'extra',
        sourceRoot: wbText(value.sourceRoot),
        sourcePath: wbText(value.sourcePath),
        targetPath: wbText(value.targetPath),
        skills: typeof value.skills === 'number' ? value.skills : 0,
        files: typeof value.files === 'number' ? value.files : 0,
        managed: value.managed === true,
        lastSyncAt: wbText(value.lastSyncAt),
        reason: wbText(value.reason),
      }
    }

    /** Normalize the shared-preset view. */
    function wbShared(body) {
      const value = body !== null && typeof body === 'object' ? body : {}
      const rows = Array.isArray(value.sources) ? value.sources : []
      return {
        localRoot: wbText(value.localRoot),
        sources: rows
          .filter(function (row) { return row !== null && typeof row === 'object' })
          .map(function (row) {
            return {
              path: wbText(row.path),
              kind: wbText(row.kind) || 'extra',
              exists: row.exists === true,
              presets: (Array.isArray(row.presets) ? row.presets : [])
                .map(wbSharedPreset)
                .filter(function (preset) { return preset.id !== '' }),
            }
          }),
      }
    }

    /** Human-readable shared preset status. */
    function wbSharedStatusText(status) {
      if (status === 'new') return '本地未安装'
      if (status === 'update') return '有更新'
      if (status === 'same') return '已同步'
      return '无法同步'
    }

    /** Human-readable shared source kind. */
    function wbSharedKindText(kind) {
      if (kind === 'preset-repo') return '预设技能仓库'
      if (kind === 'global-repo') return '共享技能仓库'
      if (kind === 'skills-home') return '$DSH_HOME/skills'
      return '额外来源'
    }

    /** Host URL for one workbench action. */
    function wbUrl(action, params) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
        ? document.baseURI
        : 'http://localhost/'
      const url = new URL('api/dsh-utils/workbench/' + action, base)
      const values = params !== null && typeof params === 'object' ? params : {}
      Object.keys(values).forEach(function (key) {
        const value = values[key]
        if (typeof value === 'string' && value !== '') url.searchParams.set(key, value)
      })
      return url
    }

    /** One Host request with prose errors. */
    async function wbRequest(action, options) {
      if (typeof fetch !== 'function') throw new Error('当前环境不支持网络请求。')
      const request = options !== null && typeof options === 'object' ? options : {}
      const url = wbUrl(action, request.params)
      const init = { headers: { accept: 'application/json' } }
      if (request.body !== undefined) {
        init.method = 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(request.body)
      }
      let response
      try {
        response = await fetch(url.toString(), init)
      } catch (error) {
        throw new Error('无法连接宿主服务，请检查页面连接后重试。')
      }
      if (response.status === 401) throw new Error('登录状态已过期，请刷新页面后重试。')
      if (response.status === 404) {
        throw new Error('宿主还没有加载 Utils 工作台组件（HTTP 404）。请重启 dsh web；如果已重启，请在插件页确认 dsh-workbench 行已启用。')
      }
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      if (!response.ok) {
        const detail = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : ''
        const failure = new Error('Utils 请求失败（HTTP ' + response.status + '）' + (detail === '' ? '' : '：' + detail))
        failure.status = response.status
        throw failure
      }
      if (body === null || typeof body !== 'object') throw new Error('Utils 返回了无法解析的数据。')
      return body
    }

    /** Whether one file has an unsaved draft. */
    function wbDirty(drafts, baseline, id) {
      if (!Object.prototype.hasOwnProperty.call(drafts, id)) return false
      if (!Object.prototype.hasOwnProperty.call(baseline, id)) return false
      return drafts[id] !== baseline[id]
    }

    /** Human-readable last sync. */
    function wbSyncText(record) {
      if (record === null || typeof record !== 'object') return '尚未同步'
      const commit = wbText(record.commit)
      const parts = [
        wbText(record.at) || '未知时间',
        record.ok === true ? '成功' : '失败',
        'commit ' + (commit === '' ? '-' : commit.slice(0, 7)),
        '技能 ' + (typeof record.skills === 'number' ? record.skills : 0),
      ]
      if (wbText(record.message) !== '') parts.push(wbText(record.message))
      return parts.join(' · ')
    }

    /** The unified Utils panel. */
    function Workbench({ sessionId }) {
      const [status, setStatus] = React.useState('loading')
      const [data, setData] = React.useState(null)
      const [selectedId, setSelectedId] = React.useState('')
      const [view, setView] = React.useState('skills')
      const [files, setFiles] = React.useState([])
      const [filesState, setFilesState] = React.useState('idle')
      const [selectedFileId, setSelectedFileId] = React.useState('')
      const [drafts, setDrafts] = React.useState({})
      const [baseline, setBaseline] = React.useState({})
      const [readState, setReadState] = React.useState('idle')
      const [saving, setSaving] = React.useState(false)
      const [repo, setRepo] = React.useState(null)
      const [repoState, setRepoState] = React.useState('idle')
      const [repoDraft, setRepoDraft] = React.useState(null)
      const [shared, setShared] = React.useState(null)
      const [sharedState, setSharedState] = React.useState('idle')
      const [sharedKey, setSharedKey] = React.useState(0)
      const [pruneShared, setPruneShared] = React.useState(false)
      const [sharedRepo, setSharedRepo] = React.useState(null)
      const [sharedRepoState, setSharedRepoState] = React.useState('idle')
      const [sharedRepoDraft, setSharedRepoDraft] = React.useState(null)
      const [sharedRepoKeyDraft, setSharedRepoKeyDraft] = React.useState('')
      const [keyDraft, setKeyDraft] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const [filesKey, setFilesKey] = React.useState(0)

      React.useEffect(function () {
        let cancelled = false
        setStatus('loading')
        setError('')
        wbRequest('list', { params: { sessionId: sessionId } }).then(function (body) {
          if (cancelled) return
          const presets = wbPresets(body)
          setData({
            presets: presets,
            global: body.global !== null && typeof body.global === 'object' ? body.global : null,
            cwd: wbText(body.cwd),
            sessionPreset: wbText(body.sessionPreset),
            defaultPresetId: wbText(body.defaultPresetId),
          })
          setStatus('ready')
          setSelectedId(function (current) {
            if (current === GLOBAL_PRESET || presets.some(function (preset) { return preset.id === current })) return current
            const preferred = wbText(body.defaultPresetId)
            if (preferred === GLOBAL_PRESET || presets.some(function (preset) { return preset.id === preferred })) return preferred
            return presets[0] !== undefined ? presets[0].id : GLOBAL_PRESET
          })
        }).catch(function (failure) {
          if (cancelled) return
          setStatus('error')
          setData(null)
          setError(messageOf(failure))
        })
        return function () { cancelled = true }
      }, [sessionId, reloadKey])

      React.useEffect(function () {
        if (selectedId === '') return undefined
        let cancelled = false
        setFiles([])
        setSelectedFileId('')
        setFilesState('loading')
        wbRequest('files', { params: { presetId: selectedId, sessionId: sessionId } }).then(function (body) {
          if (cancelled) return
          const rows = wbFiles(body)
          setFiles(rows)
          setFilesState('ready')
          setSelectedFileId(function (current) {
            if (current !== '' && rows.some(function (file) { return file.id === current })) return current
            return rows[0] !== undefined ? rows[0].id : ''
          })
        }).catch(function (failure) {
          if (cancelled) return
          setFiles([])
          setFilesState('error')
          setError(messageOf(failure))
        })
        return function () { cancelled = true }
      }, [selectedId, sessionId, filesKey, reloadKey])

      React.useEffect(function () {
        if (selectedId === '' || selectedId === GLOBAL_PRESET) {
          setRepo(null)
          setRepoDraft(null)
          setRepoState('idle')
          return undefined
        }
        let cancelled = false
        setRepoState('loading')
        wbRequest('repo', { params: { presetId: selectedId } }).then(function (body) {
          if (cancelled) return
          const normalized = wbRepo(body)
          setRepo(normalized)
          setRepoDraft(wbRepoDraft(normalized))
          setRepoState('ready')
        }).catch(function (failure) {
          if (cancelled) return
          setRepoState('error')
          setRepo(null)
          setRepoDraft(null)
          setError(messageOf(failure))
        })
        return function () { cancelled = true }
      }, [selectedId, reloadKey])

      React.useEffect(function () {
        if (selectedId === '' || selectedId === GLOBAL_PRESET) {
          setShared(null)
          setSharedState('idle')
          return undefined
        }
        let cancelled = false
        setSharedState('loading')
        wbRequest('shared', { params: { presetId: selectedId } }).then(function (body) {
          if (cancelled) return
          setShared(wbShared(body))
          setSharedState('ready')
        }).catch(function (failure) {
          if (cancelled) return
          setShared(null)
          setSharedState('error')
          setError(messageOf(failure))
        })
        return function () { cancelled = true }
      }, [selectedId, sharedKey, reloadKey])

      React.useEffect(function () {
        if (selectedId === '' || selectedId === GLOBAL_PRESET) {
          setSharedRepo(null)
          setSharedRepoDraft(null)
          setSharedRepoState('idle')
          return undefined
        }
        let cancelled = false
        setSharedRepoState('loading')
        wbRequest('shared-repo', {}).then(function (body) {
          if (cancelled) return
          const view = wbSharedRepo(body)
          setSharedRepo(view)
          setSharedRepoDraft(wbSharedRepoDraft(view))
          setSharedRepoState('ready')
        }).catch(function (failure) {
          if (cancelled) return
          setSharedRepo(null)
          setSharedRepoDraft(null)
          setSharedRepoState('error')
          setError(messageOf(failure))
        })
        return function () { cancelled = true }
      }, [selectedId, sharedKey, reloadKey])

      React.useEffect(function () {
        if (selectedFileId === '') {
          setReadState('idle')
          return undefined
        }
        let cancelled = false
        setReadState('reading')
        wbRequest('file', { params: { id: selectedFileId, sessionId: sessionId } }).then(function (body) {
          if (cancelled) return
          const content = typeof body.content === 'string' ? body.content : ''
          setBaseline(function (previous) {
            const next = Object.assign({}, previous)
            next[selectedFileId] = content
            return next
          })
          setDrafts(function (previous) {
            if (Object.prototype.hasOwnProperty.call(previous, selectedFileId)) return previous
            const next = Object.assign({}, previous)
            next[selectedFileId] = content
            return next
          })
          const nextFile = wbFile(body.file, null)
          if (nextFile.id !== '') {
            setFiles(function (previous) {
              return previous.map(function (file) { return file.id === selectedFileId ? nextFile : file })
            })
          }
          setReadState('ready')
        }).catch(function (failure) {
          if (cancelled) return
          setReadState('error')
          setError(messageOf(failure))
        })
        return function () { cancelled = true }
      }, [selectedFileId, sessionId, reloadKey])

      const presets = data !== null && Array.isArray(data.presets) ? data.presets : []
      const isGlobal = selectedId === GLOBAL_PRESET
      const preset = isGlobal ? null : presets.find(function (item) { return item.id === selectedId }) || null
      const currentFile = files.find(function (file) { return file.id === selectedFileId }) || null
      const baselineText = Object.prototype.hasOwnProperty.call(baseline, selectedFileId) ? baseline[selectedFileId] : ''
      const draftText = Object.prototype.hasOwnProperty.call(drafts, selectedFileId) ? drafts[selectedFileId] : baselineText
      const dirty = readState === 'ready' && draftText !== baselineText
      const editable = currentFile !== null && currentFile.editable && readState === 'ready'
      const targetName = isGlobal ? '全局 / 项目' : preset !== null ? preset.name : selectedId
      const presetStatus = isGlobal || preset === null
        ? ''
        : preset.broken !== '' ? ' · 加载失败'
          : preset.registered ? ' · 已注册到 DSH'
            : ' · 未注册到 DSH'
      const sessionPreset = data !== null ? wbText(data.sessionPreset) : ''
      const sessionNote = sessionPreset === ''
        ? ''
        : sessionPreset === selectedId
          ? ' · 当前会话预设'
          : presets.some(function (item) { return item.id === sessionPreset }) ? '' : ' · 当前会话预设 ' + sessionPreset + ' 不是目录式预设'
      const skills = preset !== null ? preset.skills : []
      const enabledSkills = skills.filter(function (skill) { return skill.enabled }).length

      const refresh = function () {
        setError('')
        setNotice('')
        setReloadKey(function (key) { return key + 1 })
      }

      const selectPreset = function (id) {
        setSelectedId(id)
        setView(id === GLOBAL_PRESET ? 'markdown' : 'skills')
        setKeyDraft('')
        setError('')
        setNotice('')
      }

      const openFile = function (id) {
        setView('markdown')
        setSelectedFileId(id)
        setError('')
        setNotice('')
      }

      const updateDraft = function (value) {
        setDrafts(function (previous) {
          const next = Object.assign({}, previous)
          next[selectedFileId] = value
          return next
        })
        setNotice('')
      }

      const save = async function () {
        if (currentFile === null || saving || readState !== 'ready' || !currentFile.editable) return
        setSaving(true)
        setError('')
        setNotice('')
        try {
          const result = await wbRequest('file', {
            body: {
              sessionId: sessionId,
              id: selectedFileId,
              content: draftText,
              baseMtimeMs: currentFile.exists ? currentFile.mtimeMs : null,
            },
          })
          const nextContent = draftText
          setBaseline(function (previous) {
            const next = Object.assign({}, previous)
            next[selectedFileId] = nextContent
            return next
          })
          const nextFile = wbFile(result.file, currentFile)
          if (nextFile.id !== '') {
            setFiles(function (previous) {
              return previous.map(function (file) { return file.id === selectedFileId ? nextFile : file })
            })
          }
          setNotice('已保存 · ' + new Date().toLocaleTimeString())
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setSaving(false)
        }
      }

      const reset = function () {
        if (!dirty) return
        setDrafts(function (previous) {
          const next = Object.assign({}, previous)
          next[selectedFileId] = baselineText
          return next
        })
        setNotice('')
      }

      const toggleSkill = async function (skill) {
        if (busy !== '' || preset === null) return
        setBusy('skill:' + skill.path)
        setError('')
        setNotice('')
        try {
          const result = await wbRequest('skill', {
            body: { presetId: preset.id, path: skill.path, enabled: !skill.enabled },
          })
          const updated = wbSkill(result.skill)
          setData(function (previous) {
            if (previous === null) return previous
            return {
              ...previous,
              presets: previous.presets.map(function (item) {
                if (item.id !== preset.id) return item
                return {
                  ...item,
                  skills: item.skills.map(function (candidate) {
                    return candidate.path === skill.path ? updated : candidate
                  }),
                }
              }),
            }
          })
          setNotice(updated.enabled ? '已启用 ' + updated.name : '已关闭 ' + updated.name)
          setFilesKey(function (key) { return key + 1 })
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const openSkill = function (skill) {
        const found = files.find(function (file) { return file.label === skill.path })
        if (found !== undefined) {
          openFile(found.id)
          return
        }
        setView('markdown')
        setNotice('文件列表还没有这个技能，点“刷新”后再试。')
      }

      const setRepoField = function (key, value) {
        setRepoDraft(function (previous) {
          if (previous === null) return previous
          const next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      const saveRepo = async function () {
        if (preset === null || repoDraft === null || busy !== '') return
        setBusy('repo')
        setError('')
        setNotice('')
        try {
          const result = await wbRequest('repo', {
            body: {
              presetId: preset.id,
              repoUrl: repoDraft.repoUrl,
              branch: repoDraft.branch,
              targetSubdir: repoDraft.targetSubdir,
              keyPath: repoDraft.keyPath,
              recurseSubmodules: repoDraft.recurseSubmodules,
            },
          })
          const normalized = wbRepo(result)
          setRepo(normalized)
          setRepoDraft(wbRepoDraft(normalized))
          setNotice('仓库设置已保存')
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const saveKey = async function (clear) {
        if (preset === null || busy !== '') return
        setBusy('key')
        setError('')
        setNotice('')
        try {
          const result = await wbRequest('key', {
            body: { presetId: preset.id, key: clear ? '' : keyDraft },
          })
          setKeyDraft('')
          setRepo(function (previous) {
            return previous === null ? previous : { ...previous, key: result.key }
          })
          setNotice(clear || result.key.source !== 'stored' ? 'Deploy Key 已清除' : 'Deploy Key 已保存')
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const syncNow = async function () {
        if (preset === null || busy !== '') return
        setBusy('sync')
        setError('')
        setNotice('')
        try {
          const result = await wbRequest('sync', { body: { presetId: preset.id } })
          const normalized = wbRepo(result)
          setRepo(normalized)
          setRepoDraft(wbRepoDraft(normalized))
          setNotice('同步完成：' + wbSyncText(normalized.state.lastSync))
          setReloadKey(function (key) { return key + 1 })
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const syncShared = async function (ids) {
        if (preset === null || busy !== '') return
        setBusy('shared')
        setError('')
        setNotice('')
        try {
          const result = await wbRequest('shared-sync', {
            body: { presetId: preset.id, ids: ids === null ? [] : ids, prune: pruneShared },
          })
          setShared(wbShared(result.view))
          const rows = Array.isArray(result.results) ? result.results : []
          let written = 0
          let removed = 0
          const failed = []
          rows.forEach(function (row) {
            const value = row !== null && typeof row === 'object' ? row : {}
            written += typeof value.written === 'number' ? value.written : 0
            removed += typeof value.removed === 'number' ? value.removed : 0
            if (typeof value.error === 'string' && value.error !== '') failed.push(wbText(value.id) + '：' + value.error)
          })
          if (failed.length > 0) setError('部分预设同步失败：' + failed.join('；'))
          else setNotice('预设同步完成：写入 ' + written + ' 个文件' + (removed > 0 ? '，删除 ' + removed + ' 个' : ''))
          setReloadKey(function (key) { return key + 1 })
          setSharedKey(function (key) { return key + 1 })
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const setSharedRepoField = function (key, value) {
        setSharedRepoDraft(function (previous) {
          if (previous === null) return previous
          const next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      const applySharedRepo = function (body) {
        const view = wbSharedRepo(body)
        setSharedRepo(view)
        setSharedRepoDraft(wbSharedRepoDraft(view))
        return view
      }

      const saveSharedRepo = async function () {
        if (sharedRepoDraft === null || busy !== '') return
        setBusy('shared-repo')
        setError('')
        setNotice('')
        try {
          const result = await wbRequest('shared-repo', {
            body: {
              repoUrl: sharedRepoDraft.repoUrl,
              branch: sharedRepoDraft.branch,
              targetDir: sharedRepoDraft.targetDir,
              keyPath: sharedRepoDraft.keyPath,
              recurseSubmodules: sharedRepoDraft.recurseSubmodules,
            },
          })
          applySharedRepo(result)
          setNotice('共享技能仓库设置已保存')
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const saveSharedRepoKey = async function (clear) {
        if (busy !== '') return
        setBusy('shared-key')
        setError('')
        setNotice('')
        try {
          const result = await wbRequest('shared-key', { body: { key: clear ? '' : sharedRepoKeyDraft } })
          setSharedRepoKeyDraft('')
          const view = applySharedRepo(result)
          setNotice(clear || view.key.source !== 'stored' ? '共享仓库 Deploy Key 已清除' : '共享仓库 Deploy Key 已保存')
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const pullSharedRepo = async function () {
        if (busy !== '') return
        setBusy('shared-pull')
        setError('')
        setNotice('')
        try {
          const view = applySharedRepo(await wbRequest('shared-pull', { body: {} }))
          setNotice('共享技能仓库拉取完成：' + wbSyncText(view.state.lastSync))
          setReloadKey(function (key) { return key + 1 })
          setSharedKey(function (key) { return key + 1 })
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const children = [
        h('div', { className: 'dswb-head', key: 'head' }, [
          h('h3', { className: 'dswb-title', key: 'title' }, 'Utils'),
          data !== null ? h('span', { className: 'dswb-count', key: 'count' }, presets.length + ' 个预设') : null,
          h('button', {
            className: 'dswb-refresh', key: 'refresh', type: 'button',
            disabled: status === 'loading', onClick: refresh,
          }, status === 'loading' ? '读取中…' : '刷新'),
        ]),
      ]

      if (status === 'loading') {
        children.push(h('p', { className: 'dswb-note', key: 'loading' }, '正在读取预设…'))
      } else if (status === 'error') {
        children.push(h('div', { className: 'dswb-empty', key: 'listError' }, [
          h('p', { className: 'dswb-error', key: 'error', role: 'alert' }, error),
          h('button', { className: 'dswb-refresh', key: 'retry', type: 'button', onClick: refresh }, '重试'),
        ]))
      } else if (data !== null) {
        const options = presets.map(function (item) {
          return h('option', { key: item.id, value: item.id }, item.name + '（' + item.id + '）')
        })
        options.push(h('option', { key: GLOBAL_PRESET, value: GLOBAL_PRESET }, '全局 / 项目 AGENTS.md'))
        children.push(h('div', { className: 'dswb-presetBar', key: 'presetBar' }, [
          h('select', {
            className: 'dswb-select', key: 'select', value: selectedId,
            'aria-label': '选择预设', onChange: function (event) { selectPreset(event.target.value) },
          }, options),
        ]))
        const selectedPath = isGlobal ? data.cwd : preset !== null ? preset.path : ''
        children.push(h('div', { className: 'dswb-paths', key: 'paths' }, [
          h('p', { className: 'dswb-note', key: 'target' }, targetName + presetStatus + sessionNote),
          selectedPath === '' ? null : h('p', { className: 'dswb-note', key: 'path', title: selectedPath }, selectedPath),
          isGlobal || preset === null || preset.broken === '' ? null : h('p', { className: 'dswb-error', key: 'broken', role: 'alert' }, preset.broken),
        ]))

        if (!isGlobal && preset !== null) {
          const sharedCount = shared === null ? 0 : shared.sources.reduce(function (total, source) {
            return total + source.presets.filter(function (item) { return item.status !== 'same' }).length
          }, 0)
          const tabs = [
            ['skills', '技能 · ' + enabledSkills + '/' + skills.length],
            ['markdown', 'Markdown'],
            ['repo', '技能仓库'],
            ['shared', '预设同步' + (sharedCount > 0 ? ' · ' + sharedCount : '')],
          ]
          children.push(h('div', { className: 'dswb-tabs', key: 'tabs' }, tabs.map(function (tab) {
            return h('button', {
              key: tab[0], type: 'button',
              className: 'dswb-tab' + (view === tab[0] ? ' dswb-tabActive' : ''),
              onClick: function () { setView(tab[0]); setError(''); setNotice('') },
            }, tab[1])
          })))
        }

        const body = []
        if (isGlobal || view === 'markdown') {
          if (filesState === 'loading') {
            body.push(h('p', { className: 'dswb-note', key: 'filesLoading' }, '正在读取 Markdown 文件…'))
          } else if (files.length === 0) {
            body.push(h('p', { className: 'dswb-note', key: 'filesEmpty' }, '这个目标下没有 Markdown 文件。'))
          } else {
            body.push(h('select', {
              className: 'dswb-select', key: 'fileSelect', value: selectedFileId,
              'aria-label': '选择 Markdown 文件', onChange: function (event) { openFile(event.target.value) },
            }, files.map(function (file) {
              return h('option', { key: file.id, value: file.id }, file.label + (file.exists ? '' : '（未创建）'))
            })))
            if (currentFile !== null) {
              body.push(h('div', { className: 'dswb-fileBar', key: 'fileBar' }, [
                h('span', { className: 'dswb-filePath', key: 'path', title: currentFile.path }, currentFile.path),
                currentFile.exists ? null : h('span', { className: 'dswb-badge', key: 'new' }, '新文件'),
                currentFile.editable ? null : h('span', { className: 'dswb-badge', key: 'readonly' }, '不可写'),
                wbDirty(drafts, baseline, selectedFileId) ? h('span', { className: 'dswb-badge dswb-badgeOn', key: 'dirty' }, '未保存') : null,
              ]))
              body.push(h('textarea', {
                className: 'dswb-editor', key: 'editor',
                value: readState === 'ready' ? draftText : '',
                disabled: !editable,
                spellCheck: false,
                placeholder: currentFile.editable ? '在此编辑 Markdown；Ctrl/Cmd+S 保存。' : '这个文件不可编辑。',
                onChange: function (event) { updateDraft(event.target.value) },
                onKeyDown: function (event) {
                  if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's') {
                    event.preventDefault()
                    save()
                  }
                },
              }))
              body.push(h('div', { className: 'dswb-actions', key: 'addActions' }, [
                h('button', {
                  className: 'dswb-btn dswb-primary', key: 'save', type: 'button',
                  disabled: !dirty || !editable || saving, onClick: save,
                }, saving ? '保存中…' : '保存'),
                h('button', { className: 'dswb-btn', key: 'reset', type: 'button', disabled: !dirty, onClick: reset }, '还原'),
                h('button', { className: 'dswb-btn', key: 'reload', type: 'button', disabled: readState === 'reading', onClick: refresh }, '重读'),
                h('span', { className: 'dswb-status', key: 'status' }, readState === 'reading' ? '读取中…' : dirty ? '有未保存修改' : '已同步'),
              ]))
            }
          }
        } else if (view === 'skills') {
          if (skills.length === 0) {
            body.push(h('div', { className: 'dswb-empty', key: 'skillsEmpty' }, [
              h('p', { className: 'dswb-note', key: 'empty' }, '这个预设还没有技能。'),
              h('p', { className: 'dswb-note', key: 'hint' }, '去“技能仓库”把仓库拉进 skills/，或手动放入 SKILL.md。'),
              h('button', { className: 'dswb-btn', key: 'goRepo', type: 'button', onClick: function () { setView('repo') } }, '去技能仓库'),
            ]))
          } else {
            body.push(h('div', { className: 'dswb-list', key: 'skillsList' }, skills.map(function (skill) {
              return h('div', { className: 'dswb-skill', key: skill.path }, [
                h('div', { className: 'dswb-skillHead', key: 'head' }, [
                  h('span', { className: 'dswb-skillName', key: 'name' }, skill.name),
                  h('span', { className: 'dswb-badge ' + (skill.enabled ? 'dswb-badgeOn' : 'dswb-badgeOff'), key: 'state' }, skill.enabled ? '已启用' : '已关闭'),
                ]),
                skill.description === '' ? null : h('p', { className: 'dswb-note', key: 'desc' }, skill.description),
                h('span', { className: 'dswb-skillPath', key: 'path', title: skill.path }, skill.path),
                h('div', { className: 'dswb-skillActions', key: 'actions' }, [
                  h('button', {
                    className: 'dswb-linkBtn', key: 'toggle', type: 'button',
                    disabled: busy !== '', onClick: function () { toggleSkill(skill) },
                  }, busy === 'skill:' + skill.path ? '处理中…' : skill.enabled ? '关闭' : '启用'),
                  h('button', {
                    className: 'dswb-linkBtn', key: 'edit', type: 'button',
                    onClick: function () { openSkill(skill) },
                  }, '编辑 SKILL.md'),
                ]),
              ])
            })))
          }
        } else if (view === 'shared') {
          if (sharedState === 'loading') {
            body.push(h('p', { className: 'dswb-note', key: 'sharedLoading' }, '正在读取技能仓库里的 .dsh…'))
          } else if (shared === null) {
            body.push(h('p', { className: 'dswb-note', key: 'sharedEmpty' }, '共享预设不可用。'))
          } else {
            if (sharedRepoState === 'loading') {
              body.push(h('p', { className: 'dswb-note', key: 'sharedRepoLoading' }, '正在读取共享技能仓库设置…'))
            } else if (sharedRepo !== null && sharedRepoDraft !== null) {
              body.push(h('div', { className: 'dswb-kv', key: 'sharedRepo' }, [
                h('p', { className: 'dswb-note', key: 'title' }, '共享技能仓库（私有仓库填 Deploy Key）'),
                h('label', { className: 'dswb-field', key: 'repoUrl' }, [
                  h('span', { className: 'dswb-label' }, '仓库地址'),
                  h('input', {
                    className: 'dswb-input', value: sharedRepoDraft.repoUrl,
                    onChange: function (event) { setSharedRepoField('repoUrl', event.target.value) },
                  }),
                ]),
                h('label', { className: 'dswb-field', key: 'branch' }, [
                  h('span', { className: 'dswb-label' }, '分支'),
                  h('input', {
                    className: 'dswb-input', value: sharedRepoDraft.branch,
                    onChange: function (event) { setSharedRepoField('branch', event.target.value) },
                  }),
                ]),
                h('label', { className: 'dswb-field', key: 'targetDir' }, [
                  h('span', { className: 'dswb-label' }, '检出目录（仓库根，任意绝对路径）'),
                  h('input', {
                    className: 'dswb-input', value: sharedRepoDraft.targetDir,
                    onChange: function (event) { setSharedRepoField('targetDir', event.target.value) },
                    placeholder: '例如 ~/core/projects/skills；预设读 <检出目录>/.dsh/preset',
                  }),
                  h('span', { className: 'dswb-note' }, '检出的就是这个仓库本身，不需要也不建议指向 ~/.dsh；.dsh/preset 在仓库内部。'),
                ]),
                h('label', { className: 'dswb-field', key: 'keyPath' }, [
                  h('span', { className: 'dswb-label' }, '密钥路径（可选，优先于下面的 Deploy Key）'),
                  h('input', {
                    className: 'dswb-input', value: sharedRepoDraft.keyPath,
                    onChange: function (event) { setSharedRepoField('keyPath', event.target.value) },
                    placeholder: '~/.ssh/deploy_key',
                  }),
                ]),
                h('label', { className: 'dswb-check', key: 'submodules' }, [
                  h('input', {
                    type: 'checkbox', checked: sharedRepoDraft.recurseSubmodules,
                    onChange: function (event) { setSharedRepoField('recurseSubmodules', event.target.checked) },
                  }),
                  '递归子模块',
                ]),
                h('div', { className: 'dswb-actions', key: 'repoActions' }, [
                  h('button', { className: 'dswb-btn dswb-primary', key: 'save', type: 'button', disabled: busy !== '', onClick: saveSharedRepo }, '保存设置'),
                  h('button', { className: 'dswb-btn', key: 'pull', type: 'button', disabled: busy !== '', onClick: pullSharedRepo }, busy === 'shared-pull' ? '拉取中…' : '拉取（clone / 快进）'),
                ]),
                h('label', { className: 'dswb-field', key: 'deployKey' }, [
                  h('span', { className: 'dswb-label' }, 'Deploy Key 私钥（保存后不回显）'),
                  h('textarea', {
                    className: 'dswb-textarea', value: sharedRepoKeyDraft,
                    onChange: function (event) { setSharedRepoKeyDraft(event.target.value) },
                    placeholder: '粘贴 OpenSSH 私钥；留空并点“保存”等于清除。',
                  }),
                ]),
                h('div', { className: 'dswb-actions', key: 'keyActions' }, [
                  h('button', { className: 'dswb-btn', key: 'saveKey', type: 'button', disabled: busy !== '', onClick: function () { saveSharedRepoKey(false) } }, '保存 Deploy Key'),
                  h('button', { className: 'dswb-btn', key: 'clearKey', type: 'button', disabled: busy !== '', onClick: function () { saveSharedRepoKey(true) } }, '清除'),
                  h('span', { className: 'dswb-status', key: 'keyState' }, '密钥来源：' + (sharedRepo.key.source === 'path' ? '密钥路径' : sharedRepo.key.source === 'stored' ? '已保存的 Deploy Key' : '无')),
                ]),
                h('p', { className: 'dswb-note', key: 'target', title: sharedRepo.state.targetDir }, '检出：' + (sharedRepo.target.exists
                  ? (sharedRepo.target.isRepo ? '分支 ' + (sharedRepo.target.branch || '-') + ' · commit ' + sharedRepo.target.commit.slice(0, 7) + ' · 技能 ' + sharedRepo.target.skills + ' 个' : '目录存在但不是 Git 仓库')
                  : '尚未 clone')),
                h('p', { className: 'dswb-note', key: 'last' }, '上次拉取：' + wbSyncText(sharedRepo.state.lastSync)),
                h('p', { className: 'dswb-note', key: 'hint' }, '拉取后，仓库根目录的 .dsh/preset 会出现在下面的来源列表。'),
              ]))
            }
            body.push(h('div', { className: 'dswb-actions', key: 'sharedActions' }, [
              h('button', {
                className: 'dswb-btn dswb-primary', key: 'syncAll', type: 'button',
                disabled: busy !== '', onClick: function () { syncShared(null) },
              }, busy === 'shared' ? '同步中…' : '同步全部'),
              h('label', { className: 'dswb-check', key: 'prune' }, [
                h('input', {
                  type: 'checkbox', checked: pruneShared,
                  onChange: function (event) { setPruneShared(event.target.checked) },
                }),
                '删除源中已移除的文件',
              ]),
              h('span', { className: 'dswb-status', key: 'localRoot', title: shared.localRoot }, '目标：' + shared.localRoot),
            ]))
            const sources = shared.sources
            const total = sources.reduce(function (count, source) { return count + source.presets.length }, 0)
            if (total === 0) {
              body.push(h('div', { className: 'dswb-empty', key: 'noShared' }, [
                h('p', { className: 'dswb-note', key: 'hint' }, '没有找到 .dsh 预设。'),
                h('p', { className: 'dswb-note', key: 'format' }, '仓库里放 .dsh/preset/<id>/（推荐）或让 .dsh/preset/ 本身就是一个预设；也兼容 .dsh/presets/<id>/ 与带 preset.yml 的 .dsh/<id>/。'),
              ]))
            }
            sources.forEach(function (source) {
              body.push(h('div', { className: 'dswb-kv', key: 'src:' + source.kind + ':' + source.path }, [
                h('p', { className: 'dswb-note', key: 'kind' }, wbSharedKindText(source.kind) + (source.exists ? '' : ' · 目录不存在')),
                h('p', { className: 'dswb-note', key: 'path', title: source.path }, source.path),
              ]))
              if (source.presets.length === 0) {
                body.push(h('p', { className: 'dswb-note', key: 'empty:' + source.path }, '这个来源下没有 .dsh 预设。'))
                return
              }
              source.presets.forEach(function (item) {
                body.push(h('div', { className: 'dswb-skill', key: 'sp:' + source.path + ':' + item.id }, [
                  h('div', { className: 'dswb-skillHead', key: 'head' }, [
                    h('span', { className: 'dswb-skillName', key: 'name' }, item.name),
                    h('span', {
                      className: 'dswb-badge ' + (item.status === 'same' ? 'dswb-badgeOn' : item.status === 'invalid' ? 'dswb-badgeOff' : ''),
                      key: 'status',
                    }, wbSharedStatusText(item.status)),
                    item.managed ? h('span', { className: 'dswb-badge', key: 'managed' }, '已接管') : null,
                  ]),
                  item.description === '' ? null : h('p', { className: 'dswb-note', key: 'desc' }, item.description),
                  h('span', { className: 'dswb-skillPath', key: 'meta', title: item.sourcePath }, item.id + ' · ' + item.files + ' 个文件 · 技能 ' + item.skills),
                  item.status === 'invalid' && item.reason !== '' ? h('p', { className: 'dswb-error', key: 'reason' }, item.reason) : null,
                  h('div', { className: 'dswb-skillActions', key: 'actions' }, [
                    h('button', {
                      className: 'dswb-linkBtn', key: 'sync', type: 'button',
                      disabled: busy !== '' || item.status === 'invalid' || item.status === 'same',
                      onClick: function () { syncShared([item.id]) },
                    }, item.status === 'same' ? '已是最新' : '同步这个预设'),
                  ]),
                ]))
              })
            })
          }
        } else {
          if (repoState === 'loading') {
            body.push(h('p', { className: 'dswb-note', key: 'repoLoading' }, '正在读取仓库设置…'))
          } else if (repo === null || repoDraft === null) {
            body.push(h('p', { className: 'dswb-note', key: 'repoEmpty' }, '仓库设置不可用。'))
          } else {
            body.push(h('label', { className: 'dswb-field', key: 'repoUrl' }, [
              h('span', { className: 'dswb-label' }, '仓库地址'),
              h('input', {
                className: 'dswb-input', value: repoDraft.repoUrl,
                onChange: function (event) { setRepoField('repoUrl', event.target.value) },
              }),
            ]))
            body.push(h('label', { className: 'dswb-field', key: 'branch' }, [
              h('span', { className: 'dswb-label' }, '分支'),
              h('input', {
                className: 'dswb-input', value: repoDraft.branch,
                onChange: function (event) { setRepoField('branch', event.target.value) },
              }),
            ]))
            body.push(h('label', { className: 'dswb-field', key: 'subdir' }, [
              h('span', { className: 'dswb-label' }, '目标子目录（skills/ 下）'),
              h('input', {
                className: 'dswb-input', value: repoDraft.targetSubdir,
                onChange: function (event) { setRepoField('targetSubdir', event.target.value) },
              }),
            ]))
            body.push(h('label', { className: 'dswb-field', key: 'keyPath' }, [
              h('span', { className: 'dswb-label' }, '密钥路径（可选）'),
              h('input', {
                className: 'dswb-input', value: repoDraft.keyPath,
                onChange: function (event) { setRepoField('keyPath', event.target.value) },
                placeholder: '~/.ssh/deploy_key；留空则用下面保存的 Deploy Key',
              }),
            ]))
            body.push(h('label', { className: 'dswb-check', key: 'submodules' }, [
              h('input', {
                type: 'checkbox', checked: repoDraft.recurseSubmodules,
                onChange: function (event) { setRepoField('recurseSubmodules', event.target.checked) },
              }),
              '递归子模块',
            ]))
            body.push(h('div', { className: 'dswb-actions', key: 'repoActions' }, [
              h('button', { className: 'dswb-btn dswb-primary', key: 'saveRepo', type: 'button', disabled: busy !== '', onClick: saveRepo }, '保存设置'),
              h('button', { className: 'dswb-btn', key: 'sync', type: 'button', disabled: busy !== '', onClick: syncNow }, busy === 'sync' ? '同步中…' : '同步（拉取）'),
            ]))
            body.push(h('label', { className: 'dswb-field', key: 'key' }, [
              h('span', { className: 'dswb-label' }, 'Deploy Key 私钥（保存后不回显）'),
              h('textarea', {
                className: 'dswb-textarea', value: keyDraft,
                onChange: function (event) { setKeyDraft(event.target.value) },
                placeholder: '粘贴 OpenSSH 私钥；留空并点“保存”等于清除。',
              }),
            ]))
            body.push(h('div', { className: 'dswb-actions', key: 'keyActions' }, [
              h('button', { className: 'dswb-btn', key: 'saveKey', type: 'button', disabled: busy !== '', onClick: function () { saveKey(false) } }, '保存 Deploy Key'),
              h('button', { className: 'dswb-btn', key: 'clearKey', type: 'button', disabled: busy !== '', onClick: function () { saveKey(true) } }, '清除'),
              h('span', { className: 'dswb-status', key: 'keyState' }, '密钥来源：' + (repo.key.source === 'path' ? '密钥路径' : repo.key.source === 'stored' ? '已保存的 Deploy Key' : '无')),
            ]))
            body.push(h('div', { className: 'dswb-kv', key: 'status' }, [
              h('p', { className: 'dswb-note', key: 'target' }, '目标：' + repo.target),
              h('p', { className: 'dswb-note', key: 'state' }, repo.status.exists
                ? (repo.status.isRepo ? '分支 ' + (repo.status.branch || '-') + ' · commit ' + repo.status.commit.slice(0, 7) + ' · ' + (repo.status.dirty ? '工作区有改动' : '工作区干净') + ' · 技能 ' + repo.status.skills + ' 个' : '目标存在但不是 Git 仓库')
                : '目标尚未克隆，首次同步会 clone'),
              h('p', { className: 'dswb-note', key: 'last' }, '上次同步：' + wbSyncText(repo.state.lastSync)),
            ]))
          }
        }

        children.push(h('div', { className: 'dswb-body', key: 'body' }, body))
      }

      if (notice !== '') children.push(h('p', { className: 'dswb-ok', key: 'notice', role: 'status' }, notice))
      if (error !== '' && status !== 'error') children.push(h('p', { className: 'dswb-error', key: 'error', role: 'alert' }, error))
      children.push(h('p', { className: 'dswb-note', key: 'foot' }, '预设里的技能与 Markdown 直接写入该目录，是否被会话加载取决于使用它的 preset；全局/项目 AGENTS.md 由 dsh-agent-instructions 读取，改动在会话恢复或模型再次读写该目录后生效。'))

      return h('div', { className: 'dswb-root' }, children)
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
      let skillPanelForm = null
      try {
        skillPanelForm = ctx.configForms.get(SKILL_PANEL_NS)
      } catch {
        skillPanelForm = null
      }
      let workbenchForm = null
      try {
        workbenchForm = ctx.configForms.get(WORKBENCH_NS) || null
      } catch {
        workbenchForm = null
      }
      ctx.effect(() => () => {
        skillForm.dispose()
        approvalForm.dispose()
        notifyForm.dispose()
        if (skillPanelForm) skillPanelForm.dispose()
        if (workbenchForm) workbenchForm.dispose()
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
      const WorkbenchRowPage = workbenchForm === null ? null : RowPage({
        form: workbenchForm, fields: WORKBENCH_FIELDS,
        title: 'Utils 工作台',
        intro: '右侧栏的 Utils 面板按预设统一管理 skills、技能仓库与 AGENTS.md。',
      })

      // The row page and the right-sidebar body mount the same panel; the
      // sidebar body receives its Session as a standard slot prop.
      const SkillPanelRowPage = () => h('div', { className: 'dsu-root' }, [
        h('style', { key: 'style' }, STYLE + PANEL_STYLE),
        h(SkillPanel, { key: 'panel', form: skillPanelForm }),
      ])
      // One Utils tab now carries what used to be three separate sidebar
      // cards: preset skills, the per-preset skill repository, and Markdown.
      const WorkbenchBody = (props) => h('div', { className: 'dswb-host' }, [
        h('style', { key: 'style' }, WB_STYLE),
        h(Workbench, { key: 'panel', sessionId: props?.['sessionId'] }),
      ])

      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: WB_TAB,
          kind: WB_TAB,
          title: () => 'Utils',
          guide: [{
            id: 'utils-workbench',
            order: 30,
            title: () => 'Utils',
            description: () => '按预设管理技能、技能仓库与 AGENTS.md',
          }],
        }), 'dsh-utils: workbench tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: WB_TAB,
        }, WorkbenchBody)), 'dsh-utils: workbench tab body')
      }

      // Each component owns one page, keyed the way the Plugins page addresses a
      // row's configuration: `${bundle}#${rowId}`.
      ctx.effect(() => ctx.configForms.whileServed([SKILL_NS, APPROVAL_NS, NOTIFY_NS, SKILL_PANEL_NS, WORKBENCH_NS], (served) => {
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
        if (served.has(SKILL_PANEL_NS)) {
          offs.push(ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config', key: `${BUNDLE}#${SKILL_PANEL_NS}`,
          }, SkillPanelRowPage)))
        }
        if (served.has(WORKBENCH_NS) && WorkbenchRowPage !== null) {
          offs.push(ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config', key: `${BUNDLE}#${WORKBENCH_NS}`,
          }, WorkbenchRowPage)))
        }
        return () => {
          for (const off of offs) off()
        }
      }))
    }

    return {
      inject: ['slots', 'configForms', 'sidebarRightTabs'],
      apply,
    }
  },
})
