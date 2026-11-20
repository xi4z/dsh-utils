/**
 * `dsh-utils` main component (`utils-main`), repository-sync half.
 *
 * `src/index.ts` applies this module, so the `utils-main` row owns both halves:
 * recursive `SKILL.md` discovery and the JSON routes behind the skill-repository
 * panel. The browser half is this package's `client.js`, served from the same
 * package-root row.
 *
 * The panel configures one Git repository (URL, branch, target directory, and an
 * optional deploy key). A sync clones a missing target or fast-forwards an
 * existing checkout of the same branch, then initializes submodules on a
 * best-effort basis; the target's nested `SKILL.md` files are picked up by
 * this component's discovery provider. Nothing is ever pushed.
 *
 * Routes and durable state keep the `dsh-utils-ui` names (the API paths, the
 * panel tab, and `$DSH_HOME/storages/dsh-utils-ui.json` plus an optional
 * `.deploy-key`) so a profile that mounted the former standalone UI host keeps
 * its saved settings after the merge. Both files are written atomically with
 * mode 600. The key's content never reaches a response, a log line, or a git
 * argument vector: git only ever receives its path through `GIT_SSH_COMMAND`.
 * Every command runs through `execFile` (never a shell) with terminal prompts
 * disabled and a bounded timeout.
 *
 * @module dsh-utils/ui-host
 */
import type { Context } from '@deepseek-ai/cordis';
/** Exact Connection routes owned by the sync panel. */
export declare const ROUTE_PATHS: {
    readonly status: "/api/dsh-utils-ui/status";
    readonly config: "/api/dsh-utils-ui/config";
    readonly key: "/api/dsh-utils-ui/key";
    readonly sync: "/api/dsh-utils-ui/sync";
};
/** GET: repository settings, target state, last sync. */
export declare const STATUS_PATH: "/api/dsh-utils-ui/status";
/** POST: replace the repository settings. */
export declare const CONFIG_PATH: "/api/dsh-utils-ui/config";
/** POST: store or clear the deploy key. */
export declare const KEY_PATH: "/api/dsh-utils-ui/key";
/** POST: clone or fast-forward the target. */
export declare const SYNC_PATH: "/api/dsh-utils-ui/sync";
/** Default repository: the public upstream of this machine's skill collection. */
export declare const DEFAULT_REPO_URL = "https://github.com/xi4z/skills";
/** Default branch: the Agent branch of that repository. */
export declare const DEFAULT_BRANCH = "Agent";
/** One recorded sync attempt, persisted as lastSync. */
export interface SyncRecord {
    readonly at: string;
    readonly ok: boolean;
    readonly commit: string;
    readonly skills: number;
    readonly message: string;
}
/** The durable panel configuration and the last sync outcome. */
export interface SyncState {
    repoUrl: string;
    branch: string;
    keyPath: string;
    targetDir: string;
    recurseSubmodules: boolean;
    lastSync: SyncRecord | null;
}
/** Where the SSH identity comes from, as the panel displays it. */
export type KeySource = 'path' | 'stored' | 'none';
/** How a repository URL is addressed. */
export type RepoKind = 'https' | 'http' | 'ssh' | 'scp' | 'file' | 'path';
/** One parsed repository URL: normalized fields plus a comparison key. */
export interface ParsedRepo {
    readonly kind: RepoKind;
    readonly raw: string;
    readonly isSsh: boolean;
    readonly host: string | undefined;
    readonly path: string;
    readonly canonical: string;
}
/**
 * Activate the host half: register the four panel routes when this deployment
 * provides a Connection. A non-web host simply has no routes.
 * @param ctx - host Cordis context.
 */
export declare function applyUiHost(ctx: Context): void;
/**
 * Pick the URL git should actually use. With a deploy key present, an HTTPS URL
 * on a well-known host becomes its SSH form; every other URL is used verbatim.
 * @param repoUrl - configured repository URL.
 * @param hasKey - whether an SSH identity is available.
 * @returns the URL passed to git.
 */
export declare function cloneUrlFor(repoUrl: string, hasKey: boolean): string;
/**
 * Canonical comparison key for a repository URL, tolerant of the common .git
 * suffix, scheme (https vs ssh), host case, and trailing slashes.
 * @param raw - any repository URL.
 * @returns the canonical form; unparseable input falls back to a lowercased trim.
 */
export declare function canonicalRepoUrl(raw: string): string;
