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

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'


/** Exact Connection routes owned by the sync panel. */
export const ROUTE_PATHS = {
  status: '/api/dsh-utils-ui/status',
  config: '/api/dsh-utils-ui/config',
  key: '/api/dsh-utils-ui/key',
  sync: '/api/dsh-utils-ui/sync',
} as const

/** GET: repository settings, target state, last sync. */
export const STATUS_PATH = ROUTE_PATHS.status
/** POST: replace the repository settings. */
export const CONFIG_PATH = ROUTE_PATHS.config
/** POST: store or clear the deploy key. */
export const KEY_PATH = ROUTE_PATHS.key
/** POST: clone or fast-forward the target. */
export const SYNC_PATH = ROUTE_PATHS.sync

/** Default repository: the public upstream of this machine's skill collection. */
export const DEFAULT_REPO_URL = 'https://github.com/xi4z/skills'

/** Default branch: the Agent branch of that repository. */
export const DEFAULT_BRANCH = 'Agent'

/** Reply headers shared by successful and failed route responses. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

/** Directory under $DSH_HOME holding the panel's durable files. */
const STORAGE_DIR_NAME = 'storages'
/** Repository settings plus the last sync outcome. */
const STATE_FILE_NAME = 'dsh-utils-ui.json'
/** Deploy key pasted into the panel; never returned to the browser. */
const KEY_FILE_NAME = 'dsh-utils-ui.deploy-key'

/** Every git command is bounded, so a hung remote cannot hold the request open. */
const GIT_TIMEOUT_MS = 120000
/** JSON request bodies are configuration, not uploads. */
const BODY_LIMIT_BYTES = 64 * 1024
/** Pasted deploy keys are a few kilobytes; anything larger is not a key. */
const KEY_LIMIT_BYTES = 64 * 1024
/** stdout/stderr cap for one git command. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024
/** Skill discovery never descends deeper than this when counting SKILL.md. */
const MAX_SCAN_DEPTH = 12
/** Error lines kept in a failed sync response. */
const MAX_LOG_LINES = 40

/** Branch names git itself accepts here: no spaces, no leading dash, no '..'. */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/

/**
 * HTTPS hosts whose repositories are commonly authenticated with an SSH deploy
 * key; an HTTPS URL on one of these is rewritten to SSH when a key is present.
 */
const SSH_HOSTS = new Set(['github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org', 'codeberg.org'])

/**
 * The package root, used to refuse a target directory inside this plugin.
 * The module builds to `lib/ui-host.js`, so the package root is one directory
 * up.
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** One recorded sync attempt, persisted as lastSync. */
export interface SyncRecord {
  readonly at: string
  readonly ok: boolean
  readonly commit: string
  readonly skills: number
  readonly message: string
}

/** The durable panel configuration and the last sync outcome. */
export interface SyncState {
  repoUrl: string
  branch: string
  keyPath: string
  targetDir: string
  recurseSubmodules: boolean
  lastSync: SyncRecord | null
}

/** Where the SSH identity comes from, as the panel displays it. */
export type KeySource = 'path' | 'stored' | 'none'

/** Resolved key location; keyFile is a real file path or undefined. */
interface KeyStatus {
  readonly keySource: KeySource
  readonly hasStoredKey: boolean
  readonly keyFile: string | undefined
}

/** How a repository URL is addressed. */
export type RepoKind = 'https' | 'http' | 'ssh' | 'scp' | 'file' | 'path'

/** One parsed repository URL: normalized fields plus a comparison key. */
export interface ParsedRepo {
  readonly kind: RepoKind
  readonly raw: string
  readonly isSsh: boolean
  readonly host: string | undefined
  readonly path: string
  readonly canonical: string
}

/** Whether the target directory exists and is a directory. */
interface PathKind {
  readonly exists: boolean
  readonly isDirectory: boolean
}

/** The target checkout as the status route reports it. */
interface TargetInfo {
  readonly exists: boolean
  readonly isRepo: boolean
  readonly branch: string | null
  readonly commit: string | null
  readonly dirty: boolean
  readonly skills: number
  readonly skillNames: string[]
}

/** Counted skills under a target directory. */
interface SkillCount {
  readonly skills: number
  readonly skillNames: string[]
}

/** One execFile result, normalized across exit codes, signals, and spawn errors. */
interface GitOutcome {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly spawnError: string | undefined
}

