/**
 * Shared skill repository support for the utils-agents panel.
 *
 * The repository configured here is the tracked skills checkout: the panel
 * clones or fast-forwards it with an optional Deploy Key, the shared preset
 * scanner reads ".dsh/preset" from that checkout, and Skill discovery scans it
 * recursively from its own root. When the shared repository has no key path
 * and no key of its own, the panel-wide Deploy Key from git.js is used, so a
 * private skills checkout pulls without extra setup.
 *
 * Settings live in the consolidated document
 * `$DSH_HOME/utils/utils.json` (see utils-config.ts); the old
 * `storages/dsh-utils-ui.json` document is migrated on first read. The pasted
 * key intentionally keeps its former path (`dsh-utils-ui.deploy-key`), so an
 * upgraded profile keeps its repository and key.
 *
 * A timer (skill-repo-updater.ts) calls {@link updateSkillRepositories}: it
 * fast-forwards every configured checkout and refreshes its submodules, but
 * never merges over a dirty working tree and never resets or pushes.
 *
 * @module dsh-utils/utils-agents/global-repo
 */
import type { Context } from '@deepseek-ai/cordis';
import { type KeyStatus } from './git.js';
import { type Options } from './util.js';
import { type SkillRepositoryConfig } from './utils-config.js';
/** Durable settings for one shared skill repository. */
export type SharedRepoState = SkillRepositoryConfig;
/** Checkout status for the shared skill repository. */
export interface SharedRepoTarget {
    exists: boolean;
    isRepo: boolean;
    branch: string | null;
    commit: string | null;
    dirty: boolean;
    skills: number;
}
/** The full repository view returned to the browser. */
export interface SharedRepoView {
    state: SharedRepoState;
    target: SharedRepoTarget;
    key: KeyStatus;
}
/** How one automatic refresh ended. */
export interface SkillRepositoryUpdate {
    readonly targetDir: string;
    readonly repoUrl: string;
    readonly ok: boolean;
    readonly changed: boolean;
    readonly skipped: boolean;
    readonly message: string;
}
/** Read the shared repository settings, filling defaults. */
export declare function readSharedRepoState(options: Options): Promise<SharedRepoState>;
/** Read the shared repository settings plus checkout and key status. */
export declare function sharedRepoView(ctx: Context, options: Options): Promise<SharedRepoView>;
/** Save new shared repository settings after validation. */
export declare function saveSharedRepoConfig(ctx: Context, options: Options, body: Record<string, unknown>): Promise<SharedRepoView>;
/** Store a pasted Deploy Key; an empty string clears it. */
export declare function saveSharedRepoKey(ctx: Context, options: Options, key: string): Promise<SharedRepoView>;
/** Clone or fast-forward the shared repository with the configured key. */
export declare function pullSharedRepo(ctx: Context, options: Options): Promise<SharedRepoView>;
/**
 * Refresh every configured Skill repository and its submodules.
 *
 * This is the timer's entry point: best-effort per repository, never over a
 * dirty working tree, and failures are reported instead of thrown.
 * @param ctx - plugin context for warnings.
 * @returns one result per configured repository.
 */
export declare function updateSkillRepositories(ctx: Context): Promise<SkillRepositoryUpdate[]>;
/** The legacy deploy-key path shared with the old global route. */
export declare function sharedStoredKeyPath(): string;
/** The SSH identity for the shared repository. */
export declare function sharedKeyStatus(state: SharedRepoState): Promise<KeyStatus>;
