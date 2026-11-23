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

import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  canonicalRepoUrl,
  cloneUrlFor,
  globalKeyPath,
  runGit,
  validateBranch,
  validateRepoUrl,
  type GitOutcome,
  type KeyStatus,
} from './git.js'
import {
  IGNORED_DIRS,
  AgentsError,
  directoryOf,
  dshHome,
  errorMessage,
  exists,
  expandAbsolute,
  walkFiles,
  type Options,
} from './util.js'
import {
  defaultSkillRepository,
  readUtilsConfig,
  writeUtilsConfig,
  type SkillRepositoryConfig,
} from './utils-config.js'

/** Legacy deploy-key file name; never returned to the browser. */
const KEY_FILE_NAME = 'dsh-utils-ui.deploy-key'

/** Depth used when counting skills in a shared checkout. */
const SKILL_SCAN_DEPTH = 8

/** Durable settings for one shared skill repository. */
export type SharedRepoState = SkillRepositoryConfig

/** Checkout status for the shared skill repository. */
export interface SharedRepoTarget {
  exists: boolean
  isRepo: boolean
  branch: string | null
  commit: string | null
  dirty: boolean
  skills: number
}

/** The full repository view returned to the browser. */
export interface SharedRepoView {
  state: SharedRepoState
  target: SharedRepoTarget
  key: KeyStatus
}

/** How one automatic refresh ended. */
export interface SkillRepositoryUpdate {
  readonly targetDir: string
  readonly repoUrl: string
  readonly ok: boolean
  readonly changed: boolean
  readonly skipped: boolean
  readonly message: string
}

/** Per-call switch for one repository sync. */
interface SyncOptions {
  /** Refuse to fetch/merge over uncommitted changes (the timer's choice). */
  readonly skipDirty: boolean
}

/** One completed repository sync. */
interface SyncResult {
  readonly target: SharedRepoTarget
  readonly message: string
  readonly changed: boolean
  readonly skipped: boolean
}

/** Read the shared repository settings, filling defaults. */
export async function readSharedRepoState(options: Options): Promise<SharedRepoState> {
  const { config } = await readUtilsConfig()
  return config.skillRepositories[0] ?? defaultSkillRepository(options)
}

/** Read the shared repository settings plus checkout and key status. */
export async function sharedRepoView(ctx: Context, options: Options): Promise<SharedRepoView> {
  const state = await readSharedRepoState(options)
  return { state, target: await targetStatus(ctx, state), key: await sharedKeyStatus(state) }
}

/** Save new shared repository settings after validation. */
export async function saveSharedRepoConfig(ctx: Context, options: Options, body: Record<string, unknown>): Promise<SharedRepoView> {
  const current = await readSharedRepoState(options)
  const repoUrl = textValue(body.repoUrl, current.repoUrl)
  const branch = textValue(body.branch, current.branch)
  const targetDir = textValue(body.targetDir, current.targetDir)
  const keyPath = typeof body.keyPath === 'string' ? body.keyPath.trim() : current.keyPath
  const recurseSubmodules = typeof body.recurseSubmodules === 'boolean' ? body.recurseSubmodules : current.recurseSubmodules
  validateRepoUrl(repoUrl)
  validateBranch(branch)
  let resolvedTarget: string
  try {
    resolvedTarget = expandAbsolute(targetDir)
  } catch (error) {
    throw new AgentsError('检出目录必须是绝对路径：' + errorMessage(error), 400)
  }
  if (keyPath !== '') {
    try {
      if (!(await exists(expandAbsolute(keyPath)))) throw new AgentsError('密钥路径不存在：' + keyPath, 400)
    } catch (error) {
      if (error instanceof AgentsError) throw error
      throw new AgentsError('密钥路径不合法：' + keyPath, 400)
    }
  }
  const saved: SharedRepoState = {
    repoUrl,
    branch,
    targetDir: resolvedTarget,
    keyPath,
    recurseSubmodules,
    lastSync: current.lastSync,
  }
  const { config } = await readUtilsConfig()
  config.skillRepositories = [saved, ...config.skillRepositories.slice(1)]
  await writeUtilsConfig(config)
  return sharedRepoView(ctx, options)
}