/** One exact Connection Fetch route, structurally typed so no client dependency is needed. */
interface ConnectionLike {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly string[]
      readonly requestBody: string
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** A route failure carrying its HTTP status and an optional sanitized git log. */
class UiError extends Error {
  readonly status: number
  readonly log: string[] | undefined

  /**
   * @param message - user-facing, sanitized message.
   * @param status - HTTP status the route answers with.
   * @param log - sanitized git output lines, when the failure came from git.
   */
  constructor(message: string, status: number, log?: string[]) {
    super(message)
    this.name = 'UiError'
    this.status = status
    this.log = log
  }
}

/**
 * Activate the host half: register the four panel routes when this deployment
 * provides a Connection. A non-web host simply has no routes.
 * @param ctx - host Cordis context.
 */
export function applyUiHost(ctx: Context): void {
  ctx.inject(['connection'], (scope) => {
    const connection = (scope as unknown as { connection?: ConnectionLike }).connection
    if (!connection) return
    registerRoute(scope, ctx, connection, ROUTE_PATHS.status, ['GET'], (request) => handleStatus(ctx, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.config, ['POST'], (request) => handleConfig(ctx, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.key, ['POST'], (request) => handleKey(ctx, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.sync, ['POST'], (request) => handleSync(ctx, request))
  })
}

/**
 * Register one exact route, logging (rather than throwing) a registration
 * failure so a conflicting contribution cannot take the whole row down.
 * @param scope - context owning the Connection service.
 * @param ctx - host context for warnings.
 * @param connection - Connection fetch registry.
 * @param path - exact route path.
 * @param methods - HTTP methods the route owns.
 * @param fetch - request handler.
 */
function registerRoute(
  scope: Context,
  ctx: Context,
  connection: ConnectionLike,
  path: string,
  methods: readonly string[],
  fetch: (request: Request) => Promise<Response>,
): void {
  scope.effect(() => {
    try {
      return connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })
    } catch (error) {
      ctx.logger.warn('utils-main repo-sync: cannot register ' + path + ': ' + errorMessage(error))
      return () => Promise.resolve()
    }
  }, 'utils-main repo-sync: ' + path)
}

/**
 * Serve the panel's status: configuration, key source, target checkout, and the
 * last sync outcome.
 * @param ctx - host context for warnings.
 * @param request - incoming GET request.
 * @returns JSON status response.
 */
async function handleStatus(ctx: Context, request: Request): Promise<Response> {
  void request
  try {
    return json(await statusPayload(), 200)
  } catch (error) {
    ctx.logger.warn('utils-main repo-sync: cannot read status: ' + errorMessage(error))
    return json({ error: errorMessage(error) }, 500)
  }
}

/**
 * Serve the panel's configuration update.
 * @param ctx - host context for warnings.
 * @param request - incoming POST request with a JSON object body.
 * @returns JSON configuration response.
 */
async function handleConfig(ctx: Context, request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request)
    const state = await readState()
    const next = applyConfigPatch(state, body)
    await writeState(next)
    const key = await inspectKey(next)
    return json({ ok: true, ...publicConfig(next), keySource: key.keySource, hasStoredKey: key.hasStoredKey }, 200)
  } catch (error) {
    return failure(ctx, error, '保存配置失败')
  }
}

/**
 * Serve the panel's deploy-key update. An empty key clears the stored key.
 * @param ctx - host context for warnings.
 * @param request - incoming POST request with a key field.
 * @returns JSON { hasStoredKey, keySource }; never the key itself.
 */
async function handleKey(ctx: Context, request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new UiError('请求体必须是 JSON 对象', 400)
    }
    const value = (body as Record<string, unknown>).key
    if (value === undefined) throw new UiError('请求体缺少 key 字段', 400)
    if (typeof value !== 'string') throw new UiError('key 必须是字符串', 400)
    const material = value.replace(/\r\n/g, '\n')
    if (material.includes('\u0000')) throw new UiError('key 不能包含 NUL 字符', 400)
    if (Buffer.byteLength(material, 'utf8') > KEY_LIMIT_BYTES) throw new UiError('key 过大', 400)
    if (material.trim() === '') {
      await rm(storedKeyFile(), { force: true })
    } else {
      await writePrivateFile(storedKeyFile(), material.endsWith('\n') ? material : material + '\n')
    }
    const state = await readState()
    const key = await inspectKey(state)
    return json({ ok: true, hasStoredKey: key.hasStoredKey, keySource: key.keySource, keyPath: state.keyPath }, 200)
  } catch (error) {
    return failure(ctx, error, '保存密钥失败')
  }
}

