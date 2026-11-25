import assert from 'node:assert/strict'
import { test } from 'node:test'

// ---------------------------------------------------------------- React stub --
//
// The client half is a browser plugin: it registers React components into host
// slots. This harness renders those components with a positional hook runtime
// (the same reconciliation rule React uses for a stable tree), so the real
// component code — draft conversion, validation, operation diffing, save — is
// what runs here.

let currentInstance
const instances = []
let instanceCursor = 0
let renderScheduled = false

function createElement(type, props, ...children) {
  const merged = { ...(props ?? {}) }
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  if (flat.length === 1) merged.children = flat[0]
  else if (flat.length > 1) merged.children = flat
  return { type, props: merged }
}

const React = {
  createElement: (...args) => createElement(...args),
  useState(initial) {
    const instance = currentInstance
    const index = instance.hookIndex
    instance.hookIndex += 1
    if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(instance.hooks[index]) : next
      if (Object.is(value, instance.hooks[index])) return
      instance.hooks[index] = value
      renderScheduled = true
    }
    return [instance.hooks[index], set]
  },
  useEffect(effect, deps) {
    const instance = currentInstance
    const index = instance.hookIndex
    instance.hookIndex += 1
    const previous = instance.hooks[index]
    const changed = previous === undefined || deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((dep, at) => !Object.is(dep, previous.deps[at]))
    if (changed) instance.hooks[index] = { deps: deps ?? [] }
    instance.pendingEffects.push({ effect, changed })
  },
}

/** Render one root component tree, honoring hooks positionally. */
function render(root) {
  for (let pass = 0; pass < 12; pass += 1) {
    instanceCursor = 0
    renderScheduled = false
    const tree = renderNode(root)
    for (const instance of instances) {
      const pending = instance.pendingEffects
      instance.pendingEffects = []
      for (const entry of pending) {
        if (!entry.changed) continue
        const result = entry.effect()
        if (typeof result === 'function') instance.cleanups.push(result)
      }
    }
    if (!renderScheduled) return tree
  }
  throw new Error('render did not settle')
}

function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (Array.isArray(node)) return node.map(renderNode)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const instance = instances[instanceCursor]
      ?? (instances[instanceCursor] = { hooks: [], hookIndex: 0, pendingEffects: [], cleanups: [] })
    instanceCursor += 1
    if (node.type.prototype?.isReactComponent) throw new Error('class components are not supported')
    const previous = currentInstance
    currentInstance = instance
    instance.hookIndex = 0
    let output
    try {
      output = node.type(node.props)
    } finally {
      currentInstance = previous
    }
    return renderNode(output)
  }
  return { type: node.type, props: node.props, children: renderNode(node.props?.children) }
}

