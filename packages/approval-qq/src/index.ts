/**
 * dsh-utils approval-qq component: mirror a pending approval to QQ as a
 * markdown card with two inline-keyboard buttons, and answer the host's
 * approval waterfall from the click.
 *
 * Division of labour (see the bundle README):
 *
 * - This component owns the APPROVAL semantics: which request is mirrored,
 *   how the card reads, the race against the Web GUI, and what gets settled
 *   back into the waterfall. It holds no bot credential.
 * - The relay (gotify-qq-relay with its approval listener) owns the QQ edge:
 *   sending the card, receiving INTERACTION_CREATE, acking inside 3s, storing
 *   the click, and sending the passive receipt. It never decides an approval.
 *
 * There is deliberately no TTL here. The only deadline is the unattended
 * gate's own window (approval-policy windowSeconds), which this component
 * reads through the approvalPolicyInfo service and echoes on the card:
 * "N seconds left, then auto-reject". When that window expires the gate
 * settles the request downstream, so this component closes the card silently
 * and later clicks do nothing.
 *
 * The card is sent only after a short debounce: an auto-review decision inside
 * that window means no human is needed, so no card is sent at all.
 *
 * @module dsh-utils/approval-qq
 */
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { needsTranslation, translateToChinese, type LlmRuntime, type ModelRoute } from './translate.js'

export const name = 'dsh-approval-qq'

/** Settings-page schema. Every key is volatile: reads are live on each request. */
export const Config = z.object({
  enabled: z.boolean().default(false).description('Mirror approvals to QQ. Off means the waterfall is untouched.').volatile(),
  relayUrl: z.string().default('').description('Relay approval base URL, ending in /approval; supports ENV references.').volatile(),
  sharedKey: z.string().default('').role('secret').description('Shared key for the relay approval endpoints. Write-only secret: editable in settings, never returned to the browser; configure it explicitly.').volatile(),
  deviceLabel: z.string().default('').description('Human-readable device name shown on the card; empty = hostname.').volatile(),
  sendDelayMs: z.natural().default(1200).description('Debounce before sending: an auto-decision inside it sends no card.').volatile(),
  pollWaitSeconds: z.natural().min(1).max(30).default(25).description('Long-poll window while waiting for a click.').volatile(),
  timeoutMs: z.natural().min(500).default(10000).description('Single relay HTTP timeout.').volatile(),
  includeSubagents: z.boolean().default(true).description('Also mirror approvals raised by subagent sessions.').volatile(),
  dryRun: z.boolean().default(false).description('Log the card instead of sending it.').volatile(),
  allowReceipt: z.string().default('').description('Passive reply after an allow click; empty = no callback (silent).').volatile(),
  denyReceipt: z.string().default('').description('Passive reply after a deny click; empty = no callback (silent).').volatile(),
  translateEnglish: z.boolean().default(true).description('Translate English approval reasons to Chinese via the host model before rendering the card.').volatile(),
  translateTimeoutMs: z.natural().min(200).default(4000).description('Translation budget; on timeout the original English is kept.').volatile(),
  translateProvider: z.string().default('').description('Provider override for translation; empty = the host agentDefaultModel route.').volatile(),
  translateModel: z.string().default('').description('Model override for translation; empty = the host agentDefaultModel route.').volatile(),
})

/** Volatile Config fields arrive as live references; .get() snapshots. */
interface VolatileRef<T> {
  get(): T
}

/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>

/** The runtime shape apply receives (every field volatile, every field optional). */
export interface ApprovalQqConfig {
  readonly enabled?: MaybeRef<boolean>
  readonly relayUrl?: MaybeRef<string>
  readonly sharedKey?: MaybeRef<string>
  readonly deviceLabel?: MaybeRef<string>
  readonly sendDelayMs?: MaybeRef<number>
  readonly pollWaitSeconds?: MaybeRef<number>
  readonly timeoutMs?: MaybeRef<number>
  readonly includeSubagents?: MaybeRef<boolean>
  readonly dryRun?: MaybeRef<boolean>
  readonly allowReceipt?: MaybeRef<string>
  readonly denyReceipt?: MaybeRef<string>
  readonly translateEnglish?: MaybeRef<boolean>
  readonly translateTimeoutMs?: MaybeRef<number>
  readonly translateProvider?: MaybeRef<string>
  readonly translateModel?: MaybeRef<string>
}

