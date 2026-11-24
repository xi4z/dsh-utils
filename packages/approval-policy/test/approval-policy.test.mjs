import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  globToRegExp,
  readFacts,
  shouldGate,
  describeGate,
  raceGate,
  installWithdrawSignal,
  windowExpiredReason,
  settledElsewhereReason,
  WINDOW_EXPIRED_ABORT,
  SETTLED_ABORT,
  isAutoReviewAsk,
  recordAutoReviewSettle,
  takeAutoReviewSettle,
  autoReviewNotice,
  withAutoReviewContent,
  readPermissionFacts,
  shouldPinDefaultPreset,
  apply,
} from '../lib/index.js'

// ---------------------------------------------------------------- helpers --

const DEFAULT = { origins: ['subagent', 'scheduled'], sessions: [] }

function refs(overrides = {}) {
  const values = {
    origins: ['subagent', 'scheduled'],
    sessions: [],
    windowSeconds: 60,
    defaultOutcome: 'rejected',
    defaultPermissionPreset: '',
    autoReviewContent: true,
    ...overrides,
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => value }]))
}

function fakeSession({ origin, messages = [], events } = {}) {
  return {
    ...(origin !== undefined ? { header: { origin } } : {}),
    deriveMessages: () => messages,
    ...(events !== undefined ? { snapshotEvents: () => events } : {}),
  }
}

const userMsg = (kind) => ({ role: 'user', source: { kind } })
const assistantMsg = () => ({ role: 'assistant', source: { kind: 'model' } })
const event = (type) => ({ type })

function fakeCtx({ services = {} } = {}) {
  const listeners = []
  const disposers = []
  const provided = {}
  return {
    listeners,
    disposers,
    provided,
    on(name, listener, options) {
      listeners.push({ name, listener, options })
      return () => true
    },
    effect(disposer) {
      disposers.push(disposer)
    },
    provide(name, value) {
      provided[name] = value
      return () => true
    },
    get(name) {
      return services[name]
    },
  }
}

/** Run the effect factories the way cordis does, exposing the provided services. */
function effectsRun(ctx) {
  for (const factory of [...ctx.disposers]) factory()
  return ctx.provided
}

function listenerOf(ctx, name) {
  const found = ctx.listeners.find((entry) => entry.name === name)
  assert.ok(found, `no listener registered for ${name}`)
  return found
}

const autoReviewReason = 'Auto review denied tool "bash": sudo is outside the project scope'

function fakeApprovalResult({
  errorName = 'ApprovalError',
  code = 'APPROVAL_REJECTED',
  callId = 'call-1',
  message = 'the user rejected tool "bash"',
} = {}) {
  return {
    isError: true,
    error: { message, info: { name: errorName, code } },
    content: [{ type: 'text', text: `Error: ${message}` }],
    name: 'bash',
    callId,
  }
}

/** Host 0.2.2-rc.1 shape: a plain deny with the model-facing message and no error info. */
function fakeLegacyRejection({ callId = 'call-1', message = 'the user rejected tool "bash"' } = {}) {
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
    name: 'bash',
    callId,
  }
}

// -------------------------------------------------------------------- glob --

test('globToRegExp: * matches across the id, everything else is literal', () => {
  assert.equal(globToRegExp('sess-123').test('sess-123'), true)
  assert.equal(globToRegExp('sess-123').test('sess-124'), false)
  assert.equal(globToRegExp('sess-*').test('sess-abc-def'), true)
  assert.equal(globToRegExp('*-def').test('sess-abc-def'), true)
  assert.equal(globToRegExp('*').test('anything at all'), true)
  // regex specials must not leak into the pattern (dots, plus, brackets)
  assert.equal(globToRegExp('a.b').test('a.b'), true)
  assert.equal(globToRegExp('a.b').test('axb'), false)
  assert.equal(globToRegExp('a+b').test('a+b'), true)
  assert.equal(globToRegExp('a+b').test('aab'), false)
})

// ---------------------------------------------------------------- readFacts --

test('readFacts: header origin + LAST user message kind (backward scan)', () => {
  const session = fakeSession({
    origin: 'subagent',
    messages: [userMsg('cron'), assistantMsg(), userMsg('user')],
  })
  const facts = readFacts({ id: 's1', session })
  assert.equal(facts.headerOrigin, 'subagent')
  assert.equal(facts.lastUserMessageKind, 'user') // human steer after cron fire wins
})

