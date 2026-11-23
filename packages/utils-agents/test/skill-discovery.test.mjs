import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { applySkillDiscovery } from '../lib/skill-discovery.js'

// Keep the tests off the real profile: the provider reads configured Skill
// repositories from $DSH_HOME/utils/utils.json.
const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-utils-home-'))
const dshHomeDir = join(profileRoot, '.dsh')
process.env.DSH_HOME = dshHomeDir
process.env.DSH_AGENTS_HOME = join(profileRoot, '.agents')

// ---------------------------------------------------------------- helpers --

const roots = []

async function makeRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-utils-'))
  roots.push(dir)
  return dir
}

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true })
  await rm(profileRoot, { recursive: true, force: true })
})

function skillMd(skillName, description, extra = '', body = '') {
  return `---\nname: ${skillName}\ndescription: ${description}\n${extra}---\n\n${body || `Body for ${skillName}\n`}`
}

/** Write one SKILL.md at `<root>/<segments...>/SKILL.md` and return its path. */
async function writeSkill(root, segments, content) {
  const dir = join(root, ...segments)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  await writeFile(path, content, 'utf8')
  return path
}

function fakeCtx() {
  const ctx = {
    registrations: [],
    listeners: [],
    effects: [],
    warnings: [],
    injects: [],
    inject(services) {
      ctx.injects.push(services)
      return () => {}
    },
    skills: {
      registerProvider(create) {
        ctx.registrations.push(create)
        return () => {}
      },
    },
    on(event, listener, options) {
      ctx.listeners.push({ event, listener, options })
      return () => {}
    },
    effect(execute, label) {
      ctx.effects.push({ execute, label })
      return () => {}
    },
    logger: {
      warn(message) { ctx.warnings.push(String(message)) },
      info() {},
      error() {},
      debug() {},
    },
  }
  return ctx
}

/**
 * Mount the component on a fake host context and hand back the registered
 * provider plus the registration control the registry would own.
 */
function mount(config) {
  const ctx = fakeCtx()
  applySkillDiscovery(ctx, config)
  assert.equal(ctx.registrations.length, 1, 'apply registers exactly one provider')
  const controller = new AbortController()
  let invalidations = 0
  const provider = ctx.registrations[0]({ signal: controller.signal, invalidate: () => { invalidations += 1 } })
  return { ctx, controller, provider, invalidations: () => invalidations }
}

/** A config that only reads one explicit root, with no watching. */
function rootConfig(root, overrides = {}) {
  return {
    includeProjectRoots: false,
    includeUserRoots: false,
    includeSkillRepositories: false,
    watch: false,
    extraRoots: [root],
    ...overrides,
  }
}

/** Write \(a\) configured Skill repository into the isolated profile. */
async function configureSkillRepository(t, targetDir, overrides = {}) {
  const dir = join(dshHomeDir, 'utils')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'utils.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    skillRepositories: [{
      repoUrl: 'file://' + targetDir,
      branch: 'main',
      targetDir,
      keyPath: '',
      recurseSubmodules: false,
      ...overrides,
    }],
  }), 'utf8')
  t.after(() => rm(file, { force: true }))
}

// ------------------------------------------------------------- module shape --

test('applySkillDiscovery registers the provider, the settings listener, and one labelled effect', () => {
  const ctx = fakeCtx()
  applySkillDiscovery(ctx, {})
  assert.equal(ctx.registrations.length, 1)
  assert.deepEqual(ctx.listeners.map((entry) => entry.event), ['settings/document-updated'])
  assert.equal(ctx.effects.length, 1)
  assert.equal(ctx.effects[0].label, 'utils-agents skills: watcher')
})

test('the discovery provider reports the merged component name', async () => {
  const ctx = fakeCtx()
  applySkillDiscovery(ctx, {})
  const controller = new AbortController()
  const provider = ctx.registrations[0]({ signal: controller.signal, invalidate: () => {} })
  controller.abort()
  assert.equal(provider.name, 'utils-agents')
})

// ---------------------------------------------------------------- discovery --

