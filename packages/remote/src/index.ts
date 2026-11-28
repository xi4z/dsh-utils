/**
 * `dsh-utils` remote component: the Host half.
 *
 * The Harness Web server answers loopback only, and its `/api` fence accepts
 * nothing but loopback, its own bind address, or a configured `trustedHosts`
 * authority. Publishing the GUI through a tunnel therefore needs one local hop
 * that speaks the loopback authority, which is what this row provides:
 *
 *   browser -> operator tunnel -> 127.0.0.1:<listenPort> -> 127.0.0.1:<webServer.port>
 *
 * The proxy rewrites `Host`/`Origin`/`Referer`, relays HTTP, SSE and WebSocket
 * traffic, and — on a desktop profile — answers the first `401` on `GET /` with
 * the tokenized URL the Host itself minted, because the desktop shell never
 * prints a startup URL an operator could paste. Authentication is unchanged:
 * no credential is read, no cookie is forged, and the `dsh-auth-*` cookie stays
 * the Host's own.
 *
 * On a desktop profile the UI policy is `preserve-desktop-ui`: the document,
 * its client modules and the fallback seat are relayed untouched, so the stock
 * desktop UI is what a remote browser gets. A web profile defaults to
 * `passthrough`, where the operator already holds the printed startup URL.
 *
 * Security boundary: this row listens on loopback only by default. It is not an
 * authentication layer — the operator's tunnel, or the Host's own cookie, is.
 *
 * @module dsh-utils/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  installSignIn,
  type BrowserAuthLike,
} from './signin.js'
import {
  detectProfile,
  normalizeStrategyInput,
  resolveStrategy,
  type ProfileDecision,
  type StrategyInput,
  type UiStrategy,
} from './detect.js'
import {
  createProxy,
  isLoopbackHost,
  normalizePublicUrl,
  type ProxyHandle,
  type RemoteSettings,
  type Upstream,
} from './proxy.js'

/** Row name; the Loader mounts this package under `dsh-remote`. */
export const name = 'dsh-remote'

/** The two Host services the row cannot work without. */
export const inject = ['webServer', 'connection']

/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
  get(): T
}

/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>

/** The runtime shape `apply` receives. */
export interface RemoteConfig {
  readonly enabled?: MaybeRef<boolean>
  readonly listenHost?: MaybeRef<string>
  readonly listenPort?: MaybeRef<number>
  readonly publicUrl?: MaybeRef<string>
  readonly strategy?: MaybeRef<string>
  readonly autoBootstrap?: MaybeRef<boolean>
  readonly allowRemoteListen?: MaybeRef<boolean>
  readonly bootstrapMaxPerMinute?: MaybeRef<number>
  readonly logAuthCookie?: MaybeRef<boolean>
  readonly autoSignIn?: MaybeRef<boolean>
  readonly signInMaxPerMinute?: MaybeRef<number>
}

/** Defaults, also used by the settings schema. */
const DEFAULTS = {
  enabled: false,
  listenHost: '127.0.0.1',
  listenPort: 3079,
  publicUrl: '',
  strategy: 'auto' as StrategyInput,
  autoBootstrap: true,
  allowRemoteListen: false,
  bootstrapMaxPerMinute: 6,
  logAuthCookie: true,
  autoSignIn: true,
  signInMaxPerMinute: 30,
}

