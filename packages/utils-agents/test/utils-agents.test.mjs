import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Config, apply, inject, name, ROUTE_PATHS } from '../lib/index.js'
import { updateSkillRepositories } from '../lib/global-repo.js'
import { autoSyncSharedPresets, sharedManifestPath } from '../lib/shared.js'
import { createUpdateChecker, installCommand, parseGitSpec } from '../lib/update.js'
import { normalizeOptions } from '../lib/util.js'

const runFile = promisify(execFile)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'utils-agents test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'utils-agents test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

async function git(args, cwd) {
  const { stdout } = await runFile('git', args, { cwd, env: GIT_ENV })
  return stdout.trim()
}

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

function fakeCtx(connection, cwd, registry, profileDir) {
  const effects = []
  const services = {
    connection,
    agents: { get: (id) => id === 'test' ? { session: { header: { cwd, agentPreset: 'demo' } } } : undefined },
    workingDirectory: { ensure: async () => cwd },
    agentPresets: registry,
  }
  const servicesWithProfile = { ...services, profileContext: { dir: profileDir } }
  const ctx = {
    effects,
    get(name) {
      return servicesWithProfile[name]
    },
    effect(execute, label) {
      effects.push({ label, disposer: execute() })
      return () => {}
    },
    inject(_deps, callback) {
      callback({ connection, effect: ctx.effect, logger: ctx.logger, get: ctx.get })
    },
    logger: {
      warnings: [],
      warn(message) { this.warnings.push(String(message)) },
      debug() {},
      info() {},
      error(message) { this.warnings.push(String(message)) },
    },
  }
  return ctx
}

async function dispose(ctx) {
  for (const entry of [...ctx.effects].reverse()) {
    if (typeof entry.disposer === 'function') await entry.disposer()
  }
}

function routeFor(connection, path) {
  const route = connection.routes.find((candidate) => candidate.path === path)
  assert.ok(route, 'route ' + path + ' is registered')
  return route
}

async function call(connection, path, options = {}) {
  const route = routeFor(connection, path)
  const query = options.query === undefined ? '' : '?' + new URLSearchParams(options.query)
  const init = { method: options.method ?? 'GET' }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers = { 'content-type': 'application/json' }
  }
  const response = await route.fetch(new Request('http://localhost' + path + query, init))
  const text = await response.text()
  return { response, text, body: text === '' ? undefined : JSON.parse(text) }
}

async function createRepo(dir, skillName = 'from-repo', branch = 'main') {
  await mkdir(join(dir, skillName), { recursive: true })
  await git(['init', '--quiet', '--initial-branch=' + branch], dir)
  await writeFile(join(dir, skillName, 'SKILL.md'), '---\nname: ' + skillName + '\ndescription: cloned skill\n---\n\n# ' + skillName + '\n')
  await git(['add', '--all'], dir)
  await git(['commit', '--quiet', '-m', 'initial'], dir)
  return dir
}

function fakeRegistry() {
  const rows = []
  return {
    rows,
    async register(definition) {
      rows.push(definition)
      return async () => {}
    },
    async list() {
      return rows.map((definition) => ({ id: definition.id }))
    },
  }
}

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wb-'))
  const home = join(root, 'home')
  const agentsHome = join(root, 'agents')
  const project = join(root, 'project')
  const cwd = join(project, 'packages', 'app')
  const preset = join(home, '.agent-presets', 'demo')
  await mkdir(join(preset, 'skills', 'alpha'), { recursive: true })
  await mkdir(join(preset, 'skills', 'beta'), { recursive: true })
  await mkdir(join(preset, 'skills', 'gamma', 'references'), { recursive: true })
  await mkdir(join(home, '.agent-presets', 'other'), { recursive: true })
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(agentsHome, { recursive: true })
  await writeFile(join(home, 'AGENTS.md'), '# user global\n')
  await writeFile(join(project, 'AGENTS.md'), '# project root\n')
  await writeFile(join(preset, 'preset.yml'), 'name: Demo preset\ndescription: 演示预设\n')
  await writeFile(join(preset, 'agent.cordis.yml'), '- id: demo-persona\n  name: cordis:group\n  group: true\n  config: []\n')
  await writeFile(join(preset, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha skill\n---\n\n# alpha\n')
  await writeFile(join(preset, 'skills', 'beta', 'SKILL.md.disabled'), '---\nname: beta\ndescription: beta skill\n---\n\n# beta\n')
  await writeFile(join(preset, 'skills', 'gamma', 'references', 'ref.md'), '# reference\n')
  await writeFile(join(preset, 'notes.md'), '# notes\n')

  const savedHome = process.env.DSH_HOME
  const savedAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = agentsHome
  const connection = fakeConnection()
  const ctx = fakeCtx(connection, cwd, options.registry, home)
  apply(ctx, { maxBytes: 4096, ...(options.config ?? {}) })
  t.after(async () => {
    await dispose(ctx)
    await rm(root, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = savedAgents
  })
  return { root, home, agentsHome, project, cwd, preset, connection, ctx }
}

function fileByLabel(files, label) {
  const row = files.find((file) => file.label === label || file.path.endsWith('/' + label))
  assert.ok(row, 'file ' + label + ' is listed')
  return row
}

test('the merged component exports one identity and one config schema', () => {
  assert.equal(name, 'utils-agents')
  assert.deepEqual(inject, ['skills'])
  assert.equal(typeof Config, 'function')
  const resolved = Config({})
  assert.deepEqual(resolved.disabledSkills.get(), [])
  assert.equal(resolved.minDepth.get(), 2)
  assert.equal(resolved.maxBytes.get(), 524288)
})

test('registers the utils-agents routes', async (t) => {
  const { connection } = await setup(t)
  assert.deepEqual(connection.routes.map((route) => route.path).sort(), Object.values(ROUTE_PATHS).sort())
  const fileRoute = routeFor(connection, ROUTE_PATHS.file)
  assert.deepEqual(fileRoute.methods, ['GET', 'POST'])
  const repoRoute = routeFor(connection, ROUTE_PATHS.repo)
  assert.deepEqual(repoRoute.methods, ['GET', 'POST'])
})

test('list returns presets, skills, AGENTS.md and the global chain', async (t) => {
  const { connection } = await setup(t)
  const { response, body } = await call(connection, ROUTE_PATHS.list, { query: { sessionId: 'test' } })
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.sessionPreset, 'demo')
  assert.equal(body.defaultPresetId, 'demo')
  assert.deepEqual(body.presets.map((preset) => preset.id), ['demo', 'other'])
  const demo = body.presets[0]
  assert.equal(demo.name, 'Demo preset')
  assert.deepEqual(demo.skills.map((skill) => [skill.name, skill.enabled]), [['alpha', true], ['beta', false]])
  assert.equal(demo.agents.exists, false)
  assert.equal(demo.agents.label, 'AGENTS.md')
  assert.equal(body.global.files.some((file) => file.path === join(process.env.DSH_HOME, 'AGENTS.md')), true)
})

test('registers directory presets into the live agent preset registry', async (t) => {
  const registry = fakeRegistry()
  const { connection, preset } = await setup(t, { registry })
  const { response, body } = await call(connection, ROUTE_PATHS.list, { query: { sessionId: 'test' } })
  assert.equal(response.status, 200, JSON.stringify(body))
  const demo = body.presets.find((row) => row.id === 'demo')
  assert.equal(demo.registered, true)
  assert.equal(demo.broken, undefined)
  const other = body.presets.find((row) => row.id === 'other')
  assert.equal(other.registered, false)
  assert.match(other.broken, /缺少 agent\.cordis\.yml/)

  const definition = registry.rows.find((row) => row.id === 'demo')
  assert.ok(definition, 'demo was registered')
  assert.equal(definition.name, 'Demo preset')
  assert.equal(definition.plugins.length, 1)
  assert.equal(definition.plugins[0].name, 'cordis:include')
  assert.match(definition.plugins[0].config.path, /agent\.cordis\.yml$/)
  assert.equal(definition.plugins[0].config.path.startsWith('file://'), true)
  assert.equal(preset.endsWith('demo'), true)
})

test('files lists AGENTS.md first and reads/writes Markdown', async (t) => {
  const { connection, preset } = await setup(t)
  const listed = await call(connection, ROUTE_PATHS.files, { query: { presetId: 'demo' } })
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body))
  assert.equal(listed.body.files[0].label, 'AGENTS.md')
  assert.equal(listed.body.files[0].exists, false)
  const skillFile = fileByLabel(listed.body.files, 'SKILL.md')
  assert.equal(skillFile.kind, 'skill')
  assert.equal(skillFile.editable, true)
  const disabledFile = fileByLabel(listed.body.files, 'SKILL.md.disabled')
  assert.equal(disabledFile.kind, 'skill')
  assert.equal(disabledFile.editable, true)

  const read = await call(connection, ROUTE_PATHS.file, { query: { id: listed.body.files[0].id, sessionId: 'test' } })
  assert.equal(read.response.status, 200)
  assert.equal(read.body.content, '')
  const write = await call(connection, ROUTE_PATHS.file, {
    method: 'POST',
    body: { sessionId: 'test', id: listed.body.files[0].id, content: '# preset agents\n', baseMtimeMs: null },
  })
  assert.equal(write.response.status, 200, JSON.stringify(write.body))
  assert.equal(await readFile(join(preset, 'AGENTS.md'), 'utf8'), '# preset agents\n')

  const stale = await call(connection, ROUTE_PATHS.file, {
    method: 'POST',
    body: { sessionId: 'test', id: listed.body.files[0].id, content: '# changed\n', baseMtimeMs: 1 },
  })
  assert.equal(stale.response.status, 409)
})

