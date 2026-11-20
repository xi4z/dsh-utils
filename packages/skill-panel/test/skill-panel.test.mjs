import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAbsolute } from 'node:path'
import { apply, Config, inject, name, ROUTE_PATH } from '../lib/index.js'

// ---------------------------------------------------------------- helpers --

/** One registry summary with the invocation controls the host expects. */
function skill(skillName, overrides = {}) {
  return {
    name: skillName,
    description: `Describe ${skillName}.`,
    source: 'user-dsh',
    provider: 'filesystem',
    path: `/skills/${skillName}/SKILL.md`,
    invocation: { modelInvocable: true, userInvocable: true },
    ...overrides,
  }
}

/** Registry whose discovery methods live on the prototype, like the real service. */
class FakeRegistry {
  constructor(catalogue) {
    this.catalogue = catalogue
    this.listCalls = []
    this.snapshotCalls = []
    this.getCalls = []
  }

  async list(options = {}) {
    this.listCalls.push(options)
    return this.catalogue
  }

  async snapshot(options = {}) {
    this.snapshotCalls.push(options)
    return { skills: this.catalogue, complete: true }
  }

  async get(skillName, options = {}) {
    this.getCalls.push([skillName, options])
    return { name: skillName, provider: 'filesystem', content: 'body' }
  }
}

/** Connection stub whose registered routes can be invoked directly. */
function fakeConnection() {
  const routes = []
  return {
    routes,
    fetch: {
      register(route) {
        routes.push(route)
        return async () => {
          route.removed = true
        }
      },
    },
  }
}

/**
 * Fake host context: effects execute immediately (as Cordis does) and their
 * disposers are retained so a test can unload the component.
 */
function fakeCtx({ skills, connection, services = {} } = {}) {
  const ctx = {
    skills,
    services: { ...services, ...(connection === undefined ? {} : { connection }) },
    effects: [],
    injects: [],
    warnings: [],
    get(serviceName) {
      return ctx.services[serviceName]
    },
    effect(execute, label) {
      ctx.effects.push({ label, disposer: execute() })
      return () => {}
    },
    inject(deps, callback) {
      ctx.injects.push([...deps])
      // Cordis leaves the callback pending until the service exists; this stub
      // mirrors the non-web path instead of calling it with undefined.
      if (ctx.services.connection === undefined) return
      callback({
        connection: ctx.services.connection,
        skills: ctx.skills,
        get: ctx.get,
        logger: ctx.logger,
        effect: ctx.effect,
      })
    },
    logger: {
      warn(message) {
        ctx.warnings.push(String(message))
      },
      info() {},
      error(message) {
        ctx.warnings.push(String(message))
      },
      debug() {},
    },
  }
  return ctx
}

/** Unload every effect the component registered, newest first. */
async function dispose(ctx) {
  for (const entry of [...ctx.effects].reverse()) {
    if (typeof entry.disposer === 'function') await entry.disposer()
  }
}

/** Invoke the single registered list route. */
function routeOf(connection) {
  assert.equal(connection.routes.length, 1, 'exactly one route is registered')
  return connection.routes[0]
}

/** Fetch one panel payload from a route stub. */
async function fetchPanel(route, query = '') {
  return route.fetch(new Request(`http://localhost${ROUTE_PATH}${query}`))
}

// ------------------------------------------------------------- module shape --

test('the component exports the plugin identity the bundle patch mounts', () => {
  assert.equal(name, 'skill-panel')
  assert.deepEqual(inject, ['skills'])
  assert.equal(typeof Config, 'function')
  assert.equal(ROUTE_PATH, '/api/dsh-utils/skill-panel/list')
})

test('Config defaults disabledSkills to an empty volatile list', () => {
  const resolved = Config({})
  assert.equal(typeof resolved.disabledSkills.get, 'function')
  assert.deepEqual(resolved.disabledSkills.get(), [])
})

// ---------------------------------------------------------------- filtering --

test('list and snapshot mark disabled skills model-uninvocable, leaving originals intact', async () => {
  const alpha = skill('alpha')
  const beta = skill('beta')
  const registry = new FakeRegistry([alpha, beta])
  const ctx = fakeCtx({ skills: registry })
  apply(ctx, { disabledSkills: ['beta'] })

  const listed = await registry.list({ cwd: '/work' })
  assert.equal(listed.length, 2)
  assert.equal(listed[0], alpha, 'an enabled skill keeps its identity')
  assert.equal(listed[1].name, 'beta')
  assert.equal(listed[1].invocation.modelInvocable, false)
  assert.equal(listed[1].invocation.userInvocable, true)
  assert.equal(beta.invocation.modelInvocable, true, 'the registry entry is not mutated')

  const snapshot = await registry.snapshot({ cwd: '/work' })
  assert.equal(snapshot.complete, true)
  assert.equal(snapshot.skills[1].invocation.modelInvocable, false)
  assert.equal(beta.invocation.modelInvocable, true)
})

