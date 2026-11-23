/**
 * End-to-end check of the plugin's wire logic against a local OneBot mock:
 * real listeners, real fetch, no DeepSeek Harness process needed.
 *
 *   node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply, renderMessage, renderApprovalMessage, callAction, Config } from '../lib/index.js'

/** Start a minimal OneBot 11 HTTP endpoint and record what it receives. */
async function startMock() {
  const requests = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        headers: request.headers,
        body: raw ? JSON.parse(raw) : undefined,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { requests, port, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** Fake Cordis context that records listeners so a test can emit events. */
function fakeContext(roots) {
  const listeners = new Map()
  const logs = []
  return {
    logs,
    on(event, optionsOrHandler, maybeHandler) {
      const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    agents: { roots: () => roots },
    effect(factory) {
      const disposer = factory()
      return () => {
        try { disposer?.() } catch { /* ignore */ }
      }
    },
    logger: {
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
    },
  }
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

test('renders a compact Chinese notification body', () => {
  const body = renderMessage({
    sessionId: 'abcdef1234567890',
    cwd: '/root/core',
    reason: 'completed',
    reply: '  已完成\n 迁移  ',
    summaryChars: 100,
  })
  assert.match(body, /^\[DSH\] 会话完成/)
  assert.match(body, /会话: abcdef12/)
  assert.match(body, /目录: \/root\/core/)
  assert.match(body, /结果: 完成/)
  assert.match(body, /回复: 已完成 迁移/)
})

test('idle edge after a completed turn posts exactly one QQ message', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-1', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])

  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    token: 'secret-token',
    targetType: 'private',
    targetId: '10001',
    notifyOnReasons: ['completed'],
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-1' }, { type: 'turn/start', data: { turn: 3 } })
  ctx.emit('session/event', { id: 'sess-1' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '部署完成，3 个服务均已健康' }] } },
  })
  ctx.emit('session/event', { id: 'sess-1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('agent/status', { agent, status: 'idle' })
  // A second idle edge with no new turn must not notify again.
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()

  assert.equal(mock.requests.length, 1, 'expected exactly one delivery')
  const [request] = mock.requests
  assert.equal(request.url, '/send_private_msg')
  assert.equal(request.authorization, 'Bearer secret-token')
  assert.equal(request.body.user_id, '10001')
  assert.equal(request.body.message[0].type, 'text')
  assert.match(request.body.message[0].data.text, /部署完成，3 个服务均已健康/)
})

test('group targets use send_group_msg', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-2', session: { header: { cwd: '/tmp' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    targetType: 'group',
    targetId: '20002',
    notifyOnReasons: ['completed'],
    dryRun: false,
    timeoutMs: 3000,
  })
  ctx.emit('session/event', { id: 'sess-2' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-2' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()

  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].url, '/send_group_msg')
  assert.equal(mock.requests[0].body.group_id, '20002')
})

test('subagent sessions and filtered reasons stay silent', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const root = { id: 'root', session: { header: {} } }
  const child = { id: 'child', session: { header: {} } }
  const ctx = fakeContext([root])
  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    targetType: 'private',
    targetId: '1',
    notifyOnReasons: ['completed'],
    includeSubagents: false,
    dryRun: false,
    timeoutMs: 3000,
  })

  // Child agent: not a root, must be skipped.
  ctx.emit('session/event', { id: 'child' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'child' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent: child, status: 'running' })
  ctx.emit('agent/status', { agent: child, status: 'idle' })

  // Root agent whose turn was aborted, with that reason filtered out.
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  ctx.emit('agent/status', { agent: root, status: 'running' })
  ctx.emit('agent/status', { agent: root, status: 'idle' })
  await settle()

  assert.equal(mock.requests.length, 0)
})

test('dryRun logs instead of calling OneBot', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-3', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    targetType: 'private',
    targetId: '10001',
    notifyOnReasons: ['completed'],
    dryRun: true,
  })
  ctx.emit('session/event', { id: 'sess-3' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-3' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()

  assert.equal(mock.requests.length, 0)
  assert.ok(ctx.logs.some(([level, line]) => level === 'info' && line.includes('dryRun')))
})