test('toggles SKILL.md / SKILL.md.disabled in the selected preset', async (t) => {
  const { connection, preset } = await setup(t)
  const list = await call(connection, ROUTE_PATHS.list, { query: { sessionId: 'test' } })
  const alpha = list.body.presets[0].skills.find((skill) => skill.name === 'alpha')
  const beta = list.body.presets[0].skills.find((skill) => skill.name === 'beta')

  const disabled = await call(connection, ROUTE_PATHS.skill, {
    method: 'POST',
    body: { presetId: 'demo', path: alpha.path, enabled: false },
  })
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.body))
  assert.equal(disabled.body.skill.enabled, false)
  assert.equal(await readFile(join(preset, 'skills', 'alpha', 'SKILL.md.disabled'), 'utf8').then(() => true), true)

  const enabled = await call(connection, ROUTE_PATHS.skill, {
    method: 'POST',
    body: { presetId: 'demo', path: beta.path, enabled: true },
  })
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body))
  assert.equal(enabled.body.skill.enabled, true)
})

test('reads and saves per-preset repository settings and a write-only key', async (t) => {
  const { connection } = await setup(t)
  const initial = await call(connection, ROUTE_PATHS.repo, { query: { presetId: 'demo' } })
  assert.equal(initial.response.status, 200, JSON.stringify(initial.body))
  assert.equal(initial.body.state.repoUrl, 'https://github.com/xi4z/skills')
  assert.equal(initial.body.state.branch, 'Agent')
  assert.equal(initial.body.target.endsWith('skills/skills-repo'), true)
  assert.equal(initial.body.status.exists, false)

  const saved = await call(connection, ROUTE_PATHS.repo, {
    method: 'POST',
    body: { presetId: 'demo', repoUrl: 'https://github.com/example/skills', branch: 'main', targetSubdir: 'vendor', recurseSubmodules: false },
  })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.state.targetSubdir, 'vendor')
  assert.equal(saved.body.target.endsWith('skills/vendor'), true)

  const key = await call(connection, ROUTE_PATHS.key, {
    method: 'POST',
    body: { presetId: 'demo', key: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n' },
  })
  assert.equal(key.response.status, 200, JSON.stringify(key.body))
  assert.equal(key.body.key.source, 'stored')
  assert.equal(JSON.stringify(key.body).includes('PRIVATE KEY'), false)
  const cleared = await call(connection, ROUTE_PATHS.key, { method: 'POST', body: { presetId: 'demo', key: '' } })
  assert.equal(cleared.response.status, 200)
  assert.equal(cleared.body.key.source, 'none')
})

