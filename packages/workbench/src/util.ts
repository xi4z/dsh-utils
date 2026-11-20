/**
 * Shared utilities for the dsh-utils preset workbench.
 *
 * The workbench owns one component that merges three former sidebar surfaces:
 * the preset skill list, the per-preset Git skill repository, and the Markdown
 * editor. All filesystem access is funneled through the helpers here so the
 * route handlers can stay small and the path rules stay in one place.
 *
 * @module dsh-utils/workbench/util
 */

import { randomBytes } from 'node:crypto'
import { lstat, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Absolute ceiling for one request body. */
export const BODY_LIMIT_BYTES = 8 * 1024 * 1024

/** Default per-file read/write limit. */
export const DEFAULT_MAX_BYTES = 512 * 1024

/** The pseudo preset that edits the user/project AGENTS.md chain. */
export const GLOBAL_PRESET = '__global__'

/** Directory names never entered while scanning preset Markdown or skills. */
export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.temp', '.tmp', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.dsh-utils'])

/** Project-level instruction file names, matching the shipped loader. */
export const AGENTS_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'] as const

/** Volatile Config fields arrive as live references; get() snapshots. */
export interface VolatileRef<T> {
  get(): T
}

/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
export type MaybeRef<T> = T | VolatileRef<T>

/** Raw row config accepted by the component. */
export interface WorkbenchConfig {
  readonly maxBytes?: MaybeRef<number>
  readonly presetDirs?: MaybeRef<readonly string[]>
  readonly presetSourceDirs?: MaybeRef<readonly string[]>
  readonly extraAgentsFiles?: MaybeRef<readonly string[]>
  readonly scanNestedAgents?: MaybeRef<boolean>
  readonly nestedDepth?: MaybeRef<number>
  readonly defaultRepoUrl?: MaybeRef<string>
  readonly defaultBranch?: MaybeRef<string>
}

/** Normalized settings with defaults applied. */
export interface Options {
  readonly maxBytes: number
  readonly presetDirs: string[]
  readonly presetSourceDirs: string[]
  readonly extraAgentsFiles: string[]
  readonly scanNestedAgents: boolean
  readonly nestedDepth: number
  readonly defaultRepoUrl: string
  readonly defaultBranch: string
}

/** One command failure with the HTTP status it should answer with. */
export class WorkbenchError extends Error {
  readonly status: number

  /**
   * @param message - user-facing, sanitized message.
   * @param status - HTTP status the route answers with.
   */
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WorkbenchError'
    this.status = status
  }
}

/** One skill inside a preset skills directory. */
export interface SkillRow {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly enabled: boolean
  readonly size: number
  readonly mtimeMs: number | null
}

/** One file the Markdown view can open. */
export interface FileRow {
  readonly id: string
  readonly label: string
  readonly path: string
  readonly presetId: string
  readonly kind: 'agents' | 'skill' | 'reference' | 'global'
  readonly scope?: string
  readonly exists: boolean
  readonly editable: boolean
  readonly size: number
  readonly mtimeMs: number | null
}

/** One preset directory as the panel lists it. */
export interface PresetInfo {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
  readonly skills: SkillRow[]
  readonly agents: FileRow
  readonly registered?: boolean
  readonly broken?: string
}

/** One recorded sync attempt. */
export interface SyncRecord {
  readonly at: string
  readonly ok: boolean
  readonly commit: string
  readonly skills: number
  readonly message: string
}

/** Durable per-preset repository configuration. */
export interface RepoState {
  repoUrl: string
  branch: string
  targetSubdir: string
  keyPath: string
  recurseSubmodules: boolean
  lastSync: SyncRecord | null
}

/** The target checkout as the repo view reports it. */
export interface TargetStatus {
  exists: boolean
  isRepo: boolean
  branch: string | null
  commit: string | null
  dirty: boolean
  skills: number
}

