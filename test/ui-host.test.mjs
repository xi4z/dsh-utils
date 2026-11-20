import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  applyUiHost,
  canonicalRepoUrl,
  cloneUrlFor,
  CONFIG_PATH,
  DEFAULT_BRANCH,
  DEFAULT_REPO_URL,
  KEY_PATH,
  ROUTE_PATHS,
  STATUS_PATH,
  SYNC_PATH,
} from '../lib/ui-host.js'

const runFile = promisify(execFile)

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'dsh-utils-ui test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'dsh-utils-ui test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

/** Run git in a fixture and return trimmed stdout. */
async function git(args, cwd) {
  const { stdout } = await runFile('git', args, { cwd, env: GIT_ENV })
  return stdout.trim()
}

/** Create an origin repository with one SKILL.md per requested skill. */
async function createRepo(dir, skills = ['alpha', 'beta'], branch = 'main') {
  await mkdir(dir, { recursive: true })
  await git(['init', '--quiet', '--initial-branch=' + branch], dir)
  for (const skillName of skills) await writeSkill(dir, skillName)
  await git(['add', '--all'], dir)
  await git(['commit', '--quiet', '-m', 'initial'], dir)
  return dir
}

/** Write one nested SKILL.md into a repository. */
async function writeSkill(repo, skillName) {
  const dir = join(repo, skillName)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    '---\nname: ' + skillName + '\ndescription: ' + skillName + ' skill.\n---\n\n# ' + skillName + '\n',
  )
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
function fakeCtx({ connection } = {}) {
  const ctx = {
    services: connection === undefined ? {} : { connection },
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
      if (ctx.services.connection === undefined) return
      callback({
        connection: ctx.services.connection,
        effect: ctx.effect,
        logger: ctx.logger,
        get: ctx.get,
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

/**
 * Fresh temp DSH_HOME plus a real file:// origin repository, with the panel
 * mounted and cleaned up afterwards.
 */
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-sync-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const origin = await createRepo(join(root, 'origin'), options.skills, options.branch)
  process.env.DSH_HOME = home
  const connection = fakeConnection()
  const ctx = fakeCtx({ connection })
  applyUiHost(ctx)
  t.after(async () => {
    await dispose(ctx)
    await rm(root, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })
  return {
    root,
    home,
    origin,
    url: 'file://' + origin,
    target: join(home, 'skills', 'herskill'),
    ctx,
    connection,
  }
}

/** Find the exact route registered for one path. */
function routeFor(connection, path) {
  const route = connection.routes.find((candidate) => candidate.path === path)
  assert.ok(route, 'route ' + path + ' is registered')
  return route
}

/** Invoke one route with an optional JSON body. */
async function request(connection, path, options = {}) {
  const route = routeFor(connection, path)
  const init = { method: options.method ?? 'GET' }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers = { 'content-type': 'application/json' }
  }
  if (options.text !== undefined) {
    init.body = options.text
    init.headers = { 'content-type': 'application/json' }
  }
  return route.fetch(new Request('http://localhost' + path, init))
}

/** Invoke one route and parse its JSON reply. */
async function callJson(connection, path, options = {}) {
  const response = await request(connection, path, options)
  const text = await response.text()
  return { response, text, body: text === '' ? undefined : JSON.parse(text) }
}

/** Save configuration and return the parsed reply. */
async function configure(connection, fields) {
  const result = await callJson(connection, CONFIG_PATH, { method: 'POST', body: fields })
  assert.equal(result.response.status, 200, result.text)
  return result.body
}

/** Permission bits of one file. */
async function modeOf(path) {
  return (await stat(path)).mode & 0o777
}

/** The durable state file under the fixture's DSH_HOME. */
function statePathOf(home) {
  return join(home, 'storages', 'dsh-utils-ui.json')
}

// -------------------------------------------------------------- module shape --

test('the module exports the exact route contract', () => {
  assert.deepEqual(ROUTE_PATHS, {
    status: '/api/dsh-utils-ui/status',
    config: '/api/dsh-utils-ui/config',
    key: '/api/dsh-utils-ui/key',
    sync: '/api/dsh-utils-ui/sync',
  })
  assert.equal(STATUS_PATH, ROUTE_PATHS.status)
  assert.equal(CONFIG_PATH, ROUTE_PATHS.config)
  assert.equal(KEY_PATH, ROUTE_PATHS.key)
  assert.equal(SYNC_PATH, ROUTE_PATHS.sync)
  assert.equal(DEFAULT_REPO_URL, 'https://github.com/xi4z/skills')
  assert.equal(DEFAULT_BRANCH, 'Agent')
})

test('registers four exact buffered routes with the panel methods', async (t) => {
  const fx = await setup(t)
  assert.equal(fx.connection.routes.length, 4)
  assert.deepEqual(routeFor(fx.connection, STATUS_PATH).methods, ['GET'])
  for (const path of [CONFIG_PATH, KEY_PATH, SYNC_PATH]) {
    assert.deepEqual(routeFor(fx.connection, path).methods, ['POST'])
  }
  for (const route of fx.connection.routes) assert.equal(route.requestBody, 'buffered')
  assert.ok(fx.ctx.effects.some((entry) => entry.label === 'utils-main repo-sync: ' + STATUS_PATH))

  await dispose(fx.ctx)
  for (const route of fx.connection.routes) assert.equal(route.removed, true)
})

test('a non-web host silently skips route registration', () => {
  const ctx = fakeCtx()
  applyUiHost(ctx)
  assert.deepEqual(ctx.injects, [['connection']])
  assert.equal(ctx.warnings.length, 0)
  assert.equal(ctx.effects.length, 0)
})

test('a route registration failure is logged, not thrown', () => {
  const connection = {
    fetch: {
      register() {
        throw new Error('route conflict')
      },
    },
  }
  const ctx = fakeCtx({ connection })
  applyUiHost(ctx)
  assert.ok(ctx.warnings.some((warning) => warning.includes('cannot register')))
  assert.ok(ctx.warnings.some((warning) => warning.includes('route conflict')))
})

// ------------------------------------------------------------------- status --

test('status serves the documented defaults before anything is configured', async (t) => {
  const fx = await setup(t)
  const { response, body, text } = await callJson(fx.connection, STATUS_PATH)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type'), /application\/json/)
  assert.equal(body.repoUrl, DEFAULT_REPO_URL)
  assert.equal(body.branch, 'Agent')
  assert.equal(body.keyPath, '')
  assert.equal(body.targetDir, join(fx.home, 'skills', 'herskill'))
  assert.equal(body.recurseSubmodules, true)
  assert.equal(body.keySource, 'none')
  assert.equal(body.hasStoredKey, false)
  assert.equal(body.lastSync, null)
  assert.deepEqual(body.target, {
    exists: false,
    isRepo: false,
    branch: null,
    commit: null,
    dirty: false,
    skills: 0,
    skillNames: [],
  })
  assert.ok(!text.includes('PRIVATE KEY'))
})

test('status describes a dirty checkout and a non-repository directory', async (t) => {
  const fx = await setup(t)
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target })
  await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  await writeFile(join(fx.target, 'scratch.txt'), 'dirty')

  const dirty = await callJson(fx.connection, STATUS_PATH)
  assert.equal(dirty.body.target.exists, true)
  assert.equal(dirty.body.target.isRepo, true)
  assert.equal(dirty.body.target.branch, 'main')
  assert.equal(dirty.body.target.dirty, true)

  const plain = join(fx.root, 'plain')
  await mkdir(join(plain, 'nested'), { recursive: true })
  await writeFile(join(plain, 'nested', 'SKILL.md'), '---\nname: nested\ndescription: Nested.\n---\n')
  await configure(fx.connection, { targetDir: plain })
  const status = await callJson(fx.connection, STATUS_PATH)
  assert.equal(status.body.target.exists, true)
  assert.equal(status.body.target.isRepo, false)
  assert.equal(status.body.target.skills, 1)
  assert.deepEqual(status.body.target.skillNames, ['nested'])
})

// ------------------------------------------------------------------- config --

test('config persists valid settings with mode 600 and keeps omitted fields', async (t) => {
  const fx = await setup(t)
  const target = join(fx.root, 'skills-target')
  const body = await configure(fx.connection, {
    repoUrl: fx.url,
    branch: 'main',
    targetDir: target,
    recurseSubmodules: false,
  })
  assert.equal(body.ok, true)
  assert.equal(body.repoUrl, fx.url)
  assert.equal(body.branch, 'main')
  assert.equal(body.targetDir, target)
  assert.equal(body.recurseSubmodules, false)
  assert.equal(await modeOf(statePathOf(fx.home)), 0o600)
  const state = JSON.parse(await readFile(statePathOf(fx.home), 'utf8'))
  assert.equal(state.branch, 'main')
  assert.equal(state.targetDir, target)

  const updated = await configure(fx.connection, { recurseSubmodules: true })
  assert.equal(updated.recurseSubmodules, true)
  assert.equal(updated.repoUrl, fx.url)
  assert.equal(updated.branch, 'main')
  assert.equal(updated.targetDir, target)
})

test('config rejects invalid repository URLs, branches, and target directories', async (t) => {
  const fx = await setup(t)
  const invalid = [
    { repoUrl: 'https://github.com/x/y\nz' },
    { repoUrl: '--upload-pack=evil' },
    { repoUrl: 'not a url' },
    { branch: '-bad' },
    { branch: 'a..b' },
    { branch: 'has space' },
    { targetDir: 'relative/path' },
    { targetDir: '/' },
    { targetDir: PACKAGE_ROOT },
    { targetDir: join(PACKAGE_ROOT, 'lib') },
    { targetDir: join(PACKAGE_ROOT, 'src') },
    { recurseSubmodules: 'yes' },
  ]
  for (const fields of invalid) {
    const result = await callJson(fx.connection, CONFIG_PATH, { method: 'POST', body: fields })
    assert.equal(result.response.status, 400, JSON.stringify(fields) + ' -> ' + result.text)
    assert.equal(typeof result.body.error, 'string')
  }
  await assert.rejects(stat(statePathOf(fx.home)), /ENOENT/)
})

// ---------------------------------------------------------------------- key --

test('the stored deploy key is mode 600, never echoed, and cleared by an empty key', async (t) => {
  const fx = await setup(t)
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target })
  const marker = 'MARKER-PRIVATE-KEY-7f3a9c'
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + marker + '\n-----END OPENSSH PRIVATE KEY-----'

  const saved = await callJson(fx.connection, KEY_PATH, { method: 'POST', body: { key } })
  assert.equal(saved.response.status, 200, saved.text)
  assert.equal(saved.body.hasStoredKey, true)
  assert.equal(saved.body.keySource, 'stored')
  assert.ok(!saved.text.includes(marker), 'the reply never carries the key')

  const keyFile = join(fx.home, 'storages', 'dsh-utils-ui.deploy-key')
  assert.equal(await modeOf(keyFile), 0o600)
  assert.ok((await readFile(keyFile, 'utf8')).includes(marker), 'the key is stored on disk, newline-terminated')

  const status = await callJson(fx.connection, STATUS_PATH)
  assert.equal(status.body.keySource, 'stored')
  assert.equal(status.body.hasStoredKey, true)
  assert.ok(!status.text.includes(marker))
  assert.ok(!(await readFile(statePathOf(fx.home), 'utf8')).includes(marker), 'the state file never carries the key')
  assert.ok(fx.ctx.warnings.every((warning) => !warning.includes(marker)))

  for (const body of [{ key: 42 }, {}, { key: null }]) {
    const rejected = await callJson(fx.connection, KEY_PATH, { method: 'POST', body })
    assert.equal(rejected.response.status, 400, JSON.stringify(body))
  }

  const cleared = await callJson(fx.connection, KEY_PATH, { method: 'POST', body: { key: '' } })
  assert.equal(cleared.body.hasStoredKey, false)
  assert.equal(cleared.body.keySource, 'none')
  await assert.rejects(stat(keyFile), /ENOENT/)
  assert.equal((await callJson(fx.connection, STATUS_PATH)).body.keySource, 'none')
})

