import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('the panel ships a browser half and a host entry', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.exports['./client'], './client.js')
  await readFile(join(ROOT, 'client.js'), 'utf8')
  await readFile(join(ROOT, 'helper.mjs'), 'utf8')
})

test('the peers example carries no token', async () => {
  const example = JSON.parse(await readFile(join(ROOT, 'peers.example.json'), 'utf8'))
  assert.ok(Array.isArray(example.peers))
  const text = JSON.stringify(example)
  assert.doesNotMatch(text, /"token"\s*:\s*"[^"]+"/)
})