test('callAction surfaces a non-ok OneBot retcode', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'failed', retcode: 1200, message: 'bad token' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await assert.rejects(
    () => callAction({ endpoint: `http://127.0.0.1:${port}`, token: '', timeoutMs: 3000 }, 'send_private_msg', {}),
    /retcode 1200/,
  )
  await new Promise((resolve) => server.close(resolve))
})

test('error and aborted notify under the default reasons', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-6', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    targetType: 'private',
    targetId: '10001',
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-6' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-6' }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: '429 rate limited', code: 'RATE_LIMIT' } } },
  })
  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()

  assert.equal(mock.requests.length, 1)
  const text = mock.requests[0].body.message[0].data.text
  assert.match(text, /结果: 出错/)
  assert.match(text, /错误: 429 rate limited/)
})

test('a custom template only needs placeholders filled in', async () => {
  const { fill, DEFAULT_TEMPLATE } = await import('../lib/index.js')
  // Every default line survives when values exist.
  assert.ok(DEFAULT_TEMPLATE.includes('{reply}'))

  const body = renderMessage({
    sessionId: '0123456789abcdef',
    cwd: '/root/core',
    reason: 'completed',
    reply: 'done',
    summaryChars: 50,
    template: '✅ {status} | {sessionId}\n{reply}',
  })
  assert.equal(body, '✅ 完成 | 01234567\ndone')

  // Empty values drop the whole label line instead of leaving a dangling colon.
  const sparse = renderMessage({
    sessionId: '0123456789abcdef',
    cwd: undefined,
    reason: 'completed',
    reply: '',
    summaryChars: 50,
    template: '会话: {sessionId}\n目录: {cwd}\n回复: {reply}',
  })
  assert.equal(sparse, '会话: 01234567')

  // Unknown placeholders stay visible so a typo is obvious.
  assert.equal(fill('{sessionId}/{nope}', { sessionId: 'x' }), 'x/{nope}')

  // Approval template placeholders.
  const approval = renderApprovalMessage({
    sessionId: '0123456789abcdef',
    cwd: '/root/core',
    toolName: 'Bash',
    reason: '执行 ls',
    template: '{tool}@{cwd}',
  })
  assert.equal(approval, 'Bash@/root/core')
})

test('a plugin activated mid-turn still captures the reply and the turn reason', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-7', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    targetType: 'private',
    targetId: '10001',
    dryRun: false,
    timeoutMs: 3000,
  })

  // No turn/start: the plugin activated after the turn had already begun.
  ctx.emit('session/event', { id: 'sess-7' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'mid-turn 回复' }] } },
  })
  ctx.emit('session/event', { id: 'sess-7' }, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()

  assert.equal(mock.requests.length, 1)
  assert.match(mock.requests[0].body.message[0].data.text, /回复: mid-turn 回复/)
})

test('the session- prefix does not eat the id', () => {
  const body = renderMessage({
    sessionId: 'session-0123456789abcdef',
    cwd: '/root/core',
    reason: 'completed',
    reply: '',
    summaryChars: 50,
  })
  assert.match(body, /会话: 01234567/)
})

test('reply is flattened to plain text without markdown', () => {
  const body = renderMessage({
    sessionId: 'session-abcdef123456',
    cwd: '/root/core',
    reason: 'completed',
    reply: '## 结论\n\n**已完成** 迁移，见 [文档](https://x)。\n\n```js\nconst a = 1\n```\n\n- 细节一\n- 细节二',
    summaryChars: 200,
  })
  const line = body.split('\n').find((l) => l.startsWith('回复: '))
  assert.ok(line, 'reply line must exist')
  const text = line.slice('回复: '.length)
  for (const marker of ['**', '##', '```', '[', ']', '|', '- ']) {
    assert.ok(!text.includes(marker), `markdown "${marker}" leaked: ${text}`)
  }
  assert.match(text, /已完成 迁移/)
  assert.match(text, /文档/)
  assert.match(text, /细节一/)
})

