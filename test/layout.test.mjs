/**
 * Workspace layout guard.
 *
 * The repository ships ONE installable package: the root package owns the patch
 * layer, locale, assets, the browser bundle and the `utils-main` component, and
 * mounts the other four components as **subpath rows** of itself
 * (`@xi4z/dsh-utils/utils-agents`). A subpath row is not a package — DSH never
 * reads its `package.json` and takes its display title from the exported
 * `./<subpath>/locale/*.json` — so the root manifest must export both the row
 * entry and its locale, and must carry no `@xi4z/*` dependencies: that is what
 * lets one Git URL, tarball or directory install the whole bundle.
 *
 * This test pins that shape so a moved folder, a forgotten export, a stale row
 * name or a reappearing component dependency fails before a host boots.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = '@xi4z/dsh-utils'
const COMPONENTS = ['approval-policy', 'utils-agents', 'notify', 'skill-panel']

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Whether a `files` pattern matches a `/`-separated package-relative path. */
function matches(pattern, path) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${source}(?:/|$)`).test(path)
}

test('the bundle package carries the patch layer, the utils-main entry and the browser bundle', async () => {
  const manifest = await readJson(join(ROOT, 'package.json'))
  assert.equal(manifest.name, BUNDLE)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  assert.equal(manifest.exports['./ui-host'].default, './lib/ui-host.js')
  assert.equal(manifest.exports['./client'], './client.js')
  await access(join(ROOT, 'lib/index.js'))
  await access(join(ROOT, 'lib/ui-host.js'))
  await access(join(ROOT, 'src/index.ts'))
  await access(join(ROOT, 'src/ui-host.ts'))
  await access(join(ROOT, 'client.js'))
  await access(join(ROOT, 'cordis.patch.yml'))
  for (const language of ['en', 'zh']) {
    const locale = await readJson(join(ROOT, 'locale', `${language}.json`))
    assert.equal(typeof locale.meta?.title, 'string')
  }
})

test('the bundle declares no component dependencies, so one spec installs everything', async () => {
  const manifest = await readJson(join(ROOT, 'package.json'))
  const names = Object.keys(manifest.dependencies ?? {})
  assert.deepEqual(names.filter((name) => name.startsWith('@xi4z/')), [])
  assert.deepEqual(names.filter((name) => name.startsWith('@xi4z/dsh-utils')), [])
})

test('every component is a subpath row exported from the bundle package', async () => {
  const manifest = await readJson(join(ROOT, 'package.json'))
  for (const name of COMPONENTS) {
    const subpath = `./${name}`
    const entry = manifest.exports[subpath]
    assert.equal(entry?.default, `./packages/${name}/lib/index.js`, `${subpath} must export the built component`)
    assert.equal(
      manifest.exports[`${subpath}/locale/*.json`],
      `./packages/${name}/locale/*.json`,
      `${subpath} must export its locale for the row title`,
    )
    await access(join(ROOT, 'packages', name, 'lib/index.js'))
    await access(join(ROOT, 'packages', name, 'lib/index.d.ts'))
    for (const language of ['en', 'zh']) {
      const locale = await readJson(join(ROOT, 'packages', name, 'locale', `${language}.json`))
      assert.equal(typeof locale.meta?.title, 'string', `${name}/${language}.json needs meta.title`)
    }
  }
})

test('every file a subpath row needs is packed', async () => {
  const manifest = await readJson(join(ROOT, 'package.json'))
  const files = manifest.files ?? []
  for (const name of COMPONENTS) {
    for (const path of [`packages/${name}/lib/index.js`, `packages/${name}/locale/en.json`]) {
      assert.ok(
        files.some((pattern) => matches(pattern, path)),
        `${path} must be covered by files: ${JSON.stringify(files)}`,
      )
    }
  }
})

test('every patch row names this package, directly or as a subpath', async () => {
  const manifest = await readJson(join(ROOT, 'package.json'))
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const rows = [...patch.matchAll(/- id: (\S+)\n\s+name: (['"]?)([^'"\n]+)\2/g)].map((match) => ({ id: match[1], name: match[3] }))
  assert.deepEqual(
    rows.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'dsh-approval-policy', name: `${manifest.name}/approval-policy` },
      { id: 'dsh-notify', name: `${manifest.name}/notify` },
      { id: 'dsh-skill-panel', name: `${manifest.name}/skill-panel` },
      { id: 'utils-agents', name: `${manifest.name}/utils-agents` },
      { id: 'utils-main', name: manifest.name },
    ],
  )
})

test('component directories stay build units and never declare the browser half', async () => {
  const root = await readJson(join(ROOT, 'package.json'))
  assert.equal(root.dsh?.client?.platform, 'web')
  for (const name of COMPONENTS) {
    const manifest = await readJson(join(ROOT, 'packages', name, 'package.json'))
    assert.equal(manifest.name, `${BUNDLE}-${name}`)
    assert.equal(manifest.exports['.'].default, './lib/index.js')
    assert.equal(manifest.dsh?.client, undefined, `${manifest.name} must not declare a client bundle`)
    assert.equal(manifest.publishConfig, undefined, `${manifest.name} is not published on its own`)
    await access(join(ROOT, 'packages', name, 'src/index.ts'))
  }
})