test('stores a panel-wide deploy key that is the fallback for private repositories', async (t) => {
  const { home, connection } = await setup(t)
  const initial = await call(connection, ROUTE_PATHS.deployKey)
  assert.equal(initial.response.status, 200, JSON.stringify(initial.body))
  assert.equal(initial.body.key.source, 'none')

  const saved = await call(connection, ROUTE_PATHS.deployKey, {
    method: 'POST',
    body: { key: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n' },
  })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.key.source, 'global')
  assert.equal(JSON.stringify(saved.body).includes('PRIVATE KEY'), false)
  const stored = await readFile(join(home, 'storages', 'dsh-utils-agents', 'deploy-key'), 'utf8')
  assert.equal(stored.includes('PRIVATE KEY'), true)

  const repo = await call(connection, ROUTE_PATHS.repo, { query: { presetId: 'demo' } })
  assert.equal(repo.body.key.source, 'global', 'the preset repository falls back to the panel-wide key')
  const shared = await call(connection, ROUTE_PATHS.sharedRepo)
  assert.equal(shared.body.key.source, 'global', 'the shared repository falls back to the panel-wide key')

  const presetKey = await call(connection, ROUTE_PATHS.key, {
    method: 'POST',
    body: { presetId: 'demo', key: '-----BEGIN OPENSSH PRIVATE KEY-----\npreset\n-----END OPENSSH PRIVATE KEY-----\n' },
  })
  assert.equal(presetKey.body.key.source, 'stored', 'a per-preset key wins over the panel-wide key')

  const cleared = await call(connection, ROUTE_PATHS.deployKey, { method: 'POST', body: { key: '' } })
  assert.equal(cleared.response.status, 200, JSON.stringify(cleared.body))
  assert.equal(cleared.body.key.source, 'none')
  const afterClear = await call(connection, ROUTE_PATHS.sharedRepo)
  assert.equal(afterClear.body.key.source, 'none', 'the shared repository no longer reports a key')
})

test('checks the published bundle version on a timer and on demand', async (t) => {
  const { home, connection } = await setup(t, { config: { updateCheck: false } })
  const rootManifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const initial = await call(connection, ROUTE_PATHS.update)
  assert.equal(initial.response.status, 200, JSON.stringify(initial.body))
  assert.equal(initial.body.update.current, rootManifest.version)
  assert.equal(initial.body.update.source, 'local', 'no profile manifest treats the bundle as a local install')
  assert.equal(initial.body.update.latest, null)
  assert.equal(initial.body.update.updateAvailable, false)
  assert.equal(initial.body.schedule.enabled, false)

  const checked = await call(connection, ROUTE_PATHS.update, { method: 'POST', body: {} })
  assert.equal(checked.response.status, 200, JSON.stringify(checked.body))
  assert.equal(checked.body.update.latest, '9.9.9')
  assert.equal(checked.body.update.updateAvailable, true)
  assert.equal(checked.body.update.error, null)
  assert.equal(calls[0], 'https://registry.npmjs.org/' + rootManifest.name.replace('/', '%2F') + '/latest')
  const cached = JSON.parse(await readFile(join(home, 'storages', 'dsh-utils-agents', 'update.json'), 'utf8'))
  assert.equal(cached.latest, '9.9.9')
  assert.equal(cached.updateAvailable, true)

  globalThis.fetch = async () => { throw new Error('offline') }
  const failed = await call(connection, ROUTE_PATHS.update, { method: 'POST', body: {} })
  assert.equal(failed.response.status, 200)
  assert.equal(failed.body.update.latest, '9.9.9', 'a failed check keeps the last known version')
  assert.match(failed.body.update.error, /offline/)

  globalThis.fetch = async () => new Response(JSON.stringify({ version: '0.0.1' }), { status: 200, headers: { 'content-type': 'application/json' } })
  const older = await call(connection, ROUTE_PATHS.update, { method: 'POST', body: {} })
  assert.equal(older.body.update.latest, '0.0.1')
  assert.equal(older.body.update.updateAvailable, false)
  assert.equal(older.body.update.error, null)
})

test('checks a GitHub install against the repository manifest', async (t) => {
  const { home, connection } = await setup(t, { config: { updateAutoInstall: false } })
  await writeFile(join(home, 'package.json'), JSON.stringify({ dependencies: { '@xi4z/dsh-utils': 'github:xi4z/dsh-utils#main' } }, null, 2))
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const checked = await call(connection, ROUTE_PATHS.update, { method: 'POST', body: {} })
  assert.equal(checked.response.status, 200, JSON.stringify(checked.body))
  assert.equal(checked.body.update.source, 'git')
  assert.equal(checked.body.update.origin, 'https://raw.githubusercontent.com/xi4z/dsh-utils/main/package.json')
  assert.equal(checked.body.update.latest, '9.9.9')
  assert.equal(checked.body.update.updateAvailable, true)
  assert.equal(calls[0], checked.body.update.origin)
  const cached = JSON.parse(await readFile(join(home, 'storages', 'dsh-utils-agents', 'update.json'), 'utf8'))
  assert.equal(cached.source, 'git')
  assert.equal(cached.origin, 'https://raw.githubusercontent.com/xi4z/dsh-utils/main/package.json')
})

test('auto-installs a newer registry version in the background', async (t) => {
  const { home } = await setup(t, { config: { updateCheck: false, updateAutoInstall: false } })
  await writeFile(join(home, 'package.json'), JSON.stringify({ dependencies: { '@xi4z/dsh-utils': '^0.4.0' } }, null, 2))
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200, headers: { 'content-type': 'application/json' } })
  const commands = []
  const ctx = { get: (name) => name === 'profileContext' ? { dir: home } : undefined, logger: { warn() {} } }
  const checker = createUpdateChecker(ctx, () => ({ updateRegistry: 'https://registry.npmjs.org', updateAutoInstall: true }), async (command) => {
    commands.push(command)
  })

  const running = await checker.check()
  assert.equal(running.updateAvailable, true)
  assert.equal(running.install.phase, 'installing')
  assert.equal(running.install.version, '9.9.9')

  await new Promise((resolve) => setTimeout(resolve, 20))
  const done = await checker.status()
  assert.equal(done.install.phase, 'installed')
  assert.equal(done.install.version, '9.9.9')
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0], { dir: home, spec: '@xi4z/dsh-utils@9.9.9', exact: true })
  const cached = JSON.parse(await readFile(join(home, 'storages', 'dsh-utils-agents', 'update.json'), 'utf8'))
  assert.equal(cached.install.phase, 'installed')
})

test('a failed auto-install is reported and the profile manifest is restored', async (t) => {
  const { home } = await setup(t, { config: { updateCheck: false, updateAutoInstall: false } })
  const manifest = JSON.stringify({ dependencies: { '@xi4z/dsh-utils': '^0.4.0' } }, null, 2)
  await writeFile(join(home, 'package.json'), manifest)
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200, headers: { 'content-type': 'application/json' } })
  const ctx = { get: (name) => name === 'profileContext' ? { dir: home } : undefined, logger: { warn() {} } }
  const checker = createUpdateChecker(ctx, () => ({ updateRegistry: 'https://registry.npmjs.org', updateAutoInstall: true }), async (command) => {
    await writeFile(join(command.dir, 'package.json'), '{"broken":true}')
    throw new Error('network down')
  })

  await checker.check()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const done = await checker.status()
  assert.equal(done.install.phase, 'failed')
  assert.match(done.install.message, /network down/)
  assert.equal(await readFile(join(home, 'package.json'), 'utf8'), manifest, 'the manifest is restored')
})

