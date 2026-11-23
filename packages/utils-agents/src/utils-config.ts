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
 * @module dsh-utils/utils-agents/utils-config
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  dshHome,
  expandAbsolute,
  type Options,
  type SyncRecord,
} from './util.js'

/** Version of the on-disk document. */
export const UTILS_CONFIG_VERSION = 1

/** Minutes between two automatic Skill repository refreshes. */
export const DEFAULT_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 60

/** Smallest accepted automatic refresh interval. */
export const MIN_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 5

/** Largest accepted automatic refresh interval. */
export const MAX_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES = 1440

/** Branch used for a migrated repository that never recorded one. */
const FALLBACK_BRANCH = 'Agent'

/** One configured Skill repository checkout. */
export interface SkillRepositoryConfig {
  repoUrl: string
  branch: string
  targetDir: string
  keyPath: string
  recurseSubmodules: boolean
  lastSync: SyncRecord | null
}

/** The whole `utils.json` document. */
export interface UtilsConfig {
  version: number
  skillRepositories: SkillRepositoryConfig[]
  autoUpdate: boolean
  /** Also copy presets carried by `.dsh/preset` into the local preset home. */
  autoSyncPresets: boolean
  updateIntervalMinutes: number
}

/** One read result: the normalized document plus whether the file existed. */
export interface UtilsConfigSnapshot {
  readonly config: UtilsConfig
  readonly existed: boolean
  readonly path: string
}

/** `$DSH_HOME/utils`. */
export function utilsConfigDir(): string {
  return join(dshHome(), 'utils')
}

/** `$DSH_HOME/utils/utils.json`. */
export function utilsConfigPath(): string {
  return join(utilsConfigDir(), 'utils.json')
}

/** The legacy single-repository document `global-repo` used to write. */
export function legacyUtilsStatePath(): string {
  return join(dshHome(), 'storages', 'dsh-utils-ui.json')
}

/** A fresh document with the shipped defaults. */
export function emptyUtilsConfig(): UtilsConfig {
  return {
    version: UTILS_CONFIG_VERSION,
    skillRepositories: [],
    autoUpdate: true,
    autoSyncPresets: true,
    updateIntervalMinutes: DEFAULT_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES,
  }
}

/** The fallback repository the panel shows before anything is saved. */
export function defaultSkillRepository(options: Pick<Options, 'defaultRepoUrl' | 'defaultBranch'>): SkillRepositoryConfig {
  return {
    repoUrl: options.defaultRepoUrl,
    branch: options.defaultBranch,
    targetDir: join(dshHome(), 'skills', 'utils-skill'),
    keyPath: '',
    recurseSubmodules: true,
    lastSync: null,
  }
}

/**
 * Read the consolidated configuration.
 *
 * A missing file is migrated from the legacy state document (and written back
 * when that document exists); a malformed document yields the defaults without
 * destroying the file, so a hand-edit can be repaired.
 * @returns the normalized document, whether it existed, and its path.
 */
export async function readUtilsConfig(): Promise<UtilsConfigSnapshot> {
  const path = utilsConfigPath()
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (isAbsent(error)) return migrateLegacyConfig(path)
    return { config: emptyUtilsConfig(), existed: true, path }
  }
  return { config: normalizeUtilsConfig(raw), existed: true, path }
}

/** Replace the document atomically with mode 0600. */
export async function writeUtilsConfig(config: UtilsConfig): Promise<void> {
  const file = utilsConfigPath()
  await mkdir(utilsConfigDir(), { recursive: true, mode: 0o700 })
  const document: UtilsConfig = {
    version: UTILS_CONFIG_VERSION,
    skillRepositories: config.skillRepositories,
    autoUpdate: config.autoUpdate,
    autoSyncPresets: config.autoSyncPresets,
    updateIntervalMinutes: normalizeInterval(config.updateIntervalMinutes),
  }
  const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp'
  try {
    await writeFile(temp, JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  await chmod(file, 0o600)
}

/**
 * Normalize a parsed document. A legacy single-repository object (fields at the
 * top level) is accepted so an already-written utils.json keeps working.
 * @param raw - parsed JSON value.
 * @returns a document with every field defaulted.
 */
function normalizeUtilsConfig(raw: unknown): UtilsConfig {
  const config = emptyUtilsConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config
  const record = raw as Record<string, unknown>
  const list = Array.isArray(record.skillRepositories)
    ? record.skillRepositories
    : record.repoUrl !== undefined || record.targetDir !== undefined
      ? [record]
      : []
  config.skillRepositories = list
    .map((entry) => normalizeSkillRepository(entry))
    .filter((entry): entry is SkillRepositoryConfig => entry !== undefined)
  config.autoUpdate = record.autoUpdate !== false
  config.autoSyncPresets = record.autoSyncPresets !== false
  config.updateIntervalMinutes = normalizeInterval(record.updateIntervalMinutes)
  return config
}

/**
 * Normalize one persisted repository.
 * @param raw - one array entry.
 * @returns the entry, or undefined when it names no repository or checkout.
 */
function normalizeSkillRepository(raw: unknown): SkillRepositoryConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const repoUrl = typeof record.repoUrl === 'string' ? record.repoUrl.trim() : ''
  const targetRaw = typeof record.targetDir === 'string' ? record.targetDir.trim() : ''
  if (repoUrl === '' || targetRaw === '') return undefined
  let targetDir: string
  try {
    targetDir = expandAbsolute(targetRaw)
  } catch {
    return undefined
  }
  const branch = typeof record.branch === 'string' && record.branch.trim() !== '' ? record.branch.trim() : FALLBACK_BRANCH
  return {
    repoUrl,
    branch,
    targetDir,
    keyPath: typeof record.keyPath === 'string' ? record.keyPath.trim() : '',
    recurseSubmodules: record.recurseSubmodules !== false,
    lastSync: normalizeSync(record.lastSync),
  }
}

/**
 * Migrate the legacy single-repository document exactly once.
 * @param path - the consolidated config path.
 * @returns the migrated snapshot; the legacy file is never modified.
 */
async function migrateLegacyConfig(path: string): Promise<UtilsConfigSnapshot> {
  const config = emptyUtilsConfig()
  try {
    const raw = JSON.parse(await readFile(legacyUtilsStatePath(), 'utf8')) as unknown
    const repository = normalizeSkillRepository(raw)
    if (repository !== undefined) config.skillRepositories.push(repository)
  } catch {
    // No legacy document, or it is unreadable: start empty.
  }
  if (config.skillRepositories.length > 0) {
    try {
      await writeUtilsConfig(config)
    } catch {
      // A read-only home must not turn discovery into a failure.
    }
  }
  return { config, existed: false, path }
}

/** Clamp one refresh interval to the accepted range. */
function normalizeInterval(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES
  }
  return Math.min(
    MAX_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES,
    Math.max(MIN_SKILL_REPOSITORY_UPDATE_INTERVAL_MINUTES, Math.trunc(raw)),
  )
}

/** Normalize a persisted sync record. */
function normalizeSync(raw: unknown): SyncRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  return {
    at: typeof record.at === 'string' ? record.at : '',
    ok: record.ok === true,
    commit: typeof record.commit === 'string' ? record.commit : '',
    skills: typeof record.skills === 'number' ? record.skills : 0,
    message: typeof record.message === 'string' ? record.message : '',
  }
}

/** Whether an fs error means the path is simply absent. */
function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR')
}