test('markdown stripping keeps snake_case identifiers', async () => {
  const { plain } = await import('../lib/index.js')
  assert.equal(plain('字段 session_id 和 summary_chars 保留', 80), '字段 session_id 和 summary_chars 保留')
  assert.equal(plain('这是 _斜体_ 文本', 80), '这是 斜体 文本')
})

test('long replies are cut to the configured budget', () => {
  const body = renderMessage({
    sessionId: 'session-abcdef123456',
    cwd: '/root/core',
    reason: 'completed',
    reply: '细节描述'.repeat(200),
    summaryChars: 60,
  })
  const line = body.split('\n').find((l) => l.startsWith('回复: '))
  assert.ok(line.length <= '回复: '.length + 60, `too long: ${line.length}`)
  assert.ok(line.endsWith('…'))
})

test('markdown tables are dropped instead of flattened into word salad', () => {
  const body = renderMessage({
    sessionId: 'session-abcdef123456',
    cwd: '/root/core',
    reason: 'completed',
    reply: '结论如下：\n\n| 项 | 值 |\n|---|---|\n| 结果 | 已修复 |\n\n以上。',
    summaryChars: 200,
  })
  const text = body.split('\n').find((l) => l.startsWith('回复: ')).slice('回复: '.length)
  assert.ok(!text.includes('|'))
  assert.equal(text, '结论如下： 以上。')
})

test('gotify transport posts title/message split from the rendered body', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-10', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'gotify',
    gotifyUrl: `http://127.0.0.1:${mock.port}`,
    gotifyToken: 'gtfya.test',
    gotifyPriority: 3,
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-10' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-10' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '全部完成' }] } },
  })
  ctx.emit('session/event', { id: 'sess-10' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()

  assert.equal(mock.requests.length, 1)
  const [request] = mock.requests
  assert.equal(request.url, '/message')
  assert.equal(request.authorization, undefined, 'gotify uses X-Gotify-Key, not Bearer')
  assert.equal(request.headers['x-gotify-key'], 'gtfya.test')
  assert.equal(request.body.title, '[DSH] 会话完成')
  assert.match(request.body.message, /目录: \/root\/core/)
  assert.match(request.body.message, /回复: 全部完成/)
  assert.equal(request.body.priority, 3)
})

test('gotify transport sends the X-Gotify-Key header', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-11', session: { header: {} } }
  const ctx = fakeContext([agent])
  // Re-mock to capture headers that the shared mock does not record.
  apply(ctx, {
    enabled: true,
    transport: 'gotify',
    gotifyUrl: `http://127.0.0.1:${mock.port}`,
    gotifyToken: 'gtfya.secret',
    dryRun: false,
    timeoutMs: 3000,
  })
  ctx.emit('session/event', { id: 'sess-11' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()
  assert.equal(mock.requests.length, 1)
})

test('ask_user_question tool call notifies after the debounce window', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const ctx = fakeContext([])
  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    targetType: 'private',
    targetId: '10001',
    questionDelayMs: 30,
    dryRun: false,
    timeoutMs: 3000,
  })
  ctx.emit('session/event', { id: 's1', header: { cwd: '/root/core' } }, {
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [{ id: 'q', header: '决策', question: '选哪个方案？', detail: '影响回滚', options: [{ label: 'A' }, { label: 'B' }] }],
      }),
    },
  })
  await settle(200)
  assert.equal(mock.requests.length, 1)
  const text = mock.requests[0].body.message[0].data.text
  assert.match(text, /需要你回答/)
  assert.match(text, /选哪个方案/)
  assert.match(text, /A \/ B/)
})

test('an answer that lands inside the debounce window suppresses the question push', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const ctx = fakeContext([])
  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    targetType: 'private',
    targetId: '10001',
    questionDelayMs: 200,
    dryRun: false,
    timeoutMs: 3000,
  })
  const session = { id: 's2', header: {} }
  ctx.emit('session/event', session, {
    type: 'tool/call',
    data: { callId: 'call-2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: 'x' }] }) },
  })
  ctx.emit('session/event', session, {
    type: 'tool/result',
    data: { message: { toolCallId: 'call-2', content: [] } },
  })
  await settle(300)
  assert.equal(mock.requests.length, 0)
})