test('builds an install command only for sources that can move', () => {
  const pinned = '0'.repeat(40)
  assert.deepEqual(
    installCommand({ kind: 'npm', spec: '^0.4.0' }, '/profile', '@xi4z/dsh-utils', '9.9.9'),
    { dir: '/profile', spec: '@xi4z/dsh-utils@9.9.9', exact: true },
  )
  assert.deepEqual(
    installCommand({ kind: 'git', spec: 'github:xi4z/dsh-utils#main', git: { owner: 'xi4z', repo: 'dsh-utils', ref: 'main' } }, '/profile', '@xi4z/dsh-utils', '9.9.9'),
    { dir: '/profile', spec: 'github:xi4z/dsh-utils#main', exact: false },
  )
  assert.equal(
    installCommand({ kind: 'git', spec: 'github:xi4z/dsh-utils#' + pinned, git: { owner: 'xi4z', repo: 'dsh-utils', ref: pinned } }, '/profile', '@xi4z/dsh-utils', '9.9.9'),
    null,
    'a commit-pinned spec cannot move',
  )
  assert.equal(installCommand({ kind: 'local', spec: 'link:/src' }, '/profile', '@xi4z/dsh-utils', '9.9.9'), null)
})

test('reads a GitHub repository and ref out of every git spec form', () => {
  assert.deepEqual(parseGitSpec('github:xi4z/dsh-utils'), { owner: 'xi4z', repo: 'dsh-utils', ref: 'HEAD' })
  assert.deepEqual(parseGitSpec('xi4z/dsh-utils#main'), { owner: 'xi4z', repo: 'dsh-utils', ref: 'main' })
  assert.deepEqual(parseGitSpec('git+https://github.com/xi4z/dsh-utils.git#39f0c0f'), { owner: 'xi4z', repo: 'dsh-utils', ref: '39f0c0f' })
  assert.deepEqual(parseGitSpec('git@github.com:xi4z/dsh-utils.git#Agent'), { owner: 'xi4z', repo: 'dsh-utils', ref: 'Agent' })
  assert.deepEqual(parseGitSpec('https://github.com/xi4z/dsh-utils#v0.4.1&path:/'), { owner: 'xi4z', repo: 'dsh-utils', ref: 'v0.4.1' })
  assert.equal(parseGitSpec('^0.4.0'), null)
  assert.equal(parseGitSpec('@xi4z/dsh-utils'), null)
})

test('syncs a local Git repository into the preset skills directory twice', async (t) => {
  const { connection, root, preset } = await setup(t)
  const origin = await createRepo(join(root, 'origin'), 'from-repo')
  const configured = await call(connection, ROUTE_PATHS.repo, {
    method: 'POST',
    body: { presetId: 'demo', repoUrl: 'file://' + origin, branch: 'main', targetSubdir: 'repo' },
  })
  assert.equal(configured.response.status, 200, JSON.stringify(configured.body))

  const synced = await call(connection, ROUTE_PATHS.sync, { method: 'POST', body: { presetId: 'demo' } })
  assert.equal(synced.response.status, 200, JSON.stringify(synced.body))
  assert.equal(synced.body.status.exists, true)
  assert.equal(synced.body.status.isRepo, true)
  assert.equal(synced.body.state.lastSync.ok, true)
  assert.equal(await readFile(join(preset, 'skills', 'repo', 'from-repo', 'SKILL.md'), 'utf8').then(() => true), true)

  const list = await call(connection, ROUTE_PATHS.list, { query: { sessionId: 'test' } })
  assert.equal(list.body.presets[0].skills.some((skill) => skill.name === 'from-repo'), true)

  await writeFile(join(origin, 'from-repo', 'SKILL.md'), '---\nname: from-repo\ndescription: updated\n---\n\n# updated\n')
  await git(['add', '--all'], origin)
  await git(['commit', '--quiet', '-m', 'update'], origin)
  const again = await call(connection, ROUTE_PATHS.sync, { method: 'POST', body: { presetId: 'demo' } })
  assert.equal(again.response.status, 200, JSON.stringify(again.body))
  assert.match(again.body.state.lastSync.message, /快进/)
})

async function createSharedRepo(dir, ids = ['team'], layout = ['.dsh', 'preset']) {
  for (const id of ids) {
    const preset = join(dir, ...layout, id)
    await mkdir(join(preset, 'skills', 'delta'), { recursive: true })
    await writeFile(join(preset, 'preset.yml'), 'name: ' + id + ' preset\ndescription: shared preset\n')
    await writeFile(join(preset, 'agent.cordis.yml'), '- id: shared-persona\n  name: cordis:group\n  group: true\n  config: []\n')
    await writeFile(join(preset, 'AGENTS.md'), '# ' + id + ' shared\n')
    await writeFile(join(preset, 'skills', 'delta', 'SKILL.md'), '---\nname: delta\ndescription: shared skill\n---\n\n# delta\n')
  }
  return dir
}