/** Depth-first collection of rendered elements matching a predicate. */
function collect(node, predicate) {
  const found = []
  const walk = (value) => {
    if (value === null || value === undefined || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (predicate(value)) found.push(value)
    walk(value.children)
  }
  walk(node)
  return found
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

function findByText(tree, text) {
  const [element] = collect(tree, (node) => textOf(node).includes(text) && node.type !== undefined)
  return element
}

function clickSave(tree) {
  const buttons = collect(tree, (node) => node.type === 'button' && textOf(node).includes('保存'))
  assert.ok(buttons.length > 0, 'a save button is rendered')
  return buttons[0].props.onClick()
}

/** Field control inside the label row whose text names it. */
function fieldControl(tree, label) {
  const labels = collect(tree, (node) => node.type === 'label' && textOf(node).includes(label))
  assert.ok(labels.length > 0, `label "${label}" is rendered`)
  const [control] = collect(labels[0], (node) => ['input', 'textarea', 'select'].includes(node.type))
  assert.ok(control, `label "${label}" carries a control`)
  return control
}

/** The checkbox inside the label row whose text names it (inside a choices group). */
function checkbox(tree, label) {
  const labels = collect(tree, (node) => node.type === 'label' && textOf(node).includes(label))
  assert.ok(labels.length > 0, `checkbox "${label}" is rendered`)
  const [control] = collect(labels[labels.length - 1], (node) => node.type === 'input')
  assert.equal(control.props.type, 'checkbox')
  return control
}

/** A fetch-shaped response body for the skills panel tests. */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/** Let the panel's pending fetch settle, then re-render from the component root. */
async function settle(page, props = {}) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return render(createElement(page, props))
}

/** The switch input of one skill row in the panel. */
function skillSwitch(tree, name) {
  const [input] = collect(tree, (node) => node.type === 'input' && node.props['data-skill'] === name)
  assert.ok(input, `switch for "${name}" is rendered`)
  return input
}

// ------------------------------------------------------------- host doubles --

function fakeForm(initialValue, { status = 'ready', writable = true, revision = 7, setResult = true, onSet, user, base } = {}) {
  const calls = []
  const writes = []
  const listeners = new Set()
  let value = initialValue
  const form = {
    calls,
    writes,
    getSnapshot: () => ({ status, writable, value, revision, user, base }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field, next) => {
      writes.push({ field, value: next })
      if (onSet !== undefined) {
        const accepted = await onSet(field, next)
        if (accepted === false) return false
      }
      if (setResult === false) return false
      value = { ...value, [field]: next }
      for (const listener of listeners) listener()
      return true
    },
    mutate: async (ops, at) => {
      calls.push({ ops, revision: at })
      value = { ...value }
      for (const op of ops) {
        if (op.op === 'unset') delete value[op.path[0]]
        else value[op.path[0]] = op.value
      }
      for (const listener of listeners) listener()
      return true
    },
    dispose: () => {},
  }
  return form
}

/** Full stored value of the notify row, matching the component's Config defaults. */
const NOTIFY_VALUE = {
  enabled: true,
  dryRun: true,
  transport: 'gotify',
  gotifyUrl: 'https://notify.example.com',
  gotifyToken: 'gtfya.example',
  gotifyPriority: 3,
  gotifyHeaders: {},
  targets: [],
  deviceName: '',
  deviceLabel: '办公本',
  deviceInTitle: false,
  notifyOnReasons: ['completed', 'error', 'aborted'],
  notifyOnApproval: true,
  notifyOnQuestion: true,
  questionDelayMs: 2500,
  approvalDelayMs: 3000,
  includeSubagents: false,
  summaryChars: 120,
  timeoutMs: 8000,
  traceFile: '',
  template: '',
  questionTemplate: '',
  approvalTemplate: '',
}

function fakeCtx({ served = ['dsh-approval-policy', 'dsh-notify', 'utils-agents'], agentsValue, approvalValue, notifyValue, agentsOptions, approvalOptions, notifyOptions, skillOptions, panelOptions, workbenchOptions } = {}) {
  const agentsForm = fakeForm(agentsValue ?? {
    minDepth: 1,
    maxDepth: 8,
    watch: true,
    debounceMs: 200,
    pollIntervalMs: 2000,
    includeProjectRoots: false,
    includeUserRoots: false,
    followSymlinks: false,
    extraRoots: ['D:/Core/Projects/Skill'],
    ignoreDirs: ['.system', 'node_modules', '.git'],
    disabledSkills: [],
    maxBytes: 524288,
    presetDirs: [],
    extraAgentsFiles: [],
    scanNestedAgents: false,
    nestedDepth: 3,
    defaultRepoUrl: 'https://github.com/xi4z/skills',
    defaultBranch: 'Agent',
  }, agentsOptions ?? skillOptions ?? panelOptions ?? workbenchOptions)
  const approvalForm = fakeForm(approvalValue ?? {
    origins: ['subagent', 'scheduled'],
    sessions: [],
    windowSeconds: 300,
    defaultOutcome: 'rejected',
    defaultPermissionPreset: 'auto',
    autoReviewContent: true,
  }, approvalOptions)
  const notifyForm = fakeForm(notifyValue === undefined ? { ...NOTIFY_VALUE } : notifyValue, notifyOptions)
  const registrations = []
  const tabTypes = []
  const effects = []
  const ctx = {
    configForms: {
      get: (namespace) => {
        if (namespace === 'utils-agents') return agentsForm
        if (namespace === 'dsh-notify') return notifyForm
        return approvalForm
      },
      whileServed: (namespaces, register) => {
        const servedSet = new Set(served)
        const active = namespaces.some((namespace) => servedSet.has(namespace))
        const disposer = active ? register(servedSet) : () => {}
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
    },
    slots: {
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
      inject: (_key, callback) => callback(),
    },
    sidebarRightTabs: {
      register: (definition) => {
        tabTypes.push(definition)
        return () => {}
      },
    },
    effect: (execute, label) => {
      const cleanup = execute()
      effects.push({ execute: () => cleanup, label })
      return cleanup
    },
  }
  // The former skills / skill-panel / utils-agents forms are one namespace now.
  return { ctx, agentsForm, skillForm: agentsForm, panelForm: agentsForm, workbenchForm: agentsForm, approvalForm, notifyForm, registrations, tabTypes, effects }
}
/** Load the browser half and mount it against the fake host. */
async function mountClient(options) {
  // Every mount re-imports the bundle, so hook state starts empty for the
  // fresh component identities too.
  instances.length = 0
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded.push(definition)
      },
    },
  }
  const modulePath = new URL('../client.js', import.meta.url)
  modulePath.search = `?v=${Math.random()}`
  await import(modulePath.href)
  assert.equal(loaded.length, 1, 'the bundle registers exactly one client module')
  const definition = loaded[0]
  assert.equal(definition.id, '@xi4z/dsh-utils-ui')
  const plugin = definition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected client module request: ${specifier}`)
  })
  const host = fakeCtx(options)
  plugin.apply(host.ctx)
  return { plugin, ...host }
}

// ------------------------------------------------------------------- tests --

test('the client half registers one configuration page per mounted row', async () => {
  const { plugin, registrations } = await mountClient()

  assert.deepEqual(plugin.inject, ['slots', 'configForms', 'sidebarRightTabs'])
  const keys = registrations
    .filter(({ options }) => options.name === 'plugins.row.config')
    .map(({ options }) => `${options.name}:${options.key}`)
    .sort()
  assert.deepEqual(keys, [
    'plugins.row.config:@xi4z/dsh-utils#dsh-approval-policy',
    'plugins.row.config:@xi4z/dsh-utils#dsh-notify',
    'plugins.row.config:@xi4z/dsh-utils#utils-agents',
  ])
})

test('registration follows the namespaces the Host serves', async () => {
  const { registrations } = await mountClient({ served: ['utils-agents'] })
  const keys = registrations
    .filter(({ options }) => options.name === 'plugins.row.config')
    .map(({ options }) => `${options.name}:${options.key}`)
    .sort()
  assert.deepEqual(keys, ['plugins.row.config:@xi4z/dsh-utils#utils-agents'])
})

test('a served-none deployment registers no row configuration page', async () => {
  const { registrations } = await mountClient({ served: [] })
  const keys = registrations
    .filter(({ options }) => options.name === 'plugins.row.config')
    .map(({ options }) => options.key)
    .sort()
  assert.deepEqual(keys, [])
})

test('skill page: initial draft reflects the Host values and saving writes only the changed field', async () => {
  const { registrations, skillForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#utils-agents').component

  let tree = render(createElement(page, {}))
  assert.equal(textOf(tree).includes('递归技能发现'), true)
  assert.equal(fieldControl(tree, '追加技能根').props.value, 'D:/Core/Projects/Skill')

  fieldControl(tree, '最小深度').props.onChange({ target: { value: '4' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.equal(skillForm.calls.length, 1)
  assert.deepEqual(skillForm.calls[0].ops, [{ op: 'set', path: ['minDepth'], value: 4 }])
  assert.equal(skillForm.calls[0].revision, 7)
})

test('skill page: invalid and contradictory numbers block the save with a message', async () => {
  const { registrations, skillForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#utils-agents').component

  let tree = render(createElement(page, {}))
  fieldControl(tree, '最小深度').props.onChange({ target: { value: '9' } })
  fieldControl(tree, '最大深度').props.onChange({ target: { value: '8' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)
  tree = render(createElement(page, {}))

  assert.equal(skillForm.calls.length, 0, 'a contradictory pair never reaches the Host')
  assert.equal(textOf(tree).includes('不得小于“最小深度”'), true)

  fieldControl(tree, '最小深度').props.onChange({ target: { value: '1' } })
  fieldControl(tree, '防抖（毫秒）').props.onChange({ target: { value: 'x' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)
  tree = render(createElement(page, {}))

  assert.equal(skillForm.calls.length, 0)
  assert.equal(textOf(tree).includes('必须是整数'), true)
})

test('skill page: list fields split into trimmed, non-empty lines', async () => {
  const { registrations, skillForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#utils-agents').component

  let tree = render(createElement(page, {}))
  fieldControl(tree, '忽略的目录名').props.onChange({ target: { value: '.git\n\n  node_modules  \n' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(skillForm.calls[0].ops, [{ op: 'set', path: ['ignoreDirs'], value: ['.git', 'node_modules'] }])
})

test('skill page: toggling the watch switch writes a boolean', async () => {
  const { registrations, skillForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#utils-agents').component

  let tree = render(createElement(page, {}))
  checkbox(tree, '监听变化').props.onChange({ target: { checked: false } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(skillForm.calls[0].ops, [{ op: 'set', path: ['watch'], value: false }])
})

test('approval page: origins are a checkbox set stored in canonical order', async () => {
  const { registrations, approvalForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-approval-policy').component

  let tree = render(createElement(page, {}))
  checkbox(tree, 'cron 任务').props.onChange({ target: { checked: true } })
  tree = render(createElement(page, {}))
  fieldControl(tree, '应答窗口（秒）').props.onChange({ target: { value: '0' } })
  tree = render(createElement(page, {}))
  fieldControl(tree, '超时落定值').props.onChange({ target: { value: 'unavailable' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(approvalForm.calls[0].ops, [
    { op: 'set', path: ['origins'], value: ['subagent', 'scheduled', 'cron'] },
    { op: 'set', path: ['windowSeconds'], value: 0 },
    { op: 'set', path: ['defaultOutcome'], value: 'unavailable' },
  ])
})

test('approval page: the schema bounds are enforced before the Host sees the write', async () => {
  const { registrations, approvalForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-approval-policy').component

  let tree = render(createElement(page, {}))
  fieldControl(tree, '应答窗口（秒）').props.onChange({ target: { value: '86401' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)
  tree = render(createElement(page, {}))

  assert.equal(approvalForm.calls.length, 0)
  assert.equal(textOf(tree).includes('不得大于 86400'), true)
})

test('approval page: 恢复默认 unsets exactly the user-overridden fields of this section', async () => {
  const { registrations, approvalForm } = await mountClient({
    approvalOptions: { user: { windowSeconds: 300, autoReviewContent: true } },
  })
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-approval-policy').component

  let tree = render(createElement(page, {}))
  const [reset] = collect(tree, (node) => node.type === 'button' && textOf(node) === '恢复默认')
  assert.ok(reset, 'a reset button is rendered')
  assert.equal(reset.props.disabled, false)

  await reset.props.onClick()
  tree = render(createElement(page, {}))

  assert.deepEqual(approvalForm.calls[0].ops, [
    { op: 'unset', path: ['windowSeconds'] },
    { op: 'unset', path: ['autoReviewContent'] },
  ])
  assert.equal(approvalForm.calls[0].revision, 7)
  assert.match(textOf(tree), /已恢复默认设置/)
})

test('approval page: 恢复默认 is disabled when the section has no user overrides', async () => {
  const { registrations } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-approval-policy').component

  const tree = render(createElement(page, {}))
  const [reset] = collect(tree, (node) => node.type === 'button' && textOf(node) === '恢复默认')
  assert.ok(reset, 'a reset button is rendered')
  assert.equal(reset.props.disabled, true)
})

test('an unwritable form renders read-only and cannot save', async () => {
  const { registrations } = await mountClient({ skillOptions: { writable: false } })
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#utils-agents').component

  const tree = render(createElement(page, {}))
  assert.equal(fieldControl(tree, '最小深度').props.disabled, true)
  const [save] = collect(tree, (node) => node.type === 'button')
  assert.equal(save.props.disabled, true)
})

test('a loading or unavailable namespace says so instead of rendering empty inputs', async () => {
  const unavailable = await mountClient({ skillOptions: { status: 'unavailable' } })
  const unavailablePage = unavailable.registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#utils-agents').component
  assert.equal(textOf(render(createElement(unavailablePage, {}))).includes('没有向浏览器暴露'), true)

  const loading = await mountClient({ skillOptions: { status: 'loading' } })
  const loadingPage = loading.registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#utils-agents').component
  assert.equal(textOf(render(createElement(loadingPage, {}))).includes('正在读取配置'), true)
})

test('the plugin disposes the forms it owns through an effect', async () => {
  const { effects, agentsForm, approvalForm, notifyForm } = await mountClient()
  let agentsDisposed = false
  let approvalDisposed = false
  let notifyDisposed = false
  agentsForm.dispose = () => { agentsDisposed = true }
  approvalForm.dispose = () => { approvalDisposed = true }
  notifyForm.dispose = () => { notifyDisposed = true }
  const formsEffect = effects.find((entry) => entry.label === 'dsh-utils: configuration forms')
  assert.ok(formsEffect, 'the forms effect is registered')
  formsEffect.execute()()
  assert.equal(agentsDisposed, true)
  assert.equal(approvalDisposed, true)
  assert.equal(notifyDisposed, true)
})

// ------------------------------------------------------------------ notify --

test('notify page: reasons are a checkbox set stored in canonical order', async () => {
  const { registrations, notifyForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-notify').component

  let tree = render(createElement(page, {}))
  checkbox(tree, '出错').props.onChange({ target: { checked: false } })
  tree = render(createElement(page, {}))
  checkbox(tree, '被阻塞').props.onChange({ target: { checked: true } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(notifyForm.calls[0].ops, [
    { op: 'set', path: ['notifyOnReasons'], value: ['completed', 'aborted', 'blocked'] },
  ])
})

test('notify page: the targets JSON field accepts an array of targets', async () => {
  const { registrations, notifyForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-notify').component

  let tree = render(createElement(page, {}))
  fieldControl(tree, '多目标').props.onChange({
    target: { value: '[{"name":"qq-home","url":"https://a.example","token":"t","priority":5}]' },
  })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(notifyForm.calls[0].ops, [{
    op: 'set',
    path: ['targets'],
    value: [{ name: 'qq-home', url: 'https://a.example', token: 't', priority: 5 }],
  }])
})

test('notify page: malformed JSON blocks the save with a message', async () => {
  const { registrations, notifyForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-notify').component

  let tree = render(createElement(page, {}))
  fieldControl(tree, '附加请求头').props.onChange({ target: { value: '{nope}' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)
  tree = render(createElement(page, {}))

  assert.equal(notifyForm.calls.length, 0, 'the Host never sees malformed JSON')
  assert.equal(textOf(tree).includes('不是合法 JSON'), true)
})

test('notify page: templates keep their newlines and an unchanged save writes nothing', async () => {
  const { registrations, notifyForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-notify').component

  let tree = render(createElement(page, {}))
  await clickSave(tree)
  assert.equal(notifyForm.calls.length, 0, 'a no-op save never touches the Host')

  fieldControl(tree, '会话结束模板').props.onChange({ target: { value: '[DSH] {status}\n回复: {reply}' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(notifyForm.calls[0].ops, [
    { op: 'set', path: ['template'], value: '[DSH] {status}\n回复: {reply}' },
  ])
})

test('notify page: the dry-run switch and the text fields save as typed', async () => {
  const { registrations, notifyForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#dsh-notify').component

  let tree = render(createElement(page, {}))
  checkbox(tree, '只记日志').props.onChange({ target: { checked: false } })
  tree = render(createElement(page, {}))
  fieldControl(tree, '网关地址').props.onChange({ target: { value: '  https://notify.example.org  ' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(notifyForm.calls[0].ops, [
    { op: 'set', path: ['dryRun'], value: false },
    { op: 'set', path: ['gotifyUrl'], value: 'https://notify.example.org' },
  ])
})

// ----------------------------------------------------------------- skills --

const PANEL_SKILLS = [
  {
    name: 'caveman', description: '压缩回答', source: 'user-dsh', provider: 'filesystem',
    path: '/root/core/skills/caveman/SKILL.md', modelInvocable: true, userInvocable: true, enabled: true,
  },
  {
    name: 'manual-only', description: '仅手动技能', source: 'project', provider: 'filesystem',
    path: '/root/core/.dsh/skills/manual-only/SKILL.md', modelInvocable: false, userInvocable: true, enabled: false,
  },
]

const PANEL_BODY = {
  sessionId: 'sess-1', cwd: '/root/core', complete: true, skills: PANEL_SKILLS, disabledSkills: [],
}

function clearPanelGlobals() {
  delete globalThis.fetch
  delete globalThis.document
}

/** Mount the skill panel row page (the sidebar tab was merged into Utils). */
async function mountSidebarPanel({ body = PANEL_BODY, status = 200, handler, panelOptions } = {}) {
  const mounted = await mountClient({ panelOptions })
  const page = mounted.registrations.find(({ options }) => options.name === 'plugins.row.config' && options.key === '@xi4z/dsh-utils#utils-agents').component
  const requested = []
  globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }
  globalThis.fetch = async (url) => {
    requested.push(String(url))
    if (handler !== undefined) return handler(String(url), requested.length)
    return jsonResponse(body, status)
  }
  const props = {}
  let tree = render(createElement(page, props))
  tree = await settle(page, props)
  return { ...mounted, page, props, requested, tree }
}

test('the right-sidebar type and its keyed body are registered together', async () => {
  const { tabTypes, registrations } = await mountClient()

  assert.equal(tabTypes.length, 1)
  const definition = tabTypes.find((tab) => tab.id === 'utils-agents')
  assert.ok(definition, 'the Utils tab type is registered')
  assert.equal(definition.kind, 'utils-agents')
  assert.equal(definition.title(), 'utils-agents')
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].id, 'utils-agents')
  assert.equal(definition.guide[0].order, 30)
  assert.equal(definition.guide[0].title(), 'utils-agents')
  assert.equal(typeof definition.guide[0].description(), 'string')

  const body = registrations.find(({ options }) => options.name === 'sidebar.right.pane.tab' && options.key === 'utils-agents')
  assert.ok(body, 'the keyed utils-agents pane body is registered')
  assert.equal(body.options.key, 'utils-agents')
})

test('skills panel: lists the session catalog with counts and the session query', async () => {
  const { tree, requested } = await mountSidebarPanel()
  try {
    assert.equal(requested.length, 1)
    const url = new URL(requested[0])
    assert.equal(url.pathname, '/api/dsh-utils/skill-panel/list')
    assert.equal(url.searchParams.has('sessionId'), false)

    const text = textOf(tree)
    assert.match(text, /共 2 个 · 模型可见 1/)
    assert.match(text, /工作目录：\/root\/core/)
    assert.match(text, /caveman/)
    assert.match(text, /压缩回答/)
    assert.match(text, /manual-only/)
    assert.match(text, /仅手动/)
    assert.match(text, /仍可用“\/名称”手动加载/)

    // Only model-invocable skills carry a live switch; the rest are manual-only.
    assert.equal(skillSwitch(tree, 'caveman').props.checked, true)
    assert.equal(skillSwitch(tree, 'caveman').props.disabled, false)
    assert.equal(skillSwitch(tree, 'manual-only').props.checked, false)
    assert.equal(skillSwitch(tree, 'manual-only').props.disabled, true)
  } finally {
    clearPanelGlobals()
  }
})

test('skills panel: a switch writes the sorted disabled list and updates the count', async () => {
  const { tree: initial, panelForm, page, props } = await mountSidebarPanel()
  try {
    let tree = initial
    skillSwitch(tree, 'caveman').props.onChange({ target: { checked: false } })
    tree = await settle(page, props)
    assert.deepEqual(panelForm.writes, [{ field: 'disabledSkills', value: ['caveman'] }])
    assert.equal(skillSwitch(tree, 'caveman').props.checked, false)
    assert.match(textOf(tree), /模型可见 0/)

    skillSwitch(tree, 'caveman').props.onChange({ target: { checked: true } })
    tree = await settle(page, props)
    assert.deepEqual(panelForm.writes[1], { field: 'disabledSkills', value: [] })
    assert.equal(skillSwitch(tree, 'caveman').props.checked, true)
    assert.match(textOf(tree), /模型可见 1/)
  } finally {
    clearPanelGlobals()
  }
})

test('skills panel: a refused write rolls the switch back with a message', async () => {
  const { tree: initial, panelForm, page, props } = await mountSidebarPanel({ panelOptions: { setResult: false } })
  try {
    let tree = initial
    assert.equal(skillSwitch(tree, 'caveman').props.checked, true)
    skillSwitch(tree, 'caveman').props.onChange({ target: { checked: false } })
    tree = await settle(page, props)
    assert.deepEqual(panelForm.writes, [{ field: 'disabledSkills', value: ['caveman'] }])
    assert.equal(skillSwitch(tree, 'caveman').props.checked, true)
    assert.match(textOf(tree), /宿主拒绝了这次修改/)
  } finally {
    clearPanelGlobals()
  }
})

test('skills panel: a throwing write rolls back and surfaces the failure', async () => {
  const { tree: initial, page, props } = await mountSidebarPanel({
    panelOptions: {
      onSet: () => {
        throw new Error('写入失败：连接中断')
      },
    },
  })
  try {
    let tree = initial
    skillSwitch(tree, 'caveman').props.onChange({ target: { checked: false } })
    tree = await settle(page, props)
    assert.equal(skillSwitch(tree, 'caveman').props.checked, true)
    assert.match(textOf(tree), /连接中断/)
  } finally {
    clearPanelGlobals()
  }
})

test('skills panel: a 500 shows the Host reason and retry fetches again', async () => {
  const { tree: initial, requested, page, props } = await mountSidebarPanel({
    handler: (_url, index) => (index === 1
      ? jsonResponse({ error: 'registry unavailable' }, 500)
      : jsonResponse(PANEL_BODY)),
  })
  try {
    let tree = initial
    assert.equal(requested.length, 1)
    assert.match(textOf(tree), /HTTP 500/)
    assert.match(textOf(tree), /registry unavailable/)

    const [retry] = collect(tree, (node) => node.type === 'button' && textOf(node).includes('重试'))
    assert.ok(retry, 'a retry button is rendered')
    retry.props.onClick()
    tree = await settle(page, props) // starts the second request
    tree = await settle(page, props) // renders its answer
    assert.equal(requested.length, 2)
    assert.match(textOf(tree), /caveman/)
  } finally {
    clearPanelGlobals()
  }
})

test('skills panel: 404 explains that the Host has not mounted the panel yet', async () => {
  const missing = await mountSidebarPanel({ body: { error: 'not found' }, status: 404 })
  try {
    assert.match(textOf(missing.tree), /HTTP 404/)
    assert.match(textOf(missing.tree), /重启 dsh web/)
  } finally {
    clearPanelGlobals()
  }
})

test('skills panel: 401 and transport failures read as actionable messages', async () => {
  const unauthorized = await mountSidebarPanel({ body: { error: 'unauthorized' }, status: 401 })
  try {
    assert.match(textOf(unauthorized.tree), /登录状态已过期/)
  } finally {
    clearPanelGlobals()
  }

  const offline = await mountSidebarPanel({
    handler: () => {
      throw new TypeError('fetch failed')
    },
  })
  try {
    assert.match(textOf(offline.tree), /无法连接宿主服务/)
  } finally {
    clearPanelGlobals()
  }
})

test('skills panel: the row page mounts the same panel without a session query', async () => {
  const mounted = await mountClient()
  const page = mounted.registrations.find(({ options }) => options.key === '@xi4z/dsh-utils#utils-agents').component
  const requested = []
  globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }
  globalThis.fetch = async (url) => {
    requested.push(String(url))
    return jsonResponse(PANEL_BODY)
  }
  try {
    let tree = render(createElement(page, {}))
    tree = await settle(page, {})
    const url = new URL(requested[0])
    assert.equal(url.pathname, '/api/dsh-utils/skill-panel/list')
    assert.equal(url.searchParams.has('sessionId'), false)
    assert.match(textOf(tree), /共 2 个 · 模型可见 1/)
  } finally {
    clearPanelGlobals()
  }
})

test('skills panel: an empty catalog says so instead of rendering a bare list', async () => {
  const { tree } = await mountSidebarPanel({
    body: { sessionId: 'sess-1', cwd: '/root/core', complete: true, skills: [], disabledSkills: [] },
  })
  try {
    assert.match(textOf(tree), /当前没有可读取的技能/)
  } finally {
    clearPanelGlobals()
  }
})

const MANY_SKILLS = Array.from({ length: 9 }, (_, index) => ({
  name: 'bulk-skill-' + (index + 1),
  description: '批量技能',
  source: 'user-dsh',
  provider: 'filesystem',
  path: '/root/core/skills/bulk-skill-' + (index + 1) + '/SKILL.md',
  modelInvocable: true,
  userInvocable: true,
  enabled: true,
}))

test('skills panel: a long catalog starts folded so the config sections stay reachable', async () => {
  const { tree: initial, page, props } = await mountSidebarPanel({
    body: { ...PANEL_BODY, skills: MANY_SKILLS },
  })
  try {
    let tree = initial
    assert.match(textOf(tree), /共 9 个 · 模型可见 9/)
    assert.equal(textOf(tree).includes('bulk-skill-1'), false, 'the folded list renders no rows')

    const [toggle] = collect(tree, (node) => node.type === 'button' && node.props['aria-expanded'] === false)
    assert.ok(toggle, 'a folded list offers an expand control')
    assert.match(textOf(toggle), /展开（9）/)

    toggle.props.onClick()
    tree = await settle(page, props)
    assert.equal(skillSwitch(tree, 'bulk-skill-1').props.checked, true)

    const [collapse] = collect(tree, (node) => node.type === 'button' && node.props['aria-expanded'] === true)
    assert.ok(collapse, 'an open list offers a collapse control')
    collapse.props.onClick()
    tree = await settle(page, props)
    assert.equal(textOf(tree).includes('bulk-skill-1'), false, 'collapsing hides the rows again')
  } finally {
    clearPanelGlobals()
  }
})


// ---------------------------------------------------------- utils-agents --

const WB_LIST = {
  sessionId: 'sess-1',
  cwd: '/root/core',
  sessionPreset: 'demo',
  defaultPresetId: 'demo',
  presets: [
    {
      id: 'demo',
      name: 'Demo preset',
      description: '演示预设',
      path: '/root/.dsh/.agent-presets/demo',
      registered: true,
      broken: '',
      skills: [
        { name: 'alpha', description: 'alpha skill', path: 'skills/alpha/SKILL.md', enabled: true, size: 20, mtimeMs: 1000 },
        { name: 'beta', description: 'beta skill', path: 'skills/beta/SKILL.md.disabled', enabled: false, size: 20, mtimeMs: 1000 },
      ],
      agents: {
        id: 'preset:ZGVtby1wcmVzZXQ:AGENTS.md',
        label: 'AGENTS.md',
        path: '/root/.dsh/.agent-presets/demo/AGENTS.md',
        presetId: 'demo',
        kind: 'agents',
        exists: false,
        editable: true,
        size: 0,
        mtimeMs: null,
      },
    },
    {
      id: 'other',
      name: 'Other',
      description: '',
      path: '/root/.dsh/.agent-presets/other',
      skills: [],
      agents: {
        id: 'preset:b3RoZXI:AGENTS.md',
        label: 'AGENTS.md',
        path: '/root/.dsh/.agent-presets/other/AGENTS.md',
        presetId: 'other',
        kind: 'agents',
        exists: false,
        editable: true,
        size: 0,
        mtimeMs: null,
      },
    },
  ],
  global: {
    id: '__global__',
    name: '全局 / 项目',
    files: [
      {
        id: 'global:Z2xvYmFs',
        label: 'AGENTS.md',
        path: '/root/.dsh/AGENTS.md',
        presetId: '__global__',
        kind: 'global',
        scope: '用户全局 · $DSH_HOME',
        exists: true,
        editable: true,
        size: 12,
        mtimeMs: 1000,
      },
    ],
  },
}

const WB_FILES = {
  presetId: 'demo',
  preset: WB_LIST.presets[0],
  files: [
    WB_LIST.presets[0].agents,
    {
      id: 'preset:ZGVtby1wcmVzZXQ:c2tpbGxzL2FscGhhL1NLSUxMLm1k',
      label: 'skills/alpha/SKILL.md',
      path: '/root/.dsh/.agent-presets/demo/skills/alpha/SKILL.md',
      presetId: 'demo',
      kind: 'skill',
      exists: true,
      editable: true,
      size: 20,
      mtimeMs: 1000,
    },
    {
      id: 'preset:ZGVtby1wcmVzZXQ:c2tpbGxzL2JldGEvU0tJTEwubWQuZGlzYWJsZWQ',
      label: 'skills/beta/SKILL.md.disabled',
      path: '/root/.dsh/.agent-presets/demo/skills/beta/SKILL.md.disabled',
      presetId: 'demo',
      kind: 'skill',
      exists: true,
      editable: true,
      size: 20,
      mtimeMs: 1000,
    },
    {
      id: 'preset:ZGVtby1wcmVzZXQ:bm90ZXMubWQ',
      label: 'notes.md',
      path: '/root/.dsh/.agent-presets/demo/notes.md',
      presetId: 'demo',
      kind: 'reference',
      exists: true,
      editable: true,
      size: 10,
      mtimeMs: 1000,
    },
  ],
}

const WB_REPO = {
  state: {
    repoUrl: 'https://github.com/xi4z/skills',
    branch: 'Agent',
    targetSubdir: 'skills-repo',
    keyPath: '',
    recurseSubmodules: true,
    lastSync: null,
  },
  target: '/root/.dsh/.agent-presets/demo/skills/skills-repo',
  status: { exists: false, isRepo: false, branch: null, commit: null, dirty: false, skills: 0 },
  key: { source: 'none', hasStoredKey: false },
}

function wbFileOf(id) {
  return WB_FILES.files.find((file) => file.id === id) ?? WB_FILES.files[0]
}

/** Mount the Utils sidebar body with a route-aware fake fetch. */
async function mountWorkbench({ handler } = {}) {
  const mounted = await mountClient()
  const page = mounted.registrations.find(
    ({ options }) => options.name === 'sidebar.right.pane.tab' && options.key === 'utils-agents',
  ).component
  assert.ok(page, 'the Utils pane body is registered')
  const requested = []
  globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }
  globalThis.fetch = async (url, init) => {
    const entry = {
      url: String(url),
      path: new URL(String(url)).pathname,
      method: (init ?? {}).method ?? 'GET',
      body: typeof (init ?? {}).body === 'string' ? JSON.parse(init.body) : null,
    }
    requested.push(entry)
    if (handler !== undefined) return handler(entry, requested.length)
    if (entry.path.endsWith('/list')) return jsonResponse(WB_LIST)
    if (entry.path.endsWith('/files')) return jsonResponse(WB_FILES)
    if (entry.path.endsWith('/repo')) {
      if (entry.method === 'POST') return jsonResponse({ ...WB_REPO, state: { ...WB_REPO.state, ...entry.body } })
      return jsonResponse(WB_REPO)
    }
    if (entry.path.endsWith('/key')) return jsonResponse({ key: { source: entry.body.key === '' ? 'none' : 'stored', hasStoredKey: entry.body.key !== '' }, state: WB_REPO.state })
    if (entry.path.endsWith('/update')) {
      if (entry.method === 'POST') {
        return jsonResponse({
          update: { current: '0.4.1', latest: '0.5.0', updateAvailable: true, source: 'npm', origin: 'https://registry.npmjs.org', checkedAt: '2026-11-21T00:00:00.000Z', attemptedAt: '2026-11-21T00:00:00.000Z', error: null },
          schedule: { enabled: true, intervalHours: 6, registry: 'https://registry.npmjs.org' },
        })
      }
      return jsonResponse({
        update: { current: '0.4.1', latest: null, updateAvailable: false, source: 'npm', origin: 'https://registry.npmjs.org', checkedAt: null, attemptedAt: null, error: null },
        schedule: { enabled: true, intervalHours: 6, registry: 'https://registry.npmjs.org' },
      })
    }
    if (entry.path.endsWith('/deploy-key')) {
      if (entry.method === 'POST') return jsonResponse({ key: { source: entry.body.key === '' ? 'none' : 'global', hasStoredKey: entry.body.key !== '' } })
      return jsonResponse({ key: { source: 'none', hasStoredKey: false } })
    }
    if (entry.path.endsWith('/sync')) return jsonResponse({ ...WB_REPO, state: { ...WB_REPO.state, lastSync: { at: '2026-11-20T00:00:00.000Z', ok: true, commit: 'abcdef1234567890', skills: 2, message: '已 clone 分支 Agent' } } })
    if (entry.path.endsWith('/skill')) {
      const file = WB_FILES.files.find((candidate) => candidate.label === entry.body.path) ?? WB_FILES.files[1]
      return jsonResponse({ skill: { name: file.label.includes('alpha') ? 'alpha' : 'beta', description: '', path: entry.body.enabled ? file.label.replace(/\.disabled$/, '') : file.label.replace(/\.md$/, '.md.disabled'), enabled: entry.body.enabled, size: 20, mtimeMs: 1000 } })
    }
    if (entry.path.endsWith('/file')) {
      if (entry.method === 'POST') {
        const file = wbFileOf(entry.body.id)
        return jsonResponse({ file: { ...file, exists: true, size: entry.body.content.length, mtimeMs: 2000 }, bytes: entry.body.content.length })
      }
      const id = new URL(entry.url).searchParams.get('id')
      const file = wbFileOf(id)
      const content = entry.body === null && id !== WB_FILES.files[0].id ? '# skill\n' : ''
      return jsonResponse({ file, content })
    }
    return jsonResponse({ error: 'unexpected route' }, 500)
  }
  const props = { sessionId: 'sess-1' }
  let tree = render(createElement(page, props))
  for (let pass = 0; pass < 6; pass += 1) tree = await settle(page, props)
  return { ...mounted, page, props, tree, requested }
}

/** The input/textarea/select inside a dswb label row. */
function wbField(tree, label) {
  const labels = collect(tree, (node) => node.type === 'label'
    && Array.isArray(node.children)
    && node.children.some((child) => child !== null && typeof child === 'object'
      && child.type === 'span' && child.props?.className === 'dswb-label' && textOf(child) === label))
  assert.ok(labels.length > 0, 'field ' + label + ' is rendered')
  const [control] = collect(labels[0], (node) => ['input', 'textarea', 'select'].includes(node.type))
  assert.ok(control, 'field ' + label + ' carries a control')
  return control
}

/** Click the first button whose text includes the given label. */
function wbButton(tree, label) {
  const [button] = collect(tree, (node) => node.type === 'button' && textOf(node).includes(label))
  assert.ok(button, 'button ' + label + ' is rendered')
  return button
}

test('utils panel: lists presets, skills, and defaults to the session preset', async () => {
  const { tree, requested } = await mountWorkbench()
  try {
    assert.equal(requested.some((entry) => entry.path.endsWith('/list')), true)
    assert.equal(requested.some((entry) => entry.path.endsWith('/files') && entry.url.includes('presetId=demo')), true)
    assert.equal(requested.some((entry) => entry.path.endsWith('/repo') && entry.url.includes('presetId=demo')), true)
    const text = textOf(tree)
    assert.match(text, /utils-agents/)
    assert.match(text, /Demo preset/)
    assert.match(text, /alpha/)
    assert.match(text, /beta/)
    assert.match(text, /已启用/)
    assert.match(text, /已关闭/)
    assert.match(text, /技能 · 1\/2/)
    assert.match(text, /已注册到 DSH/)
    const [select] = collect(tree, (node) => node.type === 'select')
    assert.equal(select.props.value, 'demo')
  } finally {
    clearPanelGlobals()
  }
})

test('utils panel: toggling a skill posts the preset and path, then refreshes', async () => {
  const { tree, page, props, requested } = await mountWorkbench()
  try {
    wbButton(tree, '关闭').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let next = render(createElement(page, props))
    next = await settle(page, props)
    const toggle = requested.find((entry) => entry.path.endsWith('/skill'))
    assert.ok(toggle, 'a skill toggle request was sent')
    assert.deepEqual(toggle.body, { presetId: 'demo', path: 'skills/alpha/SKILL.md', enabled: false })
    assert.match(textOf(next), /已关闭 alpha/)
  } finally {
    clearPanelGlobals()
  }
})

test('utils panel: edits and saves the selected Markdown file', async () => {
  const { tree, page, props, requested } = await mountWorkbench()
  try {
    wbButton(tree, 'Markdown').props.onClick()
    let next = render(createElement(page, props))
    next = await settle(page, props)
    const [editor] = collect(next, (node) => node.props?.className === 'dswb-editor')
    assert.ok(editor, 'the markdown editor is rendered')
    assert.equal(editor.props.value, '')
    editor.props.onChange({ target: { value: '# preset agents\n' } })
    next = render(createElement(page, props))
    const save = wbButton(next, '保存')
    await save.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    next = render(createElement(page, props))
    const write = requested.find((entry) => entry.path.endsWith('/file') && entry.method === 'POST')
    assert.ok(write, 'a file write was sent')
    assert.equal(write.body.content, '# preset agents\n')
    assert.match(textOf(next), /已保存/)
  } finally {
    clearPanelGlobals()
  }
})

test('utils panel: repository tab saves settings and syncs', async () => {
  const { tree, page, props, requested } = await mountWorkbench()
  try {
    wbButton(tree, '技能仓库').props.onClick()
    let next = render(createElement(page, props))
    next = await settle(page, props)
    assert.equal(wbField(next, '仓库地址').props.value, 'https://github.com/xi4z/skills')
    assert.equal(wbField(next, '分支').props.value, 'Agent')

    wbField(next, '分支').props.onChange({ target: { value: 'main' } })
    next = render(createElement(page, props))
    await wbButton(next, '保存设置').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    next = render(createElement(page, props))
    const saved = requested.find((entry) => entry.path.endsWith('/repo') && entry.method === 'POST')
    assert.ok(saved, 'a repo config write was sent')
    assert.equal(saved.body.presetId, 'demo')
    assert.equal(saved.body.branch, 'main')

    wbButton(next, '同步（拉取）').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    next = render(createElement(page, props))
    assert.equal(requested.some((entry) => entry.path.endsWith('/sync') && entry.method === 'POST'), true)
    assert.match(textOf(next), /已 clone 分支 Agent/)
  } finally {
    clearPanelGlobals()
  }
})

test('utils panel: shows the running version and checks for updates', async () => {
  const { tree, page, props, requested } = await mountWorkbench()
  try {
    assert.match(textOf(tree), /v0\.4\.1/)
    assert.match(textOf(tree), /检查更新/)
    wbButton(tree, '检查更新').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let next = render(createElement(page, props))
    next = await settle(page, props)
    const check = requested.find((entry) => entry.path.endsWith('/update') && entry.method === 'POST')
    assert.ok(check, 'a version check request was sent')
    assert.match(textOf(next), /有新版本 0\.5\.0/)
  } finally {
    clearPanelGlobals()
  }
})

test('utils panel: reports an applied automatic update', async () => {
  const { tree } = await mountWorkbench({
    handler: (entry) => {
      if (entry.path.endsWith('/update')) {
        return jsonResponse({
          update: {
            current: '0.4.1', latest: '0.5.0', updateAvailable: true, source: 'npm',
            origin: 'https://registry.npmjs.org', checkedAt: '2026-11-21T00:00:00.000Z',
            attemptedAt: '2026-11-21T00:00:00.000Z', error: null,
            install: { phase: 'installed', version: '0.5.0', message: '已安装，重启 dsh web 后生效', at: '2026-11-21T00:00:00.000Z' },
          },
          schedule: { enabled: true, intervalHours: 6, registry: 'https://registry.npmjs.org' },
        })
      }
      return jsonResponse({ error: 'not found' }, 404)
    },
  })
  try {
    assert.match(textOf(tree), /已自动更新到 0\.5\.0/)
    assert.match(textOf(tree), /重启 dsh web 生效/)
  } finally {
    clearPanelGlobals()
  }
})

test('utils panel: saves the panel-wide Deploy Key and reports it', async () => {
  const { tree, page, props, requested } = await mountWorkbench()
  try {
    const draft = wbField(tree, '通用 Deploy Key 私钥（保存后不回显）')
    assert.equal(draft.props.value, '')
    draft.props.onChange({ target: { value: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n' } })
    let next = render(createElement(page, props))
    await wbButton(next, '保存通用 Deploy Key').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    next = render(createElement(page, props))
    const saved = requested.find((entry) => entry.path.endsWith('/deploy-key') && entry.method === 'POST')
    assert.ok(saved, 'a panel-wide deploy key write was sent')
    assert.match(saved.body.key, /PRIVATE KEY/)
    assert.match(textOf(next), /当前：已保存通用 Deploy Key/)
    wbButton(next, '清除').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    next = render(createElement(page, props))
    const cleared = requested.filter((entry) => entry.path.endsWith('/deploy-key') && entry.method === 'POST')
    assert.equal(cleared.at(-1).body.key, '')
    assert.match(textOf(next), /当前：未设置/)
  } finally {
    clearPanelGlobals()
  }
})

test('utils panel: 404 explains that the utils-agents row is not mounted', async () => {
  const { tree } = await mountWorkbench({ handler: () => jsonResponse({ error: 'not found' }, 404) })
  try {
    assert.match(textOf(tree), /HTTP 404/)
    assert.match(textOf(tree), /utils-agents/)
    assert.match(textOf(tree), /重启 dsh web/)
  } finally {
    clearPanelGlobals()
  }
})