test('readFacts: machine-kind last message, no session, partial session', () => {
  assert.equal(
    readFacts({ id: 's1', session: fakeSession({ messages: [assistantMsg(), userMsg('schedule')] }) }).lastUserMessageKind,
    'schedule',
  )
  assert.deepEqual(readFacts({ id: 's1' }), {})
  assert.deepEqual(readFacts(undefined), {})
  const facts = readFacts({ id: 's1', session: { header: { origin: 'subagent' } } })
  assert.equal(facts.headerOrigin, 'subagent')
  assert.equal(facts.lastUserMessageKind, undefined)
})

// Regression (caught on a real host, 2026-09-25): the host injects
// synthetic role='user' messages (runtime-context, skill-catalog) AFTER the
// turn trigger — a plain "last user message" scan always saw the synthetic
// one and misclassified every cron turn as interactive.
test('readFacts: synthetic context injections do not shadow the trigger', () => {
  const cronTurn = fakeSession({
    messages: [userMsg('cron'), userMsg('runtime-context'), userMsg('skill-catalog')],
  })
  assert.equal(readFacts({ id: 's1', session: cronTurn }).lastUserMessageKind, 'cron')

  const interactiveTurn = fakeSession({
    messages: [userMsg('cron'), userMsg('user'), userMsg('runtime-context')],
  })
  assert.equal(readFacts({ id: 's1', session: interactiveTurn }).lastUserMessageKind, 'user')

  // a human steer after a cron fire wins (the "is anyone watching" rule)
  const steered = fakeSession({
    messages: [userMsg('cron'), userMsg('runtime-context'), userMsg('user')],
  })
  assert.equal(readFacts({ id: 's1', session: steered }).lastUserMessageKind, 'user')

  // missing kind = legacy human input, counts as 'user' (never skipped)
  const legacy = fakeSession({ messages: [{ role: 'user', source: {} }] })
  assert.equal(readFacts({ id: 's1', session: legacy }).lastUserMessageKind, 'user')

  // non-provenance kinds (webhook, agent-message) are skipped, not stopped on
  const mixed = fakeSession({
    messages: [userMsg('user'), userMsg('webhook'), userMsg('runtime-context')],
  })
  assert.equal(readFacts({ id: 's1', session: mixed }).lastUserMessageKind, 'user')
})

// dsh 0.2.0 timed ask (experimental): a timed-out question can still be
// answered late, and the late answer flows back as role='user' with
// source.kind='user-question-reply' — hard proof a human was there. It must
// count as human presence (same standing as an explicit 'user' steer), NOT
// be skipped as a synthetic injection past the cron/schedule trigger that
// fired earlier.
test('user-question-reply (timed-ask late answer) is human presence, not a synthetic injection', () => {
  const timedTurn = fakeSession({
    messages: [userMsg('cron'), userMsg('runtime-context'), userMsg('user-question-reply')],
  })
  assert.equal(readFacts({ id: 's1', session: timedTurn }).lastUserMessageKind, 'user-question-reply')

  assert.equal(shouldGate({ ...DEFAULT, origins: ['cron'] }, 's1', { lastUserMessageKind: 'user-question-reply' }), false)
})

// --------------------------------------------------------------- shouldGate --

test('default origins gate subagent sessions and scheduled turns, nothing else', () => {
  assert.equal(shouldGate(DEFAULT, 's1', { headerOrigin: 'subagent' }), true)
  assert.equal(shouldGate(DEFAULT, 's1', { lastUserMessageKind: 'schedule' }), true)
  assert.equal(shouldGate(DEFAULT, 's1', { lastUserMessageKind: 'cron' }), false)
  assert.equal(shouldGate(DEFAULT, 's1', { lastUserMessageKind: 'user' }), false)
  assert.equal(shouldGate(DEFAULT, 's1', {}), false)
})