/** Normalized options with every default applied. */
export interface ResolvedOptions {
  enabled: boolean
  relayUrl: string
  sharedKey: string
  deviceLabel: string
  sendDelayMs: number
  pollWaitSeconds: number
  timeoutMs: number
  includeSubagents: boolean
  dryRun: boolean
  allowReceipt: string
  denyReceipt: string
  translateEnglish: boolean
  translateTimeoutMs: number
  translateProvider: string
  translateModel: string
}

/** Structural logger slice (matches the host logger without importing it). */
export interface Logger {
  info(format: unknown, ...param: unknown[]): void
  warn(format: unknown, ...param: unknown[]): void
  debug?(format: unknown, ...param: unknown[]): void
}

/** The read-only view approval-policy publishes on the cordis context. */
export interface ApprovalPolicyInfo {
  describe(agent: unknown, sessionId: string): {
    gated: boolean
    windowMs: number
    defaultOutcome: 'rejected' | 'unavailable'
  }
}

/** Structural session/agent/request slices, mirroring dsh types without importing them. */
interface SessionEventLike {
  readonly type?: string
  readonly data?: { readonly callId?: unknown; readonly arguments?: unknown }
}
interface SessionLike {
  readonly header?: { readonly cwd?: string; readonly origin?: string }
  readonly events?: readonly SessionEventLike[]
}
interface AgentLike {
  readonly id?: unknown
  readonly session?: SessionLike
}
export interface ApprovalRequestLike {
  readonly agent: AgentLike
  readonly toolName: string
  readonly callId?: unknown
  readonly reason?: string
  readonly signal?: AbortSignal
}

function unwrap<T>(value: MaybeRef<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as VolatileRef<T>).get === 'function') {
    return (value as VolatileRef<T>).get()
  }
  return value as T | undefined
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number, minimum = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Expand name / name-with-fallback environment references in a setting. */
export function expandEnv(value: unknown): string {
  const pattern = new RegExp('\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?}', 'g')
  return String(value ?? '').replace(pattern, (_whole, key: string, fallback?: string) => {
    const found = process.env[key]
    return typeof found === 'string' && found.trim() !== '' ? found.trim() : (fallback ?? '')
  })
}