test('a configured key path wins over the stored key and stays a path in replies', async (t) => {
  const fx = await setup(t)
  const keyFile = join(fx.root, 'id_ed25519')
  await writeFile(keyFile, 'PATH-KEY-MATERIAL-8c1d\n', { mode: 0o600 })
  await callJson(fx.connection, KEY_PATH, { method: 'POST', body: { key: 'STORED-KEY-MATERIAL-2be4\n' } })

  const configured = await configure(fx.connection, { keyPath: keyFile })
  assert.equal(configured.keyPath, keyFile)
  assert.equal(configured.keySource, 'path')
  assert.equal(configured.hasStoredKey, true)

  const status = await callJson(fx.connection, STATUS_PATH)
  assert.equal(status.body.keySource, 'path')
  assert.ok(!status.text.includes('PATH-KEY-MATERIAL'))

  const missing = await configure(fx.connection, { keyPath: join(fx.root, 'absent-key') })
  assert.equal(missing.keySource, 'stored', 'an absent path falls back to the stored key')

  const cleared = await configure(fx.connection, { keyPath: '' })
  assert.equal(cleared.keySource, 'stored')
})

// --------------------------------------------------------------------- sync --

test('sync clones a file:// repository and reports commit plus skills', async (t) => {
  const fx = await setup(t)
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target, recurseSubmodules: true })
  const { response, body } = await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  assert.match(body.commit, /^[0-9a-f]{7,40}$/)
  assert.equal(body.commit, await git(['rev-parse', '--short', 'HEAD'], fx.target))
  assert.equal(body.skills, 2)
  assert.deepEqual(body.skillNames, ['alpha', 'beta'])
  assert.deepEqual(body.warnings, [])
  assert.ok((await readFile(join(fx.target, 'alpha', 'SKILL.md'), 'utf8')).includes('name: alpha'))

  const status = await callJson(fx.connection, STATUS_PATH)
  assert.equal(status.body.target.exists, true)
  assert.equal(status.body.target.isRepo, true)
  assert.equal(status.body.target.branch, 'main')
  assert.equal(status.body.target.commit, body.commit)
  assert.equal(status.body.target.dirty, false)
  assert.equal(status.body.target.skills, 2)
  assert.deepEqual(status.body.target.skillNames, ['alpha', 'beta'])
  assert.equal(status.body.lastSync.ok, true)
  assert.equal(status.body.lastSync.commit, body.commit)
  assert.equal(status.body.lastSync.skills, 2)
  assert.match(status.body.lastSync.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(await modeOf(statePathOf(fx.home)), 0o600)
})

