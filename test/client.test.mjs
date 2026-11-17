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

// ------------------------------------------------------------- host doubles --

function fakeForm(initialValue, { status = 'ready', writable = true, revision = 7 } = {}) {
  const calls = []
  let value = initialValue
  const form = {
    calls,
    getSnapshot: () => ({ status, writable, value, revision }),
    mutate: async (ops, at) => {
      calls.push({ ops, revision: at })
      value = { ...value }
      for (const op of ops) value[op.path[0]] = op.value
      return true
    },
    dispose: () => {},
  }
  return form
}

function fakeCtx({ served = ['skill-recursive', 'dsh-approval-policy'], skillValue, approvalValue, skillOptions, approvalOptions } = {}) {
  const skillForm = fakeForm(skillValue ?? {
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
  }, skillOptions)
  const approvalForm = fakeForm(approvalValue ?? {
    origins: ['subagent', 'scheduled'],
    sessions: [],
    windowSeconds: 300,
    defaultOutcome: 'rejected',
    defaultPermissionPreset: 'auto',
    autoReviewContent: true,
  }, approvalOptions)
  const registrations = []
  const effects = []
  const ctx = {
    configForms: {
      get: (namespace) => (namespace === 'skill-recursive' ? skillForm : approvalForm),
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
    effect: (execute, label) => {
      const cleanup = execute()
      effects.push({ execute: () => cleanup, label })
      return cleanup
    },
  }
  return { ctx, skillForm, approvalForm, registrations, effects }
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
  assert.equal(definition.id, 'dsh-utils')
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

  assert.deepEqual(plugin.inject, ['slots', 'configForms'])
  const keys = registrations.map(({ options }) => `${options.name}:${options.key}`).sort()
  assert.deepEqual(keys, [
    'plugins.row.config:dsh-utils#dsh-approval-policy',
    'plugins.row.config:dsh-utils#skill-recursive',
  ])
})

test('registration follows the namespaces the Host serves', async () => {
  const { registrations } = await mountClient({ served: ['skill-recursive'] })
  const keys = registrations.map(({ options }) => `${options.name}:${options.key}`).sort()
  assert.deepEqual(keys, ['plugins.row.config:dsh-utils#skill-recursive'])
})

test('a served-none deployment registers nothing', async () => {
  const { registrations } = await mountClient({ served: [] })
  assert.deepEqual(registrations, [])
})

test('skill page: initial draft reflects the Host values and saving writes only the changed field', async () => {
  const { registrations, skillForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === 'dsh-utils#skill-recursive').component

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
  const page = registrations.find(({ options }) => options.key === 'dsh-utils#skill-recursive').component

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
  const page = registrations.find(({ options }) => options.key === 'dsh-utils#skill-recursive').component

  let tree = render(createElement(page, {}))
  fieldControl(tree, '忽略的目录名').props.onChange({ target: { value: '.git\n\n  node_modules  \n' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(skillForm.calls[0].ops, [{ op: 'set', path: ['ignoreDirs'], value: ['.git', 'node_modules'] }])
})

test('skill page: toggling the watch switch writes a boolean', async () => {
  const { registrations, skillForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === 'dsh-utils#skill-recursive').component

  let tree = render(createElement(page, {}))
  checkbox(tree, '监听变化').props.onChange({ target: { checked: false } })
  tree = render(createElement(page, {}))
  await clickSave(tree)

  assert.deepEqual(skillForm.calls[0].ops, [{ op: 'set', path: ['watch'], value: false }])
})

test('approval page: origins are a checkbox set stored in canonical order', async () => {
  const { registrations, approvalForm } = await mountClient()
  const page = registrations.find(({ options }) => options.key === 'dsh-utils#dsh-approval-policy').component

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
  const page = registrations.find(({ options }) => options.key === 'dsh-utils#dsh-approval-policy').component

  let tree = render(createElement(page, {}))
  fieldControl(tree, '应答窗口（秒）').props.onChange({ target: { value: '86401' } })
  tree = render(createElement(page, {}))
  await clickSave(tree)
  tree = render(createElement(page, {}))

  assert.equal(approvalForm.calls.length, 0)
  assert.equal(textOf(tree).includes('不得大于 86400'), true)
})

test('an unwritable form renders read-only and cannot save', async () => {
  const { registrations } = await mountClient({ skillOptions: { writable: false } })
  const page = registrations.find(({ options }) => options.key === 'dsh-utils#skill-recursive').component

  const tree = render(createElement(page, {}))
  assert.equal(fieldControl(tree, '最小深度').props.disabled, true)
  const [save] = collect(tree, (node) => node.type === 'button')
  assert.equal(save.props.disabled, true)
})

test('a loading or unavailable namespace says so instead of rendering empty inputs', async () => {
  const unavailable = await mountClient({ skillOptions: { status: 'unavailable' } })
  const unavailablePage = unavailable.registrations.find(({ options }) => options.key === 'dsh-utils#skill-recursive').component
  assert.equal(textOf(render(createElement(unavailablePage, {}))).includes('没有向浏览器暴露'), true)

  const loading = await mountClient({ skillOptions: { status: 'loading' } })
  const loadingPage = loading.registrations.find(({ options }) => options.key === 'dsh-utils#skill-recursive').component
  assert.equal(textOf(render(createElement(loadingPage, {}))).includes('正在读取配置'), true)
})

test('the plugin disposes the forms it owns through an effect', async () => {
  const { effects, skillForm, approvalForm } = await mountClient()
  let skillDisposed = false
  let approvalDisposed = false
  skillForm.dispose = () => { skillDisposed = true }
  approvalForm.dispose = () => { approvalDisposed = true }
  const formsEffect = effects.find((entry) => entry.label === 'dsh-utils: configuration forms')
  assert.ok(formsEffect, 'the forms effect is registered')
  formsEffect.execute()()
  assert.equal(skillDisposed, true)
  assert.equal(approvalDisposed, true)
})
