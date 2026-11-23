/**
 * Refusal wording of the shared configuration page.
 *
 * The browser half writes settings through the Host API directly, because the
 * shared form controller only keeps the boolean outcome of a write. These
 * checks pin how one refusal is turned into the status line: the machine code
 * and the Host message survive, and a stale revision is explained rather than
 * reported as an opaque "rejected".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Load the browser bundle the way the Host's client scanner does. */
async function loadClient() {
  const source = await readFile(join(ROOT, 'packages/ui/client.js'), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load(entry) { registration = entry } } }
  vm.runInNewContext(source, { window, console, queueMicrotask }, { filename: 'packages/ui/client.js' })
  assert.ok(registration !== undefined, 'the package registers one client module')
  const react = { createElement: (...args) => ({ args }) }
  const module = registration.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  return module
}

test('the client module still exports the Loader contract', async () => {
  const module = await loadClient()
  // The bundle runs in its own realm, so compare the values, not the array identity.
  assert.deepEqual([...module.inject], ['slots', 'configForms', 'sidebarRightTabs'])
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.rejectionReason, 'function')
})

test('a stale revision is explained with both revisions', async () => {
  const { rejectionReason } = await loadClient()
  const text = rejectionReason({
    code: 'settings/conflict',
    message: 'settings namespace "dsh-approval-policy" changed since it was read (expected revision 3, now 4)',
    details: { ns: 'dsh-approval-policy', expected: 3, actual: 4 },
  })
  assert.match(text, /revision 3 → 4/)
  assert.match(text, /请刷新页面后重试/)
  assert.doesNotMatch(text, /settings namespace/, 'the conflict is reported as stale data, not as the raw Host sentence')
})

test('a stale revision without revision details still explains itself', async () => {
  const { rejectionReason } = await loadClient()
  const text = rejectionReason({ code: 'settings/conflict', message: '' })
  assert.match(text, /被改过/)
  assert.match(text, /请刷新页面后重试/)
})

test('a refused write keeps the Host message', async () => {
  const { rejectionReason } = await loadClient()
  assert.equal(
    rejectionReason({ code: 'settings/rejected', message: 'Configuration entry is no longer available' }),
    'Configuration entry is no longer available',
  )
  assert.equal(
    rejectionReason({ code: 'settings/rejected', message: '  Config field "proxy" is not volatile  ' }),
    'Config field "proxy" is not volatile',
  )
})

test('an unknown failure keeps the code next to the message', async () => {
  const { rejectionReason } = await loadClient()
  assert.equal(rejectionReason({ code: 'gateway/internal', message: 'disk full' }), 'disk full（gateway/internal）')
  assert.equal(rejectionReason({ code: 'gateway/internal', message: '' }), 'gateway/internal')
})

test('a failure without a payload never renders empty', async () => {
  const { rejectionReason } = await loadClient()
  assert.equal(rejectionReason(undefined), '宿主没有返回原因。')
  assert.equal(rejectionReason(null), '宿主没有返回原因。')
  assert.equal(rejectionReason('boom'), '宿主没有返回原因。')
})