test('list: nested bundles are contributed, flat bundles stay with the built-in provider', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['flat'], skillMd('flat-skill', 'A flat skill.'))
  await writeSkill(root, ['container', 'nested'], skillMd('nested-skill', 'A nested skill.'))

  const { provider } = mount(rootConfig(root))
  const candidates = await provider.list({})

  assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), ['nested-skill'])
})

test('minDepth 1 lets the provider own the flat level too', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['flat'], skillMd('flat-skill', 'A flat skill.'))
  await writeSkill(root, ['container', 'nested'], skillMd('nested-skill', 'A nested skill.'))

  const { provider } = mount(rootConfig(root, { minDepth: 1 }))
  const candidates = await provider.list({})

  assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), ['flat-skill', 'nested-skill'])
})

test('maxDepth bounds the walk', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['a', 'reachable'], skillMd('reachable', 'Within the bound.'))
  await writeSkill(root, ['a', 'b', 'deep'], skillMd('too-deep', 'Beyond the bound.'))

  const { provider } = mount(rootConfig(root, { maxDepth: 2 }))
  const candidates = await provider.list({})

  assert.deepEqual(candidates.map((candidate) => candidate.name), ['reachable'])
})

test('a configured Skill repository is scanned from its own root', async (t) => {
  const repository = await makeRoot()
  await writeSkill(repository, [], skillMd('repo-root', 'A skill at the repository root.'))
  await writeSkill(repository, ['nested', 'bundle'], skillMd('repo-nested', 'A nested repository skill.'))
  await configureSkillRepository(t, repository)

  const { provider } = mount({ includeProjectRoots: false, includeUserRoots: false, watch: false })
  const candidates = await provider.list({})

  assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), ['repo-nested', 'repo-root'])
  const root = candidates.find((candidate) => candidate.name === 'repo-root')
  assert.equal(root.rank, 90, 'the configured checkout outranks inferred roots')
  assert.equal(root.source, 'custom')
})

test('includeSkillRepositories false leaves the configured checkout out', async (t) => {
  const repository = await makeRoot()
  await writeSkill(repository, [], skillMd('repo-root', 'A skill at the repository root.'))
  await configureSkillRepository(t, repository)

  const { provider } = mount({ includeProjectRoots: false, includeUserRoots: false, includeSkillRepositories: false, watch: false })
  assert.deepEqual(await provider.list({}), [])
})

test('a checkout reachable through a symlinked root is contributed once', async (t) => {
  const repository = await makeRoot()
  await writeSkill(repository, ['bundle'], skillMd('only-skill', 'One skill, two roots.'))
  await configureSkillRepository(t, repository)
  const link = join(dshHomeDir, 'skills-link-' + Math.random().toString(36).slice(2))
  await symlink(repository, link, 'dir')

  const { provider } = mount({ includeProjectRoots: false, includeUserRoots: false, watch: false, extraRoots: [link] })
  const candidates = await provider.list({})

  assert.deepEqual(candidates.map((candidate) => candidate.name), ['only-skill'])
  assert.equal(candidates[0].rank, 90, 'the configured root wins the duplicate')
})

test('ignoreDirs are never descended into', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['node_modules', 'pkg', 'inner'], skillMd('vendored', 'Inside node_modules.'))
  await writeSkill(root, ['container', 'kept'], skillMd('kept', 'Outside ignored folders.'))

  const { provider } = mount(rootConfig(root))
  const candidates = await provider.list({})

  assert.deepEqual(candidates.map((candidate) => candidate.name), ['kept'])
})

test('a candidate carries provider, source, rank, locator, and resource base', async () => {
  const root = await makeRoot()
  const path = await writeSkill(root, ['container', 'skill-a'], skillMd('skill-a', 'Candidate shape.'))

  const { provider } = mount(rootConfig(root))
  const [candidate] = await provider.list({})

  assert.equal(candidate.name, 'skill-a')
  assert.equal(candidate.description, 'Candidate shape.')
  assert.equal(candidate.provider, 'utils-agents')
  assert.equal(candidate.source, 'custom')
  assert.equal(candidate.rank, 310)
  assert.equal(candidate.path, path)
  assert.deepEqual(candidate.locator, { path, directory: join(root, 'container', 'skill-a') })
  assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: join(root, 'container', 'skill-a') })
  assert.equal(candidate.metadata, undefined)
})

