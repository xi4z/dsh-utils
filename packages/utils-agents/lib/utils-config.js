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
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dshHome, expandAbsolute, } from './util.js';
/** Version of the on-disk document. */
export const UTILS_CONFIG_VERSION = 1;
/** Minutes between two automatic Skill repository refreshes. */
export const DEFAULT_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 60;
/** Smallest accepted automatic refresh interval. */
export const MIN_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 5;
/** Largest accepted automatic refresh interval. */
export const MAX_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 1440;
/** Branch used for a migrated repository that never recorded one. */
const FALLBACK_BRANCH = 'Agent';
/** Shipped default URL of the shared Skill repository (same as the preset default). */
export const DEFAULT_SHARED_REPO_URL = 'https://github.com/xi4z/skills';
/** Shipped default branch of the shared Skill repository. */
export const DEFAULT_SHARED_REPO_BRANCH = 'Agent';
/**
 * Document keys that carry settings of their own. A document with none of
 * these and no repository is treated as empty (see {@link isEmptyDocument}).
 */
const SETTING_KEYS = ['autoUpdate', 'autoSyncPresets', 'updateIntervalMinutes'];
/** `$DSH_HOME/utils`. */
export function utilsConfigDir() {
    return join(dshHome(), 'utils');
}
/** `$DSH_HOME/utils/utils.json`. */
export function utilsConfigPath() {
    return join(utilsConfigDir(), 'utils.json');
}
/** The legacy single-repository document `global-repo` used to write. */
export function legacyUtilsStatePath() {
    return join(dshHome(), 'storages', 'dsh-utils-ui.json');
}
/** The shipped settings with no repository; normalize starts from this baseline. */
export function emptyUtilsConfig() {
    return {
        version: UTILS_CONFIG_VERSION,
        skillRepositories: [],
        autoUpdate: true,
        autoSyncPresets: true,
        updateIntervalMinutes: DEFAULT_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES,
    };
}
/**
 * The fallback repository the panel shows before anything is saved, and the
 * repository an empty document is bootstrapped with.
 * @param options - row settings supplying the default URL/branch; omitted uses the shipped constants.
 * @returns the default shared repository entry.
 */
export function defaultSkillRepository(options) {
    return {
        repoUrl: options === undefined ? DEFAULT_SHARED_REPO_URL : options.defaultRepoUrl,
        branch: options === undefined ? DEFAULT_SHARED_REPO_BRANCH : options.defaultBranch,
        targetDir: join(dshHome(), 'skills', 'utils-skill'),
        keyPath: '',
        recurseSubmodules: true,
        lastSync: null,
    };
}
/**
 * The shipped default configuration: the same settings as an empty document
 * plus the default shared Skill repository. This is what a missing or empty
 * `utils.json` turns into, so a fresh install and an upgraded one start equal.
 * @returns a document to persist as-is.
 */
export function defaultUtilsConfig() {
    return { ...emptyUtilsConfig(), skillRepositories: [defaultSkillRepository()] };
}
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
export async function readUtilsConfig() {
    const path = utilsConfigPath();
    let raw;
    try {
        raw = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        if (isAbsent(error))
            return migrateLegacyConfig(path);
        // Unparsable: report defaults but never overwrite what may be a hand edit.
        return { config: emptyUtilsConfig(), existed: true, path };
    }
    if (!isEmptyDocument(raw))
        return { config: normalizeUtilsConfig(raw), existed: true, path };
    const config = defaultUtilsConfig();
    await persistQuietly(config);
    return { config, existed: true, path };
}
/**
 * Whether a parsed document carries nothing worth keeping: no repository and
 * no setting. The empty `{}` an older install left behind, and a
 * `{"version": 1}` skeleton, both qualify; an explicit setting such as
 * `autoUpdate: false` or `skillRepositories: []` does not.
 * @param raw - parsed JSON value.
 * @returns true when the default configuration should replace it.
 */
