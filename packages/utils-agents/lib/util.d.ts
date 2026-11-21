/**
 * Shared utilities for the utils-agents panel.
 *
 * This component merges three former sidebar surfaces:
 * the preset skill list, the per-preset Git skill repository, and the Markdown
 * editor. All filesystem access is funneled through the helpers here so the
 * route handlers can stay small and the path rules stay in one place.
 *
 * @module dsh-utils/utils-agents/util
 */
import type { Context } from '@deepseek-ai/cordis';
/** Absolute ceiling for one request body. */
export declare const BODY_LIMIT_BYTES: number;
/** Default per-file read/write limit. */
export declare const DEFAULT_MAX_BYTES: number;
/** The pseudo preset that edits the user/project AGENTS.md chain. */
export declare const GLOBAL_PRESET = "__global__";
/** Directory names never entered while scanning preset Markdown or skills. */
export declare const IGNORED_DIRS: Set<string>;
/** Project-level instruction file names, matching the shipped loader. */
export declare const AGENTS_CANDIDATES: readonly ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"];
/** Volatile Config fields arrive as live references; get() snapshots. */
export interface VolatileRef<T> {
    get(): T;
}
/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
export type MaybeRef<T> = T | VolatileRef<T>;
/** Raw row config accepted by the component. */
export interface AgentsConfig {
    readonly maxBytes?: MaybeRef<number>;
    readonly presetDirs?: MaybeRef<readonly string[]>;
    readonly presetSourceDirs?: MaybeRef<readonly string[]>;
    readonly builtinPresets?: MaybeRef<readonly string[]>;
    readonly extraAgentsFiles?: MaybeRef<readonly string[]>;
    readonly scanNestedAgents?: MaybeRef<boolean>;
    readonly nestedDepth?: MaybeRef<number>;
    readonly defaultRepoUrl?: MaybeRef<string>;
    readonly defaultBranch?: MaybeRef<string>;
}
/** Normalized settings with defaults applied. */
export interface Options {
    readonly maxBytes: number;
    readonly presetDirs: string[];
    readonly presetSourceDirs: string[];
    readonly builtinPresets: string[];
    readonly extraAgentsFiles: string[];
    readonly scanNestedAgents: boolean;
    readonly nestedDepth: number;
    readonly defaultRepoUrl: string;
    readonly defaultBranch: string;
}
/** One command failure with the HTTP status it should answer with. */
export declare class AgentsError extends Error {
    readonly status: number;
    /**
     * @param message - user-facing, sanitized message.
     * @param status - HTTP status the route answers with.
     */
    constructor(message: string, status: number);
}
/** One skill inside a preset skills directory. */
export interface SkillRow {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly enabled: boolean;
    readonly size: number;
    readonly mtimeMs: number | null;
}
/** One file the Markdown view can open. */
export interface FileRow {
    readonly id: string;
    readonly label: string;
    readonly path: string;
    readonly presetId: string;
    readonly kind: 'agents' | 'skill' | 'reference' | 'global';
    readonly scope?: string;
    readonly exists: boolean;
    readonly editable: boolean;
    readonly size: number;
    readonly mtimeMs: number | null;
}
/** One preset directory as the panel lists it. */
export interface PresetInfo {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly skills: SkillRow[];
    readonly agents: FileRow;
    readonly registered?: boolean;
    readonly broken?: string;
}
/** One recorded sync attempt. */
export interface SyncRecord {
    readonly at: string;
    readonly ok: boolean;
    readonly commit: string;
    readonly skills: number;
    readonly message: string;
}
/** Durable per-preset repository configuration. */
export interface RepoState {
    repoUrl: string;
    branch: string;
    targetSubdir: string;
    keyPath: string;
    recurseSubmodules: boolean;
    lastSync: SyncRecord | null;
}
/** The target checkout as the repo view reports it. */
export interface TargetStatus {
    exists: boolean;
    isRepo: boolean;
    branch: string | null;
    commit: string | null;
    dirty: boolean;
    skills: number;
}
/** Normalize the volatile row settings once per request. */
export declare function normalizeOptions(config: AgentsConfig | undefined): Options;
/**
 * Snapshot one live Config field.
 * @param value - plain value or volatile reference.
 * @param fallback - default.
 * @returns the plain value.
 */
