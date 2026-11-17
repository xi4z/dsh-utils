/**
 * `dsh-utils` approval-policy component: the unattended approval gate, with
 * two additions for the experimental auto approval (the `auto` permission
 * preset published by `@deepseek-ai/dsh-experimental-auto-review`):
 *
 *   1. `defaultPermissionPreset` — pin every NEW session to a configured
 *      preset. `"auto"` makes the experimental auto approval the deployment's
 *      default approval strategy; the host itself refuses `auto` as a
 *      `permissionPresets.defaultPreset` value (it is a current-session-only
 *      preset), so this is the one seam that can default a deployment to it.
 *   2. `autoReviewContent` — when the window expires on a request the auto
 *      approval raised (the reviewer's `ask`), the model-facing tool result
 *      gains the reviewer's own content. The host's approval pipeline renders
 *      only "the user rejected tool X" for any `rejected` outcome, which would
 *      drop the reviewer's reason; this component appends it through
 *      `tools/post-execute` so the Agent reads what the auto approval decided
 *      and why, not just that the call was denied.
 *
 * The bundle mounts this component under the entry id `dsh-approval-policy`
 * (`dsh-utils/approval-policy`); that entry id is also its settings namespace.
 *
 * On the host's 'approval/request' cordis waterfall this component is a racing
 * gate answerer. For sessions/turns declared unattended (config: origins /
 * sessions) it does not simply claim the request — it delegates with next()
 * FIRST and races the downstream chain against a bounded window. Whoever
 * settles first wins:
 *
 *   - a downstream answerer answers inside the window → its answer wins
 *     (an instant fail-closed 'unavailable' from an empty chain passes
 *     through untouched — nothing to wait for);
 *   - the window expires → the configured fail-closed default settles the
 *     approval ('rejected'; 'unavailable' also allowed — 'allowed-once' is
 *     schema-forbidden). The turn proceeds denied instead of hanging;
 *   - the request's abort signal resolves 'cancelled' upstream — the host
 *     races the signal itself; a late window expiry is simply ignored.
 *
 * Unattended detection (config `origins`), in evaluation order:
 *
 *   - sessions: glob-matched against the requesting agent id — an explicit
 *     name wins and gates EVERY turn of that session (session-level);
 *   - all: gate everything (opt-in escape hatch);
 *   - subagent: session.header.origin === 'subagent' (session-level — a
 *     subagent session is dedicated to delegation);
 *   - scheduled / cron: turn-level — the last PROVENANCE-bearing user
 *     message's source.kind is 'schedule' (host dsh-schedule) or 'cron'
 *     (dsh-cron). Synthetic context injections (runtime-context,
 *     skill-catalog, …) also ride role='user' and are skipped — they land
 *     after the trigger and would otherwise shadow it. Turn-level because
 *     those sessions are shared with humans: only machine-driven turns
 *     gate, and a human steering afterwards (last provenance message =
 *     human — 'user', or a timed-ask late reply 'user-question-reply')
 *     keeps the interactive default.
 *
 * The listener registers with prepend: true — the gate sits ahead of the
 * interactive answerers (web remote answerer, dsh-feishu card) regardless of
 * plugin load order, so an unattended request is windowed before a human
 * surface claims it. Gated requests still reach those surfaces through
 * next() inside the window. Interactive turns delegate immediately — the
 * interactive default is unchanged.
 *
 * Audit: the host owns approval/asked + approval/decided — every decision,
 * whichever answerer made it, lands in the session transcript. The gate
 * never writes to the session log itself; the auto-approval addition rides the
 * tool result the pipeline already materializes.
 *
 * Config: `export const Config` is the settings-page schema (all keys
 * volatile, all defaults fail-closed-friendly); `apply` reads them through
 * live references like dsh-cron does.
 *
 * @module dsh-utils/approval-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'dsh-approval-policy'

/** Origins a deployment may declare unattended (config vocabulary). */
export type UnattendedOrigin = 'subagent' | 'scheduled' | 'cron' | 'all'

/**
 * The only outcomes a gate may settle with. 'allowed-once' is deliberately
 * absent from this union AND from the config enum: an unattended default
 * must never grant — fail closed is the whole point.
 */
export type GatedOutcome = 'rejected' | 'unavailable'

