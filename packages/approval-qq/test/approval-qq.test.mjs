import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createAnswerer,
  deadlineLine,
  formatDuration,
  renderApprovalCard,
  resolveOptions,
  commandOf,
  createRelayClient,
  apply,
  Config,
} from '../lib/index.js'
import { needsTranslation, translateToChinese } from '../lib/translate.js'

function options(overrides = {}) {
  return {
    enabled: true,
    relayUrl: 'https://relay.test/_qq/approval',
    sharedKey: 'secret',
    deviceLabel: '随身本',
    sendDelayMs: 1200,
    pollWaitSeconds: 25,
    timeoutMs: 10000,
    includeSubagents: true,
    dryRun: false,
    allowReceipt: 'ALLOWED',
    denyReceipt: 'DENIED',
    translateEnglish: true,
    translateTimeoutMs: 4000,
    translateProvider: '',
    translateModel: '',
    ...overrides,
  }
}

function request(overrides = {}) {
  return {
    agent: {
      id: 'session-1234567890',
      session: { header: { cwd: '/tmp/work', origin: 'user' }, events: [] },
    },
    toolName: 'bash',
    callId: 'call-1',
    reason: '需要清理目录',
    ...overrides,
  }
}

function fakeRelay(waitImpl) {
  const calls = { create: [], wait: [], settle: [] }
  return {
    calls,
    async create(input) { calls.create.push(input); return { messageId: 'm1' } },
    async wait(askId, waitSeconds, signal) {
      calls.wait.push({ askId, waitSeconds })
      return waitImpl ? waitImpl(askId, waitSeconds, signal) : { state: 'pending' }
    },
    async settle(askId, body) { calls.settle.push({ askId, body }) },
  }
}

function deps(relay, overrides = {}) {
  return {
    config: () => options(overrides.options),
    relay: () => relay,
    sleep: async () => {},
    now: () => 1_000_000,
    randomId: () => 'a'.repeat(32),
    ...overrides.deps,
  }
}

async function never() {
  return new Promise(() => {})
}

test('renderApprovalCard: gated card carries the countdown and the command', () => {
  const card = renderApprovalCard({
    sessionId: 'session-abcdef123',
    cwd: '/tmp/work',
    device: '随身本',
    toolName: 'bash',
    command: 'rm -rf /tmp/x',
    reason: '清理',
    gated: true,
    remainingMs: 60_000,
    defaultOutcome: 'rejected',
    now: new Date('2026-11-23T18:00:00+08:00').getTime(),
  })
  assert.match(card, /执行审批/)
  assert.match(card, /设备: 随身本/)
  assert.match(card, /会话: abcdef12/)
  assert.match(card, /60 秒内未处理将自动拒绝/)
  assert.match(card, /再点按钮不会生效/)
  assert.match(card, /rm -rf \/tmp\/x/)
})

test('renderApprovalCard: interactive cards have no deadline', () => {
  const card = renderApprovalCard({
    sessionId: 'session-abcdef123',
    toolName: 'bash',
    gated: false,
  })
  assert.doesNotMatch(card, /自动拒绝/)
  assert.match(card, /工具: bash/)
})

test('deadlineLine names the fail-closed outcome', () => {
  const line = deadlineLine({ remainingMs: 120_000, defaultOutcome: 'unavailable', now: 0 })
  assert.match(line, /2 分钟内未处理将自动判定为不可用/)
})

test('formatDuration rounds to seconds, minutes, hours', () => {
  assert.equal(formatDuration(45_000), '45 秒')
  assert.equal(formatDuration(120_000), '2 分钟')
  assert.equal(formatDuration(7_200_000), '2 小时')
})