test('a second sync fast-forwards the target to new upstream work', async (t) => {
  const fx = await setup(t)
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target })
  const first = await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  assert.equal(first.response.status, 200, first.text)

  await writeSkill(fx.origin, 'gamma')
  await git(['add', '--all'], fx.origin)
  await git(['commit', '--quiet', '-m', 'add gamma'], fx.origin)

  const second = await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  assert.equal(second.response.status, 200, second.text)
  assert.equal(second.body.skills, 3)
  assert.deepEqual(second.body.skillNames, ['alpha', 'beta', 'gamma'])
  assert.notEqual(second.body.commit, first.body.commit)
  assert.ok((await readFile(join(fx.target, 'gamma', 'SKILL.md'), 'utf8')).includes('gamma'))
})

test('sync fast-forwards an existing full checkout without deepening it', async (t) => {
  const fx = await setup(t)
  await mkdir(dirname(fx.target), { recursive: true })
  await git(['clone', '--quiet', fx.url, fx.target], fx.root)
  await writeSkill(fx.origin, 'gamma')
  await git(['add', '--all'], fx.origin)
  await git(['commit', '--quiet', '-m', 'add gamma'], fx.origin)
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target })

  const { response, body } = await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  assert.equal(body.skills, 3)
  assert.equal(await git(['rev-parse', '--is-shallow-repository'], fx.target), 'false')
})

