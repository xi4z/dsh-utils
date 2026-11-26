/**
 * Unit + wire tests for the `dsh-utils` remote component.
 *
 * The integration half boots a real upstream HTTP server and the real proxy, so
 * the Host/Origin rewrite, the 401 bootstrap, the redirect rewrite and the
 * WebSocket relay are exercised over TCP instead of being asserted in theory.
 *
 *   node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

import {
  createProxy,
  formatAuthority,
  isLoopbackHost,
  normalizePublicUrl,
  rewriteLocation,
  rewriteRequestHeaders,
  shouldBootstrap,
} from '../lib/proxy.js'
import {
  detectProfile,
  normalizeStrategyInput,
  resolveStrategy,
} from '../lib/detect.js'

/** Settings the proxy reads on every request. */
function settings(overrides = {}) {
  return {
    publicUrl: 'https://dsh.example.com/',
    strategy: 'preserve-desktop-ui',
    autoBootstrap: true,
    bootstrapMaxPerMinute: 6,
    logAuthCookie: true,
    ...overrides,
  }
}

/** Issue one HTTP request against the proxy and collect the answer. */
function call(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

/** Upstream stand-in: 401 without a cookie, 200 otherwise, echoing headers on POST. */
async function startUpstream() {
  const seen = []
  const sockets = new Set()
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers })
    if (request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin }))
      return
    }
    if (request.url === '/moved') {
      response.writeHead(303, { location: `http://127.0.0.1:${server.address().port}/elsewhere` })
      response.end()
      return
    }
    if (request.url === '/assets/app.js') {
      response.writeHead(401)
      response.end('no')
      return
    }
    const cookie = request.headers.cookie ?? ''
    if (request.url.startsWith('/?token=') || cookie.includes('dsh-auth-')) {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>stock</html>')
      return
    }
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"unauthorized"}')
  })
  server.on('upgrade', (request, socket) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers, upgrade: true })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    seen,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.close(resolve)
      for (const socket of sockets) socket.destroy()
    }),
  }
}

/** Boot the proxy in front of a fresh upstream. */
async function startProxy(overrides = {}) {
  const upstream = await startUpstream()
  const live = overrides.settings ?? settings()
  const proxy = createProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstream: () => ({ host: '127.0.0.1', port: upstream.port, protocol: 'http:' }),
    settings: () => live,
    authenticatedUrl: (base) => `${base}?token=t0k`,
    logger: { info() {}, warn() {}, error() {} },
    describe: () => ({ profile: 'desktop', strategy: live.strategy }),
    ...overrides.options,
  })
  const bound = await proxy.start()
  return {
    proxy,
    upstream,
    port: bound.port,
    close: async () => {
      await proxy.close()
      await upstream.close()
    },
  }
}

test('authority and loopback helpers', () => {
  assert.equal(formatAuthority('127.0.0.1', 3080), '127.0.0.1:3080')
  assert.equal(formatAuthority('::1', 3080), '[::1]:3080')
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('192.168.1.5'), false)
  assert.equal(isLoopbackHost(''), false)
})

test('public URL validation rejects hazards and normalizes the path', () => {
  assert.deepEqual(normalizePublicUrl('https://dsh.example.com'), {
    origin: 'https://dsh.example.com',
    href: 'https://dsh.example.com/',
  })
  assert.equal(normalizePublicUrl('https://dsh.example.com/ui')?.href, 'https://dsh.example.com/ui/')
  assert.equal(normalizePublicUrl('https://user:pw@dsh.example.com/'), undefined)
  assert.equal(normalizePublicUrl('https://dsh.example.com/?next=1'), undefined)
  assert.equal(normalizePublicUrl('ftp://dsh.example.com/'), undefined)
  assert.equal(normalizePublicUrl('  '), undefined)
})

test('profile detection follows the strongest signal', () => {
  assert.deepEqual(detectProfile({ electron: '33.0.0' }), { profile: 'desktop', reason: 'electron' })
  assert.deepEqual(detectProfile({ env: { DSH_PROFILE: 'desktop' } }), { profile: 'desktop', reason: 'env' })
  assert.deepEqual(detectProfile({ env: { DSH_PROFILE: 'web' } }), { profile: 'web', reason: 'env' })
  assert.deepEqual(
    detectProfile({ argv: ['node', 'dsh', '--profile', 'desktop', '--no-open'] }),
    { profile: 'desktop', reason: 'argv' },
  )
  assert.deepEqual(
    detectProfile({ argv: ['node', '/home/u/.dsh/profiles/desktop/cordis.yml'] }),
    { profile: 'desktop', reason: 'argv' },
  )
  assert.deepEqual(
    detectProfile({ argv: ['node', '/home/u/.dsh/profiles/web/cordis.yml'] }),
    { profile: 'web', reason: 'argv' },
  )
  assert.deepEqual(detectProfile({ desktopService: true }), { profile: 'desktop', reason: 'service' })
  assert.deepEqual(detectProfile({}), { profile: 'unknown', reason: 'no-signal' })
})