test('origins opt-ins: cron and all', () => {
  assert.equal(shouldGate({ ...DEFAULT, origins: ['cron'] }, 's1', { lastUserMessageKind: 'cron' }), true)
  assert.equal(shouldGate({ ...DEFAULT, origins: ['all'] }, 's1', {}), true)
  assert.equal(shouldGate({ ...DEFAULT, origins: ['all'] }, 's1', { lastUserMessageKind: 'user' }), true)
})

test('interactive gates human-driven turns only, and composes with the machine origins', () => {
  const interactive = { ...DEFAULT, origins: ['interactive'] }
  // A live session waiting on a human: last provenance message is the human.
  assert.equal(shouldGate(interactive, 's1', { lastUserMessageKind: 'user' }), true)
  // A timed question's late reply is still human provenance.
  assert.equal(shouldGate(interactive, 's1', { lastUserMessageKind: 'user-question-reply' }), true)
  // Machine-driven turns and subagents are NOT covered by 'interactive'.
  assert.equal(shouldGate(interactive, 's1', { lastUserMessageKind: 'schedule' }), false)
  assert.equal(shouldGate(interactive, 's1', { lastUserMessageKind: 'cron' }), false)
  assert.equal(shouldGate(interactive, 's1', { headerOrigin: 'subagent', lastUserMessageKind: 'user' }), false)
  // Unknown provenance stays ungated; 'all' remains the fail-closed escape hatch.
  assert.equal(shouldGate(interactive, 's1', {}), false)
  assert.equal(shouldGate({ ...DEFAULT, origins: ['all'] }, 's1', {}), true)
  // Composed with the machine origins it behaves like 'all' minus unknown provenance.
  const composed = { ...DEFAULT, origins: ['subagent', 'scheduled', 'interactive'] }
  assert.equal(shouldGate(composed, 's1', { lastUserMessageKind: 'user' }), true)
  assert.equal(shouldGate(composed, 's1', { lastUserMessageKind: 'cron' }), false)
})

test('sessions list: glob hit gates every turn even for humans; miss does not', () => {
  const cfg = { origins: ['subagent'], sessions: ['sched-*'] }
  assert.equal(shouldGate(cfg, 'sched-tasks-9', { lastUserMessageKind: 'user' }), true)
  assert.equal(shouldGate(cfg, 'interactive-3', { lastUserMessageKind: 'user' }), false)
  const bad = { origins: [], sessions: ['[unclosed'] }
  assert.equal(shouldGate(bad, 's1', {}), false)
})

// ---------------------------------------------------------------- raceGate --

test('window 0 denies immediately, never asks downstream, and reports the window', async () => {
  let called = 0
  const settlement = await raceGate(async () => { called += 1; return 'allowed-once' }, 0, 'rejected')
  assert.deepEqual(settlement, { outcome: 'rejected', settledBy: 'window' })
  assert.equal(called, 0)
})

test('an instant fail-closed unavailable passes through the window untouched', async () => {
  const settlement = await raceGate(async () => 'unavailable', 60_000, 'rejected')
  assert.deepEqual(settlement, { outcome: 'unavailable', settledBy: 'downstream' })
})

test('a real answer inside the window wins over the default', async () => {
  const settlement = await raceGate(
    () => new Promise((resolve) => setTimeout(() => resolve('allowed-once'), 10)),
    60_000,
    'rejected',
  )
  assert.deepEqual(settlement, { outcome: 'allowed-once', settledBy: 'downstream' })
})

test('a pending answerer loses to the window: default settles it', async () => {
  const started = Date.now()
  const settlement = await raceGate(() => new Promise(() => {}), 40, 'rejected')
  assert.deepEqual(settlement, { outcome: 'rejected', settledBy: 'window' })
  assert.ok(Date.now() - started >= 30, 'the window actually bounded the wait')
})

test('unavailable is a legal default; a rejecting downstream rejects the race', async () => {
  assert.deepEqual(await raceGate(() => new Promise(() => {}), 0, 'unavailable'), { outcome: 'unavailable', settledBy: 'window' })
  await assert.rejects(raceGate(async () => { throw new Error('answerer blew up') }, 60_000, 'rejected'))
})

// ------------------------------------------------- auto review attribution --