test('resolveOptions normalizes relay URL and keeps the shared key literal', () => {
  process.env.APPROVAL_TEST_KEY = 'from-env'
  const resolved = resolveOptions({
    enabled: true,
    relayUrl: 'https://relay.test/_qq',
    sharedKey: 'explicit-key',
    sendDelayMs: 500,
  })
  assert.equal(resolved.relayUrl, 'https://relay.test/_qq/approval')
  assert.equal(resolved.sharedKey, 'explicit-key')
  assert.equal(resolved.sendDelayMs, 500)
  assert.ok(resolved.deviceLabel.length > 0)
  delete process.env.APPROVAL_TEST_KEY
})

test('sharedKey is a write-only secret in the settings schema', () => {
  const json = Config.toJSON()
  const refs = Object.values(json.refs ?? {})
  const field = refs.find((ref) => typeof ref?.meta?.description === 'string' && ref.meta.description.startsWith('Shared key'))
  assert.ok(field, 'sharedKey schema ref not found')
  assert.equal(field.meta.role, 'secret')
})

test('commandOf finds the gated command by call id', () => {
  const req = request({
    agent: {
      id: 's',
      session: {
        header: {},
        events: [
          { type: 'tool/call', data: { callId: 'other', arguments: '{"command":"nope"}' } },
          { type: 'tool/call', data: { callId: 'call-1', arguments: '{"command":"rm -rf /tmp/x"}' } },
        ],
      },
    },
  })
  assert.equal(commandOf(req), 'rm -rf /tmp/x')
})

test('answerer: disabled or missing relay credentials delegate untouched', async () => {
  const relay = fakeRelay()
  const disabled = createAnswerer(deps(relay, { options: { enabled: false } }))
  assert.equal(await disabled(request(), async () => 'unavailable'), 'unavailable')
  assert.equal(relay.calls.create.length, 0)

  const noKey = createAnswerer(deps(relay, { options: { sharedKey: '' } }))
  assert.equal(await noKey(request(), async () => 'unavailable'), 'unavailable')
})

test('answerer: subagents can be excluded', async () => {
  const relay = fakeRelay()
  const answerer = createAnswerer(deps(relay, { options: { includeSubagents: false } }))
  const subagent = request({
    agent: { id: 's', session: { header: { origin: 'subagent' }, events: [] } },
  })
  assert.equal(await answerer(subagent, async () => 'rejected'), 'rejected')
  assert.equal(relay.calls.create.length, 0)
})

test('answerer: a decision inside the debounce sends no card', async () => {
  const relay = fakeRelay()
  const answerer = createAnswerer(deps(relay))
  const outcome = await answerer(request(), async () => 'allowed-once')
  assert.equal(outcome, 'allowed-once')
  assert.equal(relay.calls.create.length, 0)
})

test('answerer: a zero gate window sends no card', async () => {
  const relay = fakeRelay()
  const answerer = createAnswerer(deps(relay, {
    deps: {
      policyInfo: () => ({ describe: () => ({ gated: true, windowMs: 0, defaultOutcome: 'rejected' }) }),
    },
  }))
  assert.equal(await answerer(request(), async () => 'rejected'), 'rejected')
  assert.equal(relay.calls.create.length, 0)
})

test('answerer: allow click wins, settles allowed-once with a receipt', async () => {
  const relay = fakeRelay(() => ({ state: 'clicked', choice: 'allow' }))
  const answerer = createAnswerer(deps(relay, {
    deps: {
      policyInfo: () => ({ describe: () => ({ gated: true, windowMs: 60_000, defaultOutcome: 'rejected' }) }),
    },
  }))
  const outcome = await answerer(request(), never)
  assert.equal(outcome, 'allowed-once')
  assert.equal(relay.calls.settle.length, 1)
  assert.deepEqual(relay.calls.settle[0].body, { outcome: 'allowed-once', receipt: 'ALLOWED' })
  assert.match(relay.calls.create[0].markdown, /60 秒内未处理/)
})