test('auto strategy: desktop keeps its UI, web passes through', () => {
  assert.equal(resolveStrategy('auto', { profile: 'desktop', publicUrl: '' }).strategy, 'preserve-desktop-ui')
  assert.equal(resolveStrategy('auto', { profile: 'web', publicUrl: 'https://x/' }).strategy, 'passthrough')
  assert.equal(resolveStrategy('auto', { profile: 'unknown', publicUrl: '' }).strategy, 'passthrough')
  assert.equal(
    resolveStrategy('auto', { profile: 'unknown', publicUrl: 'https://x/' }).strategy,
    'preserve-desktop-ui',
  )
  assert.equal(resolveStrategy('passthrough', { profile: 'desktop', publicUrl: '' }).strategy, 'passthrough')
  assert.equal(normalizeStrategyInput('nonsense'), 'auto')
  assert.equal(normalizeStrategyInput(undefined), 'auto')
})

test('header rewrite moves Host, Origin and Referer to the loopback authority', () => {
  const headers = rewriteRequestHeaders({
    host: 'dsh.example.com',
    origin: 'https://dsh.example.com',
    referer: 'https://dsh.example.com/session/1?x=2',
    cookie: 'dsh-auth-abc=1',
    'x-forwarded-for': '203.0.113.9',
    forwarded: 'for=203.0.113.9',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, { host: '127.0.0.1', port: 3080, protocol: 'http:' })

  assert.equal(headers.host, '127.0.0.1:3080')
  assert.equal(headers.origin, 'http://127.0.0.1:3080')
  assert.equal(headers.referer, 'http://127.0.0.1:3080/session/1?x=2')
  assert.equal(headers.cookie, 'dsh-auth-abc=1')
  assert.equal(headers['x-forwarded-for'], undefined)
  assert.equal(headers.forwarded, undefined)
  assert.equal(headers['sec-fetch-site'], 'same-origin')
  assert.equal(headers['content-type'], 'application/json')
})

test('upgrade headers keep the handshake and drop the framing noise', () => {
  const headers = rewriteRequestHeaders({
    host: 'dsh.example.com',
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': 'k',
  }, { host: '127.0.0.1', port: 3080, protocol: 'http:' }, true)
  assert.equal(headers.connection, 'Upgrade')
  assert.equal(headers.upgrade, 'websocket')
  assert.equal(headers['sec-websocket-key'], 'k')
  assert.equal(headers.host, '127.0.0.1:3080')
})

test('location rewrite only touches the loopback authority', () => {
  assert.equal(
    rewriteLocation('http://127.0.0.1:3080/x?y=1', 'http://127.0.0.1:3080', 'https://dsh.example.com'),
    'https://dsh.example.com/x?y=1',
  )
  assert.equal(rewriteLocation('./', 'http://127.0.0.1:3080', 'https://dsh.example.com'), './')
  assert.equal(
    rewriteLocation('https://other.example/x', 'http://127.0.0.1:3080', 'https://dsh.example.com'),
    'https://other.example/x',
  )
})

test('bootstrap decision is bounded and index-only', () => {
  const base = { method: 'GET', pathname: '/', hasToken: false, upstreamStatus: 401 }
  assert.equal(shouldBootstrap({ ...base, settings: settings(), recentBootstraps: 0 }), true)
  assert.equal(shouldBootstrap({ ...base, method: 'POST', settings: settings(), recentBootstraps: 0 }), false)
  assert.equal(shouldBootstrap({ ...base, pathname: '/assets/x.js', settings: settings(), recentBootstraps: 0 }), false)
  assert.equal(shouldBootstrap({ ...base, hasToken: true, settings: settings(), recentBootstraps: 0 }), false)
  assert.equal(shouldBootstrap({ ...base, upstreamStatus: 200, settings: settings(), recentBootstraps: 0 }), false)
  assert.equal(
    shouldBootstrap({ ...base, settings: settings({ strategy: 'passthrough' }), recentBootstraps: 0 }),
    false,
  )
  assert.equal(
    shouldBootstrap({ ...base, settings: settings({ autoBootstrap: false }), recentBootstraps: 0 }),
    false,
  )
  assert.equal(
    shouldBootstrap({ ...base, settings: settings({ publicUrl: '' }), recentBootstraps: 0 }),
    false,
  )
  assert.equal(
    shouldBootstrap({ ...base, settings: settings({ bootstrapMaxPerMinute: 2 }), recentBootstraps: 2 }),
    false,
  )
})

test('an unauthorized index redirects once to the Host-minted URL', async () => {
  const harness = await startProxy()
  try {
    const first = await call(harness.port, { path: '/' })
    assert.equal(first.status, 302)
    assert.equal(first.headers.location, 'https://dsh.example.com/?token=t0k')
    assert.equal(first.headers['cache-control'], 'no-store')

    const exchanged = await call(harness.port, { path: '/?token=t0k' })
    assert.equal(exchanged.status, 200)
    assert.equal(exchanged.body, '<html>stock</html>')

    const cookie = await call(harness.port, { path: '/', headers: { cookie: 'dsh-auth-abc=1' } })
    assert.equal(cookie.status, 200)

    const asset = await call(harness.port, { path: '/assets/app.js' })
    assert.equal(asset.status, 401, 'a static asset 401 must never bootstrap')
  } finally {
    await harness.close()
  }
})

test('passthrough relays the 401 instead of redirecting', async () => {
  const harness = await startProxy({ settings: settings({ strategy: 'passthrough' }) })
  try {
    const answer = await call(harness.port, { path: '/' })
    assert.equal(answer.status, 401)
    assert.equal(answer.headers.location, undefined)
  } finally {
    await harness.close()
  }
})

test('the redirect budget stops a rejected cookie from ping-ponging', async () => {
  const harness = await startProxy({ settings: settings({ bootstrapMaxPerMinute: 2 }) })
  try {
    assert.equal((await call(harness.port, { path: '/' })).status, 302)
    assert.equal((await call(harness.port, { path: '/' })).status, 302)
    assert.equal((await call(harness.port, { path: '/' })).status, 401, 'third attempt is relayed')
  } finally {
    await harness.close()
  }
})

test('API calls reach the upstream with the loopback authority', async () => {
  const harness = await startProxy()
  try {
    const answer = await call(harness.port, {
      method: 'POST',
      path: '/api/remote.mux',
      headers: { origin: 'https://dsh.example.com', cookie: 'dsh-auth-abc=1' },
    })
    assert.equal(answer.status, 200)
    assert.deepEqual(JSON.parse(answer.body), {
      host: `127.0.0.1:${harness.upstream.port}`,
      origin: `http://127.0.0.1:${harness.upstream.port}`,
    })
  } finally {
    await harness.close()
  }
})

test('an upstream redirect to loopback is rewritten for the browser', async () => {
  const harness = await startProxy()
  try {
    const answer = await call(harness.port, { path: '/moved' })
    assert.equal(answer.status, 303)
    assert.equal(answer.headers.location, 'https://dsh.example.com/elsewhere')
  } finally {
    await harness.close()
  }
})

test('the status route reports the composition', async () => {
  const harness = await startProxy()
  try {
    const answer = await call(harness.port, { path: '/_dsh_utils_remote/status' })
    assert.equal(answer.status, 200)
    const body = JSON.parse(answer.body)
    assert.equal(body.profile, 'desktop')
    assert.equal(body.strategy, 'preserve-desktop-ui')
    assert.equal(body.upstream, `http://127.0.0.1:${harness.upstream.port}`)
  } finally {
    await harness.close()
  }
})

test('a WebSocket upgrade is relayed to the upstream', async () => {
  const harness = await startProxy()
  const socket = connect(harness.port, '127.0.0.1')
  try {
    const received = []
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')))
    socket.write(
      'GET /api/remote.mux HTTP/1.1\r\n'
      + 'Host: dsh.example.com\r\n'
      + 'Origin: https://dsh.example.com\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + 'Sec-WebSocket-Version: 13\r\n\r\n',
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    socket.write('ping')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const text = received.join('')
    assert.match(text, /HTTP\/1\.1 101 Switching Protocols/)
    assert.match(text, /ping/)
    const upstreamSeen = harness.upstream.seen.find((entry) => entry.upgrade === true)
    assert.equal(upstreamSeen.headers.host, `127.0.0.1:${harness.upstream.port}`)
    assert.equal(upstreamSeen.headers.origin, `http://127.0.0.1:${harness.upstream.port}`)
  } finally {
    socket.destroy()
    await harness.close()
  }
})

test('apply() wires the proxy onto a host context and disposes it', async () => {
  const { apply } = await import('../lib/index.js')
  const upstream = await startUpstream()
  const logs = []
  const disposers = []
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const freePort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  const ctx = {
    logger: {
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
      error: (line) => logs.push(['error', line]),
    },
    effect(factory) {
      disposers.push(factory())
    },
    get() {
      return undefined
    },
    webServer: { host: '127.0.0.1', port: upstream.port, protocol: 'http:' },
    connection: { authenticatedUrl: (base) => `${base}?token=host-minted` },
  }

  // A dsh-spawned shell inherits DSH_PROFILE; pin an empty one so this test
  // asserts the fallback path instead of the shell's profile.
  const savedProfile = process.env.DSH_PROFILE
  process.env.DSH_PROFILE = ''
  try {
    apply(ctx, { enabled: true, listenPort: freePort, publicUrl: 'https://dsh.example.com/' })
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (logs.some(([, line]) => line.includes('listening on'))) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(logs.some(([, line]) => line.includes('dsh-remote: listening on')), JSON.stringify(logs))

    const status = await call(freePort, { path: '/_dsh_utils_remote/status' })
    assert.equal(status.status, 200)
    const body = JSON.parse(status.body)
    assert.equal(body.profile, 'unknown')
    assert.equal(body.strategy, 'preserve-desktop-ui')

    assert.equal(disposers.length, 1)
    disposers[0]()
    await new Promise((resolve) => setTimeout(resolve, 150))
    await assert.rejects(call(freePort, { path: '/' }), /ECONNREFUSED|socket hang up|ECONNRESET/)
  } finally {
    if (savedProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = savedProfile
    if (disposers.length > 0) disposers[0]()
    await upstream.close()
  }
})

test('a non-loopback listen address is refused without the explicit switch', async () => {
  const { apply } = await import('../lib/index.js')
  const logs = []
  const ctx = {
    logger: {
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
      error: (line) => logs.push(line),
    },
    effect() {},
    get() {
      return undefined
    },
    webServer: { host: '127.0.0.1', port: 3080, protocol: 'http:' },
    connection: { authenticatedUrl: (base) => base },
  }
  apply(ctx, { enabled: true, listenHost: '0.0.0.0', listenPort: 3079 })
  assert.ok(logs.some((line) => line.includes('refusing to listen on 0.0.0.0')))
})

test('the fixed listen port follows a new upstream port', async () => {
  const first = await startUpstream()
  const second = await startUpstream()
  let target = first.port
  const proxy = createProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstream: () => ({ host: '127.0.0.1', port: target, protocol: 'http:' }),
    settings: () => settings(),
    authenticatedUrl: (base) => `${base}?token=t0k`,
    logger: { info() {}, warn() {}, error() {} },
  })
  const bound = await proxy.start()
  try {
    const before = await call(bound.port, { path: '/?token=a' })
    assert.equal(before.status, 200)
    assert.equal(first.seen.length, 1)

    // The desktop Host restart picked a new port; the proxy keeps its own and
    // must follow without a restart.
    target = second.port
    const after = await call(bound.port, { path: '/?token=b' })
    assert.equal(after.status, 200)
    assert.equal(second.seen.length, 1)
    assert.equal(first.seen.length, 1)
  } finally {
    await proxy.close()
    await first.close()
    await second.close()
  }
})

test('a minted auth cookie is echoed into the Host log once', async () => {
  const lines = []
  const upstream = createServer((request, response) => {
    response.writeHead(303, {
      location: './',
      'set-cookie': ['dsh-auth-abc123=SECRET-VALUE; Path=/; HttpOnly; SameSite=Strict'],
    })
    response.end()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = createProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstream: () => ({ host: '127.0.0.1', port: upstream.address().port, protocol: 'http:' }),
    settings: () => settings(),
    authenticatedUrl: (base) => `${base}?token=t0k`,
    logger: {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    },
  })
  const bound = await proxy.start()
  try {
    await call(bound.port, { path: '/?token=t0k' })
    await call(bound.port, { path: '/?token=t0k' })
    const echoed = lines.filter((line) => line.includes('dsh-auth-abc123=SECRET-VALUE'))
    assert.equal(echoed.length, 1, 'the same cookie value is echoed once: ' + JSON.stringify(lines))
  } finally {
    await proxy.close()
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('the cookie echo can be turned off', async () => {
  const lines = []
  const upstream = createServer((request, response) => {
    response.writeHead(303, { location: './', 'set-cookie': ['dsh-auth-x=SECRET; Path=/'] })
    response.end()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = createProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstream: () => ({ host: '127.0.0.1', port: upstream.address().port, protocol: 'http:' }),
    settings: () => settings({ logAuthCookie: false }),
    authenticatedUrl: (base) => `${base}?token=t0k`,
    logger: {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    },
  })
  const bound = await proxy.start()
  try {
    await call(bound.port, { path: '/?token=t0k' })
    assert.equal(lines.filter((line) => line.includes('dsh-auth-x')).length, 0)
  } finally {
    await proxy.close()
    await new Promise((resolve) => upstream.close(resolve))
  }
})
