/**
 * Workspace layout guard.
 *
 * The repository ships a patch-only bundle plus five independently published
 * component packages — the same shape as the shipped experimental bundles:
 *
 * - `@xi4z/dsh-utils` owns only the patch layer, locale and icon. It mounts no
 *   component of its own (`dsh.client` is absent, `src/index.ts` exports
 *   nothing) and declares every component as an exact-version dependency.
 * - Every component is a real package with its own manifest, built entry and
 *   `locale/*.json` row title. The shared browser half lives in its own
 *   `@xi4z/dsh-utils-ui` package.
 * - `cordis.patch.yml` mounts all five by bare package name, so the plugin page
 *   keeps addressing each row's configuration as `@xi4z/dsh-utils#<row id>`.
 * - One release train: every package shares the bundle version.
 *
 * This test pins that shape so a moved folder, a forgotten export, a stale row
 * name or a version drift fails before a host boots.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = '@xi4z/dsh-utils'

/** Directory, package name and Loader row id of every component. */
const COMPONENTS = [
  { dir: 'approval-policy', name: `${BUNDLE}-approval-policy`, row: 'dsh-approval-policy', client: false },
  { dir: 'approval-qq', name: `${BUNDLE}-approval-qq`, row: 'dsh-approval-qq', client: false },
  { dir: 'notify', name: `${BUNDLE}-notify`, row: 'dsh-notify', client: false },
  { dir: 'utils-agents', name: `${BUNDLE}-utils-agents`, row: 'utils-agents', client: false },
  { dir: 'ui', name: `${BUNDLE}-ui`, row: 'utils-ui', client: true },
]

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Whether a `files` pattern matches a `/`-separated package-relative path. */
function matches(pattern, path) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${source}(?:/|$)`).test(path)
}

test('the bundle package is patch-only: no component, no browser half', async () => {
  const manifest = await readJson(join(ROOT, 'package.json'))
  assert.equal(manifest.name, BUNDLE)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client, undefined, 'the bundle must not declare a browser half')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  assert.equal(manifest.exports['./client'], undefined, 'the bundle must not export a client bundle')
  assert.equal(manifest.exports['./ui-host'], undefined, 'the bundle must not export a component entry')
  await access(join(ROOT, 'lib/index.js'))
  await access(join(ROOT, 'src/index.ts'))
  await access(join(ROOT, 'cordis.patch.yml'))
  await access(join(ROOT, 'icon.svg'))
  for (const language of ['en', 'zh']) {
    const locale = await readJson(join(ROOT, 'locale', `${language}.json`))
    assert.equal(typeof locale.meta?.title, 'string')
  }
})

test('the bundle entry module exports nothing', async () => {
  const source = await readFile(join(ROOT, 'src/index.ts'), 'utf8')
  assert.match(source, /export\s*\{\s*\}/)
  assert.doesNotMatch(source, /export\s+(function|const|class)\s+apply/)
})

test('the bundle declares every component as an exact same-version dependency', async () => {
  const manifest = await readJson(join(ROOT, 'package.json'))
  const expected = Object.fromEntries(COMPONENTS.map(({ name }) => [name, manifest.version]))
  const declared = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(([name]) => name.startsWith(BUNDLE)),
  )
  assert.deepEqual(declared, expected)
})

test('every component is a published package with an entry and a row title', async () => {
  for (const { dir, name, client } of COMPONENTS) {
    const base = join(ROOT, 'packages', dir)
    const manifest = await readJson(join(base, 'package.json'))
    assert.equal(manifest.name, name)
    assert.equal(manifest.version, (await readJson(join(ROOT, 'package.json'))).version)
    assert.equal(manifest.exports['.'].default, './lib/index.js')
    assert.equal(manifest.publishConfig?.access, 'public', `${name} must be publishable on its own`)
    assert.equal(manifest.dsh?.bundle, undefined, `${name} is a component, not a bundle`)
    assert.equal(manifest.dsh?.client === undefined, !client, `${name} client declaration`)
    await access(join(base, 'lib/index.js'))
    await access(join(base, 'lib/index.d.ts'))
    await access(join(base, 'src/index.ts'))
    for (const language of ['en', 'zh']) {
      const locale = await readJson(join(base, 'locale', `${language}.json`))
      assert.equal(typeof locale.meta?.title, 'string', `${dir}/${language}.json needs meta.title`)
    }
    if (client) {
      assert.equal(manifest.exports['./client'], './client.js')
      await access(join(base, 'client.js'))
    } else {
      assert.equal(manifest.exports['./client'], undefined)
    }
  }
})

test('every file a package needs is packed', async () => {
  const bundle = await readJson(join(ROOT, 'package.json'))
  for (const path of ['lib/index.js', 'cordis.patch.yml', 'locale/en.json', 'icon.svg']) {
    assert.ok(bundle.files.some((pattern) => matches(pattern, path)), `bundle files must cover ${path}`)
  }
  for (const { dir } of COMPONENTS) {
    const manifest = await readJson(join(ROOT, 'packages', dir, 'package.json'))
    for (const path of ['lib/index.js', 'lib/index.d.ts', 'locale/en.json', 'src/index.ts']) {
      assert.ok(
        manifest.files.some((pattern) => matches(pattern, path)),
        `${dir}: files must cover ${path}: ${JSON.stringify(manifest.files)}`,
      )
    }
    if (manifest.dsh?.client) {
      assert.ok(manifest.files.some((pattern) => matches(pattern, 'client.js')), `${dir}: client.js must be packed`)
    }
  }
})

test('every patch row mounts one component package by bare name', async () => {
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const rows = [...patch.matchAll(/- id: (\S+)\n\s+name: (['"]?)([^'"\n]+)\2/g)].map((match) => ({
    id: match[1],
    name: match[3],
  }))
  assert.deepEqual(
    rows.sort((a, b) => a.id.localeCompare(b.id)),
    COMPONENTS.map(({ name, row }) => ({ id: row, name })).sort((a, b) => a.id.localeCompare(b.id)),
  )
})
