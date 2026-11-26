/**
 * `dsh-utils` notify component: push a message through a Gotify gateway when a
 * session finishes a turn, or when the agent is blocked on an approval or a
 * question.
 *
 * The gateway is addressed by URL, so the component works from any machine that
 * can reach it over the internet: one device token, one app token, no local
 * NapCat/OneBot service required. Every message carries the sending device's
 * name so multiple machines sharing one gateway stay distinguishable.
 *
 * Wiring (all read from the session log, never from a waterfall the root
 * context cannot receive):
 *
 *   session/event    -> accumulate the finished turn's reason + final assistant text
 *   agent/status     -> the idle edge is the moment the whole task is done
 *   tool/call        -> ask_user_question / exit_plan_mode is the "parked waiting
 *                       for a human" signal, debounced; tool/result cancels it
 *   approval/asked   -> the agent is blocked on a yes/no decision, debounced;
 *                       approval/decided (auto-decided) cancels it
 *
 * Delivery is plain `fetch` to `POST {gotifyUrl}/message`; no WebSocket, no
 * heartbeat, no extra dependency. The legacy OneBot path is kept for
 * compatibility but Gotify is the default outlet.
 *
 * The bundle mounts this component under the entry id `dsh-notify`
 * (`dsh-utils/notify`); that entry id is also its settings namespace, so the
 * browser half renders a live configuration page for it. Every Config field is
 * volatile: the component re-reads the values on each event, so a save in the
 * settings page takes effect without a restart.
 *
 * Ported from `@local/dsh-plugin-qq-notify` 0.2.0 — same message
 * templates, same `DSH_QQ_NOTIFY_*` overrides for non-secret fields, same
 * delivery semantics — with the settings schema, live config reads, and the
 * `dsh-utils` bundle wiring added. `gotifyToken` is the one deliberate
 * exception: an explicit write-only secret (`role('secret')`), never expanded
 * from the environment.
 *
 * @module dsh-utils/notify
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-notify";
export declare const inject: string[];
/** Turn-end reasons a deployment may subscribe to. */
export declare const NOTIFY_REASONS: readonly ["completed", "error", "aborted", "blocked"];
export type NotifyReason = (typeof NOTIFY_REASONS)[number];
/** One delivery target: an independent gateway credential / series. */
export interface NotifyTarget {
    readonly name: string;
    readonly url: string;
    readonly token: string;
    readonly priority: number;
    readonly devices: readonly string[];
}
/**
 * Settings-page schema. Every key is volatile: the Loader hands `apply` live
 * references and the component re-reads them on use, so the configuration page
 * writes take effect immediately.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    transport: z<"gotify" | "onebot", "gotify" | "onebot", "volatile-defined">;
    endpoint: z<string, string, "volatile-defined">;
    token: z<string, string, "volatile-defined">;
    targetType: z<"private" | "group", "private" | "group", "volatile-defined">;
    targetId: z<string, string, "volatile-defined">;
    gotifyUrl: z<string, string, "volatile-defined">;
    gotifyToken: z<string, string | undefined, "volatile">;
    gotifyPriority: z<number, number, "volatile-defined">;
    gotifyHeaders: z<any, any, "volatile-defined">;
    targets: z<any, any, "volatile-defined">;
    deviceName: z<string, string, "volatile-defined">;
    deviceLabel: z<string, string, "volatile-defined">;
    deviceInTitle: z<boolean, boolean, "volatile-defined">;
    notifyOnReasons: z<NoInfer<("completed" | "error" | "aborted" | "blocked")[]>, NoInfer<("completed" | "error" | "aborted" | "blocked")[]>, "volatile-defined">;
    notifyOnApproval: z<boolean, boolean, "volatile-defined">;
    notifyOnQuestion: z<boolean, boolean, "volatile-defined">;
    questionDelayMs: z<number, number, "volatile-defined">;
    approvalDelayMs: z<number, number, "volatile-defined">;
    includeSubagents: z<boolean, boolean, "volatile-defined">;
    summaryChars: z<number, number, "volatile-defined">;
    timeoutMs: z<number, number, "volatile-defined">;
    dryRun: z<boolean, boolean, "volatile-defined">;
    traceFile: z<string, string, "volatile-defined">;
    template: z<string, string, "volatile-defined">;
    questionTemplate: z<string, string, "volatile-defined">;
    approvalTemplate: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    transport: z<"gotify" | "onebot", "gotify" | "onebot", "volatile-defined">;
    endpoint: z<string, string, "volatile-defined">;
    token: z<string, string, "volatile-defined">;
    targetType: z<"private" | "group", "private" | "group", "volatile-defined">;
    targetId: z<string, string, "volatile-defined">;
    gotifyUrl: z<string, string, "volatile-defined">;
    gotifyToken: z<string, string | undefined, "volatile">;
    gotifyPriority: z<number, number, "volatile-defined">;
    gotifyHeaders: z<any, any, "volatile-defined">;
    targets: z<any, any, "volatile-defined">;
    deviceName: z<string, string, "volatile-defined">;
    deviceLabel: z<string, string, "volatile-defined">;
    deviceInTitle: z<boolean, boolean, "volatile-defined">;
    notifyOnReasons: z<NoInfer<("completed" | "error" | "aborted" | "blocked")[]>, NoInfer<("completed" | "error" | "aborted" | "blocked")[]>, "volatile-defined">;
    notifyOnApproval: z<boolean, boolean, "volatile-defined">;
    notifyOnQuestion: z<boolean, boolean, "volatile-defined">;
    questionDelayMs: z<number, number, "volatile-defined">;
    approvalDelayMs: z<number, number, "volatile-defined">;
    includeSubagents: z<boolean, boolean, "volatile-defined">;
    summaryChars: z<number, number, "volatile-defined">;
    timeoutMs: z<number, number, "volatile-defined">;
    dryRun: z<boolean, boolean, "volatile-defined">;
    traceFile: z<string, string, "volatile-defined">;
    template: z<string, string, "volatile-defined">;
    questionTemplate: z<string, string, "volatile-defined">;
    approvalTemplate: z<string, string, "volatile-defined">;
}>>, "plain">;
/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
    get(): T;
}
/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>;
/** The runtime shape `apply` receives (every field volatile, every field optional). */
export interface NotifyConfig {
    readonly enabled?: MaybeRef<boolean>;
    readonly transport?: MaybeRef<string>;
    readonly endpoint?: MaybeRef<string>;
    readonly token?: MaybeRef<string>;
    readonly targetType?: MaybeRef<string>;
    readonly targetId?: MaybeRef<string>;
    readonly gotifyUrl?: MaybeRef<string>;
    readonly gotifyToken?: MaybeRef<string>;
    readonly gotifyPriority?: MaybeRef<number>;
    readonly gotifyHeaders?: MaybeRef<unknown>;
    readonly targets?: MaybeRef<unknown>;
    readonly deviceName?: MaybeRef<string>;
    readonly deviceLabel?: MaybeRef<string>;
    readonly deviceInTitle?: MaybeRef<boolean>;
    readonly notifyOnReasons?: MaybeRef<readonly string[]>;
    readonly notifyOnApproval?: MaybeRef<boolean>;
    readonly notifyOnQuestion?: MaybeRef<boolean>;
    readonly questionDelayMs?: MaybeRef<number>;
    readonly approvalDelayMs?: MaybeRef<number>;
    readonly includeSubagents?: MaybeRef<boolean>;
    readonly summaryChars?: MaybeRef<number>;
    readonly timeoutMs?: MaybeRef<number>;
    readonly dryRun?: MaybeRef<boolean>;
    readonly traceFile?: MaybeRef<string>;
    readonly template?: MaybeRef<string>;
    readonly questionTemplate?: MaybeRef<string>;
    readonly approvalTemplate?: MaybeRef<string>;
}
/** Normalized options with every default applied. */
interface Options {
    enabled: boolean;
    transport: 'gotify' | 'onebot';
    endpoint: string;
    token: string;
    targetType: 'private' | 'group';
    targetId: string;
    gotifyUrl: string;
    gotifyToken: string;
    gotifyPriority: number;
    gotifyHeaders: Readonly<Record<string, string>>;
    targets: readonly NotifyTarget[];
    deviceName: string;
    deviceLabel: string;
    deviceInTitle: boolean;
    notifyOnReasons: readonly NotifyReason[];
    notifyOnApproval: boolean;
    notifyOnQuestion: boolean;
    questionDelayMs: number;
    approvalDelayMs: number;
    includeSubagents: boolean;
    summaryChars: number;
    timeoutMs: number;
    dryRun: boolean;
    traceFile: string;
    template: string;
    questionTemplate: string;
    approvalTemplate: string;
}
/**
 * Expand `${NAME}` and `${NAME:-fallback}` references against the process
 * environment, so a deployment can keep gateway secrets outside the patch file.
 * An unset or blank variable expands to the fallback (or to ''), leaving the
 * target without a token instead of sending the literal reference.
 */