test('answerer: deny click settles rejected', async () => {
  const relay = fakeRelay(() => ({ state: 'clicked', choice: 'deny' }))
  const answerer = createAnswerer(deps(relay))
  assert.equal(await answerer(request(), never), 'rejected')
  assert.deepEqual(relay.calls.settle[0].body, { outcome: 'rejected', receipt: 'DENIED' })
})

test('answerer: gate auto-reject wins and closes the card silently', async () => {
  const relay = fakeRelay()
  const answerer = createAnswerer(deps(relay, {
    deps: {
      policyInfo: () => ({ describe: () => ({ gated: true, windowMs: 60_000, defaultOutcome: 'rejected' }) }),
      sleep: async () => {},
    },
  }))
  let settleDownstream
  const downstream = new Promise((resolve) => { settleDownstream = resolve })
  const pending = answerer(request(), () => downstream)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(relay.calls.create.length, 1)
  settleDownstream('rejected')
  assert.equal(await pending, 'rejected')
  assert.equal(relay.calls.settle.length, 1)
  assert.equal(relay.calls.settle[0].body.outcome, 'ignored')
  assert.match(relay.calls.settle[0].body.reason, /auto-rejected|answered-elsewhere/)
})

test('answerer: abort settles ignored and returns cancelled', async () => {
  const relay = fakeRelay((askId, waitSeconds, signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve({ state: 'pending' }); return }
    signal?.addEventListener('abort', () => resolve({ state: 'pending' }), { once: true })
  }))
  const controller = new AbortController()
  const answerer = createAnswerer(deps(relay))
  const pending = answerer(request({ signal: controller.signal }), never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  assert.equal(await pending, 'cancelled')
  assert.equal(relay.calls.settle[0].body.reason, 'aborted')
})

test('relay client: sends the shared key and maps the three states', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    const href = String(url)
    seen.push({ url: href, init })
    const body = href.includes('/settle') ? {} : href.includes('?wait=') ? { state: 'clicked', choice: 'deny' } : { messageId: 'm9' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createRelayClient({ baseUrl: 'https://r.test/_qq/approval/', key: 'k', timeoutMs: 1000, fetchImpl })
  assert.deepEqual(await client.create({ askId: 'a', markdown: 'x' }), { messageId: 'm9' })
  assert.deepEqual(await client.wait('a', 5), { state: 'clicked', choice: 'deny' })
  await client.settle('a', { outcome: 'rejected' })
  assert.equal(seen[0].url, 'https://r.test/_qq/approval')
  assert.equal(seen[0].init.headers['x-approval-key'], 'k')
  assert.match(seen[1].url, /\?wait=5$/)
  assert.equal(seen[2].url, 'https://r.test/_qq/approval/a/settle')
})

test('relay client: a non-2xx response throws with the status', async () => {
  const client = createRelayClient({
    baseUrl: 'https://r.test/approval',
    key: 'k',
    timeoutMs: 1000,
    fetchImpl: async () => new Response('nope', { status: 500 }),
  })
  await assert.rejects(() => client.settle('a', { outcome: 'ignored' }), /relay HTTP 500/)
})

test('apply registers one prepended approval/request listener', () => {
  const listeners = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, fn, opts) {
      listeners.push({ name, fn, opts })
      return () => {}
    },
    effect(fn) {
      return fn()
    },
    get() {
      return undefined
    },
  }
  apply(ctx, { enabled: false })
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].name, 'approval/request')
  assert.equal(listeners[0].opts.prepend, true)
})

test('answerer: empty receipts send no callback', async () => {
  const relay = fakeRelay(() => ({ state: 'clicked', choice: 'allow' }))
  const answerer = createAnswerer(deps(relay, {
    options: { allowReceipt: '', denyReceipt: '' },
  }))
  assert.equal(await answerer(request(), never), 'allowed-once')
  assert.deepEqual(relay.calls.settle[0].body, { outcome: 'allowed-once', receipt: '' })
})

