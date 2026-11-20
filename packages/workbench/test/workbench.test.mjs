import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { apply, ROUTE_PATHS } from '../lib/index.js'

const runFile = promisify(execFile)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'dsh-workbench test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'dsh-workbench test',
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

function fakeCtx(connection, cwd, registry) {
  const effects = []
  const services = {
    connection,
    agents: { get: (id) => id === 'test' ? { session: { header: { cwd, agentPreset: 'demo' } } } : undefined },
    workingDirectory: { ensure: async () => cwd },
    agentPresets: registry,
  }
  const ctx = {
    effects,
    get(name) {
      return services[name]
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
  const ctx = fakeCtx(connection, cwd, options.registry)
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

test('registers the workbench routes', async (t) => {
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
  const nested = await createSharedRepo(join(home, 'skills', 'herskill'), ['nested'])
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

async function createSharedGitRepo(dir, ids = ['team'], branch = 'main') {
  await createSharedRepo(dir, ids)
  await git(['init', '--quiet', '--initial-branch=' + branch], dir)
  await git(['add', '--all'], dir)
  await git(['commit', '--quiet', '-m', 'initial'], dir)
  return dir
}

test('reads and saves the shared skill repository settings and deploy key', async (t) => {
  const { connection, home } = await setup(t)
  const initial = await call(connection, ROUTE_PATHS.sharedRepo)
  assert.equal(initial.response.status, 200, JSON.stringify(initial.body))
  assert.equal(initial.body.state.repoUrl, 'https://github.com/xi4z/skills')
  assert.equal(initial.body.state.branch, 'Agent')
  assert.equal(initial.body.state.targetDir, join(home, 'skills', 'herskill'))
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
  // Local extras and the per-preset workbench config survive a pruning sync.
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
