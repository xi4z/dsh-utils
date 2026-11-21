/**
 * Shared skill repository support for the utils-agents panel.
 *
 * The repository configured here is the tracked skills checkout: the panel
 * clones or fast-forwards it with an optional Deploy Key, and the shared
 * preset scanner reads ".dsh/preset" from that checkout. When the shared
 * repository has no key path and no key of its own, the panel-wide Deploy Key
 * from git.js is used, so a private skills checkout pulls without extra setup. Settings and the
 * pasted key intentionally reuse the legacy global route's storage
 * ($DSH_HOME/storages/dsh-utils-ui.json and dsh-utils-ui.deploy-key), so both
 * surfaces describe the same repository and never fight over the same files.
 *
 * @module dsh-utils/utils-agents/global-repo
 */
import type { Context } from '@deepseek-ai/cordis';
import { type KeyStatus } from './git.js';
import { type Options, type SyncRecord } from './util.js';
/** Durable settings for the shared skill repository. */
export interface SharedRepoState {
    repoUrl: string;
    branch: string;
    targetDir: string;
    keyPath: string;
    recurseSubmodules: boolean;
    lastSync: SyncRecord | null;
}
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
/** The legacy state path shared with the old global route. */
export declare function sharedRepoStatePath(): string;
/** The legacy deploy-key path shared with the old global route. */
export declare function sharedStoredKeyPath(): string;
/** The SSH identity for the shared repository. */
export declare function sharedKeyStatus(state: SharedRepoState): Promise<KeyStatus>;