/** Settings-page schema; each key arrives as a volatile live reference. */
export const Config = z.object({
  /** Session/turn origins treated as unattended. Default: subagent + scheduled. */
  origins: z.array(z.union(['subagent', 'scheduled', 'cron', 'all'])).default(['subagent', 'scheduled']).volatile(),
  /** Glob patterns matched against the requesting agent id; a hit gates every turn of that session. */
  sessions: z.array(z.string()).default([]).volatile(),
  /** Answer window in seconds (whole seconds; no .int() chain exists — min/max bound it); 0 denies without delegating. Default 60. */
  windowSeconds: z.number().min(0).max(86400).default(60).volatile(),
  /** Settled when the window expires; 'allowed-once' is not in the union. */
  defaultOutcome: z.union(['rejected', 'unavailable']).default('rejected').volatile(),
  /**
   * Permission preset pinned into every new session; '' keeps the host default.
   * 'auto' selects the experimental auto approval (requires the
   * `@deepseek-ai/dsh-experimental-auto-review` bundle); any configured preset
   * name is accepted. The host rejects 'auto' as its own `defaultPreset`, and
   * the pinned value is a durable `permission/preset` event, so every later
   * turn reads the real knobs instead of a component-side override.
   */
  defaultPermissionPreset: z.string().default('').volatile(),
  /**
   * Append the experimental auto approval's own content to the model-facing
   * tool result when this gate's window (not a human, not another answerer)
   * rejects a request the reviewer raised. Default true.
   */
  autoReviewContent: z.boolean().default(true).volatile(),
})

/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
  get(): T
}

/** The runtime shape `apply` receives (every field volatile). */
export interface GateRuntimeConfig {
  origins: VolatileRef<UnattendedOrigin[]>
  sessions: VolatileRef<string[]>
  windowSeconds: VolatileRef<number>
  defaultOutcome: VolatileRef<GatedOutcome>
  defaultPermissionPreset: VolatileRef<string>
  autoReviewContent: VolatileRef<boolean>
}

/** Canonical identity of the experimental per-call review preset. */
export const AUTO_REVIEW_PRESET = 'auto'

/**
 * The reviewer-owned prefix of an approval reason raised by
 * `@deepseek-ai/dsh-experimental-auto-review` when its review denies a call
 * under the `ask` policy (`Auto review denied tool "<name>": <reason>`).
 * Matching the reason rather than the session preset keeps the attribution
 * correct when the policy switches between the ask and its settlement.
 */
export const AUTO_REVIEW_REASON_PREFIX = 'Auto review denied tool "'

/** Structured error code the pipeline records for a rejected approval (newer host lines). */
const APPROVAL_REJECTED_CODE = 'APPROVAL_REJECTED'

/**
 * The model-facing denial text the host pipeline renders for ANY `rejected`
 * approval outcome (`packages/core/tools/src/pipeline.ts`). Host 0.2.2-rc.1
 * records no structured error info, so the text is the only stable, version-
 * tolerant discriminator; newer lines also carry `{ name: ApprovalError }`.
 */
export function rejectedApprovalMessage(toolName: string): string {
  return `the user rejected tool "${toolName}"`
}

/** Whether one failed tool result is the pipeline's rejection of an approval ask. */
export function isRejectedApprovalResult(
  result: { readonly isError: boolean; readonly error: { readonly message: string; readonly info?: { readonly name?: string; readonly code?: string } } },
  toolName: string,
): boolean {
  if (!result.isError) return false
  const info = result.error.info
  if (info !== undefined && (info.code === APPROVAL_REJECTED_CODE || info.name === 'ApprovalError')) return true
  return result.error.message === rejectedApprovalMessage(toolName)
}

/** How long a window-rejected auto-review request may still claim its tool result. */
const AUTO_REVIEW_SETTLE_TTL_MS = 120_000

/** Compiled glob: `*` matches anything, everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^(?:${escaped})$`)
}

/** What the gate reads off the requesting agent to classify the turn. */
export interface OriginFacts {
  /** session.header.origin when the live session is readable ('subagent' …). */
  headerOrigin?: string
  /** source.kind of the session's last user message ('schedule', 'cron', 'user', …). */
  lastUserMessageKind?: string
}

/** Structural slices of the runtime faces — no closure type imports needed. */
interface MsgLike {
  readonly role?: string
  readonly source?: { readonly kind?: string }
}
interface EventLike {
  readonly type?: string
}
interface SessionLike {
  readonly header?: { readonly origin?: string }
  deriveMessages?(): MsgLike[]
  snapshotEvents?(): readonly EventLike[]
}
interface AgentLike {
  readonly id?: unknown
  readonly session?: SessionLike
}