test('an empty disabled list returns the registry arrays unchanged', async () => {
  const registry = new FakeRegistry([skill('alpha')])
  const ctx = fakeCtx({ skills: registry })
  apply(ctx, { disabledSkills: [] })

  assert.equal(await registry.list({}), registry.catalogue)
  const snapshot = await registry.snapshot({})
  assert.equal(snapshot.skills, registry.catalogue)
})

test('get is not wrapped, so manual invocation still loads a disabled skill', async () => {
  const registry = new FakeRegistry([skill('alpha')])
  const ctx = fakeCtx({ skills: registry })
  apply(ctx, { disabledSkills: ['alpha'] })

  assert.equal(Object.hasOwn(registry, 'get'), false)
  const loaded = await registry.get('alpha')
  assert.equal(loaded.content, 'body')
})

test('the disabled set is re-read from the volatile reference on every call', async () => {
  let disabled = []
  const live = {
    get() {
      return disabled
    },
  }
  const registry = new FakeRegistry([skill('alpha')])
  const ctx = fakeCtx({ skills: registry })
  apply(ctx, { disabledSkills: live })

  assert.equal((await registry.list({}))[0].invocation.modelInvocable, true)
  disabled = ['alpha']
  assert.equal((await registry.list({}))[0].invocation.modelInvocable, false)
  disabled = []
  assert.equal((await registry.list({}))[0].invocation.modelInvocable, true)
})

test('non-string and blank entries are ignored, and names are trimmed and de-duplicated', async () => {
  const registry = new FakeRegistry([skill('alpha')])
  const connection = fakeConnection()
  const ctx = fakeCtx({ skills: registry, connection })
  apply(ctx, { disabledSkills: [' alpha ', 'alpha', '', '  ', 42, null] })

  assert.equal((await registry.list({}))[0].invocation.modelInvocable, false)
  const body = await (await fetchPanel(routeOf(connection))).json()
  assert.deepEqual(body.disabledSkills, ['alpha'])
})

// ------------------------------------------------------------------ restore --

test('dispose restores inherited methods and inherited shadowing', async () => {
  const registry = new FakeRegistry([skill('alpha')])
  const ctx = fakeCtx({ skills: registry })
  apply(ctx, { disabledSkills: ['alpha'] })

  assert.equal(Object.hasOwn(registry, 'list'), true)
  assert.equal(Object.hasOwn(registry, 'snapshot'), true)
  assert.equal((await registry.list({}))[0].invocation.modelInvocable, false)

  await dispose(ctx)
  assert.equal(Object.hasOwn(registry, 'list'), false)
  assert.equal(Object.hasOwn(registry, 'snapshot'), false)
  assert.equal((await registry.list({}))[0].invocation.modelInvocable, true)
  assert.equal((await registry.snapshot({})).skills[0].invocation.modelInvocable, true)
})

test('dispose restores own methods with their original descriptor', async () => {
  const ownList = async () => [skill('alpha')]
  const ownSnapshot = async () => ({ skills: [skill('alpha')], complete: false })
  const registry = { list: ownList, snapshot: ownSnapshot }
  const ctx = fakeCtx({ skills: registry })
  apply(ctx, { disabledSkills: ['alpha'] })

  assert.notEqual(registry.list, ownList)
  assert.notEqual(registry.snapshot, ownSnapshot)

  await dispose(ctx)
  assert.equal(registry.list, ownList)
  assert.equal(registry.snapshot, ownSnapshot)
  assert.equal((await registry.snapshot({})).complete, false)
})

// --------------------------------------------------------------- list route --