function safeHostname(): string {
  try {
    return hostname() || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Resolve the live config into one concrete option set. */
export function resolveOptions(config: ApprovalQqConfig | undefined): ResolvedOptions {
  const value = <T>(key: keyof ApprovalQqConfig): T | undefined => unwrap<T>(config?.[key] as MaybeRef<T> | undefined)
  const relayUrl = expandEnv(value<string>('relayUrl')).replace(/\/+$/, '')
  return {
    enabled: bool(value<boolean>('enabled'), false),
    relayUrl: relayUrl === '' || /\/approval$/.test(relayUrl) ? relayUrl : relayUrl + '/approval',
    // Deliberately not expandEnv: the shared key is an explicit write-only secret.
    sharedKey: text(value<string>('sharedKey'), ''),
    deviceLabel: text(value<string>('deviceLabel'), '') || safeHostname(),
    sendDelayMs: num(value<number>('sendDelayMs'), 1200),
    pollWaitSeconds: Math.min(30, Math.max(1, num(value<number>('pollWaitSeconds'), 25, 1))),
    timeoutMs: num(value<number>('timeoutMs'), 10000, 500),
    includeSubagents: bool(value<boolean>('includeSubagents'), true),
    dryRun: bool(value<boolean>('dryRun'), false),
    allowReceipt: text(value<string>('allowReceipt'), ''),
    denyReceipt: text(value<string>('denyReceipt'), ''),
    translateEnglish: bool(value<boolean>('translateEnglish'), true),
    translateTimeoutMs: Math.max(200, num(value<number>('translateTimeoutMs'), 4000, 200)),
    translateProvider: text(value<string>('translateProvider'), ''),
    translateModel: text(value<string>('translateModel'), ''),
  }
}

/** Human-readable remaining time for the countdown line. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 90) return seconds + ' 秒'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return minutes + ' 分钟'
  return Math.round(minutes / 60) + ' 小时'
}

/** One deadline line: countdown plus the wall-clock deadline. */
export function deadlineLine(input: {
  remainingMs: number
  defaultOutcome: 'rejected' | 'unavailable'
  now?: number
}): string {
  const at = new Date((input.now ?? Date.now()) + input.remainingMs)
  const clock = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  const penalty = input.defaultOutcome === 'unavailable'
    ? '将自动判定为不可用（fail-closed）'
    : '将自动拒绝'
  return '⏳ **' + formatDuration(input.remainingMs) + '内未处理' + penalty + '**（约 ' + clock + '）\n'
    + '自动拒绝后，再点按钮不会生效'
}

/** Inputs for an approval card. */
export interface ApprovalCardInput {
  readonly sessionId: string
  readonly cwd?: string
  readonly device?: string
  readonly toolName: string
  readonly command?: string
  readonly reason?: string
  readonly gated: boolean
  readonly remainingMs?: number
  readonly defaultOutcome?: 'rejected' | 'unavailable'
  readonly now?: number
}

function clip(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit - 1) + '…'
}

/** Triple-backtick fence, built from char codes so this module stays quote-safe. */
const FENCE = String.fromCharCode(96).repeat(3)

/** Render the markdown body of an approval card (the relay adds the keyboard). */
export function renderApprovalCard(input: ApprovalCardInput): string {
  const shortId = String(input.sessionId).replace(/^session-/, '').slice(0, 8)
  const lines: string[] = ['🔐 **执行审批**', '']
  if (input.device) lines.push('设备: ' + input.device)
  lines.push('会话: ' + shortId)
  if (input.cwd) lines.push('目录: ' + input.cwd)
  lines.push('')
  lines.push('工具: ' + input.toolName)
  const command = clip(input.command, 500)
  if (command) {
    lines.push('')
    lines.push(FENCE)
    lines.push(command)
    lines.push(FENCE)
  }
  const reason = clip(input.reason, 200)
  if (reason) {
    lines.push('')
    lines.push('原因: ' + reason)
  }
  if (input.gated && input.remainingMs !== undefined) {
    lines.push('')
    lines.push(deadlineLine({
      remainingMs: input.remainingMs,
      defaultOutcome: input.defaultOutcome ?? 'rejected',
      now: input.now,
    }))
  }
  return lines.join('\n')
}

/** Find the gated command from the session log by tool-call id. */
export function commandOf(request: ApprovalRequestLike): string | undefined {
  if (request.callId === undefined) return undefined
  const events = request.agent?.session?.events
  if (!events) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'tool/call') continue
    if (String(event.data?.callId) !== String(request.callId)) continue
    const raw = event.data?.arguments
    if (typeof raw !== 'string') return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
        const command = (parsed as { command?: unknown }).command
        if (typeof command === 'string') return command
      }
    } catch {
      // non-JSON arguments: fall back to the raw string below
    }
    return raw
  }
  return undefined
}

/** One relay long-poll result. */
export type RelayState =
  | { state: 'pending' }
  | { state: 'clicked'; choice: 'allow' | 'deny' }
  | { state: 'closed'; reason?: string; outcome?: string }