/**
 * Serve the panel's sync: clone a missing target, or fast-forward an existing
 * checkout of the configured branch. The outcome is recorded either way.
 * @param ctx - host context for warnings.
 * @param request - incoming POST request; the body is ignored.
 * @returns JSON { ok, at, commit, skills, warnings } or { error, log? }.
 */
async function handleSync(ctx: Context, request: Request): Promise<Response> {
  void request
  const state = await readState()
  try {
    const key = await inspectKey(state)
    const result = await performSync(state, key)
    const at = new Date().toISOString()
    await recordSync(ctx, { at, ok: true, commit: result.commit, skills: result.skills, message: '' })
    return json({
      ok: true,
      at,
      commit: result.commit,
      skills: result.skills,
      skillNames: result.skillNames,
      warnings: result.warnings,
      branch: state.branch,
      targetDir: state.targetDir,
    }, 200)
  } catch (error) {
    const at = new Date().toISOString()
    await recordSync(ctx, { at, ok: false, commit: '', skills: 0, message: errorMessage(error) })
    return failure(ctx, error, '同步失败', at)
  }
}

/**
 * Run one pull-only sync against the configured repository.
 * @param state - configuration snapshot for this attempt.
 * @param key - resolved key location.
 * @returns the new commit, skill count, and non-fatal warnings.
 * @throws {@link UiError} for validation, conflict, and git failures.
 */
async function performSync(
  state: SyncState,
  key: KeyStatus,
): Promise<{ commit: string; skills: number; skillNames: string[]; warnings: string[] }> {
  const warnings: string[] = []
  const repo = parseRepoUrl(state.repoUrl)
  const keyFile = key.keyFile
  if (repo.isSsh && keyFile === undefined) {
    throw new UiError('仓库地址是 SSH 形式，需要先在面板保存 Deploy Key 或填写密钥路径后才能同步。', 400)
  }
  if ((repo.kind === 'file' || repo.kind === 'path') && keyFile !== undefined) {
    warnings.push('本地仓库地址不需要 Deploy Key，已忽略密钥。')
  }
  const remote = cloneUrlFor(state.repoUrl, keyFile !== undefined)
  const target = state.targetDir
  const kind = await pathKind(target)
  if (!kind.exists) {
    await mkdir(dirname(target), { recursive: true })
    const clone = await runGit([
      'clone',
      '--depth', '1',
      '--branch', state.branch,
      '--single-branch',
      remote,
      target,
    ], { keyFile })
    if (clone.code !== 0) throw gitFailure('克隆仓库失败', clone)
  } else if (!kind.isDirectory) {
    throw new UiError('目标路径已存在且不是目录，拒绝覆盖：' + target, 409)
  } else {
    if (!await isGitRepository(target)) {
      throw new UiError('目标目录已存在但不是 git 仓库，拒绝覆盖：' + target, 409)
    }
    const current = await currentBranch(target)
    if (current !== state.branch) {
      throw new UiError(
        '目标仓库当前分支是 ' + (current ?? '(detached HEAD)') + '，与配置分支 ' + state.branch
          + ' 不一致；请手动切换分支或修改配置后再同步。',
        409,
      )
    }
    const origin = await originUrl(target)
    if (origin === undefined) {
      throw new UiError('目标仓库没有 origin 远端，拒绝同步：' + target, 409)
    }
    if (canonicalRepoUrl(origin) !== repo.canonical) {
      throw new UiError(
        '目标仓库 origin 是 ' + origin + '，与配置仓库 ' + state.repoUrl + ' 不是同一仓库，拒绝覆盖。',
        409,
      )
    }
    // A depth-1 fetch records the new tip without its parents, and git then
    // refuses the ff-only merge as "unrelated histories". A shallow checkout is
    // therefore completed first; a complete checkout fetches normally.
    const shallow = await runGit(['rev-parse', '--is-shallow-repository'], { cwd: target })
    const depth = shallow.code === 0 && shallow.stdout.trim() === 'true' ? ['--unshallow'] : []
    const fetched = await runGit(['fetch', ...depth, 'origin', state.branch], { cwd: target, keyFile })
    if (fetched.code !== 0) throw gitFailure('拉取远端分支失败', fetched)
    const merged = await runGit(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: target, keyFile })
    if (merged.code !== 0) throw gitFailure('无法快进合并（本地分支与远端已分叉）', merged)
  }

  if (state.recurseSubmodules) {
    // Submodules are best effort: a private or unreachable submodule must not
    // roll back a successful branch sync, so failures become warnings.
    const synced = await runGit(['submodule', 'sync', '--recursive'], { cwd: target, keyFile })
    if (synced.code !== 0) {
      warnings.push('同步子模块地址失败：' + gitDetail(synced))
    } else {
      const updated = await runGit(['submodule', 'update', '--init', '--recursive', '--force'], { cwd: target, keyFile })
      if (updated.code !== 0) warnings.push('初始化子模块失败：' + gitDetail(updated))
    }
  }

  const commit = await revParse(target, ['--short', 'HEAD'])
  if (commit === undefined) throw new UiError('同步完成后无法读取提交号', 500)
  const counted = await countSkills(target)
  return { commit, skills: counted.skills, skillNames: counted.skillNames, warnings }
}