/**
 * Settings-page schema. Authentication inputs are volatile: the proxy re-reads
 * them on every request, so saving a public URL applies without a restart.
 * The listener address is read once at activation — changing it needs a reload.
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled)
    .description('Start the loopback proxy at activation. Off by default; changing it takes a Host restart.'),
  listenHost: z.string().default(DEFAULTS.listenHost)
    .description('Listen address of the proxy. Loopback only unless allowRemoteListen is set.'),
  listenPort: z.natural().min(1).max(65535).default(DEFAULTS.listenPort)
    .description('Loopback port your tunnel forwards to.'),
  publicUrl: z.string().default(DEFAULTS.publicUrl)
    .description('Public HTTPS root the tunnel publishes, e.g. https://dsh.example.com/. Needed for the desktop bootstrap.')
    .volatile(),
  strategy: z.union(['auto', 'preserve-desktop-ui', 'passthrough']).default(DEFAULTS.strategy)
    .description('auto: desktop keeps its stock UI and bootstraps auth; web stays passthrough.')
    .volatile(),
  autoBootstrap: z.boolean().default(DEFAULTS.autoBootstrap)
    .description('On 401 for GET /, redirect once to the Host-minted tokenized URL.')
    .volatile(),
  allowRemoteListen: z.boolean().default(DEFAULTS.allowRemoteListen)
    .description('Allow a non-loopback listen address. Only for a host-local tunnel that cannot dial loopback.'),
  bootstrapMaxPerMinute: z.natural().min(1).max(120).default(DEFAULTS.bootstrapMaxPerMinute)
    .description('Redirect budget per peer per minute; stops a rejected cookie from ping-ponging.')
    .volatile(),
  logAuthCookie: z.boolean().default(DEFAULTS.logAuthCookie)
    .description('Echo a freshly minted dsh-auth-* cookie into the Host log. The value is a live session credential.')
    .volatile(),
  autoSignIn: z.boolean().default(DEFAULTS.autoSignIn)
    .description('Sign a cookie-less browser into the Host\'s own port with its live launch token; independent of enabled.')
    .volatile(),
  signInMaxPerMinute: z.natural().min(1).max(600).default(DEFAULTS.signInMaxPerMinute)
    .description('Direct-port sign-in redirect budget per minute; stops a browser that refuses the cookie.')
    .volatile(),
})

/** Resolved values, with defaults applied. */
interface Options {
  enabled: boolean
  listenHost: string
  listenPort: number
  publicUrl: string
  strategy: StrategyInput
  autoBootstrap: boolean
  allowRemoteListen: boolean
  bootstrapMaxPerMinute: number
  logAuthCookie: boolean
  autoSignIn: boolean
  signInMaxPerMinute: number
}

/** The Host services this row adapts to; typed locally so the package needs no dsh dependency. */
interface WebServerLike {
  readonly host?: string
  readonly port?: number
  readonly protocol?: 'http:' | 'https:'
}

interface ConnectionLike {
  authenticatedUrl(baseUrl: string): string
  readonly browserAuth?: BrowserAuthLike
}

/** Snapshot one Config field, resolving a volatile reference. */
function unwrap<T>(value: MaybeRef<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as VolatileRef<T>).get === 'function') {
    return (value as VolatileRef<T>).get()
  }
  return value as T | undefined
}

/** Apply defaults and coerce types, tolerating a partially supplied config. */
function normalize(config: RemoteConfig | undefined): Options {
  const value = <T>(key: keyof RemoteConfig): T | undefined => unwrap<T>(config?.[key] as MaybeRef<T> | undefined)
  const port = Number(value<number>('listenPort') ?? DEFAULTS.listenPort)
  const budget = Number(value<number>('bootstrapMaxPerMinute') ?? DEFAULTS.bootstrapMaxPerMinute)
  const signInBudget = Number(value<number>('signInMaxPerMinute') ?? DEFAULTS.signInMaxPerMinute)
  return {
    enabled: value<boolean>('enabled') ?? DEFAULTS.enabled,
    listenHost: String(value<string>('listenHost') ?? DEFAULTS.listenHost),
    listenPort: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULTS.listenPort,
    publicUrl: String(value<string>('publicUrl') ?? DEFAULTS.publicUrl),
    strategy: normalizeStrategyInput(value<string>('strategy')),
    autoBootstrap: value<boolean>('autoBootstrap') ?? DEFAULTS.autoBootstrap,
    allowRemoteListen: value<boolean>('allowRemoteListen') ?? DEFAULTS.allowRemoteListen,
    bootstrapMaxPerMinute: Number.isInteger(budget) && budget > 0 ? budget : DEFAULTS.bootstrapMaxPerMinute,
    logAuthCookie: value<boolean>('logAuthCookie') ?? DEFAULTS.logAuthCookie,
    autoSignIn: value<boolean>('autoSignIn') ?? DEFAULTS.autoSignIn,
    signInMaxPerMinute: Number.isInteger(signInBudget) && signInBudget > 0 ? signInBudget : DEFAULTS.signInMaxPerMinute,
  }
}

/** Probe the desktop Host's own service without depending on its package. */
function hasDesktopService(ctx: Context): boolean {
  const get = (ctx as unknown as { get?: (service: string) => unknown }).get
  if (typeof get !== 'function') return false
  for (const service of ['desktopHost', 'desktop-host', 'desktopAuth']) {
    try {
      if (get.call(ctx, service) !== undefined) return true
    } catch {
      // An unknown service name throws; keep probing.
    }
  }
  return false
}