test('an invalid name or a missing description skips the file and warns', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['container', 'bad-name'], skillMd('Not_Kebab', 'Invalid name.'))
  await writeSkill(root, ['container', 'no-description'], '---\nname: lonely\n---\n\nbody\n')
  await writeSkill(root, ['container', 'good'], skillMd('good-skill', 'Valid one.'))

  const { ctx, provider } = mount(rootConfig(root))
  const candidates = await provider.list({})

  assert.deepEqual(candidates.map((candidate) => candidate.name), ['good-skill'])
  assert.ok(ctx.warnings.some((warning) => warning.includes('invalid skill name "Not_Kebab"')))
})

// -------------------------------------------------------------- frontmatter --

test('frontmatter: block description, quoted whenToUse, invocation flags', async () => {
  const root = await makeRoot()
  const content = [
    '---',
    'name: rich-skill',
    'description: |',
    '  First line of the description.',
    '  Second line of the description.',
    'whenToUse: "Use it when the task names rich-skill."',
    'disable-model-invocation: false',
    'user-invocable: no',
    '---',
    '',
    'Rich body.',
  ].join('\n')
  await writeSkill(root, ['container', 'rich'], content)

  const { provider } = mount(rootConfig(root))
  const [candidate] = await provider.list({})
  assert.equal(candidate.description, 'First line of the description.\nSecond line of the description.')
  assert.equal(candidate.whenToUse, 'Use it when the task names rich-skill.')
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: false })

  const skill = await provider.get(candidate)
  assert.equal(skill.content, 'Rich body.')
  assert.equal(skill.provider, 'utils-agents')
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: false })
})

test('frontmatter: the legacy invocation field names are rejected', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['container', 'legacy'], skillMd('legacy-skill', 'Legacy fields.', 'modelInvocable: true\n'))

  const { ctx, provider } = mount(rootConfig(root))
  const candidates = await provider.list({})

  assert.deepEqual(candidates, [])
  assert.ok(ctx.warnings.some((warning) => warning.includes('"modelInvocable" is unsupported')))
})

// -------------------------------------------------------------------- get --

test('get returns the full body and fast-fails when the file changed identity', async () => {
  const root = await makeRoot()
  const path = await writeSkill(root, ['container', 'first'], skillMd('first-skill', 'First.'))

  const { provider } = mount(rootConfig(root))
  const [candidate] = await provider.list({})

  await writeFile(path, skillMd('renamed-skill', 'First.'), 'utf8')
  await assert.rejects(provider.get(candidate), /declares "renamed-skill" but was discovered as "first-skill"/)
})

test('get returns undefined once the file is gone', async () => {
  const root = await makeRoot()
  const path = await writeSkill(root, ['container', 'gone'], skillMd('gone-skill', 'Gone.'))

  const { provider } = mount(rootConfig(root))
  const [candidate] = await provider.list({})

  await rm(path)
  assert.equal(await provider.get(candidate), undefined)
})

test('get honours an aborted lookup signal', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['container', 'aborted'], skillMd('aborted-skill', 'Aborted.'))

  const { provider } = mount(rootConfig(root))
  const [candidate] = await provider.list({})
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(provider.get(candidate, { signal: controller.signal }))
})

test('get fast-fails on a candidate without a path', async () => {
  const { provider } = mount({ includeProjectRoots: false, includeUserRoots: false, watch: false })
  await assert.rejects(provider.get({ name: 'no-path', description: 'x' }), /carries no path/)
})

// ------------------------------------------------------------------ config --