test('the list route serves a sorted payload with unwrapped model flags', async () => {
  const registry = new FakeRegistry([
    skill('zeta'),
    skill('alpha', { whenToUse: 'Use alpha.' }),
    skill('beta', { invocation: { modelInvocable: false, userInvocable: true } }),
  ])
  const connection = fakeConnection()
  const ctx = fakeCtx({
    skills: registry,
    connection,
    services: { workingDirectory: { defaultDirectory: '/default/work' } },
  })
  apply(ctx, { disabledSkills: [' beta ', 'beta', 'alpha'] })

  const route = routeOf(connection)
  assert.equal(route.path, '/api/dsh-utils/skill-panel/list')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')

  const response = await fetchPanel(route)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type'), /application\/json/)

  const body = await response.json()
  assert.equal(body.sessionId, null)
  assert.equal(body.cwd, '/default/work')
  assert.equal(body.complete, true)
  assert.deepEqual(body.disabledSkills, ['beta', 'alpha'])
  assert.deepEqual(body.skills.map((entry) => entry.name), ['alpha', 'beta', 'zeta'])

  const [alpha, beta, zeta] = body.skills
  assert.equal(alpha.description, 'Describe alpha.')
  assert.equal(alpha.whenToUse, 'Use alpha.')
  assert.equal(alpha.source, 'user-dsh')
  assert.equal(alpha.provider, 'filesystem')
  assert.equal(alpha.path, '/skills/alpha/SKILL.md')
  assert.equal(alpha.modelInvocable, true)
  assert.equal(alpha.userInvocable, true)
  assert.equal(alpha.enabled, false, 'disabled even though the registry says model-invocable')

  assert.equal(beta.modelInvocable, false)
  assert.equal(beta.enabled, false)
  assert.equal(zeta.enabled, true)

  assert.equal(body.skills.length, 3, 'the route reads the unwrapped list and sees disabled skills')
  const options = registry.snapshotCalls.at(-1)
  assert.equal(options.cwd, '/default/work')
  assert.equal(options.scope, undefined)
  assert.ok(isAbsolute(body.cwd))
})

test('the list route uses the live agent cwd, scope, and preset skill layer', async () => {
  const hostRegistry = new FakeRegistry([skill('host-skill')])
  const scopedRegistry = new FakeRegistry([skill('scoped-skill')])
  const agent = { id: 'session-1', session: { header: { cwd: '/header/work' } } }
  const ensureCalls = []
  const presetCalls = []
  const agents = {
    get(id) {
      return id === 'session-1' ? agent : undefined
    },
  }
  const workingDirectory = {
    defaultDirectory: '/default/work',
    async ensure(candidate, signal) {
      ensureCalls.push([candidate, signal])
      return '/ensured/work'
    },
  }
  const agentPresets = {
    serviceFor(candidate, serviceName) {
      presetCalls.push([candidate, serviceName])
      return scopedRegistry
    },
  }
  const connection = fakeConnection()
  const ctx = fakeCtx({
    skills: hostRegistry,
    connection,
    services: { agents, workingDirectory, agentPresets },
  })
  apply(ctx, {})

  const body = await (await fetchPanel(routeOf(connection), '?sessionId=session-1')).json()
  assert.equal(body.sessionId, 'session-1')
  assert.equal(body.cwd, '/ensured/work')
  assert.deepEqual(body.skills.map((entry) => entry.name), ['scoped-skill'])
  assert.equal(presetCalls.length, 1)
  assert.equal(presetCalls[0][0], agent)
  assert.equal(presetCalls[0][1], 'skills')
  assert.equal(ensureCalls.length, 1)
  assert.equal(ensureCalls[0][0], agent)
  assert.equal(scopedRegistry.snapshotCalls[0].scope, agent)
  assert.equal(scopedRegistry.snapshotCalls[0].cwd, '/ensured/work')
  assert.equal(hostRegistry.snapshotCalls.length, 0)
})

test('a scoped proxy for the same registry still lists through the unwrapped host function', async () => {
  const hostRegistry = new FakeRegistry([skill('alpha'), skill('beta')])
  // `agentPresets.serviceFor` may return another traceable proxy for the same
  // service. Cordis exposes the underlying service under this symbol.
  const scopedProxy = {
    [Symbol.for('cordis.original')]: hostRegistry,
    async list() {
      const skills = await hostRegistry.list()
      return skills.map((item) => ({ ...item, invocation: { ...item.invocation, modelInvocable: false } }))
    },
    async snapshot() {
      throw new Error('unused')
    },
  }
  const agent = { id: 'session-1', session: { header: { cwd: '/header/work' } } }
  const connection = fakeConnection()
  const ctx = fakeCtx({
    skills: hostRegistry,
    connection,
    services: {
      agents: { get: (id) => (id === 'session-1' ? agent : undefined) },
      workingDirectory: { defaultDirectory: '/default/work', async ensure() { return '/ensured/work' } },
      agentPresets: { serviceFor: () => scopedProxy },
    },
  })
  apply(ctx, { disabledSkills: ['beta'] })

  const body = await (await fetchPanel(routeOf(connection), '?sessionId=session-1')).json()
  const byName = Object.fromEntries(body.skills.map((entry) => [entry.name, entry]))
  assert.equal(byName.alpha.modelInvocable, true)
  assert.equal(byName.beta.modelInvocable, true, 'the panel sees the unwrapped catalog')
  assert.equal(byName.beta.enabled, false, 'the disabled switch stays off but is readable')
  assert.equal(hostRegistry.snapshotCalls.length, 1, 'the unwrapped host snapshot served the panel')
  assert.equal(hostRegistry.listCalls.length, 0, 'the pinned list is never consulted')
})

