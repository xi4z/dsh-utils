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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
export declare const name = "dsh-approval-policy";
/** Origins a deployment may declare unattended (config vocabulary). */
export type UnattendedOrigin = 'subagent' | 'scheduled' | 'cron' | 'interactive' | 'all';
/**
 * The only outcomes a gate may settle with. 'allowed-once' is deliberately
 * absent from this union AND from the config enum: an unattended default
 * must never grant — fail closed is the whole point.
 */
export type GatedOutcome = 'rejected' | 'unavailable';
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
        gated: boolean;
        /** Window length in milliseconds; 0 means the gate denies immediately. */
        windowMs: number;
        /** What the gate settles with when the window expires. */
        defaultOutcome: GatedOutcome;
    };
    /**
     * Settle one gate-held request from outside the delegated chain (e.g. the QQ
     * card click) and withdraw the prompts the other surfaces still show for it.
     * The gate then reports `outcome` instead of waiting out its own window.
     * @param request - the exact waterfall request object the caller received.
     * @param outcome - the decision this channel produced.
     * @returns whether the gate held that request and withdrew it.
     */
    withdraw(request: unknown, outcome: ApprovalOutcome): boolean;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        approvalPolicyInfo: ApprovalPolicyInfo;
    }
}
/** Settings-page schema; each key arrives as a volatile live reference. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** Session/turn origins treated as unattended. Default: subagent + scheduled; 'interactive' also gates human-driven turns. */
    origins: z<NoInfer<("subagent" | "scheduled" | "cron" | "interactive" | "all")[]>, NoInfer<("subagent" | "scheduled" | "cron" | "interactive" | "all")[]>, "volatile-defined">;
    /** Glob patterns matched against the requesting agent id; a hit gates every turn of that session. */
    sessions: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    /** Answer window in seconds (whole seconds; no .int() chain exists — min/max bound it); 0 denies without delegating. Default 60. */
    windowSeconds: z<number, number, "volatile-defined">;
    /** Settled when the window expires; 'allowed-once' is not in the union. */
    defaultOutcome: z<"rejected" | "unavailable", "rejected" | "unavailable", "volatile-defined">;
    /**
     * Permission preset pinned into every new session; '' keeps the host default.
     * 'auto' selects the experimental auto approval (requires the
     * `@deepseek-ai/dsh-experimental-auto-review` bundle); any configured preset
     * name is accepted. The host rejects 'auto' as its own `defaultPreset`, and
     * the pinned value is a durable `permission/preset` event, so every later
     * turn reads the real knobs instead of a component-side override.
     */
    defaultPermissionPreset: z<string, string, "volatile-defined">;
    /**
     * Append the experimental auto approval's own content to the model-facing
     * tool result when this gate's window (not a human, not another answerer)
     * rejects a request the reviewer raised. Default true.
     */
    autoReviewContent: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** Session/turn origins treated as unattended. Default: subagent + scheduled; 'interactive' also gates human-driven turns. */
    origins: z<NoInfer<("subagent" | "scheduled" | "cron" | "interactive" | "all")[]>, NoInfer<("subagent" | "scheduled" | "cron" | "interactive" | "all")[]>, "volatile-defined">;
    /** Glob patterns matched against the requesting agent id; a hit gates every turn of that session. */
    sessions: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    /** Answer window in seconds (whole seconds; no .int() chain exists — min/max bound it); 0 denies without delegating. Default 60. */
    windowSeconds: z<number, number, "volatile-defined">;
    /** Settled when the window expires; 'allowed-once' is not in the union. */
    defaultOutcome: z<"rejected" | "unavailable", "rejected" | "unavailable", "volatile-defined">;
    /**
     * Permission preset pinned into every new session; '' keeps the host default.
     * 'auto' selects the experimental auto approval (requires the
     * `@deepseek-ai/dsh-experimental-auto-review` bundle); any configured preset
     * name is accepted. The host rejects 'auto' as its own `defaultPreset`, and
     * the pinned value is a durable `permission/preset` event, so every later
     * turn reads the real knobs instead of a component-side override.
     */
    defaultPermissionPreset: z<string, string, "volatile-defined">;
    /**
     * Append the experimental auto approval's own content to the model-facing
     * tool result when this gate's window (not a human, not another answerer)
     * rejects a request the reviewer raised. Default true.
     */
    autoReviewContent: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
    get(): T;
}
/** The runtime shape `apply` receives (every field volatile). */
export interface GateRuntimeConfig {
    origins: VolatileRef<UnattendedOrigin[]>;
    sessions: VolatileRef<string[]>;
    windowSeconds: VolatileRef<number>;
    defaultOutcome: VolatileRef<GatedOutcome>;
    defaultPermissionPreset: VolatileRef<string>;
    autoReviewContent: VolatileRef<boolean>;
}
/** Canonical identity of the experimental per-call review preset. */
export declare const AUTO_REVIEW_PRESET = "auto";
/**
 * The reviewer-owned prefix of an approval reason raised by
 * `@deepseek-ai/dsh-experimental-auto-review` when its review denies a call
 * under the `ask` policy (`Auto review denied tool "<name>": <reason>`).
 * Matching the reason rather than the session preset keeps the attribution
 * correct when the policy switches between the ask and its settlement.
 */