/**
 * Kinds that carry a turn's human/machine provenance. The host also injects
 * SYNTHETIC context messages into the role='user' stream after a turn starts
 * (runtime-context snapshots, skill-catalog reminders, …); they always sit
 * after the real trigger and would shadow it, so the backward scan skips any
 * user-role message whose kind is not one of these (a missing kind is legacy
 * human input and counts as 'user'). Live-tested: without this skip, every
 * cron/scheduled turn misclassified as interactive and slipped through
 * unwindowed.
 *
 * 'user-question-reply' (dsh 0.2.0 timed ask, experimental) is the LATE
 * answer to a timed-out question flowing back as a user-role message — hard
 * proof a human was there. It stops the scan with the same standing as an
 * explicit 'user' steer (the turn stays interactive); skipping it as
 * synthetic would shadow it with the cron/schedule trigger that fired
 * BEFORE the human answered.
 */
const PROVENANCE_KINDS: ReadonlySet<string> = new Set(['user', 'schedule', 'cron', 'user-question-reply'])

/**
 * Read the origin facts off the request's agent. Both reads are best-effort:
 * a projected agent without a live session yields `{}` (only `sessions`/`all`
 * can then gate), and each fact independently degrades to undefined.
 */
export function readFacts(agent: AgentLike | undefined): OriginFacts {
  const session = agent?.session
  if (!session) return {}
  const facts: OriginFacts = { headerOrigin: session.header?.origin }
  const messages = session.deriveMessages?.()
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message?.role !== 'user') continue
      const kind = message.source?.kind
      if (kind === undefined || PROVENANCE_KINDS.has(kind)) {
        facts.lastUserMessageKind = kind ?? 'user'
        break
      }
      // synthetic context injection — keep scanning for the real trigger
    }
  }
  return facts
}

/** Gate predicate: explicit session hit → 'all' → session/turn origins. */
export function shouldGate(
  config: { readonly origins: readonly UnattendedOrigin[]; readonly sessions: readonly string[] },
  sessionId: string,
  facts: OriginFacts,
): boolean {
  if (config.sessions.length > 0 && config.sessions.some((pattern) => {
    try {
      return globToRegExp(pattern).test(sessionId)
    } catch {
      return false // a malformed pattern must not break approvals
    }
  })) return true
  const origins = config.origins
  if (origins.includes('all')) return true
  if (origins.includes('subagent') && facts.headerOrigin === 'subagent') return true
  const kind = facts.lastUserMessageKind
  if (kind === 'schedule' && origins.includes('scheduled')) return true
  if (kind === 'cron' && origins.includes('cron')) return true
  return false
}

/** Which side of the race produced the settled outcome. */
export type GateSettledBy = 'downstream' | 'window'

/** One gate result: the outcome plus the side that produced it. */
export interface GateSettlement {
  readonly outcome: ApprovalOutcome
  readonly settledBy: GateSettledBy
}

/**
 * The gate: delegate first, race the downstream chain against the window.
 *
 * windowMs <= 0 denies immediately WITHOUT calling `decision` (the 0 = instant
 * deny degenerate case — downstream never sees the request, mirroring the
 * host's approval/policy=never); that settlement is reported as `'window'`
 * because no answerer produced it. A fast `decision` (including an instant
 * fail-closed 'unavailable' from an empty chain) passes through untouched;
 * only a pending decision races the timer.
 */