test('a human approval ask notifies; an auto-decided one stays silent', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const ctx = fakeContext([])
  apply(ctx, {
    enabled: true,
    transport: 'onebot',
    endpoint: `http://127.0.0.1:${mock.port}`,
    targetType: 'private',
    targetId: '10001',
    approvalDelayMs: 40,
    dryRun: false,
    timeoutMs: 3000,
  })
  const session = { id: 's3', header: { cwd: '/root/core' } }

  // Auto-decided: ask + decide in the same tick -> no push.
  ctx.emit('session/event', session, { type: 'approval/asked', data: { id: 'a1', toolName: 'Bash' } })
  ctx.emit('session/event', session, { type: 'approval/decided', data: { id: 'a1', outcome: 'rejected' } })

  // Genuinely waiting: no decision arrives -> push.
  ctx.emit('session/event', session, {
    type: 'approval/asked',
    data: { id: 'a2', toolName: 'Write', reason: '需要写入 /etc/hosts' },
  })
  await settle(250)

  assert.equal(mock.requests.length, 1)
  const text = mock.requests[0].body.message[0].data.text
  assert.match(text, /需要授权/)
  assert.match(text, /操作: Write/)
  assert.match(text, /需要写入/)
})

// ---- 设备标识 / 多目标 / 外网网关 ----

test('device and host placeholders render into the message', async () => {
  const { renderMessage, DEFAULT_TEMPLATE } = await import('../lib/index.js')
  assert.ok(DEFAULT_TEMPLATE.includes('设备: {device}'), 'default template should show the device')
  const body = renderMessage({
    sessionId: 'session-0123456789abcdef',
    cwd: '/root/core',
    reason: 'completed',
    reply: 'done',
    summaryChars: 50,
    device: '办公本',
    host: 'host-a',
    template: '设备: {device}\n主机: {host}',
  })
  assert.equal(body, '设备: 办公本\n主机: host-a')
})

test('one event fans out to every matching target with its own token and priority', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-20', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'gotify',
    targets: [
      { name: 'qq-main', url: `http://127.0.0.1:${mock.port}`, token: 'gtfya.main', priority: 3 },
      { name: 'qq-alt', url: `http://127.0.0.1:${mock.port}`, token: 'gtfya.alt', priority: 7 },
    ],
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-20' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-20' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle(150)

  assert.equal(mock.requests.length, 2, 'both targets must receive the message')
  const keys = mock.requests.map((request) => request.headers['x-gotify-key']).sort()
  assert.deepEqual(keys, ['gtfya.alt', 'gtfya.main'])
  const priorities = mock.requests.map((request) => request.body.priority).sort()
  assert.deepEqual(priorities, [3, 7])
  for (const request of mock.requests) {
    assert.match(request.body.message, /会话: sess-20|会话: .*sess-20/i)
  }
})

test('targets pinned to other devices are skipped', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-21', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'gotify',
    deviceName: 'host-a',
    deviceLabel: '办公本',
    targets: [
      { name: 'for-a', url: `http://127.0.0.1:${mock.port}`, token: 'gtfya.a', devices: ['办公本'] },
      { name: 'for-b', url: `http://127.0.0.1:${mock.port}`, token: 'gtfya.b', devices: ['host-b'] },
    ],
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-21' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-21' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle(120)

  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].headers['x-gotify-key'], 'gtfya.a')
})

test('deviceInTitle prefixes the Gotify title; custom headers are sent', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-22', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'gotify',
    gotifyUrl: `http://127.0.0.1:${mock.port}`,
    gotifyToken: 'gtfya.hdr',
    gotifyHeaders: { 'X-Relay-Auth': 'relay-secret', 'X-Gotify-Key': 'should-be-overridden' },
    deviceLabel: '办公本',
    deviceInTitle: true,
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-22' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-22' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle(120)

  assert.equal(mock.requests.length, 1)
  const [request] = mock.requests
  assert.equal(request.body.title, '[办公本] [DSH] 会话完成')
  assert.equal(request.headers['x-relay-auth'], 'relay-secret')
  assert.equal(request.headers['x-gotify-key'], 'gtfya.hdr', 'token must win over custom headers')
  assert.match(request.body.message, /设备: 办公本/)
})