export declare const AUTO_REVIEW_REASON_PREFIX = "Auto review denied tool \"";
/**
 * The model-facing denial text the host pipeline renders for ANY `rejected`
 * approval outcome (`packages/core/tools/src/pipeline.ts`). Host 0.2.2-rc.1
 * records no structured error info, so the text is the only stable, version-
 * tolerant discriminator; newer lines also carry `{ name: ApprovalError }`.
 */
export declare function rejectedApprovalMessage(toolName: string): string;
/** Whether one failed tool result is the pipeline's rejection of an approval ask. */
export declare function isRejectedApprovalResult(result: {
    readonly isError: boolean;
    readonly error: {
        readonly message: string;
        readonly info?: {
            readonly name?: string;
            readonly code?: string;
        };
    };
}, toolName: string): boolean;
/** Compiled glob: `*` matches anything, everything else is literal. */
export declare function globToRegExp(pattern: string): RegExp;
/** What the gate reads off the requesting agent to classify the turn. */
export interface OriginFacts {
    /** session.header.origin when the live session is readable ('subagent' …). */
    headerOrigin?: string;
    /** source.kind of the session's last user message ('schedule', 'cron', 'user', …). */
    lastUserMessageKind?: string;
}
/** Structural slices of the runtime faces — no closure type imports needed. */
interface MsgLike {
    readonly role?: string;
    readonly source?: {
        readonly kind?: string;
    };
}
interface EventLike {
    readonly type?: string;
}
interface SessionLike {
    readonly header?: {
        readonly origin?: string;
    };
    deriveMessages?(): MsgLike[];
    snapshotEvents?(): readonly EventLike[];
}
interface AgentLike {
    readonly id?: unknown;
    readonly session?: SessionLike;
}
/**
 * Read the origin facts off the request's agent. Both reads are best-effort:
 * a projected agent without a live session yields `{}` (only `sessions`/`all`
 * can then gate), and each fact independently degrades to undefined.
 */
export declare function readFacts(agent: AgentLike | undefined): OriginFacts;
/** Gate predicate: explicit session hit → 'all' → session/turn origins. */
export declare function shouldGate(config: {
    readonly origins: readonly UnattendedOrigin[];
    readonly sessions: readonly string[];
}, sessionId: string, facts: OriginFacts): boolean;
/**
 * Describe the policy for one request: the exact predicate the gate will apply
 * plus the window it will apply it with. Pure, so both the gate and any human
 * channel can render and enforce the same deadline.
 */
