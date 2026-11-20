/**
 * Workspace layout guard.
 *
 * The repository keeps the official bundle shape — the root package owns the
 * patch layer, locale, assets and the browser bundle — and the root package is
 * also one real component (`utils-main`, mounted by name as `@xi4z/dsh-utils`).
 * The other utility components are separate packages under `packages/`. This
 * test pins that split so a moved folder, a forgotten export or a stale row
 * fails before a host boots.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = '@xi4z/dsh-utils'
const COMPONENTS = {
  'approval-policy': '@xi4z/dsh-utils-approval-policy',
  workbench: '@xi4z/dsh-utils-workbench',
  notify: '@xi4z/dsh-utils-notify',
  'skill-panel': '@xi4z/dsh-utils-skill-panel',
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
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

test('every patch row mounts a package by name', async () => {
  const manifest = await readJson(join(ROOT, 'package.json'))
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const rows = [...patch.matchAll(/- id: (\S+)\n\s+name: (['"]?)([^'"\n]+)\2/g)].map((match) => ({ id: match[1], name: match[3] }))
  assert.deepEqual(
    rows.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'dsh-approval-policy', name: '@xi4z/dsh-utils-approval-policy' },
      { id: 'dsh-notify', name: '@xi4z/dsh-utils-notify' },
      { id: 'dsh-skill-panel', name: '@xi4z/dsh-utils-skill-panel' },
      { id: 'dsh-workbench', name: '@xi4z/dsh-utils-workbench' },
      { id: 'utils-main', name: manifest.name },
    ],
  )
})

test('every component package ships a built entry and its own locale', async () => {
  for (const [directory, name] of Object.entries(COMPONENTS)) {
    const packageDir = join(ROOT, 'packages', directory)
    const manifest = await readJson(join(packageDir, 'package.json'))
    assert.equal(manifest.name, name)
    assert.equal(manifest.exports['.'].default, './lib/index.js')
    await access(join(packageDir, 'lib/index.js'))
    await access(join(packageDir, 'lib/index.d.ts'))
    await access(join(packageDir, 'src/index.ts'))
    for (const language of ['en', 'zh']) {
      const locale = await readJson(join(packageDir, 'locale', `${language}.json`))
      assert.equal(typeof locale.meta?.title, 'string')
    }
  }
})

test('only the root package declares the browser half', async () => {
  const root = await readJson(join(ROOT, 'package.json'))
  assert.equal(root.dsh?.client?.platform, 'web')
  assert.equal(root.exports['./client'], './client.js')
  await access(join(ROOT, 'client.js'))
  for (const directory of Object.keys(COMPONENTS)) {
    const manifest = await readJson(join(ROOT, 'packages', directory, 'package.json'))
    assert.equal(manifest.dsh?.client, undefined, `${manifest.name} must not declare a client bundle`)
  }
})