test('isAutoReviewAsk matches the reviewer-owned reason prefix only', () => {
  assert.equal(isAutoReviewAsk(autoReviewReason), true)
  assert.equal(isAutoReviewAsk('Auto review denied tool "bash"'), true)
  assert.equal(isAutoReviewAsk('escalate sandbox to danger-full-access: need network'), false)
  assert.equal(isAutoReviewAsk('auto review denied tool "bash"'), false)
  assert.equal(isAutoReviewAsk(undefined), false)
})

test('settlements are keyed by call id, taken once, and expire', () => {
  const store = new Map()
  recordAutoReviewSettle(store, undefined, { toolName: 'bash', reason: autoReviewReason, at: 0 })
  assert.equal(store.size, 0, 'a call without an id cannot claim a result')

  recordAutoReviewSettle(store, 'call-1', { toolName: 'bash', reason: autoReviewReason, at: 1_000 })
  assert.equal(takeAutoReviewSettle(store, 'call-2', 1_000), undefined)
  assert.equal(takeAutoReviewSettle(store, 'call-1', 1_500).reason, autoReviewReason)
  assert.equal(takeAutoReviewSettle(store, 'call-1', 1_500), undefined, 'a settlement is consumed once')

  recordAutoReviewSettle(store, 'call-3', { toolName: 'bash', reason: autoReviewReason, at: 0 })
  assert.equal(takeAutoReviewSettle(store, 'call-3', 120_001), undefined)
  assert.equal(store.size, 0, 'expired entries are pruned')
})

test('the appended content keeps the denial and carries the reviewer content', () => {
  const original = [{ type: 'text', text: 'Error: the user rejected tool "bash"' }]
  const settle = { toolName: 'bash', reason: autoReviewReason, at: 0 }
  const content = withAutoReviewContent(original, settle)
  assert.equal(content.length, 2)
  assert.deepEqual(content[0], original[0])
  assert.equal(content[1].type, 'text')
  assert.match(content[1].text, /unattended approval window expired/)
  assert.ok(content[1].text.includes(autoReviewReason))
  // the notice names the tool so a multi-call turn cannot misattribute it
  assert.ok(autoReviewNotice('bash', autoReviewReason).includes('tool "bash"'))
})

// ---------------------------------------------------------- default preset --

test('readPermissionFacts folds the permission-relevant events', () => {
  assert.deepEqual(readPermissionFacts(fakeSession({ events: [] })), {
    readable: true, turnStarted: false, permissionState: false, seeded: false,
  })
  assert.deepEqual(readPermissionFacts(fakeSession({ events: [event('permission/preset'), event('sandbox/mode')] })), {
    readable: true, turnStarted: false, permissionState: true, seeded: false,
  })
  assert.deepEqual(readPermissionFacts(fakeSession({ events: [event('turn/start')] })), {
    readable: true, turnStarted: true, permissionState: false, seeded: false,
  })
  assert.deepEqual(readPermissionFacts(fakeSession({ events: [event('session/end-seed')] })), {
    readable: true, turnStarted: false, permissionState: true, seeded: true,
  })
  // a session that cannot expose its log must never be repinned
  assert.equal(readPermissionFacts(undefined).readable, false)
  assert.equal(readPermissionFacts({}).readable, false)
})

test('shouldPinDefaultPreset: fresh sessions only, and only when the host pin is creation-time state', () => {
  const fresh = { readable: true, turnStarted: false, permissionState: false, seeded: false }
  const pinned = { readable: true, turnStarted: false, permissionState: true, seeded: false }
  const resumed = { readable: true, turnStarted: true, permissionState: true, seeded: false }

  // no configuration → no pin
  assert.equal(shouldPinDefaultPreset({ configured: '', current: 'workspace-write', hostDefault: 'workspace-write', facts: fresh }), false)
  // already on the configured preset
  assert.equal(shouldPinDefaultPreset({ configured: 'auto', current: 'auto', hostDefault: 'workspace-write', facts: fresh }), false)
  // the gate ran before the host pinned its default
  assert.equal(shouldPinDefaultPreset({ configured: 'auto', current: 'workspace-write', hostDefault: 'workspace-write', facts: fresh }), true)
  // the host pinned its default first — still a creation-time pin
  assert.equal(shouldPinDefaultPreset({ configured: 'auto', current: 'workspace-write', hostDefault: 'workspace-write', facts: pinned }), true)
  // the host pinned something else, or a user switched before the first turn
  assert.equal(shouldPinDefaultPreset({ configured: 'auto', current: 'read-only', hostDefault: 'workspace-write', facts: pinned }), false)
  // resumed and seeded sessions keep their recorded permission
  assert.equal(shouldPinDefaultPreset({ configured: 'auto', current: 'workspace-write', hostDefault: 'workspace-write', facts: resumed }), false)
  assert.equal(shouldPinDefaultPreset({ configured: 'auto', current: 'workspace-write', hostDefault: 'workspace-write', facts: { ...pinned, seeded: true } }), false)
  // unreadable session logs never repin
  assert.equal(shouldPinDefaultPreset({ configured: 'auto', current: 'workspace-write', hostDefault: 'workspace-write', facts: readPermissionFacts(undefined) }), false)
})