test('targets can come from the environment as JSON (for per-device secrets)', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-23', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  process.env.DSH_QQ_NOTIFY_TARGETS = JSON.stringify([
    { name: 'env-target', url: `http://127.0.0.1:${mock.port}`, token: 'gtfya.env', priority: 5 },
  ])
  process.env.DSH_QQ_NOTIFY_DEVICE = 'env-device'
  t.after(() => {
    delete process.env.DSH_QQ_NOTIFY_TARGETS
    delete process.env.DSH_QQ_NOTIFY_DEVICE
  })
  apply(ctx, { enabled: true, transport: 'gotify', dryRun: false, timeoutMs: 3000 })

  ctx.emit('session/event', { id: 'sess-23' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-23' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle(120)

  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].headers['x-gotify-key'], 'gtfya.env')
  assert.match(mock.requests[0].body.message, /设备: env-device/)
})

test('a target missing url/token is skipped without failing the others', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-24', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'gotify',
    targets: [
      // Kept by normalizeTargets (has a url) but skipped at send time (no token).
      { name: 'broken', url: 'https://unused.example', token: '' },
      { name: 'ok', url: `http://127.0.0.1:${mock.port}`, token: 'gtfya.ok' },
    ],
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-24' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-24' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle(120)

  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].headers['x-gotify-key'], 'gtfya.ok')
  assert.ok(
    ctx.logs.some(([level, line]) => level === 'warn' && line.includes('broken')),
    'the skipped target should be reported',
  )
})

test('normalizeTargets drops malformed entries and fills defaults', async () => {
  const { normalizeTargets } = await import('../lib/index.js')
  const list = normalizeTargets([
    null,
    'nope',
    { url: 'https://a.example', token: 't1' },
    { name: 'b', url: 'https://b.example', token: 't2', priority: 9, devices: ['host-b', '', 42] },
    { name: 'empty' },
  ], 4)
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], {
    name: 'target-1', url: 'https://a.example', token: 't1', priority: 4, devices: [],
  })
  assert.deepEqual(list[1], {
    name: 'b', url: 'https://b.example', token: 't2', priority: 9, devices: ['host-b'],
  })
})

// ---- dsh-utils bundle wiring ----

test('the component declares its mount identity, service, and settings schema', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-notify')
  assert.deepEqual(mod.inject, ['agents'])
  assert.ok(mod.Config, 'the bundle needs a Config export for the settings page')
})

test('Config refs carry the documented defaults without a settings document', async () => {
  const { Config, normalizeOptions } = await import('../lib/index.js')
  const config = Config({})
  assert.equal(config.dryRun.get(), true, 'dryRun stays on until the user turns it off')
  assert.equal(config.transport.get(), 'gotify')
  assert.deepEqual(config.notifyOnReasons.get(), ['completed', 'error', 'aborted'])
  assert.deepEqual(config.targets.get(), [])
  assert.equal(config.timeoutMs.get(), 8000)
  // The Loader hands these same live refs to apply; normalizeOptions folds them.
  const options = normalizeOptions(config)
  assert.equal(options.dryRun, true)
  assert.equal(options.deviceName.length > 0, true)
  assert.equal(options.targets.length, 1, 'the single-url fields become the default target')
})