export async function raceGate(
  decision: () => Promise<ApprovalOutcome>,
  windowMs: number,
  defaultOutcome: GatedOutcome,
): Promise<GateSettlement> {
  if (windowMs <= 0) return { outcome: defaultOutcome, settledBy: 'window' }
  // The window timer stays REF'd on purpose: an open window means the host
  // turn is still owed an outcome, so the process must not drain the event
  // loop before it settles. It is cleared as soon as the race settles
  // (answer, rejection, or expiry) so a fast answer never leaves a stray
  // timer holding the loop for the rest of the window.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const windowSettlement = new Promise<GateSettlement>((resolve) => {
      timer = setTimeout(() => resolve({ outcome: defaultOutcome, settledBy: 'window' }), windowMs)
    })
    return await Promise.race([
      decision().then((outcome): GateSettlement => ({ outcome, settledBy: 'downstream' })),
      windowSettlement,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Whether an approval reason was raised by the experimental auto approval. */
export function isAutoReviewAsk(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(AUTO_REVIEW_REASON_PREFIX)
}

/** One window-rejected auto-review request waiting for its tool result. */
export interface AutoReviewSettle {
  /** Tool whose approval the reviewer raised. */
  readonly toolName: string
  /** The reviewer-owned approval reason, verbatim. */
  readonly reason: string
  /** Wall clock of the settlement, for TTL pruning. */
  readonly at: number
}

/** Remember one settlement under its tool-call id (absent call ids cannot claim a result). */
export function recordAutoReviewSettle(
  store: Map<string, AutoReviewSettle>,
  callId: string | undefined,
  settle: AutoReviewSettle,
): void {
  if (callId === undefined || callId === '') return
  store.set(callId, settle)
}

/**
 * Take and forget the settlement for one tool call; expired entries are pruned
 * first so a result arriving after the TTL never claims stale content.
 */
export function takeAutoReviewSettle(
  store: Map<string, AutoReviewSettle>,
  callId: string | undefined,
  now: number,
): AutoReviewSettle | undefined {
  for (const [key, settle] of store) {
    if (now - settle.at > AUTO_REVIEW_SETTLE_TTL_MS) store.delete(key)
  }
  if (callId === undefined || callId === '') return undefined
  const settle = store.get(callId)
  if (settle === undefined) return undefined
  store.delete(callId)
  return settle
}

/** The model-facing sentence appended to the denied tool result. */
export function autoReviewNotice(toolName: string, reason: string): string {
  return 'The unattended approval window expired before anyone answered, so this request was rejected '
    + `instead of being answered by the user. The pending request for tool "${toolName}" came from the `
    + `experimental auto approval (auto review); its content follows:\n\n${reason}`
}

/** Append the auto approval's content to the model-facing result content. */
export function withAutoReviewContent(
  content: readonly ContentBlock[],
  settle: AutoReviewSettle,
): ContentBlock[] {
  return [
    ...content,
    { type: 'text', text: `\n\n${autoReviewNotice(settle.toolName, settle.reason)}` },
  ]
}

/** What the permission projection already recorded in a session log. */
export interface PermissionFacts {
  /** The session log was readable at all. */
  readonly readable: boolean
  /** The session already started a turn (a resumed or user-driven session). */
  readonly turnStarted: boolean
  /** The host (or a user) already recorded permission state. */
  readonly permissionState: boolean
  /** The log carries the constructor-seed boundary of a seeded session. */
  readonly seeded: boolean
}

const PERMISSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'session/end-seed',
])

/**
 * Fold the permission-relevant facts out of a session log. A session that
 * cannot expose its events is reported unreadable so the caller skips pinning
 * instead of overriding a restored selection it cannot see.
 */
export function readPermissionFacts(session: SessionLike | undefined): PermissionFacts {
  const events = session?.snapshotEvents?.()
  if (events === undefined) {
    return { readable: false, turnStarted: true, permissionState: true, seeded: true }
  }
  let turnStarted = false
  let permissionState = false
  let seeded = false
  for (const event of events) {
    const type = event?.type
    if (type === 'turn/start') turnStarted = true
    else if (type === 'session/end-seed') { permissionState = true; seeded = true }
    else if (type !== undefined && PERMISSION_EVENT_TYPES.has(type)) permissionState = true
  }
  return { readable: true, turnStarted, permissionState, seeded }
}

/** Inputs for the default-preset decision. */
export interface DefaultPresetDecision {
  /** Configured preset name; '' means leave the session alone. */
  readonly configured: string
  /** Preset the session currently resolves to. */
  readonly current: string
  /** The host's deployment default preset. */
  readonly hostDefault: string
  /** Permission facts folded from the session log. */
  readonly facts: PermissionFacts
}

/**
 * Decide whether a new session may take the configured default preset.
 *
 * A session qualifies while it has no turn and no seed boundary. It qualifies
 * either before the host pinned its own default (no permission state yet — the
 * gate ran first) or right after the host pinned exactly that default (the
 * session is still untouched, so the pin is creation-time state rather than a
 * user choice). Anything else is a resumed, seeded, or deliberately switched
 * session and keeps its recorded permission.
 */
export function shouldPinDefaultPreset(decision: DefaultPresetDecision): boolean {
  const { configured, current, hostDefault, facts } = decision
  if (configured === '' || current === configured) return false
  if (!facts.readable || facts.turnStarted || facts.seeded) return false
  return !facts.permissionState || current === hostDefault
}

/** Structural slice of `ctx.permissionPresets` (types only; no runtime import). */
interface PermissionPresetsLike {
  readonly names: readonly string[]
  readonly defaultPreset: string
  current(session: unknown): string
  set(session: unknown, name: string): void
}