test('config: invalid values fail fast, unknown keys warn, extra roots resolve', async () => {
  // Validation runs when the registry constructs the provider, not at applySkillDiscovery().
  const createWith = (config) => {
    const ctx = fakeCtx()
    applySkillDiscovery(ctx, config)
    try {
      ctx.registrations[0]({ signal: new AbortController().signal, invalidate: () => {} })
    } catch (error) {
      return { ctx, error }
    }
    return { ctx, error: undefined }
  }

  assert.match(createWith({ minDepth: 0 }).error.message, /minDepth must be an integer >= 1/)
  assert.match(createWith({ maxDepth: 1, minDepth: 4 }).error.message, /maxDepth must be an integer >= 4/)
  assert.match(createWith({ watch: 'yes' }).error.message, /watch must be a boolean/)
  assert.match(createWith({ extraRoots: [''] }).error.message, /extraRoots must be an array of non-empty strings/)
  assert.match(createWith({ debounceMs: -1 }).error.message, /debounceMs must be a non-negative integer/)

  const { ctx, error } = createWith({ mystery: true })
  assert.equal(error, undefined)
  assert.ok(ctx.warnings.some((warning) => warning.includes('unknown config key "mystery"')))

  const mounted = mount({ includeUserRoots: false, includeProjectRoots: false, extraRoots: ['relative/skills'] })
  const resolved = await mounted.provider.roots(undefined)
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].path, join(process.cwd(), 'relative', 'skills'))
  assert.ok(isAbsolute(resolved[0].path))
})

test('config: volatile references are read through, and changes invalidate the catalog', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['container', 'live'], skillMd('live-skill', 'Live.'))
  const live = { minDepth: 2, maxDepth: 8, watch: false, includeProjectRoots: false, includeUserRoots: false, extraRoots: [root], ignoreDirs: [] }

  const ctx = fakeCtx()
  applySkillDiscovery(ctx, Object.fromEntries(Object.keys(live).map((key) => [key, { get: () => live[key] }])))
  const controller = new AbortController()
  let invalidations = 0
  const provider = ctx.registrations[0]({ signal: controller.signal, invalidate: () => { invalidations += 1 } })

  assert.deepEqual((await provider.list({})).map((candidate) => candidate.name), ['live-skill'])

  live.minDepth = 1
  ctx.listeners[0].listener()
  assert.equal(invalidations, 1, 'a settings change invalidates the catalog')
})

// ------------------------------------------------------------------- roots --

test('roots: project roots come from the nearest .git ancestor, then user roots', async () => {
  const project = await makeRoot()
  await mkdir(join(project, '.git'), { recursive: true })
  const nested = join(project, 'packages', 'app')
  await mkdir(nested, { recursive: true })

  const { provider } = mount({ watch: false, extraRoots: [] })
  const resolved = await provider.roots(nested)

  const paths = resolved.map((root) => root.path)
  assert.equal(paths[0], join(project, '.dsh', 'skills'))
  assert.equal(paths[1], join(project, '.agents', 'skills'))
  assert.ok(paths.some((path) => path.endsWith(join('.dsh', 'skills')) && !path.startsWith(project)))

  const sources = resolved.map((root) => root.source)
  assert.deepEqual(sources.slice(2), ['user-dsh', 'user-agents'])
})

test('roots: duplicate roots are de-duplicated by path', async () => {
  const root = await makeRoot()
  const { provider } = mount({ includeProjectRoots: false, includeUserRoots: false, watch: false, extraRoots: [root, root] })
  const resolved = await provider.roots(undefined)
  assert.equal(resolved.length, 1)
})

// ---------------------------------------------------------------- lifecycle --

test('dispose stops the registration and is idempotent', async () => {
  const root = await makeRoot()
  await writeSkill(root, ['container', 'lifecycle'], skillMd('lifecycle-skill', 'Lifecycle.'))
  const { ctx, provider } = mount(rootConfig(root, { watch: true }))

  assert.equal((await provider.list({})).length, 1)
  const disposer = ctx.effects[0].execute().next().value
  assert.equal(typeof disposer, 'function', 'the effect yields the watcher teardown')
  await disposer()
  await provider.dispose()
  await provider.dispose()
})