test('sync refuses to overwrite a non-repository target', async (t) => {
  const fx = await setup(t)
  await mkdir(fx.target, { recursive: true })
  await writeFile(join(fx.target, 'keep.txt'), 'do not delete')
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target })

  const { response, body } = await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  assert.equal(response.status, 409)
  assert.match(body.error, /不是 git 仓库/)
  assert.equal(await readFile(join(fx.target, 'keep.txt'), 'utf8'), 'do not delete')

  const status = await callJson(fx.connection, STATUS_PATH)
  assert.equal(status.body.target.isRepo, false)
  assert.equal(status.body.lastSync.ok, false)
  assert.match(status.body.lastSync.message, /不是 git 仓库/)
})

test('sync refuses a checkout whose branch differs from the configured branch', async (t) => {
  const fx = await setup(t)
  await mkdir(dirname(fx.target), { recursive: true })
  await git(['clone', '--quiet', fx.url, fx.target], fx.root)
  await git(['checkout', '--quiet', '-b', 'other'], fx.target)
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target })

  const { response, body } = await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  assert.equal(response.status, 409)
  assert.match(body.error, /分支/)
  assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.target), 'other')
})

test('sync refuses a checkout whose origin is a different repository', async (t) => {
  const fx = await setup(t)
  const other = await createRepo(join(fx.root, 'other-origin'), ['delta'])
  await mkdir(dirname(fx.target), { recursive: true })
  await git(['clone', '--quiet', 'file://' + other, fx.target], fx.root)
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target })

  const { response, body } = await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  assert.equal(response.status, 409)
  assert.match(body.error, /不是同一仓库/)
})