// ------------------------------------------------------------------- apply --

test('apply registers the policy service, the gate, the result editor, and the default-preset pin, then disposes all of them', () => {
  const ctx = fakeCtx()
  apply(ctx, refs())
  assert.equal(ctx.listeners.length, 3)
  assert.equal(listenerOf(ctx, 'approval/request').options?.prepend, true)
  assert.equal(listenerOf(ctx, 'tools/post-execute').options?.prepend, true)
  assert.equal(listenerOf(ctx, 'agent/created').options?.prepend, undefined)
  // the service effect, the gate, the result editor, the pin
  assert.equal(ctx.disposers.length, 4)
})

test('listener: an interactive turn delegates to next() untouched', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs())
  const { listener } = listenerOf(ctx, 'approval/request')
  let delegated = 0
  const request = { agent: { id: 'interactive-1', session: fakeSession({ messages: [userMsg('user')] }) } }
  const outcome = await listener(request, async () => { delegated += 1; return 'allowed-once' })
  assert.equal(outcome, 'allowed-once')
  assert.equal(delegated, 1)
})

test('listener: a subagent turn with window 0 denies without delegating', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ windowSeconds: 0 }))
  const { listener } = listenerOf(ctx, 'approval/request')
  let delegated = 0
  const request = { agent: { id: 'child-1', session: fakeSession({ origin: 'subagent' }) } }
  const outcome = await listener(request, async () => { delegated += 1; return 'allowed-once' })
  assert.equal(outcome, 'rejected')
  assert.equal(delegated, 0)
})

test('listener: a cron turn is windowed (default origins without cron do NOT gate it)', async () => {
  const defaultCtx = fakeCtx()
  apply(defaultCtx, refs())
  const cronRequest = { agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('cron')] }) } }
  let delegated = 0
  const defaultOutcome = await listenerOf(defaultCtx, 'approval/request').listener(cronRequest, async () => {
    delegated += 1
    return 'allowed-once'
  })
  assert.equal(defaultOutcome, 'allowed-once')
  assert.equal(delegated, 1)

  const cronCtx = fakeCtx()
  apply(cronCtx, refs({ origins: ['cron'], windowSeconds: 0 }))
  const gated = await listenerOf(cronCtx, 'approval/request').listener(cronRequest, async () => 'allowed-once')
  assert.equal(gated, 'rejected')
})

test('listener: a sessions-list hit gates even a human-driven turn', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ sessions: ['night-*'], windowSeconds: 0 }))
  const { listener } = listenerOf(ctx, 'approval/request')
  const request = { agent: { id: 'night-runner', session: fakeSession({ messages: [userMsg('user')] }) } }
  assert.equal(await listener(request, async () => 'allowed-once'), 'rejected')
})

test('withdraw helpers: both abort reasons are identifiable and the caller signal still flows through', () => {
  assert.equal(windowExpiredReason().name, WINDOW_EXPIRED_ABORT)
  assert.equal(settledElsewhereReason().name, SETTLED_ABORT)
  const caller = new AbortController()
  const withdraw = new AbortController()
  const request = { signal: caller.signal }
  const fused = installWithdrawSignal(request, withdraw)
  assert.equal(request.signal, fused)
  assert.equal(fused.aborted, false)
  caller.abort(new Error('turn cancelled'))
  assert.equal(fused.aborted, true)
})

