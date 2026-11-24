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
 *     schema-forbidden). The turn proceeds denied instead of hanging, AND the
 *     request is withdrawn: the gate fuses a controller into the delegated
 *     request's signal, so aborting it once the request settles cancels the
 *     forwarded Remote prompt and the still-open Web GUI card / "awaiting
 *     approval" badge disappear instead of piling up as decided requests.
 *     Every settlement withdraws — the window default, a downstream answer
 *     (Web GUI / ACP / auto approval), and an outside answer reported through
 *     `ApprovalPolicyInfo.withdraw` (the QQ card click);
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
 *     keeps the interactive default;
 *   - interactive: the complement of the machine origins — a HUMAN-driven
 *     turn (last provenance message is 'user' / 'user-question-reply' and
 *     the session is not a subagent) is gated too, so approvals raised
 *     while an ordinary session is in progress get the same bounded window.
 *     Reachable alone or composed with the machine origins (e.g.
 *     [subagent, scheduled, interactive] ≈ everything but cron); 'all'
 *     remains the blunt escape hatch that also covers unknown provenance.
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
export type UnattendedOrigin = 'subagent' | 'scheduled' | 'cron' | 'interactive' | 'all'

/**
 * The only outcomes a gate may settle with. 'allowed-once' is deliberately
 * absent from this union AND from the config enum: an unattended default
 * must never grant — fail closed is the whole point.
 */
export type GatedOutcome = 'rejected' | 'unavailable'

/**
 * Read-only view of the gate policy, published on the cordis context so a
 * human channel (e.g. the QQ approval card) can echo the real deadline instead
 * of inventing its own TTL. `describe` reuses the exact predicate the gate
 * applies to the request, so the card and the window can never disagree.
 * `withdraw` is the write side: a channel that settled the request outside the
 * delegated chain reports that outcome, and every prompt still showing the
 * request on the other surfaces is withdrawn.
 */
export interface ApprovalPolicyInfo {
  describe(agent: unknown, sessionId: string): {
    /** Would this request enter the unattended window at all. */
    gated: boolean
    /** Window length in milliseconds; 0 means the gate denies immediately. */
    windowMs: number
    /** What the gate settles with when the window expires. */
    defaultOutcome: GatedOutcome
  }
  /**
   * Settle one gate-held request from outside the delegated chain (e.g. the QQ
   * card click) and withdraw the prompts the other surfaces still show for it.
   * The gate then reports `outcome` instead of waiting out its own window.
   * @param request - the exact waterfall request object the caller received.
   * @param outcome - the decision this channel produced.
   * @returns whether the gate held that request and withdrew it.
   */
  withdraw(request: unknown, outcome: ApprovalOutcome): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    approvalPolicyInfo: ApprovalPolicyInfo
  }
}