function isEmptyDocument(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return true;
    const record = raw;
    const repositories = record.skillRepositories;
    const hasRepository = Array.isArray(repositories)
        ? repositories.length > 0
        : record.repoUrl !== undefined || record.targetDir !== undefined;
    if (hasRepository)
        return false;
    return !SETTING_KEYS.some((key) => record[key] !== undefined);
}
/** Write the document, ignoring a read-only home so a read never fails on it. */
async function persistQuietly(config) {
    try {
        await writeUtilsConfig(config);
    }
    catch {
        // A read-only home must not turn configuration reads into a failure.
    }
}
/** Replace the document atomically with mode 0600. */
export async function writeUtilsConfig(config) {
    const file = utilsConfigPath();
    await mkdir(utilsConfigDir(), { recursive: true, mode: 0o700 });
    const document = {
        version: UTILS_CONFIG_VERSION,
        skillRepositories: config.skillRepositories,
        autoUpdate: config.autoUpdate,
        autoSyncPresets: config.autoSyncPresets,
        updateIntervalMinutes: normalizeInterval(config.updateIntervalMinutes),
    };
    const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        await writeFile(temp, JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, file);
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
    await chmod(file, 0o600);
}
/**
 * Normalize a parsed document. A legacy single-repository object (fields at the
 * top level) is accepted so an already-written utils.json keeps working.
 * @param raw - parsed JSON value.
 * @returns a document with every field defaulted.
 */
function normalizeUtilsConfig(raw) {
    const config = emptyUtilsConfig();
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return config;
    const record = raw;
    const list = Array.isArray(record.skillRepositories)
        ? record.skillRepositories
        : record.repoUrl !== undefined || record.targetDir !== undefined
            ? [record]
            : [];
    config.skillRepositories = list
        .map((entry) => normalizeSkillRepository(entry))
        .filter((entry) => entry !== undefined);
    config.autoUpdate = record.autoUpdate !== false;
    config.autoSyncPresets = record.autoSyncPresets !== false;
    config.updateIntervalMinutes = normalizeInterval(record.updateIntervalMinutes);
    return config;
}
/**
 * Normalize one persisted repository.
 * @param raw - one array entry.
 * @returns the entry, or undefined when it names no repository or checkout.
 */
function normalizeSkillRepository(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const record = raw;
    const repoUrl = typeof record.repoUrl === 'string' ? record.repoUrl.trim() : '';
    const targetRaw = typeof record.targetDir === 'string' ? record.targetDir.trim() : '';
    if (repoUrl === '' || targetRaw === '')
        return undefined;
    let targetDir;
    try {
        targetDir = expandAbsolute(targetRaw);
    }
    catch {
        return undefined;
    }
    const branch = typeof record.branch === 'string' && record.branch.trim() !== '' ? record.branch.trim() : FALLBACK_BRANCH;
    return {
        repoUrl,
        branch,
        targetDir,
        keyPath: typeof record.keyPath === 'string' ? record.keyPath.trim() : '',
        recurseSubmodules: record.recurseSubmodules !== false,
        lastSync: normalizeSync(record.lastSync),
    };
}
/**
 * Materialize the document a profile without one starts from.
 *
 * A legacy single-repository document wins when it names a repository;
 * otherwise the shipped default configuration is used, so an upgraded profile
 * ends up with defaults instead of an empty document. The result is always
 * written back (best effort), and the legacy file is never modified.
 * @param path - the consolidated config path.
 * @returns the migrated snapshot.
 */
async function migrateLegacyConfig(path) {
    const config = defaultUtilsConfig();
    try {
        const raw = JSON.parse(await readFile(legacyUtilsStatePath(), 'utf8'));
        const repository = normalizeSkillRepository(raw);
        if (repository !== undefined)
            config.skillRepositories = [repository];
    }
    catch {
        // No legacy document, or it is unreadable: keep the shipped default.
    }
    await persistQuietly(config);
    return { config, existed: false, path };
}
/** Clamp one refresh interval to the accepted range. */
function normalizeInterval(raw) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return DEFAULT_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES;
    }
    return Math.min(MAX_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES, Math.max(MIN_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES, Math.trunc(raw)));
}
/** Normalize a persisted sync record. */
function normalizeSync(raw) {
    if (raw === null || typeof raw !== 'object')
        return null;
    const record = raw;
    return {
        at: typeof record.at === 'string' ? record.at : '',
        ok: record.ok === true,
        commit: typeof record.commit === 'string' ? record.commit : '',
        skills: typeof record.skills === 'number' ? record.skills : 0,
        message: typeof record.message === 'string' ? record.message : '',
    };
}
/** Whether an fs error means the path is simply absent. */
function isAbsent(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
//# sourceMappingURL=utils-config.js.map