export declare function expandEnv(value: unknown): string;
/** One repaired token plus a human-readable list of what was changed. */
export interface TokenRepair {
    readonly value: string;
    readonly notes: readonly string[];
    readonly changed: boolean;
}
/**
 * Repair a pasted token before it reaches an HTTP header.
 *
 * A full-width character (`。` left by a Chinese IME, `（`, `：`, …) cannot be
 * encoded into a header at all: `fetch` throws `Cannot convert argument to a
 * ByteString` before a single byte leaves the process, so every notification
 * fails and only the server log explains why. Gateway tokens are ASCII, so this
 * trims, drops invisible characters and wrapping quotes, converts full-width
 * ASCII and CJK punctuation to their ASCII form, removes inner whitespace, and
 * restores the scheme prefix (`gtfya` / `gtfyc`) to its canonical lower-case
 * form with its separator dot. Whatever is still outside printable ASCII is
 * reported by {@link tokenProblem} so delivery can skip that target with a
 * clear warning instead of failing inside `fetch`.
 */
export declare function normalizeToken(raw: unknown): TokenRepair;
/**
 * The first reason this token cannot go into an HTTP header, or `undefined`
 * when it is printable ASCII. The position and code point are enough to fix the
 * paste without writing the secret itself into a log.
 */
export declare function tokenProblem(token: string): string | undefined;
/** Keep only string/number request headers; ignore everything else. */
export declare function normalizeHeaders(raw: unknown): Record<string, string>;
/**
 * Normalize `targets` into a predictable list; bad entries are dropped.
 * A target with only one of url/token is kept so delivery can warn about the
 * exact target name instead of silently disappearing.
 */