test('listener: window expiry withdraws the delegated prompt', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 0.05 }))
  const { listener } = listenerOf(ctx, 'approval/request')
  const request = { agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('schedule')] }) } }
  let shown
  const outcome = await listener(request, async () => {
    shown = request.signal // the Web GUI answered chain now owns the prompt
    return new Promise(() => {})
  })
  assert.equal(outcome, 'rejected')
  assert.ok(shown instanceof AbortSignal)
  assert.equal(shown.aborted, true)
  assert.equal(shown.reason.name, WINDOW_EXPIRED_ABORT)
})

test('listener: a downstream answer withdraws the prompts left on the other surfaces', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 60 }))
  const { listener } = listenerOf(ctx, 'approval/request')
  const request = { agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('schedule')] }) } }
  let shown
  assert.equal(await listener(request, async () => { shown = request.signal; return 'allowed-once' }), 'allowed-once')
  assert.ok(shown instanceof AbortSignal)
  assert.equal(shown.aborted, true)
  assert.equal(shown.reason.name, SETTLED_ABORT)
})

test('policyInfo.withdraw: settles the request from outside and ends the pending prompt', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 60 }))
  const info = effectsRun(ctx).approvalPolicyInfo
  assert.equal(typeof info.withdraw, 'function')
  const { listener } = listenerOf(ctx, 'approval/request')
  const request = { agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('schedule')] }) } }
  let shown
  const pending = listener(request, async () => { shown = request.signal; return new Promise(() => {}) })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(shown.aborted, false)
  // an answerer outside the delegated chain (the QQ card) decided it
  assert.equal(info.withdraw(request, 'allowed-once'), true)
  assert.equal(shown.aborted, true)
  assert.equal(shown.reason.name, SETTLED_ABORT)
  // the outside answer wins the race instead of the gate's own window
  assert.equal(await pending, 'allowed-once')
  assert.equal(info.withdraw(request, 'allowed-once'), false) // already settled
  assert.equal(info.withdraw({ agent: {} }, 'rejected'), false) // never held by the gate
})

test('listener: the caller signal still reaches the delegated prompt (turn cancellation)', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 0.05 }))
  const { listener } = listenerOf(ctx, 'approval/request')
  const turn = new AbortController()
  const reason = new Error('turn cancelled')
  const request = {
    agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('schedule')] }) },
    signal: turn.signal,
  }
  let shown
  const pending = listener(request, async () => { shown = request.signal; return new Promise(() => {}) })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.notEqual(shown, turn.signal)
  assert.equal(shown.aborted, false)
  turn.abort(reason)
  assert.equal(shown.reason, reason)
  // the window still settles the gate once the turn's own abort is observed
  assert.equal(await pending, 'rejected')
})

test('listener: a downstream rejected BY the withdrawal does not disturb the settlement', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 0.03 }))
  const { listener } = listenerOf(ctx, 'approval/request')
  const request = { agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('schedule')] }) } }
  // Mirrors the Host gateway: cancelling the forwarded prompt rejects the
  // downstream answerer, long after the gate already returned its outcome.
  const outcome = await listener(request, () => new Promise((_, reject) => {
    request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  }))
  assert.equal(outcome, 'rejected')
  await new Promise((resolve) => setTimeout(resolve, 20)) // no unhandled rejection
})

test('listener: a zero window never installs a withdraw signal', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 0 }))
  const { listener } = listenerOf(ctx, 'approval/request')
  const turn = new AbortController()
  const request = {
    agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('schedule')] }) },
    signal: turn.signal,
  }
  assert.equal(await listener(request, async () => 'allowed-once'), 'rejected')
  assert.equal(request.signal, turn.signal)
})

test('auto review: a window rejection feeds the reviewer content into the tool result', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 0 }))
  const gate = listenerOf(ctx, 'approval/request').listener
  const post = listenerOf(ctx, 'tools/post-execute').listener
  const request = {
    agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('schedule')] }) },
    toolName: 'bash',
    callId: 'call-7',
    reason: autoReviewReason,
  }
  assert.equal(await gate(request, async () => 'allowed-once'), 'rejected')

  const decision = await post(fakeApprovalResult({ callId: 'call-7' }), fakeApprovalResult({ callId: 'call-7' }), async () => ({
    kind: 'accept',
  }))
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 2)
  assert.ok(decision.content[1].text.includes(autoReviewReason))
  assert.ok(decision.content[1].text.includes('unattended approval window expired'))

  // the settlement is single-use: the next result for the same call id is untouched
  const second = await post(fakeApprovalResult({ callId: 'call-7' }), fakeApprovalResult({ callId: 'call-7' }), async () => ({ kind: 'accept' }))
  assert.equal(second.kind, 'accept')
  assert.equal(second.content, undefined)
})