/** Effective strategy for the current config and detected profile. */
function currentStrategy(options: Options, decision: ProfileDecision): { strategy: UiStrategy; reason: string } {
  return resolveStrategy(options.strategy, { profile: decision.profile, publicUrl: options.publicUrl })
}

/**
 * Activate the proxy.
 * @param ctx - host Cordis context.
 * @param config - row config; volatile fields arrive as live references.
 */
export function apply(ctx: Context, config: RemoteConfig = {}): void {
  const profile = detectProfile({
    electron: process.versions.electron,
    argv: process.argv,
    env: process.env,
    desktopService: hasDesktopService(ctx),
  })
  const initial = normalize(config)
  const resolved = currentStrategy(initial, profile)
  const logger = ctx.logger

  logger.info(
    `dsh-remote: profile=${profile.profile} (${profile.reason}), strategy=${resolved.strategy} (${resolved.reason}), `
    + `enabled=${initial.enabled}, listen=${initial.listenHost}:${initial.listenPort}`,
  )

  const connection = (ctx as unknown as { connection?: ConnectionLike }).connection

  /** Direct-port sign-in is independent of the proxy switch: it serves the host's own listener. */
  if (initial.autoSignIn) installSignIn(ctx, connection)

  if (!initial.enabled) return

  if (!isLoopbackHost(initial.listenHost) && !initial.allowRemoteListen) {
    logger.error(
      `dsh-remote: refusing to listen on ${initial.listenHost} — the proxy rewrites the Host/Origin fence, `
      + 'so it is loopback-only unless allowRemoteListen is set',
    )
    return
  }

  const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
  const upstreamPort = Number(webServer?.port)
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
    logger.error('dsh-remote: the Web server has no listening port yet; the proxy was not started')
    return
  }
  if (typeof connection?.authenticatedUrl !== 'function') {
    logger.error('dsh-remote: connection.authenticatedUrl is unavailable; the desktop bootstrap cannot work')
    return
  }

  /**
   * Resolve the upstream on every request. The desktop Host picks an
   * OS-assigned port on each start, so caching it at activation would pin the
   * proxy to a dead port after the next Host restart.
   */
  const upstreamOf = (): Upstream => {
    const live = (ctx as unknown as { webServer?: WebServerLike }).webServer
    const port = Number(live?.port)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('the Web server reports no listening port')
    }
    return {
      host: live?.host !== undefined && live.host !== '' ? live.host : '127.0.0.1',
      port,
      protocol: live?.protocol === 'https:' ? 'https:' : 'http:',
    }
  }
  if (normalizePublicUrl(initial.publicUrl) === undefined && resolved.strategy === 'preserve-desktop-ui') {
    logger.warn('dsh-remote: publicUrl is not a usable absolute http(s) root; the 401 bootstrap stays off until it is')
  }

  const settings = (): RemoteSettings => {
    const current = normalize(config)
    return {
      publicUrl: current.publicUrl,
      strategy: currentStrategy(current, profile).strategy,
      autoBootstrap: current.autoBootstrap,
      bootstrapMaxPerMinute: current.bootstrapMaxPerMinute,
      logAuthCookie: current.logAuthCookie,
    }
  }

  const handle: ProxyHandle = createProxy({
    listenHost: initial.listenHost,
    listenPort: initial.listenPort,
    upstream: upstreamOf,
    settings,
    authenticatedUrl: (baseUrl) => connection.authenticatedUrl(baseUrl),
    logger: {
      info: (line) => logger.info(line),
      warn: (line) => logger.warn(line),
      error: (line) => logger.error(line),
    },
    describe: () => {
      const current = settings()
      return {
        profile: profile.profile,
        profileReason: profile.reason,
        strategy: current.strategy,
        strategyReason: currentStrategy(normalize(config), profile).reason,
        publicUrl: current.publicUrl,
        autoBootstrap: current.autoBootstrap,
        logAuthCookie: current.logAuthCookie,
      }
    },
  })

  ctx.effect(() => () => {
    void handle.close()
  }, 'dsh-remote: listener')

  void handle.start()
    .then((bound) => {
      const live = upstreamOf()
      logger.info(
        `dsh-remote: listening on ${bound.host}:${bound.port} -> ${live.protocol}//${live.host}:${live.port} `
        + `(upstream is re-resolved per request; ${handle.stats.requests} request(s) so far)`,
      )
    })
    .catch((error: unknown) => {
      logger.error(`dsh-remote: cannot listen on ${initial.listenHost}:${initial.listenPort}: ${String(error)}`)
    })
}