export declare function normalizeTargets(raw: unknown, fallbackPriority?: number): NotifyTarget[];
/** A target with no `devices` list applies everywhere; otherwise match name or label. */
export declare function targetMatchesDevice(target: NotifyTarget, cfg: Pick<Options, 'deviceName' | 'deviceLabel'>): boolean;
/**
 * Resolve the live Config into one concrete option set: defaults, then the
 * settings values, then the environment overrides (so a deployment can keep
 * secrets out of the patch file).
 */
export declare function normalizeOptions(config: NotifyConfig | undefined): Options;
/**
 * Turn assistant Markdown into a short plain-text snippet for the gateway.
 *
 * Fenced code blocks are dropped entirely (they are long and unreadable once
 * flattened); inline code keeps its text; emphasis markers, headings, list
 * bullets, table pipes and HTML tags are removed. Single underscores are left
 * alone so `session_id` survives. The result is then cut at `limit`, preferring
 * a sentence boundary when one is reasonably close to the end.
 */
export declare function plain(text: unknown, limit?: number): string;
/** One question parsed out of an `ask_user_question` tool call. */
export interface ParsedQuestion {
    readonly question: string;
    readonly detail?: string;
    readonly header?: string;
    readonly options: readonly string[];
}
/** Parse `ask_user_question` tool arguments defensively (older logs, odd providers). */
export declare function parseQuestions(raw: unknown): ParsedQuestion[];
/** Parse `exit_plan_mode` tool arguments into the reviewed plan text. */
export declare function parsePlan(raw: unknown): string | undefined;
/**
 * Fill a template. A line containing only a label whose value is empty
 * (`目录: ` / `回复: `) is dropped, so one template serves every outcome.
 */
export declare function fill(template: string, values: Readonly<Record<string, unknown>>): string;
/** Default turn-end template. */
export declare const DEFAULT_TEMPLATE: string;
/** Default question template. */
export declare const DEFAULT_QUESTION_TEMPLATE: string;
/** Default approval template. */
export declare const DEFAULT_APPROVAL_TEMPLATE: string;
/** Inputs for a turn-end message. */
export interface TurnMessageInput {
    readonly sessionId: unknown;
    readonly cwd?: string;
    readonly reason?: string;
    readonly error?: string;
    readonly reply?: string;
    readonly summaryChars?: number;
    readonly template?: string;
    readonly device?: string;
    readonly host?: string;
}
/** Compact body of a turn-completion message. */
export declare function renderMessage(input: TurnMessageInput): string;
/** Inputs for a question-request message. */
export interface QuestionMessageInput {
    readonly sessionId: unknown;
    readonly cwd?: string;
    readonly question?: string;
    readonly detail?: string;
    readonly options?: string;
    readonly template?: string;
    readonly device?: string;
    readonly host?: string;
}
/** Compact body of a question-request message (the agent is blocked on you). */
export declare function renderQuestionMessage(input: QuestionMessageInput): string;
/** Inputs for an approval-request message. */
export interface ApprovalMessageInput {
    readonly sessionId: unknown;
    readonly cwd?: string;
    readonly toolName?: string;
    readonly reason?: string;
    readonly template?: string;
    readonly device?: string;
    readonly host?: string;
}
/** Compact body of an approval-request message. */
export declare function renderApprovalMessage(input: ApprovalMessageInput): string;
/** The OneBot endpoint slice `callAction` needs. */
export interface OneBotEndpoint {
    readonly endpoint: string;
    readonly token: string;
    readonly timeoutMs: number;
}
/** POST one OneBot 11 action; throws on transport failure or a non-ok retcode. */
export declare function callAction(cfg: OneBotEndpoint, action: string, body: unknown): Promise<unknown>;
/**
 * Activate the component.
 * @param ctx - host Cordis context.
 * @param config - row config from cordis.patch.yml or the settings document;
 *   volatile fields arrive as live references.
 */
export declare function apply(ctx: Context, config?: NotifyConfig): void;
export {};
