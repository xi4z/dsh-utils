import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types';
export declare const name = "dsh-approval-qq";
/** Settings-page schema. Every key is volatile: reads are live on each request. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    relayUrl: z<string, string, "volatile-defined">;
    sharedKey: z<string, string, "volatile-defined">;
    deviceLabel: z<string, string, "volatile-defined">;
    sendDelayMs: z<number, number, "volatile-defined">;
    pollWaitSeconds: z<number, number, "volatile-defined">;
    timeoutMs: z<number, number, "volatile-defined">;
    includeSubagents: z<boolean, boolean, "volatile-defined">;
    dryRun: z<boolean, boolean, "volatile-defined">;
    allowReceipt: z<string, string, "volatile-defined">;
    denyReceipt: z<string, string, "volatile-defined">;
    translateEnglish: z<boolean, boolean, "volatile-defined">;
    translateTimeoutMs: z<number, number, "volatile-defined">;
    translateProvider: z<string, string, "volatile-defined">;
    translateModel: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    relayUrl: z<string, string, "volatile-defined">;
    sharedKey: z<string, string, "volatile-defined">;
    deviceLabel: z<string, string, "volatile-defined">;
    sendDelayMs: z<number, number, "volatile-defined">;
    pollWaitSeconds: z<number, number, "volatile-defined">;
    timeoutMs: z<number, number, "volatile-defined">;
    includeSubagents: z<boolean, boolean, "volatile-defined">;
    dryRun: z<boolean, boolean, "volatile-defined">;
    allowReceipt: z<string, string, "volatile-defined">;
    denyReceipt: z<string, string, "volatile-defined">;
    translateEnglish: z<boolean, boolean, "volatile-defined">;
    translateTimeoutMs: z<number, number, "volatile-defined">;
    translateProvider: z<string, string, "volatile-defined">;
    translateModel: z<string, string, "volatile-defined">;
}>>, "plain">;
/** Volatile Config fields arrive as live references; .get() snapshots. */
interface VolatileRef<T> {
    get(): T;
}
/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>;
/** The runtime shape apply receives (every field volatile, every field optional). */
export interface ApprovalQqConfig {
    readonly enabled?: MaybeRef<boolean>;
    readonly relayUrl?: MaybeRef<string>;
    readonly sharedKey?: MaybeRef<string>;
    readonly deviceLabel?: MaybeRef<string>;
    readonly sendDelayMs?: MaybeRef<number>;
    readonly pollWaitSeconds?: MaybeRef<number>;
    readonly timeoutMs?: MaybeRef<number>;
    readonly includeSubagents?: MaybeRef<boolean>;
    readonly dryRun?: MaybeRef<boolean>;
    readonly allowReceipt?: MaybeRef<string>;
    readonly denyReceipt?: MaybeRef<string>;
    readonly translateEnglish?: MaybeRef<boolean>;
    readonly translateTimeoutMs?: MaybeRef<number>;
    readonly translateProvider?: MaybeRef<string>;
    readonly translateModel?: MaybeRef<string>;
}
/** Normalized options with every default applied. */
export interface ResolvedOptions {
    enabled: boolean;
    relayUrl: string;
    sharedKey: string;
    deviceLabel: string;
    sendDelayMs: number;
    pollWaitSeconds: number;
    timeoutMs: number;
    includeSubagents: boolean;
    dryRun: boolean;
    allowReceipt: string;
    denyReceipt: string;
    translateEnglish: boolean;
    translateTimeoutMs: number;
    translateProvider: string;
    translateModel: string;
}
/** Structural logger slice (matches the host logger without importing it). */
export interface Logger {
    info(format: unknown, ...param: unknown[]): void;
    warn(format: unknown, ...param: unknown[]): void;
    debug?(format: unknown, ...param: unknown[]): void;
}
/** The read-only view approval-policy publishes on the cordis context. */
export interface ApprovalPolicyInfo {
    describe(agent: unknown, sessionId: string): {
        gated: boolean;
        windowMs: number;
        defaultOutcome: 'rejected' | 'unavailable';
    };
}
/** Structural session/agent/request slices, mirroring dsh types without importing them. */
interface SessionEventLike {
    readonly type?: string;
    readonly data?: {
        readonly callId?: unknown;
        readonly arguments?: unknown;
    };
}
interface SessionLike {
    readonly header?: {
        readonly cwd?: string;
        readonly origin?: string;
    };
    readonly events?: readonly SessionEventLike[];
}
interface AgentLike {
    readonly id?: unknown;
    readonly session?: SessionLike;
}
export interface ApprovalRequestLike {
    readonly agent: AgentLike;
    readonly toolName: string;
    readonly callId?: unknown;
    readonly reason?: string;
    readonly signal?: AbortSignal;
}
/** Expand name / name-with-fallback environment references in a setting. */
export declare function expandEnv(value: unknown): string;
/** Resolve the live config into one concrete option set. */
export declare function resolveOptions(config: ApprovalQqConfig | undefined): ResolvedOptions;
/** Human-readable remaining time for the countdown line. */
export declare function formatDuration(ms: number): string;
/** One deadline line: countdown plus the wall-clock deadline. */
export declare function deadlineLine(input: {
    remainingMs: number;
    defaultOutcome: 'rejected' | 'unavailable';
    now?: number;
}): string;
/** Inputs for an approval card. */
export interface ApprovalCardInput {
    readonly sessionId: string;
    readonly cwd?: string;
    readonly device?: string;
    readonly toolName: string;
    readonly command?: string;
    readonly reason?: string;
    readonly gated: boolean;
    readonly remainingMs?: number;
    readonly defaultOutcome?: 'rejected' | 'unavailable';
    readonly now?: number;
}
/** Render the markdown body of an approval card (the relay adds the keyboard). */
export declare function renderApprovalCard(input: ApprovalCardInput): string;
/** Find the gated command from the session log by tool-call id. */
export declare function commandOf(request: ApprovalRequestLike): string | undefined;
/** One relay long-poll result. */
export type RelayState = {
    state: 'pending';
} | {
    state: 'clicked';
    choice: 'allow' | 'deny';
} | {
    state: 'closed';
    reason?: string;
    outcome?: string;
};
/** The relay client slice the answerer needs (injectable for tests). */
export interface RelayClient {
    create(input: {
        askId: string;
        markdown: string;
        device?: string;
    }): Promise<{
        messageId?: string;
    }>;
    wait(askId: string, waitSeconds: number, signal?: AbortSignal): Promise<RelayState>;
    settle(askId: string, body: {
        outcome: 'allowed-once' | 'rejected' | 'ignored';
        reason?: string;
        receipt?: string;
    }): Promise<void>;
}
/**
 * Build the HTTP client for the relay approval endpoints.
 *
 * baseUrl ends in /approval; endpoints are base, base/askId and
 * base/askId/settle.
 */
export declare function createRelayClient(options: {
    baseUrl: string;
    key: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
}): RelayClient;
/** Generate a 128-bit ask id (hex). */
export declare function randomAskId(): string;
/** What an answerer needs; everything injectable so the race is unit-testable. */
export interface AnswererDeps {
    config: () => ResolvedOptions;
    policyInfo?: () => ApprovalPolicyInfo | undefined;
    relay: (cfg: ResolvedOptions) => RelayClient | undefined;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    randomId?: () => string;
    log?: Logger;
    /** Translate an English reason; undefined keeps the source text. */
    translate?: (text: string, budgetMs: number, signal?: AbortSignal) => Promise<string | undefined>;
}
/**
 * Build the approval/request answerer.
 *
 * Flow: read the gate window -> call next() immediately (the GUI/downstream
 * chain starts and the window clock ticks) -> debounce -> send the card ->
 * race downstream / click / abort -> settle the relay accordingly.
 */
export declare function createAnswerer(deps: AnswererDeps): (request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>;
/**
 * Activate the component.
 * @param ctx - host Cordis context.
 * @param config - row config; volatile fields arrive as live references.
 */
export declare function apply(ctx: Context, config?: ApprovalQqConfig): void;
export {};
