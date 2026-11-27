/**
 * Unit tests for the `dsh-remote` direct-port sign-in half.
 *
 * The module rewrites `browserAuth.authorizeIndex()` on the live prototype, so
 * each case builds a fresh fake auth class and drives the patched method with a
 * captured response.
 *
 *   node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installSignIn, SIGN_IN_DEFAULTS } from '../lib/signin.js'

/** Just enough context: logging and effect registration. */
function fakeContext(effects = []) {
  return {
    logger: { info() {}, warn() {}, error() {} },
    effect(factory, label) {
      effects.push({ factory, label })
      return () => {}
    },
  }
}

/** A Host-shaped auth owner: token in, cookie flag out. */
function fakeAuth(token = 'tok-123') {
  class FakeAuth {
    constructor() {
      this.launchToken = token
      this.authenticated = false
      this.calls = []
    }

    isAuthenticated() {
      return this.authenticated
    }

    authorizeIndex(request, response, secure) {
      this.calls.push({ request, secure })
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('unauthorized')
      return false
    }
  }
  return new FakeAuth()
}

/** Capture what the wrapper writes to the index response. */
function captured() {
  const state = { status: 0, headers: {}, body: undefined, ended: false }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
      state.ended = true
    },
  }
}

/** One index request, optionally carrying a token. */
function get(url = '/', method = 'GET') {
  return { method, url, headers: {} }
}

test('defaults keep sign-in on with a bounded budget', () => {
  assert.equal(SIGN_IN_DEFAULTS.autoSignIn, true)
  assert.equal(SIGN_IN_DEFAULTS.signInMaxPerMinute, 30)
})

test('answers a cookie-less index request with the Host token URL', () => {
  const auth = fakeAuth('tok-abc')
  const installed = installSignIn(fakeContext(), { browserAuth: auth })

  assert.equal(installed, true)
  const response = captured()
  auth.authorizeIndex(get('/'), response)

  assert.equal(response.state.status, 303)
  assert.equal(response.state.headers.location, '/?token=tok-abc')
  assert.equal(response.state.headers['cache-control'], 'no-store')
  assert.equal(auth.calls.length, 0, 'the Host exchange must not run for a redirect')
})

test('leaves an authenticated request to the Host', () => {
  const auth = fakeAuth()
  installSignIn(fakeContext(), { browserAuth: auth })
  auth.authenticated = true

  const response = captured()
  auth.authorizeIndex(get('/'), response)

  assert.equal(auth.calls.length, 1)
  assert.equal(response.state.status, 401)
})

test('falls through when the request already carries a token', () => {
  const auth = fakeAuth()
  installSignIn(fakeContext(), { browserAuth: auth })

  const response = captured()
  auth.authorizeIndex(get('/?token=stale'), response)

  assert.equal(auth.calls.length, 1, 'an invalid token must reach the Host 401')
  assert.equal(response.state.status, 401)
})

test('only GET and HEAD are redirected', () => {
  const auth = fakeAuth()
  installSignIn(fakeContext(), { browserAuth: auth })

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = captured()
    auth.authorizeIndex(get('/', method), response)
    assert.equal(response.state.status, 401, method)
  }
})

test('keeps the mount prefix in the redirect', () => {
  const auth = fakeAuth()
  installSignIn(fakeContext(), { browserAuth: auth })

  const response = captured()
  auth.authorizeIndex(get('/sub/'), response)
  assert.equal(response.state.headers.location, '/sub/?token=tok-123')
})

test('stops redirecting once the minute budget is spent', () => {
  const auth = fakeAuth()
  installSignIn(fakeContext(), { browserAuth: auth }, { signInMaxPerMinute: 2 })

  const statuses = []
  for (let i = 0; i < 3; i += 1) {
    const response = captured()
    auth.authorizeIndex(get('/'), response)
    statuses.push(response.state.status)
  }

  assert.deepEqual(statuses, [303, 303, 401])
})

test('autoSignIn: false leaves the Host gate untouched', () => {
  const auth = fakeAuth()
  const installed = installSignIn(fakeContext(), { browserAuth: auth }, { autoSignIn: false })

  assert.equal(installed, false)
  const response = captured()
  auth.authorizeIndex(get('/'), response)
  assert.equal(response.state.status, 401)
})

test('a Host without the expected shape only warns', () => {
  const effects = []
  const installed = installSignIn(fakeContext(effects), { browserAuth: { launchToken: '' } })

  assert.equal(installed, false)
  assert.equal(effects.length, 0)
})

test('a second install is idempotent', () => {
  const auth = fakeAuth()
  installSignIn(fakeContext(), { browserAuth: auth })
  const again = installSignIn(fakeContext(), { browserAuth: auth })

  assert.equal(again, true)
  const response = captured()
  auth.authorizeIndex(get('/'), response)
  assert.equal(response.state.status, 303)
})

test('disposing restores the original method', () => {
  const auth = fakeAuth()
  const effects = []
  installSignIn(fakeContext(effects), { browserAuth: auth })

  const dispose = effects[0].factory()
  dispose()

  const response = captured()
  auth.authorizeIndex(get('/'), response)
  assert.equal(response.state.status, 401)
})