/** Normalize the volatile row settings once per request. */
export function normalizeOptions(config: WorkbenchConfig | undefined): Options {
  return {
    maxBytes: clamp(refValue(config?.maxBytes, DEFAULT_MAX_BYTES), 1024, BODY_LIMIT_BYTES),
    presetDirs: stringList(refValue(config?.presetDirs, [])),
    presetSourceDirs: stringList(refValue(config?.presetSourceDirs, [])),
    extraAgentsFiles: stringList(refValue(config?.extraAgentsFiles, [])),
    scanNestedAgents: refValue(config?.scanNestedAgents, false) === true,
    nestedDepth: clamp(refValue(config?.nestedDepth, 3), 1, 8),
    defaultRepoUrl: stringValue(refValue(config?.defaultRepoUrl, 'https://github.com/xi4z/skills'), 'https://github.com/xi4z/skills'),
    defaultBranch: stringValue(refValue(config?.defaultBranch, 'Agent'), 'Agent'),
  }
}

/**
 * Snapshot one live Config field.
 * @param value - plain value or volatile reference.
 * @param fallback - default.
 * @returns the plain value.
 */
export function refValue<T>(value: MaybeRef<T> | undefined, fallback: T): T {
  if (value === undefined) return fallback
  if (value !== null && typeof value === 'object' && typeof (value as VolatileRef<T>).get === 'function') {
    try {
      return (value as VolatileRef<T>).get()
    } catch {
      return fallback
    }
  }
  return value as T
}

/** Clamp one numeric setting. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** One non-empty string setting or its fallback. */
function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Trim, drop empty entries, and de-duplicate one string list. */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** $DSH_HOME, falling back to ~/.dsh. */
export function dshHome(): string {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim())
  return join(homedir(), '.dsh')
}

/** $DSH_AGENTS_HOME, falling back to ~/.agents. */
export function agentsHome(): string {
  const override = process.env.DSH_AGENTS_HOME
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim())
  return join(homedir(), '.agents')
}

/** $DSH_HOME/storages/dsh-utils-workbench. */
export function workbenchStorageDir(): string {
  return join(dshHome(), 'storages', 'dsh-utils-workbench')
}

/** All configured preset roots, defaults first. */
export function presetRoots(options: Options): string[] {
  const roots = new Set<string>([join(dshHome(), '.agent-presets'), join(agentsHome(), '.agent-presets')])
  for (const raw of options.presetDirs) {
    try {
      roots.add(expandAbsolute(raw))
    } catch {
      // An invalid extra root is ignored at list time.
    }
  }
  return [...roots]
}

/** Stable storage name for one preset id. */
export function presetStorageName(id: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..') return id
  return Buffer.from(id, 'utf8').toString('base64url')
}

/**
 * Expand a configured path to an absolute path.
 * @param raw - configured value; ~ and $VAR / braced VAR are expanded.
 * @returns absolute path.
 */
export function expandAbsolute(raw: string): string {
  let value = raw.trim()
  if (value === '') throw new Error('路径为空')
  if (value === '~') value = homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(2))
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match: string, braced: string | undefined, bare: string | undefined) => {
    const variable = braced ?? bare ?? ''
    const resolved = process.env[variable]
    if (resolved === undefined) throw new Error('环境变量 ' + variable + ' 未设置')
    return resolved
  })
  if (!isAbsolute(value)) throw new Error('必须是绝对路径')
  return resolve(value)
}

/** Join a relative path under a root and refuse escapes. */
export function insideJoin(root: string, rel: string): string {
  if (rel === '' || rel.includes('\u0000')) throw new WorkbenchError('相对路径不合法', 400)
  if (isAbsolute(rel)) throw new WorkbenchError('相对路径不能是绝对路径', 400)
  const base = resolve(root)
  const path = resolve(base, rel)
  if (!isInside(base, path) || path === base) throw new WorkbenchError('路径越界', 400)
  return path
}

