/**
 * Consolidated `dsh-utils` configuration at `$DSH_HOME/utils/utils.json`.
 *
 * The document is the one place the bundle keeps operator-editable settings:
 *
 * - `skillRepositories`: the Skill checkouts that are scanned from their own
 *   repository root and refreshed on a timer;
 * - `autoUpdate` / `updateIntervalMinutes`: whether (and how often) the timer
 *   pulls those checkouts together with their submodules;
 * - `autoSyncPresets`: whether each refresh mirrors the presets a checkout
 *   carries under `.dsh/preset` into the local preset home. The repository is
 *   the only source of truth: a preset it no longer carries is removed locally
 *   as well, and `builtinPresets` are always exempt.
 *
 * The former single-repository state file
 * (`$DSH_HOME/storages/dsh-utils-ui.json`) is migrated on first read and left
 * untouched afterwards, so downgrading still works. Deploy Keys stay under
 * `$DSH_HOME/storages`: they are secrets, not configuration.
 *
 * A missing document with no legacy state, or a document that carries neither
 * repositories nor settings (an empty `{}` left by an older install), is
 * converted to the shipped default configuration — one shared Skill repository
 * at the default URL/branch — and written back, so an upgraded profile starts
 * from the same defaults as a fresh install. A document that already configures
 * anything is never rewritten by a read; a malformed document is reported as
 * defaults without touching the file (a hand edit stays repairable).
 *
 * @module dsh-utils/utils-agents/utils-config
 */
import { type Options, type SyncRecord } from './util.js';
/** Version of the on-disk document. */
export declare const UTILS_CONFIG_VERSION = 1;
/** Minutes between two automatic Skill repository refreshes. */
export declare const DEFAULT_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 60;
/** Smallest accepted automatic refresh interval. */
export declare const MIN_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 5;
/** Largest accepted automatic refresh interval. */
export declare const MAX_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 1440;
/** Shipped default URL of the shared Skill repository (same as the preset default). */
export declare const DEFAULT_SHARED_REPO_URL = "https://github.com/xi4z/skills";
/** Shipped default branch of the shared Skill repository. */
export declare const DEFAULT_SHARED_REPO_BRANCH = "Agent";
/** One configured Skill repository checkout. */
export interface SkillRepositoryConfig {
    repoUrl: string;
    branch: string;
    targetDir: string;
    keyPath: string;
    recurseSubmodules: boolean;
    lastSync: SyncRecord | null;
}
/** The whole `utils.json` document. */
export interface UtilsConfig {
    version: number;
    skillRepositories: SkillRepositoryConfig[];
    autoUpdate: boolean;
    /** Also copy presets carried by `.dsh/preset` into the local preset home. */
    autoSyncPresets: boolean;
    updateIntervalMinutes: number;
}
/** One read result: the normalized document plus whether the file existed. */
export interface UtilsConfigSnapshot {
    readonly config: UtilsConfig;
    readonly existed: boolean;
    readonly path: string;
}
/** `$DSH_HOME/utils`. */
export declare function utilsConfigDir(): string;
/** `$DSH_HOME/utils/utils.json`. */
export declare function utilsConfigPath(): string;
/** The legacy single-repository document `global-repo` used to write. */
export declare function legacyUtilsStatePath(): string;
/** The shipped settings with no repository; normalize starts from this baseline. */
export declare function emptyUtilsConfig(): UtilsConfig;
/**
 * The fallback repository the panel shows before anything is saved, and the
 * repository an empty document is bootstrapped with.
 * @param options - row settings supplying the default URL/branch; omitted uses the shipped constants.
 * @returns the default shared repository entry.
 */
export declare function defaultSkillRepository(options?: Pick<Options, 'defaultRepoUrl' | 'defaultBranch'>): SkillRepositoryConfig;
/**
 * The shipped default configuration: the same settings as an empty document
 * plus the default shared Skill repository. This is what a missing or empty
 * `utils.json` turns into, so a fresh install and an upgraded one start equal.
 * @returns a document to persist as-is.
 */
export declare function defaultUtilsConfig(): UtilsConfig;
/**
 * Read the consolidated configuration.
 *
 * A missing file is migrated from the legacy state document when that document
 * carries a repository, and otherwise becomes the shipped default
 * configuration; an empty document is converted to the default and written
 * back, so an upgraded profile ends up with the same document a fresh install
 * gets. A malformed document yields the defaults without destroying the file,
 * so a hand edit can be repaired.
 * @returns the normalized document, whether it existed, and its path.
 */
export declare function readUtilsConfig(): Promise<UtilsConfigSnapshot>;
/** Replace the document atomically with mode 0600. */
export declare function writeUtilsConfig(config: UtilsConfig): Promise<void>;