export declare function refValue<T>(value: MaybeRef<T> | undefined, fallback: T): T;
/** Trim, drop empty entries, and de-duplicate one string list. */
export declare function stringList(value: unknown): string[];
/** $DSH_HOME, falling back to ~/.dsh. */
export declare function dshHome(): string;
/** $DSH_AGENTS_HOME, falling back to ~/.agents. */
export declare function agentsHome(): string;
/** $DSH_HOME/storages/dsh-utils-agents. */
export declare function agentsStorageDir(): string;
/** All configured preset roots, defaults first. */
export declare function presetRoots(options: Options): string[];
/** Stable storage name for one preset id. */
export declare function presetStorageName(id: string): string;
/**
 * Expand a configured path to an absolute path.
 * @param raw - configured value; ~ and $VAR / braced VAR are expanded.
 * @returns absolute path.
 */
export declare function expandAbsolute(raw: string): string;
/** Join a relative path under a root and refuse escapes. */
export declare function insideJoin(root: string, rel: string): string;
/** Whether a path is strictly inside a directory. */
export declare function isInside(parent: string, child: string): boolean;
/** Whether a directory exists and is a directory. */
export declare function directoryOf(path: string): Promise<boolean>;
/** Whether any path exists (file, directory, or symlink). */
export declare function exists(path: string): Promise<boolean>;
/** Recursively collect paths under one directory with a depth bound. */
export declare function walkFiles(dir: string, depth: number, ignored: Set<string>, visit: (path: string) => void, ctx: Context): Promise<void>;
/** Build one file row for an existing or missing path. */
export declare function fileRow(id: string, label: string, path: string, presetId: string, kind: FileRow['kind']): Promise<FileRow>;
/** Read one file, refusing oversized files and non-regular files. */
export declare function readTextFile(path: string, maxBytes: number): Promise<{
    content: string;
    row: FileRow;
}>;
/**
 * Write one file atomically, preserving mode and detecting a stale browser
 * copy. A missing file is created when baseMtimeMs is null.
 */
export declare function writeTextFile(path: string, content: string, baseMtimeMs: number | null, maxBytes: number): Promise<{
    bytes: number;
    mtimeMs: number | null;
}>;
/** Parse one buffered JSON request body, with a size cap. */
export declare function readJsonBody(request: Request): Promise<unknown>;
/** Trimmed non-empty text, or null. */
export declare function optionalText(value: string | null | undefined): string | null;
/** Required trimmed text. */
export declare function requiredText(value: unknown, message: string): string;
/** Build one JSON response. */
export declare function json(value: unknown, status: number): Response;
/** Map an error to the route's JSON failure shape. */
export declare function failure(ctx: Context, action: string, error: unknown): Response;
/** Render an unknown error for a log line or route payload. */
export declare function errorMessage(error: unknown): string;
/** Resolve the session working directory with the same fallbacks as the skill panel. */
export declare function resolveCwd(ctx: Context, sessionId: string | null, signal: AbortSignal): Promise<string>;
/** The preset id recorded on the live session, when the host exposes it. */
export declare function sessionPresetOf(ctx: Context, sessionId: string | null): string | null;
/** Read one host service defensively. */
export declare function serviceOf(ctx: Context, name: string): Record<string, any> | undefined;
/** Resolve a live Agent for a session id. */
export declare function agentOf(ctx: Context, sessionId: string): Record<string, any> | undefined;
/** Project root: the nearest ancestor holding .git, else the working directory. */
export declare function findProjectRoot(cwd: string): Promise<string>;
/** Directories from the project root down to the working directory. */
export declare function projectChain(root: string, cwd: string): string[];
/** Human-readable scope label for one directory. */
export declare function scopeOf(dir: string, cwd: string, root: string): string;
/** Base64url encode one id component. */
export declare function encodeIdPart(value: string): string;
/** Decode one id component, rejecting non-canonical spellings. */
export declare function decodeIdPart(value: string): string;