/** Build the status payload read on every panel refresh. */
async function statusPayload(): Promise<Record<string, unknown>> {
  const state = await readState()
  const key = await inspectKey(state)
  const target = await inspectTarget(state.targetDir)
  return {
    ...publicConfig(state),
    keySource: key.keySource,
    hasStoredKey: key.hasStoredKey,
    target,
  }
}

/**
 * Project the durable state into the fields the panel reads.
 * @param state - durable state.
 * @returns repository settings plus the last sync record.
 */
function publicConfig(state: SyncState): {
  repoUrl: string
  branch: string
  keyPath: string
  targetDir: string
  recurseSubmodules: boolean
  lastSync: SyncRecord | null
} {
  return {
    repoUrl: state.repoUrl,
    branch: state.branch,
    keyPath: state.keyPath,
    targetDir: state.targetDir,
    recurseSubmodules: state.recurseSubmodules,
    lastSync: state.lastSync,
  }
}

/** The default state, resolved against the current $DSH_HOME. */
function defaultState(): SyncState {
  return {
    repoUrl: DEFAULT_REPO_URL,
    branch: DEFAULT_BRANCH,
    keyPath: '',
    targetDir: join(dshHome(), 'skills', 'herskill'),
    recurseSubmodules: true,
    lastSync: null,
  }
}

/**
 * Merge a configuration body onto the current state, validating every supplied
 * field. Omitted fields are preserved; an empty keyPath clears the path.
 * @param state - current durable state.
 * @param body - parsed JSON request body.
 * @returns the next state, not yet persisted.
 */
function applyConfigPatch(state: SyncState, body: unknown): SyncState {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new UiError('请求体必须是 JSON 对象', 400)
  }
  const record = body as Record<string, unknown>
  const next: SyncState = { ...state }
  if (record.repoUrl !== undefined) next.repoUrl = parseRepoUrl(requireString(record.repoUrl, 'repoUrl')).raw
  if (record.branch !== undefined) next.branch = validateBranch(requireString(record.branch, 'branch'))
  if (record.targetDir !== undefined) next.targetDir = resolveTargetDir(requireString(record.targetDir, 'targetDir'))
  if (record.recurseSubmodules !== undefined) {
    if (typeof record.recurseSubmodules !== 'boolean') throw new UiError('recurseSubmodules 必须是布尔值', 400)
    next.recurseSubmodules = record.recurseSubmodules
  }
  next.keyPath = normalizeKeyPath(record.keyPath, state.keyPath)
  return next
}

/** Read one required string field from a request body. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new UiError(field + ' 必须是字符串', 400)
  return value
}

/**
 * Normalize a configured key path without requiring it to exist yet.
 * @param value - raw keyPath field, or undefined to keep the current one.
 * @param current - current stored value.
 * @returns the trimmed path, or an empty string to clear it.
 */