/** The relay client slice the answerer needs (injectable for tests). */
export interface RelayClient {
  create(input: { askId: string; markdown: string; device?: string }): Promise<{ messageId?: string }>
  wait(askId: string, waitSeconds: number, signal?: AbortSignal): Promise<RelayState>
  settle(askId: string, body: {
    outcome: 'allowed-once' | 'rejected' | 'ignored'
    reason?: string
    receipt?: string
  }): Promise<void>
}

/**
 * Build the HTTP client for the relay approval endpoints.
 *
 * baseUrl ends in /approval; endpoints are base, base/askId and
 * base/askId/settle.
 */
export function createRelayClient(options: {
  baseUrl: string
  key: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}): RelayClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.baseUrl.replace(/\/+$/, '')

  async function call(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const signals = [AbortSignal.timeout(options.timeoutMs)]
    if (signal) signals.push(signal)
    const response = await fetchImpl(base + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-approval-key': options.key,
        ...(init.headers ?? {}),
      },
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error('relay HTTP ' + response.status + ': ' + body.slice(0, 200))
    }
    return response
  }

  return {
    async create(input) {
      const response = await call('', { method: 'POST', body: JSON.stringify(input) })
      const body = await response.json().catch(() => ({})) as { messageId?: unknown }
      return { messageId: typeof body.messageId === 'string' ? body.messageId : undefined }
    },
    async wait(askId, waitSeconds, signal) {
      const response = await call('/' + encodeURIComponent(askId) + '?wait=' + waitSeconds, { method: 'GET' }, signal)
      const body = await response.json().catch(() => ({})) as { state?: unknown, choice?: unknown, reason?: unknown, outcome?: unknown }
      if (body.state === 'clicked' && (body.choice === 'allow' || body.choice === 'deny')) {
        return { state: 'clicked', choice: body.choice }
      }
      if (body.state === 'closed') {
        return {
          state: 'closed',
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          outcome: typeof body.outcome === 'string' ? body.outcome : undefined,
        }
      }
      return { state: 'pending' }
    },
    async settle(askId, body) {
      await call('/' + encodeURIComponent(askId) + '/settle', { method: 'POST', body: JSON.stringify(body) })
    },
  }
}

/** Generate a 128-bit ask id (hex). */
export function randomAskId(): string {
  return randomBytes(16).toString('hex')
}

/** What an answerer needs; everything injectable so the race is unit-testable. */
export interface AnswererDeps {
  config: () => ResolvedOptions
  policyInfo?: () => ApprovalPolicyInfo | undefined
  relay: (cfg: ResolvedOptions) => RelayClient | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  randomId?: () => string
  log?: Logger
  /** Translate an English reason; undefined keeps the source text. */
  translate?: (text: string, budgetMs: number, signal?: AbortSignal) => Promise<string | undefined>
}

type PollOutcome =
  | { kind: 'clicked'; choice: 'allow' | 'deny' }
  | { kind: 'closed' }
  | { kind: 'aborted' }

/**
 * Long-poll the relay until a click, a close, or an abort. Network failures
 * back off instead of ending the wait: the approval is still pending.
 */
async function waitForClick(relay: RelayClient, askId: string, cfg: ResolvedOptions, signal?: AbortSignal, sleepFn?: (ms: number) => Promise<void>): Promise<PollOutcome> {
  const nap = sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let failures = 0
  for (;;) {
    if (signal?.aborted) return { kind: 'aborted' }
    try {
      const before = Date.now()
      const state = await relay.wait(askId, cfg.pollWaitSeconds, signal)
      failures = 0
      if (state.state === 'clicked') return { kind: 'clicked', choice: state.choice }
      if (state.state === 'closed') return { kind: 'closed' }
      // A relay that answers `pending` instantly must not turn this into a hot
      // loop; a real long-poll holds the connection for pollWaitSeconds.
      if (Date.now() - before < 250) await new Promise<void>((resolve) => setTimeout(resolve, 250))
    } catch {
      failures += 1
      await nap(Math.min(5000, 500 * failures))
    }
  }
}