test('lists and syncs .dsh presets carried by a skill repository', async (t) => {
  const { connection, home } = await setup(t)
  const repo = await createSharedRepo(join(home, 'skills'), ['team'])
  // A bare ".dsh/<id>" directory is accepted when it looks like a preset.
  await createSharedRepo(repo, ['plain'], ['.dsh'])
  // The legacy global repository clone target is scanned even when nested.
  const nested = await createSharedRepo(join(home, 'skills', 'utils-skill'), ['nested'])
  // ".dsh/preset/" may itself be one preset; its id comes from preset.yml.
  const single = join(home, 'skills', 'single', '.dsh', 'preset')
  await mkdir(join(single, 'skills', 'one'), { recursive: true })
  await writeFile(join(single, 'preset.yml'), 'id: single-demo\nname: Single\ndescription: single preset dir\n')
  await writeFile(join(single, 'agent.cordis.yml'), '- id: single\n  name: cordis:group\n  group: true\n  config: []\n')
  await writeFile(join(single, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: one\n---\n# one\n')

  const listed = await call(connection, ROUTE_PATHS.shared, { query: { presetId: 'demo' } })
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body))
  const shared = listed.body.sources.find((source) => source.path === join(home, 'skills'))
  assert.ok(shared, 'skills home is scanned')
  assert.deepEqual(shared.presets.map((preset) => preset.id), ['team', 'plain'])
  const nestedSource = listed.body.sources.find((source) => source.path === nested)
  assert.ok(nestedSource, 'nested skill repository is scanned')
  assert.equal(nestedSource.kind, 'global-repo')
  assert.deepEqual(nestedSource.presets.map((preset) => preset.id), ['nested'])
  const singleSource = listed.body.sources.find((source) => source.path === join(home, 'skills', 'single'))
  assert.ok(singleSource, 'a repository with a single .dsh/preset directory is scanned')
  assert.deepEqual(singleSource.presets.map((preset) => preset.id), ['single-demo'])
  const team = shared.presets.find((preset) => preset.id === 'team')
  assert.equal(team.status, 'new')
  assert.equal(team.name, 'team preset')
  assert.equal(team.skills, 1)
  assert.equal(team.managed, false)
  assert.equal(team.targetPath, join(home, '.agent-presets', 'team'))

  const synced = await call(connection, ROUTE_PATHS.sharedSync, { method: 'POST', body: { presetId: 'demo', ids: ['team'] } })
  assert.equal(synced.response.status, 200, JSON.stringify(synced.body))
  assert.deepEqual(synced.body.results.map((result) => [result.id, result.status, result.written]), [['team', 'new', 4]])
  assert.equal(await readFile(join(home, '.agent-presets', 'team', 'AGENTS.md'), 'utf8'), '# team shared\n')
  assert.equal(await readFile(join(home, '.agent-presets', 'team', 'preset.yml'), 'utf8').then(() => true), true)
  const after = synced.body.view.sources.find((source) => source.kind === 'skills-home')
  const syncedTeam = after.presets.find((preset) => preset.id === 'team')
  assert.equal(syncedTeam.status, 'same')
  assert.equal(syncedTeam.managed, true)
  assert.match(syncedTeam.lastSyncAt, /T/)
})

function fakeNativeRegistry(docs) {
  const registered = []
  return {
    async register(definition) {
      registered.push(definition)
      return async () => {}
    },
    async list() {
      return Object.entries(docs).map(([id, doc]) => ({
        id,
        ...(doc.name === undefined ? {} : { name: doc.name }),
        ...(doc.description === undefined ? {} : { description: doc.description }),
      }))
    },
    async readDocument(id) {
      const doc = docs[id]
      if (doc === undefined) throw new Error('unknown preset: ' + id)
      return { agentPreset: id, content: doc.content, ...(doc.name === undefined ? {} : { name: doc.name }), ...(doc.description === undefined ? {} : { description: doc.description }) }
    },
  }
}

async function createSharedGitRepo(dir, ids = ['team'], branch = 'main') {
  await createSharedRepo(dir, ids)
  await git(['init', '--quiet', '--initial-branch=' + branch], dir)
  await git(['add', '--all'], dir)
  await git(['commit', '--quiet', '-m', 'initial'], dir)
  return dir
}

test('imports non-built-in native presets as directory presets', async (t) => {
  const registry = fakeNativeRegistry({
    standard: { name: 'Standard', content: '- id: standard-persona\n  name: cordis:group\n  group: true\n  config: []\n' },
    butler: { name: '管家模式', description: 'butler preset', content: '- id: butler-persona\n  name: cordis:group\n  group: true\n  config: []\n' },
  })
  const { connection, home } = await setup(t, { registry })

  const listed = await call(connection, ROUTE_PATHS.native)
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body))
  const standard = listed.body.presets.find((row) => row.id === 'standard')
  const butler = listed.body.presets.find((row) => row.id === 'butler')
  assert.equal(standard.builtin, true)
  assert.equal(standard.importable, false)
  assert.equal(butler.builtin, false)
  assert.equal(butler.importable, true)

  const imported = await call(connection, ROUTE_PATHS.nativeImport, { method: 'POST', body: { ids: ['butler'] } })
  assert.equal(imported.response.status, 200, JSON.stringify(imported.body))
  assert.deepEqual(imported.body.results.map((row) => [row.id, row.status]), [['butler', 'imported']])
  const target = join(home, '.agent-presets', 'butler')
  assert.equal(await readFile(join(target, 'agent.cordis.yml'), 'utf8').then((text) => text.includes('butler-persona')), true)
  assert.match(await readFile(join(target, 'preset.yml'), 'utf8'), /管家模式/)
  assert.equal((await imported.body.view.presets.find((row) => row.id === 'butler')).directory, true)

  const again = await call(connection, ROUTE_PATHS.nativeImport, { method: 'POST', body: { ids: ['butler'] } })
  assert.equal(again.body.results[0].status, 'exists')
  const builtin = await call(connection, ROUTE_PATHS.nativeImport, { method: 'POST', body: { ids: ['standard'] } })
  assert.equal(builtin.body.results[0].status, 'skipped')
})

test('publishes non-built-in presets into the shared repository', async (t) => {
  const { connection, root } = await setup(t)
  const repo = join(root, 'shared-work')
  await mkdir(join(repo, '.dsh', 'preset', 'seed'), { recursive: true })
  await writeFile(join(repo, '.dsh', 'preset', 'seed', 'preset.yml'), 'name: seed\n')
  await git(['init', '--quiet', '--initial-branch=main'], repo)
  await git(['add', '--all'], repo)
  await git(['commit', '--quiet', '-m', 'seed'], repo)
  await writeFile(join(repo, 'unrelated.md'), '# keep me out\n')

  const saved = await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file://' + repo, branch: 'main', targetDir: repo, recurseSubmodules: false },
  })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))

  const published = await call(connection, ROUTE_PATHS.publish, { method: 'POST', body: { push: false } })
  assert.equal(published.response.status, 200, JSON.stringify(published.body))
  assert.equal(published.body.pushed, false)
  assert.match(published.body.commit, /^[0-9a-f]{40}$/)
  assert.deepEqual(published.body.results.map((row) => row.id).sort(), ['demo', 'other'])
  assert.equal(await readFile(join(repo, '.dsh', 'preset', 'demo', 'preset.yml'), 'utf8').then((text) => text.includes('Demo preset')), true)
  assert.equal(await readFile(join(repo, '.dsh', 'preset', 'seed', 'preset.yml'), 'utf8'), 'name: seed\n')

  const shown = await git(['-C', repo, 'show', '--name-only', '--pretty=format:', 'HEAD'])
  assert.match(shown, /^\.dsh\/preset\/demo\/preset\.yml$/m)
  const status = await git(['-C', repo, 'status', '--porcelain'])
  assert.match(status, /^\?\? unrelated\.md$/m)
})