function normalizeKeyPath(value: unknown, current: string): string {
  if (value === undefined) return current
  if (typeof value !== 'string') throw new UiError('keyPath 必须是字符串', 400)
  const raw = value.trim()
  if (raw === '') return ''
  if (hasControlCharacters(raw)) throw new UiError('keyPath 不能包含换行或控制字符', 400)
  expandPath(raw)
  return raw
}

/** Whether text carries a newline, NUL, or other control character. */
function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Resolve a configured target directory: tilde and environment expansion, absolute
 * path required, and never the filesystem root or this package's own checkout.
 * @param raw - configured path.
 * @returns the resolved absolute path.
 */
function resolveTargetDir(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new UiError('目标目录不能为空', 400)
  if (hasControlCharacters(value)) throw new UiError('目标目录不能包含换行或控制字符', 400)
  const expanded = expandPath(value)
  if (!isAbsolute(expanded)) throw new UiError('目标目录必须是绝对路径：' + value, 400)
  const resolved = resolve(expanded)
  if (resolved === '/') throw new UiError('目标目录不能是文件系统根目录', 400)
  if (isInsidePackage(resolved)) throw new UiError('目标目录不能位于 dsh-utils 包内，避免覆盖插件自身', 400)
  return resolved
}

/** Whether a path is this package's root or lies inside it. */
function isInsidePackage(path: string): boolean {
  const rel = relative(PACKAGE_ROOT, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Expand a leading tilde and dollar-brace environment references. A missing
 * variable is an error rather than an empty string, so a typo cannot silently
 * redirect a path.
 * @param input - configured path.
 * @returns the expanded path.
 */
function expandPath(input: string): string {
  let value = input
  if (value === '~') value = homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(2))
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match: string, braced: string | undefined, bare: string | undefined) => {
    const variable = braced ?? bare ?? ''
    const resolved = process.env[variable]
    if (resolved === undefined) throw new UiError('环境变量 ' + variable + ' 未设置', 400)
    return resolved
  })
  return value
}

/**
 * Validate a branch name.
 * @param raw - configured branch.
 * @returns the trimmed branch name.
 */
function validateBranch(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new UiError('分支不能为空', 400)
  if (!BRANCH_PATTERN.test(value)) throw new UiError('分支名不合法：' + value, 400)
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
    || value.includes('..') || value.includes('//')) {
    throw new UiError('分支名不合法：' + value, 400)
  }
  return value
}

/**
 * Parse and validate one repository URL.
 * @param rawInput - configured repository URL (https, http, ssh, scp-like, file, or absolute path).
 * @returns normalized fields plus a comparison key.
 */
function parseRepoUrl(rawInput: string): ParsedRepo {
  const raw = rawInput.trim()
  if (raw === '') throw new UiError('仓库地址不能为空', 400)
  if (hasControlCharacters(raw)) throw new UiError('仓库地址不能包含换行或控制字符', 400)
  if (/\s/.test(raw)) throw new UiError('仓库地址不能包含空白字符', 400)
  if (raw.startsWith('-')) throw new UiError('仓库地址不能以 - 开头', 400)

  const httpMatch = /^(https?):\/\/([^/]+)\/(.+)$/i.exec(raw)
  if (httpMatch !== null) {
    const scheme = httpMatch[1].toLowerCase()
    const host = httpMatch[2].toLowerCase()
    const path = trimGitSuffix(httpMatch[3].replace(/^\/+/, '').replace(/\/+$/, ''))
    if (path === '') throw new UiError('仓库地址缺少仓库路径：' + raw, 400)
    return {
      kind: scheme === 'https' ? 'https' : 'http',
      raw,
      isSsh: false,
      host,
      path,
      canonical: host + '/' + path.toLowerCase(),
    }
  }

  const sshUrlMatch = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(raw)
  if (sshUrlMatch !== null) {
    const host = sshUrlMatch[1].toLowerCase()
    const path = trimGitSuffix(sshUrlMatch[2].replace(/^\/+/, '').replace(/\/+$/, ''))
    if (path === '') throw new UiError('仓库地址缺少仓库路径：' + raw, 400)
    return { kind: 'ssh', raw, isSsh: true, host, path, canonical: host + '/' + path.toLowerCase() }
  }

  if (/^file:\/\//i.test(raw)) {
    let path: string
    try {
      path = resolve(fileURLToPath(raw))
    } catch {
      throw new UiError('file:// 地址不合法：' + raw, 400)
    }
    return { kind: 'file', raw, isSsh: false, host: undefined, path, canonical: 'file:' + path }
  }

  if (isAbsolute(raw)) {
    const path = resolve(raw)
    return { kind: 'path', raw, isSsh: false, host: undefined, path, canonical: 'file:' + path }
  }

  const scpMatch = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+\.[A-Za-z0-9._-]+):(.+)$/.exec(raw)
  if (scpMatch !== null) {
    const host = scpMatch[2].toLowerCase()
    const path = trimGitSuffix(scpMatch[3].replace(/^\/+/, '').replace(/\/+$/, ''))
    if (path === '') throw new UiError('仓库地址缺少仓库路径：' + raw, 400)
    return { kind: 'scp', raw, isSsh: true, host, path, canonical: host + '/' + path.toLowerCase() }
  }

  throw new UiError('无法识别的仓库地址：' + raw + '（支持 https、http、ssh、git@host:path、file:// 或绝对路径）', 400)
}