/** Settings-page schema; each key arrives as a volatile live reference. */
export const Config = z.object({
  /** Session/turn origins treated as unattended. Default: subagent + scheduled; 'interactive' also gates human-driven turns. */
  origins: z.array(z.union(['subagent', 'scheduled', 'cron', 'interactive', 'all'])).default(['subagent', 'scheduled']).volatile(),
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
  // 'interactive' is the complement of the machine origins: gate a turn only
  // when both provenance reads positively say a human is driving it — a real
  // user message and no subagent header. Unknown facts stay ungated (use
  // 'all' for the fail-closed escape hatch).
  if (origins.includes('interactive') && facts.headerOrigin !== 'subagent'
    && (kind === 'user' || kind === 'user-question-reply')) return true
  return false
}

/**
 * Describe the policy for one request: the exact predicate the gate will apply
 * plus the window it will apply it with. Pure, so both the gate and any human
 * channel can render and enforce the same deadline.
 */
export function describeGate(
  config: {
    readonly origins: readonly UnattendedOrigin[]
    readonly sessions: readonly string[]
    readonly windowSeconds: number
    readonly defaultOutcome: GatedOutcome
  },
  agent: AgentLike | undefined,
  sessionId: string,
): { gated: boolean, windowMs: number, defaultOutcome: GatedOutcome } {
  return {
    gated: shouldGate(config, sessionId, readFacts(agent)),
    windowMs: Math.max(0, config.windowSeconds * 1000),
    defaultOutcome: config.defaultOutcome,
  }
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
 *
 * `external` is the third arm: an answer produced OUTSIDE the delegated chain
 * (a human channel ahead of the gate — the QQ card — settles through
 * {@link ApprovalPolicyInfo.withdraw}). It counts as a downstream answer, so
 * the gate reports that outcome instead of abandoning the request to its own
 * timer.
 */
export async function raceGate(
  decision: () => Promise<ApprovalOutcome>,
  windowMs: number,
  defaultOutcome: GatedOutcome,
  external?: Promise<ApprovalOutcome>,
): Promise<GateSettlement> {
  if (windowMs <= 0) return { outcome: defaultOutcome, settledBy: 'window' }
  // The window timer stays REF'd on purpose: an open window means the host
  // turn is still owed an outcome, so the process must not drain the event
  // loop before it settles. It is cleared as soon as the race settles
  // (answer, external answer, rejection, or expiry) so a fast answer never
  // leaves a stray timer holding the loop for the rest of the window.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const windowSettlement = new Promise<GateSettlement>((resolve) => {
      timer = setTimeout(() => resolve({ outcome: defaultOutcome, settledBy: 'window' }), windowMs)
    })
    const arms: Promise<GateSettlement>[] = [
      decision().then((outcome): GateSettlement => ({ outcome, settledBy: 'downstream' })),
      windowSettlement,
    ]
    if (external !== undefined) {
      arms.push(external.then((outcome): GateSettlement => ({ outcome, settledBy: 'downstream' })))
    }
    return await Promise.race(arms)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Name carried by the abort reason the gate uses to withdraw a prompt whose
 * window expired. A human channel racing the same deadline (the QQ card
 * answerer) matches this name to tell the gate's own fail-closed settlement
 * apart from a cancelled turn. Kept as a literal in both components on
 * purpose: they are independently published packages, and this name is the
 * only contract between them.
 */
export const WINDOW_EXPIRED_ABORT = 'UnattendedApprovalWindowExpired'

/** Abort reason that withdraws a pending prompt once the window expires. */
export function windowExpiredReason(): Error {
  const error = new Error('The unattended approval window expired, so the pending approval request was withdrawn.')
  error.name = WINDOW_EXPIRED_ABORT
  return error
}

/**
 * Name carried by the abort reason the gate uses when a request was settled
 * somewhere else (a downstream answerer, another human channel through
 * {@link ApprovalPolicyInfo.withdraw}) and the prompts still open on the
 * remaining surfaces have to go away.
 */
export const SETTLED_ABORT = 'UnattendedApprovalSettledElsewhere'

/** Abort reason that withdraws a prompt because the request was already settled. */
export function settledElsewhereReason(): Error {
  const error = new Error('The approval request was already settled elsewhere, so this pending prompt was withdrawn.')
  error.name = SETTLED_ABORT
  return error
}

/**
 * Make one delegated request withdrawable.
 *
 * A human surface (the Web GUI's forwarded Remote prompt) drops a pending
 * request only when the Host cancels the Remote event, and the Host watches
 * exactly the request signal it was handed. The caller's signal belongs to the
 * turn — aborting it would cancel the tool call — so the gate fuses a
 * controller it owns into it: aborts from the turn still propagate unchanged,
 * while the gate gains a handle that withdraws the prompt at its deadline
 * without cancelling anything.
 *
 * @param request - the borrowed waterfall request about to be delegated.
 * @param withdraw - the gate-owned controller for this one request.
 * @returns the fused signal now installed on the request.
 */
export function installWithdrawSignal(
  request: { signal?: AbortSignal },
  withdraw: AbortController,
): AbortSignal {
  const original = request.signal
  const fused = original === undefined ? withdraw.signal : AbortSignal.any([original, withdraw.signal])
  request.signal = fused
  return fused
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

  /**
   * Withdrawal handle per delegated request. Keyed by the request object the
   * waterfall hands every listener, so an answerer that settles the request
   * outside the delegated chain (the QQ card) can end the prompts that other
   * surfaces still show. Weak: a request that never settles cannot leak.
   */
  const withdrawals = new WeakMap<object, {
    /** Aborts the fused signal: cancels the still-pending forwarded prompts. */
    readonly withdraw: AbortController
    /** Delivers an outside answer into the gate's race. */
    readonly settle: (outcome: ApprovalOutcome) => void
  }>()

  /**
   * Publish the read-only policy view. The service is optional by design: a
   * composition without this component simply has no approvalPolicyInfo, and
   * a human channel then shows no countdown (there is no gate deadline).
   */
  const policyInfo: ApprovalPolicyInfo = {
    describe(agent, sessionId) {
      return describeGate(cfgNow(), agent as AgentLike, sessionId)
    },
    withdraw(request, outcome) {
      const held = withdrawals.get(request as object)
      if (held === undefined) return false
      withdrawals.delete(request as object)
      held.withdraw.abort(settledElsewhereReason())
      held.settle(outcome)
      return true
    },
  }
  const provideService = (ctx as unknown as { provide?: (name: string, value: unknown) => () => void }).provide
  if (typeof provideService === 'function') {
    ctx.effect(() => provideService('approvalPolicyInfo', policyInfo))
  }

  const listener = async (
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    const cfg = cfgNow()
    const sessionId = String(request.agent?.id ?? '')
    if (!shouldGate(cfg, sessionId, readFacts(request.agent))) return next()
    const windowMs = Math.max(0, cfg.windowSeconds * 1000)
    // Only a delegated request owns a downstream prompt; a zero window denies
    // without calling next(), so there is nothing to withdraw then.
    const withdraw = windowMs > 0 ? new AbortController() : undefined
    let externalSettle: ((outcome: ApprovalOutcome) => void) | undefined
    const external = withdraw === undefined ? undefined : new Promise<ApprovalOutcome>((resolve) => {
      externalSettle = resolve
    })
    if (withdraw !== undefined && externalSettle !== undefined) {
      installWithdrawSignal(request as { signal?: AbortSignal }, withdraw)
      withdrawals.set(request, { withdraw, settle: externalSettle })
    }
    const settlement = await raceGate(next, windowMs, cfg.defaultOutcome, external)
    if (withdraw !== undefined) {
      // Whoever settled the request ends every prompt still showing it: the
      // window's fail-closed default, a downstream answer (Web GUI, ACP, auto
      // approval), and an outside answer routed through withdraw() all take
      // the prompts left open on the OTHER surfaces away. A prompt kept alive
      // after its decision is only a stale card on the user's panel, and a
      // late click is discarded by the service.
      withdrawals.delete(request)
      withdraw.abort(settlement.settledBy === 'window' ? windowExpiredReason() : settledElsewhereReason())
    }
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