/**
 * Build the approval/request answerer.
 *
 * Flow: read the gate window -> call next() immediately (the GUI/downstream
 * chain starts and the window clock ticks) -> debounce -> send the card ->
 * race downstream / click / abort -> settle the relay accordingly.
 */
export function createAnswerer(deps: AnswererDeps) {
  return async function answerer(request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const cfg = deps.config()
    if (!cfg.enabled || cfg.relayUrl === '' || cfg.sharedKey === '') return next()
    if (!cfg.includeSubagents && request.agent?.session?.header?.origin === 'subagent') return next()

    const relay = deps.relay(cfg)
    if (!relay) return next()

    const sessionId = String(request.agent?.id ?? '')
    const info = deps.policyInfo?.()?.describe(request.agent, sessionId)
    const gated = info?.gated === true
    const windowMs = Math.max(0, info?.windowMs ?? 0)
    // A zero window denies without letting anyone answer: don't send a dead card.
    if (gated && windowMs <= 0) return next()

    const now = deps.now ?? Date.now
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const startedAt = now()

    let downstreamSettled = false
    const downstream = next().then((outcome) => {
      downstreamSettled = true
      return outcome
    })

    await sleep(cfg.sendDelayMs)
    if (downstreamSettled) return downstream

    const remainingBefore = gated ? windowMs - (now() - startedAt) : undefined
    if (remainingBefore !== undefined && remainingBefore <= 0) return downstream

    // English reasons (typically auto-review escalations) are translated before
    // the card is rendered; a failed translation keeps the original text.
    let reason = request.reason
    if (cfg.translateEnglish && needsTranslation(reason) && deps.translate) {
      const budget = remainingBefore !== undefined
        ? Math.max(800, Math.min(cfg.translateTimeoutMs, remainingBefore - 500))
        : cfg.translateTimeoutMs
      const translated = await deps.translate(reason as string, budget, request.signal).catch(() => undefined)
      if (translated !== undefined) reason = translated
    }

    const remainingMs = gated ? windowMs - (now() - startedAt) : undefined
    if (remainingMs !== undefined && remainingMs <= 0) return downstream

    const askId = (deps.randomId ?? randomAskId)()
    const markdown = renderApprovalCard({
      sessionId,
      cwd: request.agent?.session?.header?.cwd,
      device: cfg.deviceLabel,
      toolName: request.toolName,
      command: commandOf(request),
      reason,
      gated,
      remainingMs,
      defaultOutcome: info?.defaultOutcome,
      now: now(),
    })

    if (cfg.dryRun) {
      deps.log?.info('dsh-approval-qq: dryRun, would send askId=' + askId + ':\n' + markdown)
      return downstream
    }

    try {
      await relay.create({ askId, markdown, device: cfg.deviceLabel })
    } catch (error) {
      deps.log?.warn('dsh-approval-qq: card send failed, keeping the GUI chain: ' + String((error as Error)?.message ?? error))
      return downstream
    }

    const pollAbort = new AbortController()
    const signals: AbortSignal[] = [pollAbort.signal]
    if (request.signal) signals.push(request.signal)
    const pollSignal = AbortSignal.any(signals)

    const aborted = new Promise<PollOutcome>((resolve) => {
      if (request.signal?.aborted) {
        resolve({ kind: 'aborted' })
        return
      }
      request.signal?.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true })
    })

    try {
      const winner = await Promise.race([
        downstream.then((outcome) => ({ kind: 'downstream' as const, outcome })),
        waitForClick(relay, askId, cfg, pollSignal, sleep),
        aborted,
      ])

      if (winner.kind === 'downstream') {
        const elapsed = now() - startedAt
        const reason = gated && elapsed >= windowMs - 100 ? 'auto-rejected' : 'answered-elsewhere'
        await relay.settle(askId, { outcome: 'ignored', reason }).catch(() => {})
        return winner.outcome
      }

      if (winner.kind === 'aborted') {
        await relay.settle(askId, { outcome: 'ignored', reason: 'aborted' }).catch(() => {})
        return 'cancelled'
      }

      if (winner.kind === 'closed') {
        // The relay closed the card without an honored click (restart/expiry race).
        // Nothing to settle; treat the request as withdrawn.
        return 'cancelled'
      }

      const outcome: ApprovalOutcome = winner.choice === 'allow' ? 'allowed-once' : 'rejected'
      await relay.settle(askId, {
        outcome,
        receipt: winner.choice === 'allow' ? cfg.allowReceipt : cfg.denyReceipt,
      }).catch((error) => {
        deps.log?.warn('dsh-approval-qq: settle failed: ' + String((error as Error)?.message ?? error))
      })
      return outcome
    } finally {
      pollAbort.abort()
    }
  }
}