test('needsTranslation: only prose without CJK is translated', () => {
  assert.equal(needsTranslation('Auto review denied tool "bash": sudo is outside the project scope'), true)
  assert.equal(needsTranslation('需要清理目录'), false)
  assert.equal(needsTranslation('Auto review 拒绝：超出范围'), false)
  assert.equal(needsTranslation('short'), false)
  assert.equal(needsTranslation(undefined), false)
})

test('translateToChinese: one-shot completion, CJK output only', async () => {
  const captured = []
  const llm = {
    async *stream(options) {
      captured.push(options)
      yield { type: 'text-delta', index: 0, text: '自动审批' }
      yield { type: 'text-delta', index: 0, text: '拒绝了工具' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const out = await translateToChinese(llm, { provider: 'p', model: 'm' }, 'Auto review denied the tool', { timeoutMs: 1000 })
  assert.equal(out, '自动审批拒绝了工具')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].provider, 'p')
  assert.equal(captured[0].model, 'm')
  assert.match(captured[0].system, /Simplified Chinese/)
  assert.equal(captured[0].messages[0].role, 'user')
})

test('translateToChinese: a non-Chinese or failed answer yields undefined', async () => {
  const englishOnly = {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: 'Still English' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  assert.equal(await translateToChinese(englishOnly, { provider: 'p', model: 'm' }, 'English', { timeoutMs: 1000 }), undefined)

  const errored = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }
    },
  }
  assert.equal(await translateToChinese(errored, { provider: 'p', model: 'm' }, 'English', { timeoutMs: 1000 }), undefined)
})

test('answerer: English reasons are translated before rendering', async () => {
  const relay = fakeRelay(() => ({ state: 'clicked', choice: 'allow' }))
  const seen = []
  const answerer = createAnswerer(deps(relay, {
    deps: {
      translate: async (text, budget) => { seen.push({ text, budget }); return '自动审批拒绝了工具：sudo 超出范围' },
    },
  }))
  const outcome = await answerer(request({ reason: 'Auto review denied tool "bash": sudo is outside the project scope' }), never)
  assert.equal(outcome, 'allowed-once')
  assert.equal(seen.length, 1)
  assert.match(relay.calls.create[0].markdown, /自动审批拒绝了工具/)
  assert.doesNotMatch(relay.calls.create[0].markdown, /outside the project scope/)
})

test('answerer: Chinese reasons and failed translations keep the source', async () => {
  const relay = fakeRelay(() => ({ state: 'clicked', choice: 'deny' }))
  let calls = 0
  const chinese = createAnswerer(deps(relay, { deps: { translate: async () => { calls += 1; return 'x' } } }))
  await chinese(request({ reason: '需要清理临时目录' }), never)
  assert.equal(calls, 0)
  assert.match(relay.calls.create[0].markdown, /需要清理临时目录/)

  const failed = createAnswerer(deps(relay, { deps: { translate: async () => undefined } }))
  await failed(request({ reason: 'Auto review denied tool "bash": outside scope' }), never)
  assert.match(relay.calls.create[1].markdown, /outside scope/)
})

test('answerer: translation can be switched off', async () => {
  const relay = fakeRelay(() => ({ state: 'clicked', choice: 'allow' }))
  let calls = 0
  const answerer = createAnswerer(deps(relay, {
    options: { translateEnglish: false },
    deps: { translate: async () => { calls += 1; return '翻译' } },
  }))
  await answerer(request({ reason: 'Auto review denied tool "bash": outside scope' }), never)
  assert.equal(calls, 0)
})

test('answerer: card send failure falls back to the GUI chain', async () => {
  const relay = fakeRelay()
  relay.create = async () => { throw new Error('relay down') }
  const answerer = createAnswerer(deps(relay))
  const outcome = await answerer(request(), async () => { throw new Error('downstream should win') })
    .catch((error) => error.message)
  assert.equal(outcome, 'downstream should win')
  assert.equal(relay.calls.settle.length, 0)
})
