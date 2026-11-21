/**
 * Published-version checks for the dsh-utils bundle itself.
 *
 * The panel can tell the user whether a newer `@xi4z/dsh-utils` exists than the
 * version this component runs from, and can install it automatically. Where it
 * asks depends on how the bundle was installed in the profile:
 *
 * - a registry spec asks the npm `latest` document (one GET);
 * - a GitHub spec reads the repository's `package.json` on that ref
 *   (`raw.githubusercontent.com`, no token needed for public repositories),
 *   and a branch/tag install is re-added by `pnpm add <spec>`;
 * - a `link:`/`file:`/unknown install has no remote to install, so the npm
 *   answer is shown for reference only and nothing is ever installed.
 *
 * The automatic check runs shortly after activation and then every
 * `updateCheckIntervalHours` (default 6). A manual "检查更新" asks immediately.
 * With `updateAutoInstall` (default on) an available update is installed in the
 * background, then reported as "installed, restart to apply": replacing a
 * running plugin's files cannot take effect inside this process.
 *
 * The answer is cached in $DSH_HOME/storages/dsh-utils-agents/update.json so a
 * restart shows the last known answer before the first network call, and a
 * failed check never hides the last successfully read version.
 *
 * @module dsh-utils/utils-agents/update
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Options } from './util.js';
/** Where the newest version is read from. */
export type UpdateSourceKind = 'npm' | 'git' | 'local';
/** The state of one automatic install attempt. */
export interface UpdateInstall {
    /** idle: nothing to do; installing: pnpm is running; installed: restart to apply; failed: see message. */
    readonly phase: 'idle' | 'installing' | 'installed' | 'failed';
    /** The version being installed. */
    readonly version: string | null;
    /** Why the install failed, or the restart reminder after success. */
    readonly message: string | null;
    /** When the last phase change happened. */
    readonly at: string | null;
}
/** The durable and returned shape of one update check. */
export interface UpdateStatus {
    /** The version this component runs from; the bundle root package's version. */
    readonly current: string;
    /** The last successfully read remote version, if any. */
    readonly latest: string | null;
    /** Whether `latest` is newer than `current`. */
    readonly updateAvailable: boolean;
    /** Which remote the answer describes: npm, GitHub, or none for a local install. */
    readonly source: UpdateSourceKind;
    /** The exact remote the answer came from (registry base URL or raw GitHub URL). */
    readonly origin: string;
    /** When `latest` was read successfully. */
    readonly checkedAt: string | null;
    /** When the last attempt finished, successful or not. */
    readonly attemptedAt: string | null;
    /** Why the last check failed; null after a successful one. */
    readonly error: string | null;
    /** The last automatic install attempt. */
    readonly install: UpdateInstall;
}
/** What the panel needs to describe the schedule. */
export interface UpdateSchedule {
    readonly enabled: boolean;
    readonly intervalHours: number;
    readonly registry: string;
}
/** How this bundle was installed in the profile. */
interface InstallSource {
    readonly kind: UpdateSourceKind;
    /** The profile dependency spec, when it could be read. */
    readonly spec: string | null;
    /** A GitHub repository parsed from a Git spec. */
    readonly git?: {
        readonly owner: string;
        readonly repo: string;
        readonly ref: string;
    };
}
/** One install command for the profile. */
export interface InstallCommand {
    /** The profile directory `pnpm add` runs in. */
    readonly dir: string;
    /** The package spec to add. */
    readonly spec: string;
    /** Whether to save an exact registry version. */
    readonly exact: boolean;
}
/** Runs one install; tests replace it. */
export type InstallRunner = (command: InstallCommand) => Promise<void>;
/**
 * Compare two semantic versions, ignoring build metadata.
 * @returns negative when left is older, 0 when equal, positive when newer.
 */
export declare function compareVersions(left: string, right: string): number;
/**
 * Read a GitHub repository out of a pnpm Git spec: `github:owner/repo`,
 * `owner/repo`, `git+https://github.com/owner/repo.git#<ref>`, or the SSH form.
 * A `#path:` parameter is dropped; the first remaining parameter is the ref.
 */
export declare function parseGitSpec(spec: string): {
    owner: string;
    repo: string;
    ref: string;
} | null;
/** The install command for one source and target version; null when it must not install. */
export declare function installCommand(source: InstallSource, profile: string, name: string, version: string): InstallCommand | null;
/** One update checker per mounted component. */
export interface UpdateChecker {
    /** The last known answer, reading the cache on first use. */
    status(): Promise<UpdateStatus>;
    /** Ask the remote now; concurrent calls share one request. */
    check(): Promise<UpdateStatus>;
}
/**
 * Create the checker for one component instance.
 * @param ctx - host context, read for the profile directory the spec lives in.
 * @param options - live settings snapshot; registry and auto-install are read per check.
 * @param runner - how an install runs; defaults to `pnpm add` in the profile.
 */
export declare function createUpdateChecker(ctx: Context, options: () => Options, runner?: InstallRunner): UpdateChecker;
/**
 * Run the automatic checks: one shortly after activation, then at the
 * configured interval. The next delay is recomputed after every run, so an
 * interval edited in the panel is picked up without a restart.
 */
export declare function startUpdateWatcher(ctx: Context, checker: UpdateChecker, options: () => Options): void;
export {};