/** Whether a path is strictly inside a directory. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Whether a directory exists and is a directory. */
export async function directoryOf(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Whether any path exists (file, directory, or symlink). */
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Recursively collect paths under one directory with a depth bound. */
export async function walkFiles(
  dir: string,
  depth: number,
  ignored: Set<string>,
  visit: (path: string) => void,
  ctx: Context,
): Promise<void> {
  if (depth < 0) return
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.debug('workbench: cannot scan ' + dir + ': ' + errorMessage(error))
    return
  }
  items.sort((left, right) => left.name.localeCompare(right.name))
  for (const item of items) {
    if (ignored.has(item.name)) continue
    const path = join(dir, item.name)
    if (item.isDirectory()) {
      await walkFiles(path, depth - 1, ignored, visit, ctx)
    } else if (item.isFile() || item.isSymbolicLink()) {
      visit(path)
    }
  }
}

/** Build one file row for an existing or missing path. */
export async function fileRow(id: string, label: string, path: string, presetId: string, kind: FileRow['kind']): Promise<FileRow> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = await directoryOf(dirname(path))
    return { id, label, path, presetId, kind, exists: false, editable: parent, size: 0, mtimeMs: null }
  }
  const parent = await directoryOf(dirname(path))
  return {
    id,
    label,
    path,
    presetId,
    kind,
    exists: true,
    editable: parent && info.isFile(),
    size: info.isFile() ? info.size : 0,
    mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : null,
  }
}

/** Read one file, refusing oversized files and non-regular files. */
export async function readTextFile(path: string, maxBytes: number): Promise<{ content: string; row: FileRow }> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new WorkbenchError('拒绝读取符号链接', 409)
  if (!info.isFile()) throw new WorkbenchError('目标不是普通文件', 409)
  if (info.size > maxBytes) throw new WorkbenchError('文件超过 ' + maxBytes + ' 字节上限', 413)
  const content = await readFile(path, 'utf8')
  return { content, row: await fileRow('', basename(path), path, '', 'reference') }
}

/**
 * Write one file atomically, preserving mode and detecting a stale browser
 * copy. A missing file is created when baseMtimeMs is null.
 */