test('auto review: the human answer inside the window wins and leaves no reviewer note', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 60 }))
  const gate = listenerOf(ctx, 'approval/request').listener
  const post = listenerOf(ctx, 'tools/post-execute').listener
  const request = {
    agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('schedule')] }) },
    toolName: 'bash',
    callId: 'call-8',
    reason: autoReviewReason,
  }
  assert.equal(await gate(request, async () => 'rejected'), 'rejected')
  const decision = await post(fakeApprovalResult({ callId: 'call-8' }), fakeApprovalResult({ callId: 'call-8' }), async () => ({ kind: 'accept' }))
  assert.equal(decision.content, undefined)
})

test('auto review content can be switched off; non-review reasons are never annotated', async () => {
  const off = fakeCtx()
  apply(off, refs({ origins: ['all'], windowSeconds: 0, autoReviewContent: false }))
  const offGate = listenerOf(off, 'approval/request').listener
  await offGate(
    { agent: { id: 'r', session: fakeSession() }, toolName: 'bash', callId: 'call-9', reason: autoReviewReason },
    async () => 'allowed-once',
  )
  const offPost = listenerOf(off, 'tools/post-execute').listener
  assert.equal((await offPost(fakeApprovalResult({ callId: 'call-9' }), fakeApprovalResult({ callId: 'call-9' }), async () => ({ kind: 'accept' }))).content, undefined)

  const gateCtx = fakeCtx()
  apply(gateCtx, refs({ origins: ['all'], windowSeconds: 0 }))
  const gate = listenerOf(gateCtx, 'approval/request').listener
  await gate(
    { agent: { id: 'r', session: fakeSession() }, toolName: 'bash', callId: 'call-10', reason: 'escalate sandbox to danger-full-access: need network' },
    async () => 'allowed-once',
  )
  const post = listenerOf(gateCtx, 'tools/post-execute').listener
  assert.equal((await post(fakeApprovalResult({ callId: 'call-10' }), fakeApprovalResult({ callId: 'call-10' }), async () => ({ kind: 'accept' }))).content, undefined)
})

test('post-execute: only approval rejections are edited; other failures delegate', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 0 }))
  const gate = listenerOf(ctx, 'approval/request').listener
  const post = listenerOf(ctx, 'tools/post-execute').listener
  await gate(
    { agent: { id: 'r', session: fakeSession() }, toolName: 'bash', callId: 'call-11', reason: autoReviewReason },
    async () => 'allowed-once',
  )

  let delegated = 0
  const otherCode = await post(fakeApprovalResult({ callId: 'call-11' }), fakeApprovalResult({
    callId: 'call-11',
    errorName: 'SandboxEscalationError',
    code: 'SANDBOX_ESCALATION_REJECTED',
    message: 'the user rejected escalating this command to "danger-full-access"; it stays denied, so stop and explain instead of working around it',
  }), async () => {
    delegated += 1
    return { kind: 'accept' }
  })
  assert.equal(delegated, 1)
  assert.equal(otherCode.content, undefined)

  const success = await post({ isError: false, content: [] }, { isError: false, content: [] }, async () => {
    delegated += 1
    return { kind: 'accept' }
  })
  assert.equal(delegated, 2)
  assert.deepEqual(success, { kind: 'accept' })
})

// ------------------------------------------------ approvalPolicyInfo view --