test('an unknown session falls back to the default cwd and host registry', async () => {
  const hostRegistry = new FakeRegistry([skill('host-skill')])
  const agents = { get: () => undefined }
  const connection = fakeConnection()
  const ctx = fakeCtx({
    skills: hostRegistry,
    connection,
    services: { agents, workingDirectory: { defaultDirectory: '/default/work' } },
  })
  apply(ctx, {})

  const body = await (await fetchPanel(routeOf(connection), '?sessionId=missing')).json()
  assert.equal(body.sessionId, 'missing')
  assert.equal(body.cwd, '/default/work')
  assert.deepEqual(body.skills.map((entry) => entry.name), ['host-skill'])
  assert.equal(hostRegistry.snapshotCalls.length, 1)
})

test('a discovery failure becomes a 500 JSON response and a warning', async () => {
  const registry = new FakeRegistry([])
  registry.snapshot = async () => {
    throw new Error('boom')
  }
  const connection = fakeConnection()
  const ctx = fakeCtx({ skills: registry, connection })
  apply(ctx, {})

  const response = await fetchPanel(routeOf(connection))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'boom' })
  assert.ok(ctx.warnings.some((warning) => warning.includes('cannot list skills')))
})

// ---------------------------------------------------------------- lifecycle --

test('without Connection the panel silently skips the route', () => {
  const registry = new FakeRegistry([skill('alpha')])
  const ctx = fakeCtx({ skills: registry })
  apply(ctx, { disabledSkills: ['alpha'] })

  assert.deepEqual(ctx.injects, [['connection']])
  assert.equal(ctx.warnings.length, 0)
  assert.equal(ctx.effects.length, 1, 'only the catalog filter effect is registered')
})

test('a route registration failure is logged, not swallowed or thrown', () => {
  const registry = new FakeRegistry([skill('alpha')])
  const connection = {
    fetch: {
      register() {
        throw new Error('route already registered')
      },
    },
  }
  const ctx = fakeCtx({ skills: registry, connection })
  apply(ctx, {})

  assert.ok(ctx.warnings.some((warning) => warning.includes('cannot register')))
  assert.ok(ctx.warnings.some((warning) => warning.includes('route already registered')))
})

test('the route effect is labelled with its path and removed on dispose', async () => {
  const registry = new FakeRegistry([skill('alpha')])
  const connection = fakeConnection()
  const ctx = fakeCtx({ skills: registry, connection })
  apply(ctx, {})

  const route = routeOf(connection)
  assert.ok(ctx.effects.some((entry) => entry.label === `skill-panel: ${ROUTE_PATH}`))
  await dispose(ctx)
  assert.equal(route.removed, true)
})

// ------------------------------------------------------ real service proxy --

test('real Cordis SkillRegistry: snapshot/list hide disabled skills and get still loads', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill')
  const ctx = new Context()
  new SkillRegistry(ctx)
  ctx.skills.registerProvider(() => ({
    name: 'probe',
    async list() {
      return [
        { name: 'alpha', description: 'A', source: 'user-dsh', provider: 'probe', rank: 100, locator: 'a', invocation: { modelInvocable: true, userInvocable: true } },
        { name: 'beta', description: 'B', source: 'user-dsh', provider: 'probe', rank: 100, locator: 'b', invocation: { modelInvocable: true, userInvocable: true } },
      ]
    },
    async get(candidate) {
      return {
        name: candidate.name,
        description: candidate.description,
        content: 'body',
        provider: 'probe',
        source: 'user-dsh',
        invocation: candidate.invocation,
      }
    },
  }))

  apply(ctx, { disabledSkills: ['beta'] })

  // The traceable proxy is exactly where a bound instance method would have
  // resolved the pinned `snapshot` dynamically; this exercises that real path.
  const snapshot = await ctx.skills.snapshot({ cwd: '/' })
  const byName = Object.fromEntries(snapshot.skills.map((entry) => [entry.name, entry]))
  assert.equal(byName.alpha.invocation.modelInvocable, true)
  assert.equal(byName.beta.invocation.modelInvocable, false)

  const listed = await ctx.skills.list({ cwd: '/' })
  assert.equal(listed.find((entry) => entry.name === 'beta').invocation.modelInvocable, false)

  const loaded = await ctx.skills.get('beta', { cwd: '/' })
  assert.equal(loaded.content, 'body', 'manual loading remains available')
})