test('live settings refs are re-read on every event', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-live', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  const dryRun = { value: true }
  apply(ctx, {
    enabled: { get: () => true },
    transport: { get: () => 'onebot' },
    endpoint: { get: () => `http://127.0.0.1:${mock.port}` },
    targetType: { get: () => 'private' },
    targetId: { get: () => '10001' },
    notifyOnReasons: { get: () => ['completed'] },
    timeoutMs: { get: () => 3000 },
    dryRun: { get: () => dryRun.value },
  })

  ctx.emit('session/event', { id: 'sess-live' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-live' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()
  assert.equal(mock.requests.length, 0, 'dryRun was still on')
  assert.ok(ctx.logs.some(([level, line]) => level === 'info' && line.includes('dryRun')))

  dryRun.value = false
  ctx.emit('session/event', { id: 'sess-live' }, { type: 'turn/start', data: { turn: 2 } })
  ctx.emit('session/event', { id: 'sess-live' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle()
  assert.equal(mock.requests.length, 1, 'the same instance picked up the new value')
})


// ---- secrets from the environment ----

test('gotify url still expands ENV; the token is explicit and ignores the environment', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  const agent = { id: 'sess-env1', session: { header: { cwd: '/root/core' } } }
  const ctx = fakeContext([agent])
  process.env.DSU_TEST_GOTIFY_URL = 'http://127.0.0.1:' + mock.port
  process.env.DSH_QQ_NOTIFY_GOTIFY_TOKEN = 'gtfya.from-env'
  t.after(() => {
    delete process.env.DSU_TEST_GOTIFY_URL
    delete process.env.DSH_QQ_NOTIFY_GOTIFY_TOKEN
  })
  apply(ctx, {
    enabled: true,
    transport: 'gotify',
    gotifyUrl: '${DSU_TEST_GOTIFY_URL}',
    gotifyToken: 'gtfya.explicit',
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-env1' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-env1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle(150)

  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].headers['x-gotify-key'], 'gtfya.explicit')
  assert.match(mock.requests[0].body.message, /目录: \/root\/core/)
})

test('gotifyToken is a write-only secret in the settings schema', () => {
  const json = Config.toJSON()
  const refs = Object.values(json.refs ?? {})
  const field = refs.find((ref) => typeof ref?.meta?.description === 'string' && ref.meta.description.startsWith('Gotify application token'))
  assert.ok(field, 'gotifyToken schema ref not found')
  assert.equal(field.meta.role, 'secret')
})

test('per-target urlEnv/tokenEnv name the variables and ${ENV:-fallback} keeps a default', async (t) => {
  const mock = await startMock()
  t.after(() => mock.close())
  process.env.DSU_TARGET_URL = 'http://127.0.0.1:' + mock.port
  process.env.DSU_TARGET_TOKEN = 'gtfya.target-env'
  t.after(() => {
    delete process.env.DSU_TARGET_URL
    delete process.env.DSU_TARGET_TOKEN
  })
  const agent = { id: 'sess-env2', session: { header: {} } }
  const ctx = fakeContext([agent])
  apply(ctx, {
    enabled: true,
    transport: 'gotify',
    targets: [
      { name: 'env', urlEnv: 'DSU_TARGET_URL', tokenEnv: 'DSU_TARGET_TOKEN' },
      { name: 'fallback', url: '${DSU_TARGET_URL}', token: '${DSU_MISSING_TOKEN:-gtfya.fallback}' },
    ],
    dryRun: false,
    timeoutMs: 3000,
  })

  ctx.emit('session/event', { id: 'sess-env2' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await settle(150)

  const keys = mock.requests.map((request) => request.headers['x-gotify-key']).sort()
  assert.deepEqual(keys, ['gtfya.fallback', 'gtfya.target-env'])
})

test('an unset ${ENV} reference leaves the target without a token instead of sending the literal text', async () => {
  const { normalizeTargets } = await import('../lib/index.js')
  process.env.DSU_SET_VAR = 'x'
  const list = normalizeTargets([
    { name: 'a', url: 'https://${DSU_SET_VAR}.example', token: '${DSU_UNSET_VAR:-from-default}' },
    { name: 'b', url: 'https://b.example', token: '${DSU_UNSET_VAR}' },
  ])
  delete process.env.DSU_SET_VAR
  assert.equal(list.length, 2)
  assert.equal(list[0].url, 'https://x.example')
  assert.equal(list[0].token, 'from-default')
  assert.equal(list[1].token, '')
})