/** Store a pasted Deploy Key; an empty string clears it. */
export async function saveSharedRepoKey(ctx: Context, options: Options, key: string): Promise<SharedRepoView> {
  const file = sharedStoredKeyPath()
  if (key.trim() === '') {
    await rm(file, { force: true })
    return sharedRepoView(ctx, options)
  }
  if (key.includes(String.fromCharCode(0))) throw new AgentsError('Deploy Key 不能包含 NUL 字符', 400)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.' + randomSuffix() + '.tmp'
  try {
    await writeFile(temp, key.trimEnd() + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  await chmod(file, 0o600)
  return sharedRepoView(ctx, options)
}

/** Clone or fast-forward the shared repository with the configured key. */
export async function pullSharedRepo(ctx: Context, options: Options): Promise<SharedRepoView> {
  const snapshot = await readUtilsConfig()
  const current = snapshot.config.skillRepositories[0] ?? defaultSkillRepository(options)
  const synced = await syncRepository(ctx, current, { skipDirty: false })
  const next: SharedRepoState = {
    ...current,
    lastSync: {
      at: new Date().toISOString(),
      ok: true,
      commit: synced.target.commit ?? '',
      skills: synced.target.skills,
      message: synced.message,
    },
  }
  const repositories = snapshot.config.skillRepositories.length > 0
    ? [next, ...snapshot.config.skillRepositories.slice(1)]
    : [next]
  await writeUtilsConfig({ ...snapshot.config, skillRepositories: repositories })
  return { state: next, target: synced.target, key: await sharedKeyStatus(next) }
}

/**
 * Refresh every configured Skill repository and its submodules.
 *
 * This is the timer's entry point: best-effort per repository, never over a
 * dirty working tree, and failures are reported instead of thrown.
 * @param ctx - plugin context for warnings.
 * @returns one result per configured repository.
 */
export async function updateSkillRepositories(ctx: Context): Promise<SkillRepositoryUpdate[]> {
  const snapshot = await readUtilsConfig()
  const { skillRepositories } = snapshot.config
  if (skillRepositories.length === 0) return []
  const results: SkillRepositoryUpdate[] = []
  let dirty = false
  for (let index = 0; index < skillRepositories.length; index += 1) {
    const repository = skillRepositories[index]
    try {
      const synced = await syncRepository(ctx, repository, { skipDirty: true })
      if (synced.skipped) {
        results.push({
          targetDir: repository.targetDir,
          repoUrl: repository.repoUrl,
          ok: true,
          changed: false,
          skipped: true,
          message: synced.message,
        })
        continue
      }
      skillRepositories[index] = {
        ...repository,
        lastSync: {
          at: new Date().toISOString(),
          ok: true,
          commit: synced.target.commit ?? '',
          skills: synced.target.skills,
          message: synced.message,
        },
      }
      dirty = true
      results.push({
        targetDir: repository.targetDir,
        repoUrl: repository.repoUrl,
        ok: true,
        changed: synced.changed,
        skipped: false,
        message: synced.message,
      })
    } catch (error) {
      const message = errorMessage(error)
      ctx.logger.warn('utils-agents: skill repository update failed for ' + repository.targetDir + ': ' + message)
      results.push({
        targetDir: repository.targetDir,
        repoUrl: repository.repoUrl,
        ok: false,
        changed: false,
        skipped: false,
        message,
      })
    }
  }
  if (dirty) {
    try {
      await writeUtilsConfig(snapshot.config)
    } catch (error) {
      ctx.logger.debug('utils-agents: cannot persist skill repository state: ' + errorMessage(error))
    }
  }
  return results
}

/**
 * Clone or fast-forward one configured checkout, then refresh its submodules.
 * @param ctx - plugin context for warnings.
 * @param state - one repository configuration.
 * @param options - per-call behavior.
 * @returns the new status plus whether the checkout changed.
 */
async function syncRepository(ctx: Context, state: SharedRepoState, options: SyncOptions): Promise<SyncResult> {
  const key = await sharedKeyStatus(state)
  if (state.keyPath !== '' && key.file === undefined) throw new AgentsError('配置的密钥路径不存在', 409)
  const parsed = validateRepoUrl(state.repoUrl)
  validateBranch(state.branch)
  if (!isAbsolute(state.targetDir)) throw new AgentsError('检出目录必须是绝对路径', 400)
  const target = state.targetDir
  const cloneUrl = cloneUrlFor(parsed, key.file)
  let message = ''
  let changed = false

  if (!(await exists(target))) {
    await mkdir(dirname(target), { recursive: true })
    const cloned = await runGit(['clone', '--depth', '1', '--branch', state.branch, '--single-branch', cloneUrl, target], undefined, key.file)
    if (cloned.code !== 0) throw pullError('克隆仓库失败', cloned)
    message = '已 clone 分支 ' + state.branch
    changed = true
  } else {
    if (!(await directoryOf(target))) throw new AgentsError('检出目录已存在但不是目录：' + target, 409)
    const root = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], undefined, key.file)
    if (root.code !== 0 || resolve(root.stdout.trim()) !== resolve(target)) {
      throw new AgentsError('检出目录不是该仓库的 Git checkout', 409)
    }
    const origin = await runGit(['-C', target, 'remote', 'get-url', 'origin'], undefined, key.file)
    if (origin.code !== 0) throw pullError('读取 origin 失败', origin)
    if (canonicalRepoUrl(origin.stdout.trim()) !== parsed.canonical) {
      throw new AgentsError('检出目录的 origin 与配置的仓库不一致', 409)
    }
    const current = await runGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined, key.file)
    if (current.code !== 0) throw pullError('读取当前分支失败', current)
    if (current.stdout.trim() !== state.branch) {
      throw new AgentsError('检出目录当前分支是 ' + current.stdout.trim() + '，配置分支是 ' + state.branch, 409)
    }
    if (options.skipDirty) {
      const dirty = await runGit(['-C', target, 'status', '--porcelain'], undefined, key.file)
      if (dirty.code === 0 && dirty.stdout.trim() !== '') {
        return {
          target: await targetStatus(ctx, state),
          message: '工作区有本地改动，跳过自动更新',
          changed: false,
          skipped: true,
        }
      }
    }
    const before = await runGit(['-C', target, 'rev-parse', 'HEAD'], undefined, key.file)
    const shallow = await runGit(['-C', target, 'rev-parse', '--is-shallow-repository'], undefined, key.file)
    const fetchArgs = shallow.code === 0 && shallow.stdout.trim() === 'true'
      ? ['-C', target, 'fetch', '--unshallow', 'origin', state.branch]
      : ['-C', target, 'fetch', 'origin', state.branch]
    const fetched = await runGit(fetchArgs, undefined, key.file)
    if (fetched.code !== 0) throw pullError('fetch 失败', fetched)
    const merged = await runGit(['-C', target, 'merge', '--ff-only', 'FETCH_HEAD'], undefined, key.file)
    if (merged.code !== 0) throw pullError('快进合并失败', merged)
    const after = await runGit(['-C', target, 'rev-parse', 'HEAD'], undefined, key.file)
    changed = before.code !== 0 || after.code !== 0 || before.stdout.trim() !== after.stdout.trim()
    message = changed ? '已快进到最新提交' : '已是最新提交'
  }

  if (state.recurseSubmodules) {
    const sync = await runGit(['-C', target, 'submodule', 'sync', '--recursive'], undefined, key.file)
    if (sync.code !== 0) ctx.logger.warn('utils-agents: shared submodule sync failed: ' + sync.stderr.trim())
    const update = await runGit(['-C', target, 'submodule', 'update', '--init', '--recursive'], undefined, key.file)
    if (update.code !== 0) {
      ctx.logger.warn('utils-agents: shared submodule update failed: ' + update.stderr.trim())
    } else if (update.stdout.trim() !== '') {
      changed = true
    }
  }

  return { target: await targetStatus(ctx, state), message, changed, skipped: false }
}