/**
 * Activate the component.
 * @param ctx - host Cordis context.
 * @param config - row config; volatile fields arrive as live references.
 */
export function apply(ctx: Context, config: ApprovalQqConfig = {}): void {
  const log = (ctx as unknown as { logger: Logger }).logger
  const read = (): ResolvedOptions => resolveOptions(config)

  const policyInfo = (): ApprovalPolicyInfo | undefined => {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    return typeof get === 'function' ? get('approvalPolicyInfo') as ApprovalPolicyInfo | undefined : undefined
  }

  const serviceOf = (serviceName: string): unknown => {
    const get = (ctx as unknown as { get?: (key: string) => unknown }).get
    return typeof get === 'function' ? get(serviceName) : undefined
  }

  const translationCache = new Map<string, string>()
  const resolveModelRoute = (cfg: ResolvedOptions): ModelRoute | undefined => {
    if (cfg.translateProvider !== '' && cfg.translateModel !== '') {
      return { provider: cfg.translateProvider, model: cfg.translateModel }
    }
    try {
      const selection = (serviceOf('agentDefaultModel') as {
        currentSelection?: () => { provider?: unknown, model?: unknown }
      } | undefined)?.currentSelection?.()
      if (typeof selection?.provider === 'string' && typeof selection.model === 'string'
        && selection.provider !== '' && selection.model !== '') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // a missing or projecting service is not fatal: fall back to English
    }
    return undefined
  }

  const translate = async (source: string, budgetMs: number, signal?: AbortSignal): Promise<string | undefined> => {
    const cached = translationCache.get(source)
    if (cached !== undefined) return cached
    const llm = serviceOf('llm') as LlmRuntime | undefined
    if (!llm || typeof llm.stream !== 'function') return undefined
    const route = resolveModelRoute(read())
    if (route === undefined) {
      log.warn('dsh-approval-qq: no model route for translation; keeping the English reason')
      return undefined
    }
    try {
      const translated = await translateToChinese(llm, route, source, { timeoutMs: budgetMs, signal })
      if (translated === undefined) return undefined
      if (translationCache.size >= 100) {
        const oldest = translationCache.keys().next().value
        if (oldest !== undefined) translationCache.delete(oldest)
      }
      translationCache.set(source, translated)
      return translated
    } catch (error) {
      log.warn('dsh-approval-qq: translation failed: ' + String((error as Error)?.message ?? error))
      return undefined
    }
  }

  const answerer = createAnswerer({
    config: read,
    policyInfo,
    relay: (cfg) => createRelayClient({ baseUrl: cfg.relayUrl, key: cfg.sharedKey, timeoutMs: cfg.timeoutMs }),
    translate,
    log,
  })

  const initial = read()
  log.info(
    'dsh-approval-qq: active (enabled=' + initial.enabled + ', relay=' + (initial.relayUrl === '' ? '<unset>' : initial.relayUrl) + ', '
    + 'device=' + initial.deviceLabel + ', sendDelay=' + initial.sendDelayMs + 'ms, dryRun=' + initial.dryRun + ')',
  )

  const dispose = ctx.on('approval/request', answerer as never, { prepend: true })
  ctx.effect(() => dispose)
}