test('an SSH repository without any key fails fast instead of prompting', async (t) => {
  const fx = await setup(t)
  await configure(fx.connection, { repoUrl: 'git@example.com:team/skills.git', branch: 'main', targetDir: fx.target })
  const { response, body } = await callJson(fx.connection, SYNC_PATH, { method: 'POST', body: {} })
  assert.equal(response.status, 400)
  assert.match(body.error, /Deploy Key/)
  await assert.rejects(stat(fx.target), /ENOENT/)
})

test('config rejects malformed bodies while sync ignores its own body', async (t) => {
  const fx = await setup(t)
  await configure(fx.connection, { repoUrl: fx.url, branch: 'main', targetDir: fx.target })
  const wrongType = await callJson(fx.connection, CONFIG_PATH, { method: 'POST', body: { branch: 42 } })
  assert.equal(wrongType.response.status, 400)
  const malformed = await request(fx.connection, CONFIG_PATH, { method: 'POST', text: 'not json' })
  assert.equal(malformed.status, 400)
  const sync = await request(fx.connection, SYNC_PATH, { method: 'POST', text: 'not json' })
  assert.equal(sync.status, 200)
})

// ------------------------------------------------------------ URL rewriting --

test('cloneUrlFor rewrites known HTTPS hosts to SSH only when a key exists', () => {
  assert.equal(cloneUrlFor('https://github.com/xi4z/skills', true), 'git@github.com:xi4z/skills.git')
  assert.equal(cloneUrlFor('https://github.com/xi4z/skills.git', true), 'git@github.com:xi4z/skills.git')
  assert.equal(cloneUrlFor('https://gitlab.com/team/repo', true), 'git@gitlab.com:team/repo.git')
  assert.equal(cloneUrlFor('https://github.com/xi4z/skills', false), 'https://github.com/xi4z/skills')
  assert.equal(cloneUrlFor('https://example.com/team/repo', true), 'https://example.com/team/repo')
  assert.equal(cloneUrlFor('file:///tmp/skills', true), 'file:///tmp/skills')
  assert.equal(cloneUrlFor('git@github.com:xi4z/skills.git', true), 'git@github.com:xi4z/skills.git')
  assert.equal(cloneUrlFor('/tmp/skills', true), '/tmp/skills')
})

test('repository URLs compare across scheme, case, and .git suffix', () => {
  assert.equal(canonicalRepoUrl('git@github.com:xi4z/skills.git'), canonicalRepoUrl('https://github.com/xi4z/Skills'))
  assert.equal(canonicalRepoUrl('ssh://git@github.com/xi4z/skills.git'), 'github.com/xi4z/skills')
  assert.notEqual(canonicalRepoUrl('https://github.com/xi4z/skills'), canonicalRepoUrl('https://github.com/xi4z/other'))
})