/** Read the optional permission-presets service without importing its module. */
function permissionPresetsOf(ctx: Context): PermissionPresetsLike | undefined {
  return (ctx as unknown as { get(name: string): PermissionPresetsLike | undefined }).get('permissionPresets')
}

/** Payload of the host's agent/created event, as this component reads it. */
interface AgentCreatedPayload {
  readonly agent?: AgentLike
}

export function apply(ctx: Context, config: GateRuntimeConfig): void {
  const cfgNow = () => ({
    origins: config.origins.get(),
    sessions: config.sessions.get(),
    windowSeconds: config.windowSeconds.get(),
    defaultOutcome: config.defaultOutcome.get(),
    defaultPermissionPreset: config.defaultPermissionPreset.get(),
    autoReviewContent: config.autoReviewContent.get(),
  })

  /** Window-rejected auto-review requests, keyed by tool-call id. */
  const pendingAutoReview = new Map<string, AutoReviewSettle>()

  const listener = async (
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    const cfg = cfgNow()
    const sessionId = String(request.agent?.id ?? '')
    if (!shouldGate(cfg, sessionId, readFacts(request.agent))) return next()
    const settlement = await raceGate(next, cfg.windowSeconds * 1000, cfg.defaultOutcome)
    if (settlement.settledBy === 'window'
      && settlement.outcome === 'rejected'
      && cfg.autoReviewContent
      && isAutoReviewAsk(request.reason)) {
      recordAutoReviewSettle(pendingAutoReview, request.callId === undefined ? undefined : String(request.callId), {
        toolName: request.toolName,
        reason: request.reason as string,
        at: Date.now(),
      })
    }
    return settlement.outcome
  }

  /**
   * Append the reviewer's content to a rejection this gate produced. The
   * listener delegates with next() first so every other post-execute policy
   * still runs, then edits only the accepted content of an APPROVAL_REJECTED
   * failure that matches a recorded window settlement.
   */
  const postExecute = async (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    if (!result.isError || !isRejectedApprovalResult(result, exec.name)) return next()
    const settle = takeAutoReviewSettle(
      pendingAutoReview,
      exec.callId === undefined ? undefined : String(exec.callId),
      Date.now(),
    )
    if (settle === undefined) return next()
    const downstream = await next()
    if (downstream.kind !== 'accept') return downstream
    // A value-replacing accept cannot apply to a failed result; leave it to the pipeline's own rejection.
    if ('value' in downstream) return downstream
    return {
      kind: 'accept',
      content: withAutoReviewContent(downstream.content ?? result.content, settle),
      ...downstream.additionalContexts === undefined ? {} : { additionalContexts: downstream.additionalContexts },
    }
  }

  /**
   * Pin the configured default preset into a new session. A deployment that
   * asks for a preset the composition does not publish throws here, which
   * vetoes agent publication — a missing auto-review bundle must be visible,
   * not a silently interactive session.
   */
  const pinDefaultPreset = (payload: AgentCreatedPayload): void => {
    const configured = config.defaultPermissionPreset.get()
    if (configured === '') return
    const presets = permissionPresetsOf(ctx)
    if (presets === undefined) {
      throw new Error(`dsh-approval-policy: defaultPermissionPreset "${configured}" requires ctx.permissionPresets, which this composition does not mount`)
    }
    if (!presets.names.includes(configured)) {
      throw new Error(`dsh-approval-policy: defaultPermissionPreset "${configured}" is not an available preset (available: ${presets.names.join(', ')}); preset "auto" requires the @deepseek-ai/dsh-experimental-auto-review bundle`)
    }
    const session = payload.agent?.session
    if (session === undefined) return
    if (shouldPinDefaultPreset({
      configured,
      current: presets.current(session),
      hostDefault: presets.defaultPreset,
      facts: readPermissionFacts(session),
    })) presets.set(session, configured)
  }

  // prepend keeps the gate ahead of interactive answerers regardless of
  // plugin load order; gated requests still reach them via next().
  const disposeGate = ctx.on('approval/request', listener, { prepend: true })
  // prepend so the rejection is edited before later policies materialize it;
  // next() still runs so no other post-execute policy is skipped.
  const disposePostExecute = ctx.on('tools/post-execute', postExecute, { prepend: true })
  const disposePin = ctx.on('agent/created', pinDefaultPreset as never)
  ctx.effect(() => disposeGate)
  ctx.effect(() => disposePostExecute)
  ctx.effect(() => disposePin)
}