test('describeGate mirrors the gate predicate and window for a human channel', () => {
  const policy = { origins: ['subagent'], sessions: [], windowSeconds: 60, defaultOutcome: 'rejected' }
  const sub = describeGate(policy, { id: 'c', session: { header: { origin: 'subagent' } } }, 'child-1')
  assert.deepEqual(sub, { gated: true, windowMs: 60000, defaultOutcome: 'rejected' })

  const human = describeGate(policy, { id: 'r', session: fakeSession({ messages: [userMsg('user')] }) }, 'root-1')
  assert.equal(human.gated, false)

  const zero = describeGate({ ...policy, windowSeconds: 0 }, {}, 'x')
  assert.equal(zero.windowMs, 0)
})

test('describeGate honours the sessions list and the fail-closed default', () => {
  const policy = { origins: [], sessions: ['night-*'], windowSeconds: 2.5, defaultOutcome: 'unavailable' }
  const hit = describeGate(policy, {}, 'night-runner')
  assert.equal(hit.gated, true)
  assert.equal(hit.windowMs, 2500)
  assert.equal(hit.defaultOutcome, 'unavailable')
  assert.equal(describeGate(policy, {}, 'day-runner').gated, false)
})

test('post-execute: the 0.2.2-rc.1 message-only rejection is recognized too', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 0 }))
  const gate = listenerOf(ctx, 'approval/request').listener
  const post = listenerOf(ctx, 'tools/post-execute').listener
  await gate(
    { agent: { id: 'r', session: fakeSession() }, toolName: 'bash', callId: 'call-13', reason: autoReviewReason },
    async () => 'allowed-once',
  )
  const decision = await post(fakeLegacyRejection({ callId: 'call-13' }), fakeLegacyRejection({ callId: 'call-13' }), async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 2)
  assert.ok(decision.content[1].text.includes(autoReviewReason))
})

test('post-execute: a downstream block is preserved verbatim', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ origins: ['all'], windowSeconds: 0 }))
  const gate = listenerOf(ctx, 'approval/request').listener
  const post = listenerOf(ctx, 'tools/post-execute').listener
  await gate(
    { agent: { id: 'r', session: fakeSession() }, toolName: 'bash', callId: 'call-12', reason: autoReviewReason },
    async () => 'allowed-once',
  )
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  assert.deepEqual(await post(fakeApprovalResult({ callId: 'call-12' }), fakeApprovalResult({ callId: 'call-12' }), async () => blocked), blocked)
})

test('default preset: a fresh session is pinned, a resumed one is left alone', () => {
  const calls = []
  const presets = {
    names: ['workspace-write', 'danger-full-access', 'auto'],
    defaultPreset: 'workspace-write',
    current: (session) => session.current,
    set: (session, name) => { calls.push({ session, name }); session.current = name },
  }
  const ctx = fakeCtx({ services: { permissionPresets: presets } })
  apply(ctx, refs({ defaultPermissionPreset: 'auto' }))
  const pin = listenerOf(ctx, 'agent/created').listener

  const fresh = { current: 'workspace-write', snapshotEvents: () => [] }
  pin({ agent: { id: 'a1', session: fresh } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'auto')

  const resumed = { current: 'workspace-write', snapshotEvents: () => [event('approval/policy'), event('turn/start')] }
  pin({ agent: { id: 'a2', session: resumed } })
  assert.equal(calls.length, 1)
})

test('default preset: a missing preset or missing service fails fast', () => {
  const noAuto = {
    names: ['workspace-write'],
    defaultPreset: 'workspace-write',
    current: () => 'workspace-write',
    set: () => {},
  }
  const ctx = fakeCtx({ services: { permissionPresets: noAuto } })
  apply(ctx, refs({ defaultPermissionPreset: 'auto' }))
  const pin = listenerOf(ctx, 'agent/created').listener
  assert.throws(
    () => pin({ agent: { id: 'a1', session: { current: 'workspace-write', snapshotEvents: () => [] } } }),
    /requires the @deepseek-ai\/dsh-experimental-auto-review bundle/,
  )

  const noService = fakeCtx()
  apply(noService, refs({ defaultPermissionPreset: 'auto' }))
  assert.throws(
    () => listenerOf(noService, 'agent/created').listener({ agent: { id: 'a1' } }),
    /requires ctx\.permissionPresets/,
  )

  // no configuration → the listener never touches the service
  const off = fakeCtx()
  apply(off, refs())
  assert.doesNotThrow(() => listenerOf(off, 'agent/created').listener({ agent: { id: 'a1' } }))
})