test('pushes published presets to the shared repository origin', async (t) => {
  const { connection, root } = await setup(t)
  const bare = join(root, 'shared-origin.git')
  await git(['init', '--quiet', '--bare', '--initial-branch=main', bare], root)
  const repo = join(root, 'shared-push')
  await mkdir(join(repo, '.dsh', 'preset', 'seed'), { recursive: true })
  await writeFile(join(repo, '.dsh', 'preset', 'seed', 'preset.yml'), 'name: seed\n')
  await git(['init', '--quiet', '--initial-branch=main'], repo)
  await git(['add', '--all'], repo)
  await git(['commit', '--quiet', '-m', 'seed'], repo)
  await git(['remote', 'add', 'origin', 'file://' + bare], repo)
  await git(['push', '--quiet', '-u', 'origin', 'main'], repo)

  await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file://' + bare, branch: 'main', targetDir: repo, recurseSubmodules: false },
  })
  const published = await call(connection, ROUTE_PATHS.publish, { method: 'POST', body: { push: true } })
  assert.equal(published.response.status, 200, JSON.stringify(published.body))
  assert.equal(published.body.pushed, true)
  const remoteHead = await git(['-C', bare, 'rev-parse', 'main'])
  assert.equal(remoteHead, published.body.commit)
})

test('reads and saves the shared skill repository settings and deploy key', async (t) => {
  const { connection, home } = await setup(t)
  const initial = await call(connection, ROUTE_PATHS.sharedRepo)
  assert.equal(initial.response.status, 200, JSON.stringify(initial.body))
  assert.equal(initial.body.state.repoUrl, 'https://github.com/xi4z/skills')
  assert.equal(initial.body.state.branch, 'Agent')
  assert.equal(initial.body.state.targetDir, join(home, 'skills', 'utils-skill'))
  assert.equal(initial.body.key.source, 'none')

  const target = join(home, 'shared-checkout')
  const saved = await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file:///tmp/skills.git', branch: 'main', targetDir: target, recurseSubmodules: false },
  })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.state.branch, 'main')
  assert.equal(saved.body.state.targetDir, target)
  assert.equal(saved.body.state.recurseSubmodules, false)

  const relative = await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file:///tmp/skills.git', branch: 'main', targetDir: 'relative/dir' },
  })
  assert.equal(relative.response.status, 400)

  const keyed = await call(connection, ROUTE_PATHS.sharedKey, {
    method: 'POST',
    body: { key: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n' },
  })
  assert.equal(keyed.response.status, 200, JSON.stringify(keyed.body))
  assert.equal(keyed.body.key.source, 'stored')
  assert.equal(JSON.stringify(keyed.body).includes('PRIVATE KEY'), false)
  assert.equal(await readFile(join(home, 'storages', 'dsh-utils-ui.deploy-key'), 'utf8').then((text) => text.includes('PRIVATE KEY')), true)
  const cleared = await call(connection, ROUTE_PATHS.sharedKey, { method: 'POST', body: { key: '' } })
  assert.equal(cleared.response.status, 200)
  assert.equal(cleared.body.key.source, 'none')
})

test('stores the shared repository settings in utils/utils.json', async (t) => {
  const { connection, home } = await setup(t)
  const target = join(home, 'shared-checkout')
  const saved = await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file:///tmp/skills.git', branch: 'main', targetDir: target, recurseSubmodules: false },
  })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))

  const document = JSON.parse(await readFile(join(home, 'utils', 'utils.json'), 'utf8'))
  assert.equal(document.version, 1)
  assert.equal(document.skillRepositories.length, 1)
  assert.equal(document.skillRepositories[0].repoUrl, 'file:///tmp/skills.git')
  assert.equal(document.skillRepositories[0].targetDir, target)
  assert.equal(document.skillRepositories[0].recurseSubmodules, false)
  assert.equal(document.autoUpdate, true)
  assert.equal(document.autoSyncPresets, true)
  assert.equal(document.updateIntervalMinutes, 60)

  // The panel keeps reading the same document on the next request.
  const again = await call(connection, ROUTE_PATHS.sharedRepo)
  assert.equal(again.body.state.targetDir, target)
})

test('refreshes configured Skill repositories and their submodules', async (t) => {
  const { connection, root, home, ctx } = await setup(t)
  const savedProtocol = process.env.GIT_ALLOW_PROTOCOL
  process.env.GIT_ALLOW_PROTOCOL = 'file'
  t.after(() => {
    if (savedProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL
    else process.env.GIT_ALLOW_PROTOCOL = savedProtocol
  })

  const subOrigin = join(root, 'sub-origin')
  await mkdir(join(subOrigin, 'bundle'), { recursive: true })
  await writeFile(join(subOrigin, 'bundle', 'SKILL.md'), '---\nname: sub-skill\ndescription: sub skill\n---\n\n# sub\n')
  await git(['init', '--quiet', '--initial-branch=main'], subOrigin)
  await git(['add', '--all'], subOrigin)
  await git(['commit', '--quiet', '-m', 'sub initial'], subOrigin)

  const superOrigin = join(root, 'super-origin')
  await mkdir(superOrigin, { recursive: true })
  await writeFile(join(superOrigin, 'SKILL.md'), '---\nname: root-skill\ndescription: root skill\n---\n\n# root\n')
  await git(['init', '--quiet', '--initial-branch=main'], superOrigin)
  await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', 'file://' + subOrigin, 'vendor/skills'], superOrigin)
  await git(['add', '--all'], superOrigin)
  await git(['commit', '--quiet', '-m', 'super initial'], superOrigin)

  const target = join(home, 'skills-checkout')
  const saved = await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file://' + superOrigin, branch: 'main', targetDir: target, recurseSubmodules: true },
  })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))

  const first = await updateSkillRepositories(ctx)
  assert.equal(first.length, 1)
  assert.equal(first[0].ok, true, JSON.stringify(first[0]))
  assert.equal(first[0].changed, true)
  assert.equal(first[0].skipped, false)
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8').then(() => true), true)
  assert.equal(await readFile(join(target, 'vendor', 'skills', 'bundle', 'SKILL.md'), 'utf8').then(() => true), true, 'the submodule is initialized')

  const second = await updateSkillRepositories(ctx)
  assert.equal(second[0].ok, true)
  assert.equal(second[0].changed, false)
  assert.match(second[0].message, /最新/)
})

