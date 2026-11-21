/**
 * Git skill repository support for the utils-agents panel.
 *
 * The repository settings live inside the preset directory at
 * .dsh-utils/repo.json, so moving a preset moves its repository config with it.
 * Pasted deploy keys are the only secrets stored outside: the per-preset keys
 * and the panel-wide key live under $DSH_HOME/storages/dsh-utils-agents and are
 * never returned to the browser. The panel-wide key is the fallback for any
 * repository (including the shared skill repository) whose own key path and
 * stored key are absent, so one private Deploy Key can pull every private
 * repository the panel tracks.
 *
 * The sync is intentionally pull-only: a missing target is cloned, an existing
 * target must be a checkout of the same repository on the configured branch,
 * and the update is a fast-forward merge. Nothing is reset or pushed.
 *
 * @module dsh-utils/utils-agents/git
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Options, type PresetInfo, type RepoState, type TargetStatus } from './util.js';
/** One execFile result. */
export interface GitOutcome {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly spawnError: string | undefined;
}
/** How the SSH identity is resolved. */
export interface KeyStatus {
    readonly source: 'path' | 'stored' | 'global' | 'none';
    readonly file: string | undefined;
    readonly hasStoredKey: boolean;
}
/** A parsed repository URL. */
interface ParsedRepo {
    readonly kind: 'https' | 'http' | 'ssh' | 'scp' | 'file' | 'path';
    readonly raw: string;
    readonly isSsh: boolean;
    readonly host: string | undefined;
    readonly path: string;
    readonly canonical: string;
}
/** The full repository view returned to the browser. */
export interface RepoView {
    readonly state: RepoState;
    readonly target: string;
    readonly status: TargetStatus;
    readonly key: KeyStatus;
}
/** Read the per-preset repository state, filling defaults. */
export declare function readRepoState(preset: PresetInfo, options: Options): Promise<RepoState>;
/** Persist the per-preset repository state. */
export declare function saveRepoState(preset: PresetInfo, state: RepoState): Promise<void>;
/** Build the repository view: settings, target status and key source. */
export declare function repoView(ctx: Context, preset: PresetInfo, options: Options): Promise<RepoView>;
/** Save a new repository configuration after validation. */
export declare function saveRepoConfig(ctx: Context, preset: PresetInfo, options: Options, body: Record<string, unknown>): Promise<RepoView>;
/** Store a pasted deploy key; an empty string clears it. */
export declare function saveRepoKey(preset: PresetInfo, key: string): Promise<KeyStatus>;
/** Synchronize the configured repository into the preset skills directory. */
export declare function syncRepo(ctx: Context, preset: PresetInfo, options: Options): Promise<RepoView>;
/** Inspect the target checkout. */
export declare function targetStatus(ctx: Context, preset: PresetInfo, state: RepoState): Promise<TargetStatus>;
/** The SSH identity for one preset. */
export declare function keyStatus(preset: PresetInfo, state: RepoState): Promise<KeyStatus>;
/** The target checkout path; always inside preset/skills. */
export declare function targetPath(preset: PresetInfo, state: RepoState): string;
/** The panel-wide Deploy Key used when a repository has no key of its own. */
export declare function globalKeyPath(): string;
/** The panel-wide Deploy Key status; the key's content never leaves the host. */
export declare function globalKeyStatus(): Promise<KeyStatus>;
/** Store the panel-wide Deploy Key; an empty string clears it. */
export declare function saveGlobalKey(key: string): Promise<KeyStatus>;
/** Validate and normalize a repository URL. */
export declare function validateRepoUrl(raw: string): ParsedRepo;
/** Compare key for one repository URL. */
export declare function canonicalRepoUrl(raw: string): string;
/** Clone URL, rewritten to SSH when a key is present and the host supports it. */
export declare function cloneUrlFor(parsed: ParsedRepo, keyFile: string | undefined): string;
/** Validate a branch name. */
export declare function validateBranch(raw: string): string;
/** Validate the target folder under skills/. */
export declare function validateSubdir(raw: string): string;
/** Run one git command without a shell, with prompts disabled. */
export declare function runGit(args: string[], cwd: string | undefined, keyFile: string | undefined): Promise<GitOutcome>;
export {};