export declare function describeGate(config: {
    readonly origins: readonly UnattendedOrigin[];
    readonly sessions: readonly string[];
    readonly windowSeconds: number;
    readonly defaultOutcome: GatedOutcome;
}, agent: AgentLike | undefined, sessionId: string): {
    gated: boolean;
    windowMs: number;
    defaultOutcome: GatedOutcome;
};
/** Which side of the race produced the settled outcome. */
export type GateSettledBy = 'downstream' | 'window';
/** One gate result: the outcome plus the side that produced it. */
export interface GateSettlement {
    readonly outcome: ApprovalOutcome;
    readonly settledBy: GateSettledBy;
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
export declare function raceGate(decision: () => Promise<ApprovalOutcome>, windowMs: number, defaultOutcome: GatedOutcome, external?: Promise<ApprovalOutcome>): Promise<GateSettlement>;
/**
 * Name carried by the abort reason the gate uses to withdraw a prompt whose
 * window expired. A human channel racing the same deadline (the QQ card
 * answerer) matches this name to tell the gate's own fail-closed settlement
 * apart from a cancelled turn. Kept as a literal in both components on
 * purpose: they are independently published packages, and this name is the
 * only contract between them.
 */
export declare const WINDOW_EXPIRED_ABORT = "UnattendedApprovalWindowExpired";
/** Abort reason that withdraws a pending prompt once the window expires. */
export declare function windowExpiredReason(): Error;
/**
 * Name carried by the abort reason the gate uses when a request was settled
 * somewhere else (a downstream answerer, another human channel through
 * {@link ApprovalPolicyInfo.withdraw}) and the prompts still open on the
 * remaining surfaces have to go away.
 */
export declare const SETTLED_ABORT = "UnattendedApprovalSettledElsewhere";
/** Abort reason that withdraws a prompt because the request was already settled. */
export declare function settledElsewhereReason(): Error;
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
export declare function installWithdrawSignal(request: {
    signal?: AbortSignal;
}, withdraw: AbortController): AbortSignal;
/** Whether an approval reason was raised by the experimental auto approval. */
export declare function isAutoReviewAsk(reason: string | undefined): boolean;
/** One window-rejected auto-review request waiting for its tool result. */
export interface AutoReviewSettle {
    /** Tool whose approval the reviewer raised. */
    readonly toolName: string;
    /** The reviewer-owned approval reason, verbatim. */
    readonly reason: string;
    /** Wall clock of the settlement, for TTL pruning. */
    readonly at: number;
}
/** Remember one settlement under its tool-call id (absent call ids cannot claim a result). */
export declare function recordAutoReviewSettle(store: Map<string, AutoReviewSettle>, callId: string | undefined, settle: AutoReviewSettle): void;
/**
 * Take and forget the settlement for one tool call; expired entries are pruned
 * first so a result arriving after the TTL never claims stale content.
 */
export declare function takeAutoReviewSettle(store: Map<string, AutoReviewSettle>, callId: string | undefined, now: number): AutoReviewSettle | undefined;
/** The model-facing sentence appended to the denied tool result. */
export declare function autoReviewNotice(toolName: string, reason: string): string;
/** Append the auto approval's content to the model-facing result content. */
export declare function withAutoReviewContent(content: readonly ContentBlock[], settle: AutoReviewSettle): ContentBlock[];
/** What the permission projection already recorded in a session log. */
export interface PermissionFacts {
    /** The session log was readable at all. */
    readonly readable: boolean;
    /** The session already started a turn (a resumed or user-driven session). */
    readonly turnStarted: boolean;
    /** The host (or a user) already recorded permission state. */
    readonly permissionState: boolean;
    /** The log carries the constructor-seed boundary of a seeded session. */
    readonly seeded: boolean;
}
/**
 * Fold the permission-relevant facts out of a session log. A session that
 * cannot expose its events is reported unreadable so the caller skips pinning
 * instead of overriding a restored selection it cannot see.
 */
export declare function readPermissionFacts(session: SessionLike | undefined): PermissionFacts;
/** Inputs for the default-preset decision. */
export interface DefaultPresetDecision {
    /** Configured preset name; '' means leave the session alone. */
    readonly configured: string;
    /** Preset the session currently resolves to. */
    readonly current: string;
    /** The host's deployment default preset. */
    readonly hostDefault: string;
    /** Permission facts folded from the session log. */
    readonly facts: PermissionFacts;
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
export declare function shouldPinDefaultPreset(decision: DefaultPresetDecision): boolean;
export declare function apply(ctx: Context, config: GateRuntimeConfig): void;
export {};