test('auto-syncs presets carried by the configured repository', async (t) => {
  const { connection, root, home, ctx } = await setup(t)
  const origin = await createSharedGitRepo(join(root, 'auto-origin'), ['team'])
  const target = join(home, 'auto-checkout')
  await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file://' + origin, branch: 'main', targetDir: target, recurseSubmodules: false },
  })
  const pulled = await call(connection, ROUTE_PATHS.sharedPull, { method: 'POST', body: {} })
  assert.equal(pulled.response.status, 200, JSON.stringify(pulled.body))

  const options = normalizeOptions({})
  const first = await autoSyncSharedPresets(ctx, options)
  assert.deepEqual(first.results.map((row) => [row.id, row.status]), [['team', 'new']])
  assert.equal(first.results[0].written > 0, true)
  assert.equal(await readFile(join(home, '.agent-presets', 'team', 'AGENTS.md'), 'utf8'), '# team shared\n')
  assert.equal(await readFile(join(home, '.agent-presets', 'team', 'preset.yml'), 'utf8').then(() => true), true)

  const second = await autoSyncSharedPresets(ctx, options)
  assert.deepEqual(second.results, [], 'an up-to-date preset is not rewritten')

  await writeFile(join(home, '.agent-presets', 'team', 'local.md'), '# local\n')
  await writeFile(join(origin, '.dsh', 'preset', 'team', 'AGENTS.md'), '# team changed\n')
  await git(['add', '--all'], origin)
  await git(['commit', '--quiet', '-m', 'update'], origin)
  const again = await call(connection, ROUTE_PATHS.sharedPull, { method: 'POST', body: {} })
  assert.equal(again.response.status, 200, JSON.stringify(again.body))

  const third = await autoSyncSharedPresets(ctx, options)
  assert.deepEqual(third.results.map((row) => [row.id, row.status]), [['team', 'update']])
  assert.equal(await readFile(join(home, '.agent-presets', 'team', 'AGENTS.md'), 'utf8'), '# team changed\n')
  assert.equal(await readFile(join(home, '.agent-presets', 'team', 'local.md'), 'utf8'), '# local\n', 'local-only files are kept')
})

test('auto-syncs presets from every configured repository', async (t) => {
  const { root, home, ctx } = await setup(t)
  const first = await createSharedRepo(join(root, 'repo-one'), ['alpha-one'])
  const second = await createSharedRepo(join(root, 'repo-two'), ['beta-two'])
  await mkdir(join(home, 'utils'), { recursive: true })
  await writeFile(join(home, 'utils', 'utils.json'), JSON.stringify({
    version: 1,
    skillRepositories: [
      { repoUrl: 'file://' + first, branch: 'main', targetDir: first, keyPath: '', recurseSubmodules: false, lastSync: null },
      { repoUrl: 'file://' + second, branch: 'main', targetDir: second, keyPath: '', recurseSubmodules: false, lastSync: null },
    ],
  }))

  const payload = await autoSyncSharedPresets(ctx, normalizeOptions({}))
  assert.deepEqual(payload.results.map((row) => [row.id, row.status]).sort(), [['alpha-one', 'new'], ['beta-two', 'new']])
  assert.equal(await readFile(join(home, '.agent-presets', 'alpha-one', 'AGENTS.md'), 'utf8'), '# alpha-one shared\n')
  assert.equal(await readFile(join(home, '.agent-presets', 'beta-two', 'AGENTS.md'), 'utf8'), '# beta-two shared\n')
})

test('mirrors the repository as the only source of truth for presets', async (t) => {
  const { connection, root, home, ctx } = await setup(t)
  const origin = await createSharedGitRepo(join(root, 'authoritative-origin'), ['team', 'gone'])
  // A preset named like a shipped one is never synced.
  await createSharedRepo(origin, ['standard'])
  await git(['add', '--all'], origin)
  await git(['commit', '--quiet', '-m', 'standard'], origin)

  const target = join(home, 'authoritative-checkout')
  const saved = await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file://' + origin, branch: 'main', targetDir: target, recurseSubmodules: false },
  })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))
  const pulled = await call(connection, ROUTE_PATHS.sharedPull, { method: 'POST', body: {} })
  assert.equal(pulled.response.status, 200, JSON.stringify(pulled.body))

  const options = normalizeOptions({})
  const first = await autoSyncSharedPresets(ctx, options)
  assert.deepEqual(first.results.map((row) => [row.id, row.status]).sort(), [['gone', 'new'], ['team', 'new']])
  assert.deepEqual(first.removed, [])
  assert.equal(await readFile(join(home, '.agent-presets', 'standard', 'AGENTS.md'), 'utf8').then(() => true, () => false), false, 'a shipped preset is never synced')

  // A preset that is already identical is adopted into the manifest, so a
  // later repository deletion still reaches it.
  await rm(sharedManifestPath(), { force: true })
  const adopted = await autoSyncSharedPresets(ctx, options)
  assert.deepEqual(adopted.results, [])
  assert.deepEqual(adopted.removed, [])
  const manifest = JSON.parse(await readFile(sharedManifestPath(), 'utf8'))
  assert.equal(manifest.presets.team !== undefined, true)
  assert.equal(manifest.presets.gone !== undefined, true)

  // A local-only preset is never removed.
  await mkdir(join(home, '.agent-presets', 'mine'), { recursive: true })
  await writeFile(join(home, '.agent-presets', 'mine', 'AGENTS.md'), '# mine\n')

  // Deleting the preset in the repository removes the local copy.
  await rm(join(origin, '.dsh', 'preset', 'gone'), { recursive: true, force: true })
  await git(['add', '--all'], origin)
  await git(['commit', '--quiet', '-m', 'drop gone'], origin)
  const again = await call(connection, ROUTE_PATHS.sharedPull, { method: 'POST', body: {} })
  assert.equal(again.response.status, 200, JSON.stringify(again.body))

  const second = await autoSyncSharedPresets(ctx, options)
  assert.deepEqual(second.removed, ['gone'])
  assert.equal(await readFile(join(home, '.agent-presets', 'gone', 'AGENTS.md'), 'utf8').then(() => true, () => false), false)
  assert.equal(await readFile(join(home, '.agent-presets', 'team', 'AGENTS.md'), 'utf8'), '# team shared\n')
  assert.equal(await readFile(join(home, '.agent-presets', 'mine', 'AGENTS.md'), 'utf8'), '# mine\n', 'a local-only preset is never removed')
})

test('the periodic refresh never merges over local changes', async (t) => {
  const { connection, root, home, ctx } = await setup(t)
  const origin = await createSharedGitRepo(join(root, 'dirty-origin'), ['team'])
  const target = join(home, 'dirty-checkout')
  await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file://' + origin, branch: 'main', targetDir: target, recurseSubmodules: false },
  })
  const cloned = await updateSkillRepositories(ctx)
  assert.equal(cloned[0].ok, true, JSON.stringify(cloned[0]))

  await writeFile(join(target, 'local-note.md'), '# local work\n')
  const before = await git(['-C', target, 'rev-parse', 'HEAD'])
  await writeFile(join(origin, '.dsh', 'preset', 'team', 'AGENTS.md'), '# upstream\n')
  await git(['add', '--all'], origin)
  await git(['commit', '--quiet', '-m', 'update'], origin)

  const results = await updateSkillRepositories(ctx)
  assert.equal(results[0].ok, true)
  assert.equal(results[0].skipped, true)
  assert.match(results[0].message, /本地改动/)
  assert.equal(await git(['-C', target, 'rev-parse', 'HEAD']), before, 'the checkout is untouched')
})