/** Strip one trailing .git suffix. */
function trimGitSuffix(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -4) : path
}

/**
 * Pick the URL git should actually use. With a deploy key present, an HTTPS URL
 * on a well-known host becomes its SSH form; every other URL is used verbatim.
 * @param repoUrl - configured repository URL.
 * @param hasKey - whether an SSH identity is available.
 * @returns the URL passed to git.
 */
export function cloneUrlFor(repoUrl: string, hasKey: boolean): string {
  const repo = parseRepoUrl(repoUrl)
  if (!hasKey || repo.kind !== 'https' || repo.host === undefined) return repo.raw
  const host = repo.host.split(':')[0]
  if (!SSH_HOSTS.has(host)) return repo.raw
  return 'git@' + host + ':' + repo.path + '.git'
}

/**
 * Canonical comparison key for a repository URL, tolerant of the common .git
 * suffix, scheme (https vs ssh), host case, and trailing slashes.
 * @param raw - any repository URL.
 * @returns the canonical form; unparseable input falls back to a lowercased trim.
 */
export function canonicalRepoUrl(raw: string): string {
  try {
    return parseRepoUrl(raw).canonical
  } catch {
    return raw.trim().toLowerCase()
  }
}

/** Resolve where the SSH identity comes from. */
async function inspectKey(state: SyncState): Promise<KeyStatus> {
  const hasStoredKey = await fileExists(storedKeyFile())
  if (state.keyPath !== '') {
    let candidate: string | undefined
    try {
      candidate = expandPath(state.keyPath)
    } catch {
      candidate = undefined
    }
    if (candidate !== undefined && isAbsolute(candidate) && await fileExists(candidate)) {
      return { keySource: 'path', hasStoredKey, keyFile: resolve(candidate) }
    }
  }
  if (hasStoredKey) return { keySource: 'stored', hasStoredKey, keyFile: storedKeyFile() }
  return { keySource: 'none', hasStoredKey, keyFile: undefined }
}

/** Inspect a target checkout for the status route. */
async function inspectTarget(target: string): Promise<TargetInfo> {
  const kind = await pathKind(target)
  if (!kind.isDirectory) {
    return { exists: kind.exists, isRepo: false, branch: null, commit: null, dirty: false, skills: 0, skillNames: [] }
  }
  const counted = await countSkills(target)
  if (!await isGitRepository(target)) {
    return { exists: true, isRepo: false, branch: null, commit: null, dirty: false, ...counted }
  }
  const branch = await revParse(target, ['--abbrev-ref', 'HEAD'])
  const commit = await revParse(target, ['--short', 'HEAD'])
  const status = await runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd: target })
  return {
    exists: true,
    isRepo: true,
    branch: branch ?? null,
    commit: commit ?? null,
    dirty: status.code === 0 && status.stdout.trim() !== '',
    ...counted,
  }
}

/**
 * Count nested SKILL.md files and name the first-level directories that contain
 * at least one, which is the skill set the catalog will see.
 * @param target - target directory.
 * @returns the recursive skill count and first-level skill names.
 */