/** The legacy deploy-key path shared with the old global route. */
export function sharedStoredKeyPath(): string {
  return join(dshHome(), 'storages', KEY_FILE_NAME)
}

/** The SSH identity for the shared repository. */
export async function sharedKeyStatus(state: SharedRepoState): Promise<KeyStatus> {
  if (state.keyPath !== '') {
    let file: string
    try {
      file = expandAbsolute(state.keyPath)
    } catch {
      return { source: 'none', file: undefined, hasStoredKey: await exists(sharedStoredKeyPath()) }
    }
    if (await exists(file)) return { source: 'path', file, hasStoredKey: await exists(sharedStoredKeyPath()) }
  }
  const stored = sharedStoredKeyPath()
  if (await exists(stored)) return { source: 'stored', file: stored, hasStoredKey: true }
  const fallback = globalKeyPath()
  if (await exists(fallback)) return { source: 'global', file: fallback, hasStoredKey: false }
  return { source: 'none', file: undefined, hasStoredKey: false }
}

/** Inspect the shared checkout. */
async function targetStatus(ctx: Context, state: SharedRepoState): Promise<SharedRepoTarget> {
  const target = state.targetDir
  if (!(await exists(target))) return { exists: false, isRepo: false, branch: null, commit: null, dirty: false, skills: 0 }
  const root = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], undefined, undefined)
  if (root.code !== 0 || resolve(root.stdout.trim()) !== resolve(target)) {
    return { exists: true, isRepo: false, branch: null, commit: null, dirty: false, skills: 0 }
  }
  const branch = await runGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined, undefined)
  const commit = await runGit(['-C', target, 'rev-parse', 'HEAD'], undefined, undefined)
  const dirty = await runGit(['-C', target, 'status', '--porcelain'], undefined, undefined)
  const skills = await countSkills(ctx, target)
  return {
    exists: true,
    isRepo: true,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    commit: commit.code === 0 ? commit.stdout.trim() : null,
    dirty: dirty.code === 0 && dirty.stdout.trim() !== '',
    skills,
  }
}

/** Count enabled SKILL.md files inside the shared checkout. */
async function countSkills(ctx: Context, root: string): Promise<number> {
  let count = 0
  await walkFiles(root, SKILL_SCAN_DEPTH, new Set(IGNORED_DIRS), (path) => {
    if (path.endsWith('/SKILL.md') || path.endsWith('\\SKILL.md')) count += 1
  }, ctx)
  return count
}

/** Build a sanitized git failure. */
function pullError(prefix: string, outcome: GitOutcome): AgentsError {
  const detail = outcome.stderr.trim() || outcome.spawnError || (outcome.timedOut ? 'timeout' : 'exit ' + String(outcome.code))
  return new AgentsError(prefix + '：' + detail.split(/\r?\n/).slice(0, 3).join(' / '), 500)
}

/** Read one string field or its fallback. */
function textValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Short random suffix for one temporary file. */
function randomSuffix(): string {
  return process.pid.toString(36) + Math.random().toString(36).slice(2, 8)
}