test('pulls the shared skill repository and exposes its .dsh/preset', async (t) => {
  const { connection, root, home } = await setup(t)
  const origin = await createSharedGitRepo(join(root, 'shared-origin'), ['team'])
  const target = join(home, 'shared-checkout')
  const saved = await call(connection, ROUTE_PATHS.sharedRepo, {
    method: 'POST',
    body: { repoUrl: 'file://' + origin, branch: 'main', targetDir: target, recurseSubmodules: false },
  })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))

  const pulled = await call(connection, ROUTE_PATHS.sharedPull, { method: 'POST', body: {} })
  assert.equal(pulled.response.status, 200, JSON.stringify(pulled.body))
  assert.equal(pulled.body.target.exists, true)
  assert.equal(pulled.body.target.isRepo, true)
  assert.equal(pulled.body.state.lastSync.ok, true)
  assert.equal(await readFile(join(target, '.dsh', 'preset', 'team', 'preset.yml'), 'utf8').then(() => true), true)

  const shared = await call(connection, ROUTE_PATHS.shared, { query: { presetId: 'demo' } })
  const source = shared.body.sources.find((row) => row.kind === 'global-repo')
  assert.ok(source, 'the pulled repository is scanned')
  assert.equal(source.path, target)
  assert.deepEqual(source.presets.map((preset) => preset.id), ['team'])

  await writeFile(join(origin, '.dsh', 'preset', 'team', 'AGENTS.md'), '# updated\n')
  await git(['add', '--all'], origin)
  await git(['commit', '--quiet', '-m', 'update'], origin)
  const again = await call(connection, ROUTE_PATHS.sharedPull, { method: 'POST', body: {} })
  assert.equal(again.response.status, 200, JSON.stringify(again.body))
  assert.match(again.body.state.lastSync.message, /快进/)
})

test('scans the global skill repository configured by the legacy route', async (t) => {
  const { connection, home } = await setup(t)
  const target = await createSharedRepo(join(home, 'global-skills'), ['global-demo'])
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'dsh-utils-ui.json'), JSON.stringify({
    repoUrl: 'https://github.com/xi4z/skills',
    branch: 'main',
    targetDir: target,
    recurseSubmodules: true,
  }))

  const listed = await call(connection, ROUTE_PATHS.shared, { query: { presetId: 'demo' } })
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body))
  const source = listed.body.sources.find((row) => row.kind === 'global-repo')
  assert.ok(source, 'legacy global repository target is scanned')
  assert.equal(source.path, target)
  assert.deepEqual(source.presets.map((preset) => preset.id), ['global-demo'])

  const migrated = JSON.parse(await readFile(join(home, 'utils', 'utils.json'), 'utf8'))
  assert.equal(migrated.skillRepositories.length, 1)
  assert.equal(migrated.skillRepositories[0].targetDir, target)
})

test('shared sync detects updates and only prunes repository-owned files', async (t) => {
  const { connection, home } = await setup(t)
  const repo = await createSharedRepo(join(home, 'skills'), ['team'])
  const source = join(repo, '.dsh', 'preset', 'team')
  await call(connection, ROUTE_PATHS.sharedSync, { method: 'POST', body: { presetId: 'demo', ids: ['team'] } })

  const local = join(home, '.agent-presets', 'team')
  await mkdir(join(local, '.dsh-utils'), { recursive: true })
  await writeFile(join(local, '.dsh-utils', 'repo.json'), '{}\n')
  await writeFile(join(local, 'local-only.md'), '# keep me\n')
  await writeFile(join(local, 'stale.md'), '# stale\n')

  await writeFile(join(source, 'AGENTS.md'), '# team changed\n')
  const listed = await call(connection, ROUTE_PATHS.shared, { query: { presetId: 'demo' } })
  const team = listed.body.sources.find((row) => row.kind === 'skills-home').presets.find((row) => row.id === 'team')
  assert.equal(team.status, 'update')

  // Removing a file upstream must not delete files the sync never owned.
  await rm(join(source, 'AGENTS.md'))
  const pruned = await call(connection, ROUTE_PATHS.sharedSync, { method: 'POST', body: { presetId: 'demo', ids: ['team'], prune: true } })
  assert.equal(pruned.response.status, 200, JSON.stringify(pruned.body))
  assert.equal(pruned.body.results[0].removed, 1)
  assert.equal(await readFile(join(local, 'AGENTS.md'), 'utf8').then(() => false, () => true), true)
  assert.equal(await readFile(join(local, 'stale.md'), 'utf8'), '# stale\n')
  // Local extras and the per-preset utils-agents config survive a pruning sync.
  assert.equal(await readFile(join(local, 'local-only.md'), 'utf8'), '# keep me\n')
  assert.equal(await readFile(join(local, '.dsh-utils', 'repo.json'), 'utf8'), '{}\n')
})

test('registers a synced shared preset in the live preset registry', async (t) => {
  const registry = fakeRegistry()
  const { connection, home } = await setup(t, { registry })
  await createSharedRepo(join(home, 'skills'), ['team'])
  const synced = await call(connection, ROUTE_PATHS.sharedSync, { method: 'POST', body: { presetId: 'demo', ids: ['team'] } })
  assert.equal(synced.response.status, 200, JSON.stringify(synced.body))
  const definition = registry.rows.find((row) => row.id === 'team')
  assert.ok(definition, 'synced preset was registered')
  assert.equal(definition.plugins[0].name, 'cordis:include')
})

test('rejects traversal file ids and invalid repo settings', async (t) => {
  const { connection, preset } = await setup(t)
  const badId = 'preset:' + Buffer.from(preset).toString('base64url') + ':' + Buffer.from('../outside.md').toString('base64url')
  const traversal = await call(connection, ROUTE_PATHS.file, { query: { id: badId, sessionId: 'test' } })
  assert.equal(traversal.response.status, 400)

  const badDir = await call(connection, ROUTE_PATHS.repo, {
    method: 'POST',
    body: { presetId: 'demo', repoUrl: 'https://github.com/example/skills', branch: 'main', targetSubdir: '../escape' },
  })
  assert.equal(badDir.response.status, 400)
})