async function countSkills(target: string): Promise<SkillCount> {
  let skills = 0
  const skillNames = new Set<string>()
  const queue: { dir: string; top: string | undefined; depth: number }[] = [{ dir: target, top: undefined, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.pop() as { dir: string; top: string | undefined; depth: number }
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'SKILL.md') {
        skills += 1
        if (current.top !== undefined) skillNames.add(current.top)
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      if (current.depth >= MAX_SCAN_DEPTH) continue
      queue.push({ dir: join(current.dir, entry.name), top: current.top ?? entry.name, depth: current.depth + 1 })
    }
  }
  return { skills, skillNames: [...skillNames].sort() }
}

/** Whether a directory is the root of a git work tree. */
async function isGitRepository(dir: string): Promise<boolean> {
  const outcome = await runGit(['rev-parse', '--git-dir'], { cwd: dir })
  return outcome.code === 0
}

/** Read one git rev-parse value. */
async function revParse(dir: string, args: readonly string[]): Promise<string | undefined> {
  const outcome = await runGit(['rev-parse', ...args], { cwd: dir })
  if (outcome.code !== 0) return undefined
  const value = outcome.stdout.trim()
  return value === '' ? undefined : value
}

/** The current branch name, or undefined on a detached HEAD / non-repo. */
async function currentBranch(dir: string): Promise<string | undefined> {
  return revParse(dir, ['--abbrev-ref', 'HEAD'])
}

/** The origin remote URL, when one is configured. */
async function originUrl(dir: string): Promise<string | undefined> {
  const outcome = await runGit(['config', '--get', 'remote.origin.url'], { cwd: dir })
  if (outcome.code !== 0) return undefined
  const value = outcome.stdout.trim()
  return value === '' ? undefined : value
}

/**
 * Run one git command without a shell, with prompts disabled and a bounded
 * timeout. A configured key becomes GIT_SSH_COMMAND; the key's content is never
 * part of the argument vector.
 * @param args - git arguments.
 * @param options - working directory and optional SSH identity path.
 * @returns the normalized outcome; it never rejects for a non-zero exit.
 */
function runGit(args: readonly string[], options: { cwd?: string; keyFile?: string } = {}): Promise<GitOutcome> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (options.keyFile !== undefined) env.GIT_SSH_COMMAND = sshCommand(options.keyFile)
  return new Promise((resolvePromise) => {
    execFile('git', [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      // execFile reports success as a null error; only a non-null error carries
      // an exit code, a signal, or a spawn failure.
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; message?: string }) | null
      const code = failure === null ? 0 : failure.code
      resolvePromise({
        code: typeof code === 'number' ? code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        timedOut: failure?.killed === true,
        spawnError: typeof code === 'string' ? (code + ': ' + (failure?.message ?? '')).trim() : undefined,
      })
    })
  })
}

/** Build the SSH command that supplies one identity file, quoted for git's shell. */
function sshCommand(keyFile: string): string {
  return 'ssh -i ' + shellQuote(keyFile) + ' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new'
}

/** Single-quote one value for a POSIX shell. */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** The last useful line of a failed git command. */
function gitDetail(outcome: GitOutcome): string {
  if (outcome.timedOut) return '命令超过 ' + Math.round(GIT_TIMEOUT_MS / 1000) + 's 未完成'
  return outcome.spawnError ?? logLines(outcome).at(-1) ?? '退出码 ' + (outcome.code ?? '未知')
}

/**
 * Turn a failed git command into a sanitized route failure.
 * @param label - what the command was doing.
 * @param outcome - failed command outcome.
 * @returns an error carrying the last useful line and the sanitized log.
 */
function gitFailure(label: string, outcome: GitOutcome): UiError {
  return new UiError(label + '：' + gitDetail(outcome), 500, logLines(outcome))
}

/** Sanitized git output lines: ANSI stripped, blank lines dropped, tail kept. */
function logLines(outcome: GitOutcome): string[] {
  const text = outcome.stderr + '\n' + outcome.stdout
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-MAX_LOG_LINES)
}

/** Build a failure response from a thrown value. */
function failure(ctx: Context, error: unknown, label: string, at?: string): Response {
  const message = errorMessage(error)
  ctx.logger.warn('utils-main repo-sync: ' + label + '：' + message)
  const log = error instanceof UiError ? error.log : undefined
  return json({
    error: message,
    ...(at === undefined ? {} : { at }),
    ...(log !== undefined && log.length > 0 ? { log } : {}),
  }, errorStatus(error))
}