export async function writeTextFile(path: string, content: string, baseMtimeMs: number | null, maxBytes: number): Promise<{ bytes: number; mtimeMs: number | null }> {
  if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new WorkbenchError('内容超过 ' + maxBytes + ' 字节上限', 413)
  if (content.includes('\u0000')) throw new WorkbenchError('内容不能包含 NUL 字符', 400)
  let existing
  try {
    existing = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== undefined && existing.isSymbolicLink()) throw new WorkbenchError('拒绝写入符号链接，避免改到链接目标', 409)
  if (existing !== undefined && !existing.isFile()) throw new WorkbenchError('目标不是普通文件', 409)
  if (existing !== undefined && baseMtimeMs !== null && Math.abs(existing.mtimeMs - baseMtimeMs) > 1) {
    throw new WorkbenchError('文件已在别处修改，请重读后再保存', 409)
  }
  if (existing === undefined && baseMtimeMs !== null) throw new WorkbenchError('文件已被删除，请刷新文件列表', 409)
  const directory = dirname(path)
  if (!(await directoryOf(directory))) throw new WorkbenchError('目标目录不存在', 409)
  const mode = existing !== undefined ? existing.mode & 0o777 : 0o644
  const temp = join(directory, '.' + basename(path) + '.' + randomBytes(6).toString('hex') + '.tmp')
  try {
    await writeFile(temp, content, { mode, flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    if (process.platform === 'win32' && existing !== undefined) {
      await writeFile(path, content, { mode })
    } else {
      throw error
    }
  }
  const after = await stat(path)
  return { bytes: Buffer.byteLength(content, 'utf8'), mtimeMs: Number.isFinite(after.mtimeMs) ? after.mtimeMs : null }
}

/** Parse one buffered JSON request body, with a size cap. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT_BYTES) throw new WorkbenchError('请求体过大', 413)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new WorkbenchError('请求体不是合法 JSON', 400)
  }
}

/** Trimmed non-empty text, or null. */
export function optionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/** Required trimmed text. */
export function requiredText(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new WorkbenchError(message, 400)
  const text = value.trim()
  if (text === '') throw new WorkbenchError(message, 400)
  return text
}

/** Build one JSON response. */
export function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/** Map an error to the route's JSON failure shape. */
export function failure(ctx: Context, action: string, error: unknown): Response {
  if (error instanceof WorkbenchError) return json({ error: error.message }, error.status)
  ctx.logger.warn('workbench: ' + action + ': ' + errorMessage(error))
  return json({ error: errorMessage(error) }, 500)
}

/** Render an unknown error for a log line or route payload. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the session working directory with the same fallbacks as the skill panel. */
export async function resolveCwd(ctx: Context, sessionId: string | null, signal: AbortSignal): Promise<string> {
  const agent = sessionId === null ? undefined : agentOf(ctx, sessionId)
  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  if (agent !== undefined && workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
    try {
      const cwd = await (workingDirectory.ensure as (agent: unknown, signal?: AbortSignal) => Promise<unknown>)(agent, signal)
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch (error) {
      ctx.logger.debug('workbench: working directory lookup failed: ' + errorMessage(error))
    }
  }
  const header = agentHeader(agent)
  const sessionCwd = header.cwd
  if (typeof sessionCwd === 'string' && sessionCwd !== '') return sessionCwd
  const fallback = workingDirectory?.defaultDirectory
  if (typeof fallback === 'string' && fallback !== '') return fallback
  return process.cwd()
}

/** The preset id recorded on the live session, when the host exposes it. */
export function sessionPresetOf(ctx: Context, sessionId: string | null): string | null {
  if (sessionId === null) return null
  const preset = agentHeader(agentOf(ctx, sessionId)).agentPreset
  return typeof preset === 'string' && preset !== '' ? preset : null
}

/** The session fields this component reads. */
function agentHeader(agent: Record<string, any> | undefined): Record<string, any> {
  return agent?.session?.header ?? {}
}

/** Read one host service defensively. */
export function serviceOf(ctx: Context, name: string): Record<string, any> | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name) as Record<string, any> | undefined
  } catch {
    return undefined
  }
}

/** Resolve a live Agent for a session id. */
export function agentOf(ctx: Context, sessionId: string): Record<string, any> | undefined {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || typeof agents.get !== 'function') return undefined
  try {
    return (agents.get as (id: string) => Record<string, any> | undefined)(sessionId)
  } catch {
    return undefined
  }
}

/** Project root: the nearest ancestor holding .git, else the working directory. */
export async function findProjectRoot(cwd: string): Promise<string> {
  let dir = resolve(cwd)
  for (let step = 0; step < 64; step += 1) {
    if (await exists(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(cwd)
}

/** Directories from the project root down to the working directory. */
export function projectChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let dir = resolve(cwd)
  for (let step = 0; step < 64; step += 1) {
    chain.push(dir)
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (!chain.includes(root)) chain.push(root)
  return chain.reverse()
}

/** Human-readable scope label for one directory. */
export function scopeOf(dir: string, cwd: string, root: string): string {
  if (dir === cwd) return '当前目录'
  if (dir === root) return '项目根'
  const rel = relative(root, dir)
  return rel === '' ? '项目根' : rel.split(sep).join('/')
}

/** Base64url encode one id component. */
export function encodeIdPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Decode one id component, rejecting non-canonical spellings. */
export function decodeIdPart(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new WorkbenchError('文件 id 不合法', 400)
  const text = Buffer.from(value, 'base64url').toString('utf8')
  if (encodeIdPart(text) !== value) throw new WorkbenchError('文件 id 不合法', 400)
  return text
}