/** HTTP status for a thrown value. */
function errorStatus(error: unknown): number {
  return error instanceof UiError ? error.status : 500
}

/** Whether a path is a regular file. */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Whether a path exists and, when it does, whether it is a directory. */
async function pathKind(path: string): Promise<PathKind> {
  try {
    const info = await stat(path)
    return { exists: true, isDirectory: info.isDirectory() }
  } catch (error) {
    if (isAbsent(error)) return { exists: false, isDirectory: false }
    throw error
  }
}

/** Read the durable state, falling back field by field to the defaults. */
async function readState(): Promise<SyncState> {
  const defaults = defaultState()
  let raw: string
  try {
    raw = await readFile(statePath(), 'utf8')
  } catch {
    return defaults
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaults
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults
  const record = parsed as Record<string, unknown>
  return {
    repoUrl: storedRepoUrl(record.repoUrl, defaults.repoUrl),
    branch: storedBranch(record.branch, defaults.branch),
    keyPath: storedKeyPathValue(record.keyPath),
    targetDir: storedTargetDir(record.targetDir, defaults.targetDir),
    recurseSubmodules: typeof record.recurseSubmodules === 'boolean' ? record.recurseSubmodules : defaults.recurseSubmodules,
    lastSync: storedLastSync(record.lastSync),
  }
}

/** One stored repository URL, or the default when absent or invalid. */
function storedRepoUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  try {
    return parseRepoUrl(value).raw
  } catch {
    return fallback
  }
}

/** One stored branch, or the default when absent or invalid. */
function storedBranch(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  try {
    return validateBranch(value)
  } catch {
    return fallback
  }
}

/** One stored key path; a hand-edited path that no longer validates is ignored. */
function storedKeyPathValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (raw === '' || hasControlCharacters(raw)) return ''
  try {
    expandPath(raw)
  } catch {
    return ''
  }
  return raw
}

/** One stored target directory, or the default when absent or invalid. */
function storedTargetDir(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  try {
    return resolveTargetDir(value)
  } catch {
    return fallback
  }
}

/** One stored last-sync record, or null when absent or malformed. */
function storedLastSync(value: unknown): SyncRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.at !== 'string' || record.at === '') return null
  if (typeof record.ok !== 'boolean') return null
  return {
    at: record.at,
    ok: record.ok,
    commit: typeof record.commit === 'string' ? record.commit : '',
    skills: typeof record.skills === 'number' && Number.isFinite(record.skills) ? record.skills : 0,
    message: typeof record.message === 'string' ? record.message : '',
  }
}

/** Persist the durable state atomically with mode 600. */
async function writeState(state: SyncState): Promise<void> {
  await writePrivateFile(statePath(), JSON.stringify(state, null, 2) + '\n')
}

/** Record one sync outcome without clobbering configuration edited meanwhile. */
async function recordSync(ctx: Context, record: SyncRecord): Promise<void> {
  try {
    const state = await readState()
    state.lastSync = record
    await writeState(state)
  } catch (error) {
    ctx.logger.warn('utils-main repo-sync: cannot record sync state: ' + errorMessage(error))
  }
}

/**
 * Write one private file atomically: a random-suffix sibling is created with
 * mode 600 and renamed over the target, so a reader sees either the old or the
 * new complete content and the replacement keeps mode 600.
 * @param file - final path.
 * @param content - complete next content.
 */
async function writePrivateFile(file: string, content: string): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp'
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  await chmod(file, 0o600)
}

/** Resolve $DSH_HOME, falling back to ~/.dsh. */
function dshHome(): string {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim())
  return join(homedir(), '.dsh')
}

/** $DSH_HOME/storages. */
function storageDir(): string {
  return join(dshHome(), STORAGE_DIR_NAME)
}

/** The durable settings file. */
function statePath(): string {
  return join(storageDir(), STATE_FILE_NAME)
}

/** The stored deploy key file. */
function storedKeyFile(): string {
  return join(storageDir(), KEY_FILE_NAME)
}

/** Parse one buffered JSON request body, with a size cap. */
async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT_BYTES) throw new UiError('请求体过大', 413)
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new UiError('请求体不是合法 JSON', 400)
  }
}

/** Build one JSON response with no-store caching. */
function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/** Whether an fs error means the path is simply absent. */
function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR')
}

/** Render an unknown error for a log line or route payload. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
