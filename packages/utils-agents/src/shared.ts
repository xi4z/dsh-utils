/**
 * Shared preset sources for the utils-agents panel.
 *
 * A skill repository may carry a ".dsh" directory that mirrors part of the DSH
 * home, so presets can travel with the skills instead of being copied by hand.
 * This module discovers those presets and copies them into
 * "$DSH_HOME/.agent-presets"; the existing legacy bridge then registers the
 * result as real Agent presets.
 *
 * Accepted layouts inside one repository root:
 *
 * - ".dsh/preset/<id>/" (canonical)
 * - ".dsh/preset/" itself when it holds "preset.yml" or "agent.cordis.yml"
 * - ".dsh/presets/<id>/" and ".dsh/.agent-presets/<id>/" (tolerated aliases)
 * - ".dsh/<id>/" when the directory holds "preset.yml" or "agent.cordis.yml"
 *
 * Sources are read-only: the repository checkout is never modified. Writes are
 * limited to the local preset home, and a removed source file is only deleted
 * when the caller asks for a pruning sync.
 *
 * @module dsh-utils/utils-agents/shared
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { scanSkills } from './presets.js'
import { readRepoState, targetPath } from './git.js'
import { readUtilsConfig } from './utils-config.js'
import {
  BODY_LIMIT_BYTES,
  IGNORED_DIRS,
  AgentsError,
  directoryOf,
  dshHome,
  errorMessage,
  exists,
  expandAbsolute,
  insideJoin,
  isInside,
  stringList,
  agentsStorageDir,
  type Options,
  type PresetInfo,
} from './util.js'

/** Per-file copy ceiling; larger files are skipped, not truncated. */
const SHARED_MAX_BYTES = BODY_LIMIT_BYTES

/** Directories never copied out of a source repository. */
const IGNORED_SHARED_DIRS = new Set([...IGNORED_DIRS, '.dsh-utils'])

/** Local-only trees that a pruning sync never deletes. */
const LOCAL_ONLY_DIRS = new Set(['.dsh-utils', '.git'])

/** Ids the panel reserves for its own pseudo target. */
const RESERVED_IDS = new Set(['__global__'])

/** Status of one source preset against the local preset home. */
export type SharedStatus = 'new' | 'update' | 'same' | 'invalid'

/** Where a source repository came from. */
export type SharedSourceKind = 'preset-repo' | 'global-repo' | 'skills-home' | 'extra'

/** One preset found in a shared repository. */
export interface SharedPresetView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly status: SharedStatus
  readonly sourceKind: SharedSourceKind
  readonly sourceRoot: string
  readonly sourcePath: string
  readonly targetPath: string
  readonly skills: number
  readonly files: number
  readonly managed: boolean
  readonly lastSyncAt: string | null
  readonly reason?: string
}

/** One repository root that was scanned. */
export interface SharedSourceView {
  readonly path: string
  readonly kind: SharedSourceKind
  readonly exists: boolean
  readonly presets: SharedPresetView[]
}

/** The complete shared-preset view returned to the browser. */
export interface SharedListView {
  readonly localRoot: string
  readonly sources: SharedSourceView[]
}

/** One record remembered from a previous sync. */
interface ManagedPreset {
  readonly source: string
  readonly syncedAt: string
  readonly files: string[]
}

/** The on-disk sync manifest. */
interface SharedManifest {
  readonly version: 1
  readonly presets: Record<string, ManagedPreset>
}

/** Outcome for one preset sync. */
export interface SharedSyncResult {
  readonly id: string
  readonly status: SharedStatus
  readonly written: number
  readonly removed: number
  readonly skipped: string[]
  readonly error?: string
}

/** The response of one sync request. */
export interface SharedSyncPayload {
  readonly results: SharedSyncResult[]
  readonly view: SharedListView
}

/** One source file to copy. */
interface SourceFile {
  readonly rel: string
  readonly path: string
  readonly mode: number
  readonly size: number
}

/**
 * Scan every known repository for ".dsh" presets.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @param preset - the selected preset, whose synced checkout is also a source.
 * @returns the source roots with their preset rows.
 */
export async function sharedPresetView(ctx: Context, options: Options, preset: PresetInfo | null): Promise<SharedListView> {
  const localRoot = join(dshHome(), '.agent-presets')
  const manifest = await readManifest()
  const sources: SharedSourceView[] = []
  const seen = new Set<string>()
  for (const source of await presetSources(options, preset)) {
    const key = await canonicalPath(source.path)
    if (seen.has(key)) continue
    seen.add(key)
    if (!(await directoryOf(source.path))) {
      sources.push({ path: source.path, kind: source.kind, exists: false, presets: [] })
      continue
    }
    sources.push({
      path: source.path,
      kind: source.kind,
      exists: true,
      presets: await discoverSourcePresets(ctx, source.path, source.kind, manifest),
    })
  }
  return { localRoot, sources }
}

/**
 * Copy the requested source presets into the DSH preset home.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @param preset - the selected preset, used to locate its repository checkout.
 * @param body - request body with optional "ids" and "prune".
 * @returns per-preset results plus the refreshed view.
 */
export async function syncSharedPresets(
  ctx: Context,
  options: Options,
  preset: PresetInfo | null,
  body: Record<string, unknown>,
): Promise<SharedSyncPayload> {
  const requested = stringList(body.ids)
  const prune = body.prune === true
  const manifest = await readManifest()
  const view = await sharedPresetView(ctx, options, preset)
  const all = view.sources.flatMap((source) => source.presets)
  const targets = requested.length === 0 ? all : all.filter((row) => requested.includes(row.id))
  if (requested.length > 0 && targets.length === 0) throw new AgentsError('没有找到要同步的预设：' + requested.join(', '), 404)

  const results = await copyPresetRows(ctx, targets, prune, manifest)
  if (results.some((result) => result.error === undefined)) await writeManifest(manifest)
  return { results, view: await sharedPresetView(ctx, options, preset) }
}

/** Payload of one automatic preset pass. */
export interface AutoPresetSyncPayload extends SharedSyncPayload {
  /** Preset ids whose local copy was removed because the repository dropped them. */
  readonly removed: string[]
}

/**
 * Mirror the presets carried by the configured Skill repositories into the
 * preset home.
 *
 * The repository is the only source of truth: new and outdated presets are
 * copied, and a preset the repository no longer carries is removed locally when
 * an earlier pass synced it (the manifest records that ownership). Built-in
 * presets and presets that only ever existed locally are never touched, and a
 * checkout that is missing or unreadable never triggers a removal.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @returns per-preset results, removed ids, and the refreshed view.
 */
export async function autoSyncSharedPresets(ctx: Context, options: Options): Promise<AutoPresetSyncPayload> {
  const manifest = await readManifest()
  const view = await sharedPresetView(ctx, options, null)
  const repoRoots = view.sources
    .filter((source) => source.kind === 'global-repo' && source.exists)
    .map((source) => source.path)
  const carried = new Set<string>()
  for (const source of view.sources) {
    if (source.kind !== 'global-repo' || !source.exists) continue
    for (const preset of source.presets) carried.add(preset.id)
  }

  const removed: string[] = []
  const localRoot = join(dshHome(), '.agent-presets')
  for (const [id, entry] of Object.entries(manifest.presets)) {
    if (carried.has(id) || options.builtinPresets.includes(id) || RESERVED_IDS.has(id)) continue
    if (entry.source === '' || !repoRoots.some((root) => entry.source === root || isInside(root, entry.source))) continue
    delete manifest.presets[id]
    const target = join(localRoot, id)
    if (!(await directoryOf(target))) continue
    try {
      await rm(target, { recursive: true, force: true })
      removed.push(id)
    } catch (error) {
      ctx.logger.warn('utils-agents: cannot remove preset ' + id + ' dropped by the repository: ' + errorMessage(error))
    }
  }

  const targets = view.sources
    .filter((source) => source.kind === 'global-repo' && source.exists)
    .flatMap((source) => source.presets)
    .filter((row) => !options.builtinPresets.includes(row.id))
    .filter((row) => row.status === 'new' || row.status === 'update')
  // A preset that is already identical must still be recorded as managed, or a
  // later repository deletion could not be told apart from a local-only preset.
  let ownershipChanged = false
  for (const source of view.sources) {
    if (source.kind !== 'global-repo' || !source.exists) continue
    for (const row of source.presets) {
      if (row.status !== 'same' || options.builtinPresets.includes(row.id)) continue
      if (manifest.presets[row.id] !== undefined) continue
      const files = (await collectFiles(ctx, row.sourcePath)).map((file) => file.rel)
      manifest.presets[row.id] = { source: row.sourceRoot, syncedAt: new Date().toISOString(), files }
      ownershipChanged = true
    }
  }
  const results = targets.length === 0 ? [] : await copyPresetRows(ctx, targets, false, manifest)
  if (ownershipChanged || removed.length > 0 || results.some((result) => result.error === undefined)) {
    await writeManifest(manifest)
  }
  return { results, removed, view: await sharedPresetView(ctx, options, null) }
}

/** Copy one scanned batch, recording each outcome in the manifest. */
async function copyPresetRows(
  ctx: Context,
  rows: readonly SharedPresetView[],
  prune: boolean,
  manifest: SharedManifest,
): Promise<SharedSyncResult[]> {
  const results: SharedSyncResult[] = []
  for (const row of rows) {
    if (row.status === 'invalid') {
      results.push({ id: row.id, status: row.status, written: 0, removed: 0, skipped: [], error: row.reason ?? '预设 id 不合法' })
      continue
    }
    try {
      const previous = manifest.presets[row.id]?.files ?? []
      const outcome = await copyPreset(ctx, row, prune, previous)
      manifest.presets[row.id] = { source: row.sourceRoot, syncedAt: new Date().toISOString(), files: outcome.files }
      results.push({ id: row.id, status: row.status, written: outcome.written, removed: outcome.removed, skipped: outcome.skipped })
    } catch (error) {
      const message = errorMessage(error)
      ctx.logger.warn('utils-agents: cannot sync shared preset ' + row.id + ': ' + message)
      results.push({ id: row.id, status: row.status, written: 0, removed: 0, skipped: [], error: message })
    }
  }
  return results
}

/** The storage path of the shared-preset manifest. */
export function sharedManifestPath(): string {
  return join(agentsStorageDir(), 'shared-presets.json')
}

/** Normalize one preset directory name into a safe id, or null. */
export function sharedPresetId(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return null
  if (name.startsWith('.') || RESERVED_IDS.has(name)) return null
  if (name.includes('/') || name.includes('\\') || name.includes(String.fromCharCode(0))) return null
  return name
}

/** Candidate directories inside one scanned repository. */
async function sharedLayouts(root: string): Promise<string[]> {
  const candidates = [
    join(root, '.dsh', 'preset'),
    join(root, '.dsh', 'presets'),
    join(root, '.dsh', '.agent-presets'),
    join(root, '.dsh'),
  ]
  const out: string[] = []
  for (const candidate of candidates) {
    if (await directoryOf(candidate)) out.push(candidate)
  }
  return out
}

/** Discover the presets inside one repository root. */
async function discoverSourcePresets(
  ctx: Context,
  root: string,
  kind: SharedSourceKind,
  manifest: SharedManifest,
): Promise<SharedPresetView[]> {
  const rows: SharedPresetView[] = []
  const seen = new Set<string>()
  const seenPaths = new Set<string>()
  for (const layout of await sharedLayouts(root)) {
    let entries
    try {
      entries = await readdir(layout, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.debug('utils-agents: cannot read shared layout ' + layout + ': ' + errorMessage(error))
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const sourcePath = join(layout, entry.name)
      // Every candidate must carry the markers of a preset, so a skills/ tree
      // inside the layout is not mistaken for a preset.
      if (!(await looksLikePreset(sourcePath))) continue
      const id = sharedPresetId(entry.name)
      const pathKey = await canonicalPath(sourcePath)
      if (id === null || seen.has(id) || seenPaths.has(pathKey)) continue
      seen.add(id)
      seenPaths.add(pathKey)
      rows.push(await describeSourcePreset(ctx, id, sourcePath, root, kind, manifest))
    }
    // ".dsh/preset/" may also be a single preset directory instead of a parent
    // of preset directories; take its display id from preset.yml when present.
    if (await looksLikePreset(layout)) {
      const meta = await readSourceMeta(layout)
      const id = sharedPresetId(meta.id === '' ? basename(layout) : meta.id)
      const pathKey = await canonicalPath(layout)
      if (id !== null && !seen.has(id) && !seenPaths.has(pathKey)) {
        seen.add(id)
        seenPaths.add(pathKey)
        rows.push(await describeSourcePreset(ctx, id, layout, root, kind, manifest))
      }
    }
  }
  return rows
}

/** Whether a directory holds the markers of a preset. */
async function looksLikePreset(path: string): Promise<boolean> {
  return (await exists(join(path, 'preset.yml'))) || (await exists(join(path, 'agent.cordis.yml')))
}

/** Build one browser row for a source preset. */
async function describeSourcePreset(
  ctx: Context,
  id: string,
  sourcePath: string,
  sourceRoot: string,
  kind: SharedSourceKind,
  manifest: SharedManifest,
): Promise<SharedPresetView> {
  const meta = await readSourceMeta(sourcePath)
  const skills = await scanSkills(ctx, sourcePath)
  const files = await collectFiles(ctx, sourcePath)
  const targetPath = join(dshHome(), '.agent-presets', id)
  const managed = manifest.presets[id] !== undefined
  const status = await comparePreset(files, targetPath)
  return {
    id,
    name: meta.name === '' ? id : meta.name,
    description: meta.description,
    status,
    sourceKind: kind,
    sourceRoot,
    sourcePath,
    targetPath,
    skills: skills.filter((skill) => skill.enabled).length,
    files: files.length,
    managed,
    lastSyncAt: managed ? manifest.presets[id].syncedAt : null,
  }
}

/** Read the preset display metadata without a YAML dependency. */
async function readSourceMeta(presetPath: string): Promise<{ id: string; name: string; description: string }> {
  let text
  try {
    text = await readFile(join(presetPath, 'preset.yml'), 'utf8')
  } catch {
    return { id: '', name: '', description: '' }
  }
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = match[2].trim()
    values[match[1]] = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])
      ? value.slice(1, -1)
      : value
  }
  return { id: values.id ?? '', name: values.name ?? '', description: values.description ?? '' }
}

/** Compare every source file with its local copy. */
async function comparePreset(files: SourceFile[], targetPath: string): Promise<SharedStatus> {
  if (!(await directoryOf(targetPath))) return 'new'
  for (const file of files) {
    const target = join(targetPath, file.rel)
    let info
    try {
      info = await lstat(target)
    } catch {
      return 'update'
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) return 'update'
    if (await hashFile(target) !== await hashFile(file.path)) return 'update'
  }
  return 'same'
}

/** Every regular file under one source preset, relative to its root. */
async function collectFiles(ctx: Context, root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  await walkSource(root, root, ctx, out)
  return out.sort((left, right) => left.rel.localeCompare(right.rel))
}

/** Recursively collect regular files, skipping symlinks and ignored trees. */
async function walkSource(root: string, dir: string, ctx: Context, out: SourceFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.debug('utils-agents: cannot scan shared preset ' + dir + ': ' + errorMessage(error))
    return
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (IGNORED_SHARED_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkSource(root, path, ctx, out)
      continue
    }
    if (!entry.isFile()) continue
    let info
    try {
      info = await lstat(path)
    } catch {
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) continue
    if (info.size > SHARED_MAX_BYTES) {
      ctx.logger.warn('utils-agents: skipping oversized shared preset file ' + path)
      continue
    }
    out.push({ rel: relative(root, path).split(sep).join('/'), path, mode: info.mode & 0o777, size: info.size })
  }
}

/** Copy one preset into $DSH_HOME/.agent-presets/<id>. */
async function copyPreset(
  ctx: Context,
  row: SharedPresetView,
  prune: boolean,
  previous: string[],
): Promise<{ written: number; removed: number; skipped: string[]; files: string[] }> {
  if (sharedPresetId(row.id) === null) throw new AgentsError('预设 id 不合法：' + row.id, 400)
  const targetRoot = join(dshHome(), '.agent-presets', row.id)
  await mkdir(targetRoot, { recursive: true, mode: 0o755 })
  const files = await collectFiles(ctx, row.sourcePath)
  const skipped: string[] = []
  let written = 0
  for (const file of files) {
    const target = insideJoin(targetRoot, file.rel)
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    if (await sameContent(file.path, target)) continue
    const content = await readFile(file.path)
    await writeAtomic(target, content, file.mode)
    written += 1
  }
  const removed = prune ? await prunePreset(ctx, targetRoot, files, previous) : 0
  return { written, removed, skipped, files: files.map((file) => file.rel) }
}

/** Whether two files already carry identical bytes. */
async function sameContent(source: string, target: string): Promise<boolean> {
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) return false
    if (info.size !== (await lstat(source)).size) return false
    return await hashFile(source) === await hashFile(target)
  } catch {
    return false
  }
}

/** Remove files this source owned before but no longer publishes. */
async function prunePreset(ctx: Context, targetRoot: string, files: SourceFile[], previous: string[]): Promise<number> {
  const keep = new Set(files.map((file) => file.rel))
  const removed: string[] = []
  for (const rel of previous) {
    if (keep.has(rel)) continue
    if (LOCAL_ONLY_DIRS.has(rel.split('/')[0])) continue
    try {
      const info = await lstat(insideJoin(targetRoot, rel))
      if (!info.isFile() || info.isSymbolicLink()) continue
    } catch {
      continue
    }
    removed.push(rel)
  }
  for (const rel of removed) await rm(insideJoin(targetRoot, rel), { force: true })
  await removeEmptyDirs(ctx, targetRoot, targetRoot)
  return removed.length
}

/** Remove directories left empty by a pruning sync. */
async function removeEmptyDirs(ctx: Context, root: string, dir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (LOCAL_ONLY_DIRS.has(relative(root, path).split(sep)[0])) continue
    await removeEmptyDirs(ctx, root, path)
  }
  if (dir === root) return
  try {
    const remaining = await readdir(dir)
    if (remaining.length === 0) await rm(dir, { recursive: true, force: true })
  } catch (error) {
    ctx.logger.debug('utils-agents: cannot remove empty shared preset directory ' + dir + ': ' + errorMessage(error))
  }
}

/** Write one file through a temporary sibling, then rename. */
async function writeAtomic(target: string, content: Buffer, mode: number): Promise<void> {
  const temp = join(dirname(target), '.' + basename(target) + '.' + process.pid.toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp')
  try {
    await writeFile(temp, content, { mode: mode === 0 ? 0o644 : mode, flag: 'wx' })
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** sha256 of one file. */
async function hashFile(path: string): Promise<string> {
  const content = await readFile(path)
  return createHash('sha256').update(content).digest('hex')
}

/** The checkouts of the configured Skill repositories, from `utils.json`. */
async function configuredSkillRepoRoots(): Promise<string[]> {
  try {
    const roots = (await readUtilsConfig()).config.skillRepositories
      .map((repository) => repository.targetDir)
      .filter((path) => path !== '')
    if (roots.length > 0) return roots
  } catch {
    // A missing or malformed document falls back to the shipped default.
  }
  return [join(dshHome(), 'skills', 'utils-skill')]
}

/** The repository roots to scan, in display order. */
async function presetSources(options: Options, preset: PresetInfo | null): Promise<Array<{ path: string; kind: SharedSourceKind }>> {
  const out: Array<{ path: string; kind: SharedSourceKind }> = []
  if (preset !== null) {
    try {
      const state = await readRepoState(preset, options)
      const target = targetPath(preset, state)
      if (await directoryOf(target)) out.push({ path: target, kind: 'preset-repo' })
    } catch {
      // A malformed repository configuration only hides that source.
    }
  }
  for (const shared of await configuredSkillRepoRoots()) {
    if (await directoryOf(shared)) out.push({ path: shared, kind: 'global-repo' })
  }
  const skills = join(dshHome(), 'skills')
  out.push({ path: skills, kind: 'skills-home' })
  // The legacy global repository may live one level below (for example
  // $DSH_HOME/skills/utils-skill); treat any child that carries .dsh as a source.
  try {
    const entries = await readdir(skills, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const child = join(skills, entry.name)
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && await directoryOf(child))) continue
      if (await directoryOf(join(child, '.dsh'))) out.push({ path: child, kind: 'skills-home' })
    }
  } catch {
    // A missing skills home simply contributes no per-repository sources.
  }
  for (const raw of options.presetSourceDirs) {
    try {
      out.push({ path: expandAbsolute(raw), kind: 'extra' })
    } catch {
      // Invalid extras are ignored, matching the other path settings.
    }
  }
  return out
}

/** Real path when it exists, resolved path otherwise. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** Read the sync manifest, tolerating a missing or broken file. */
export async function readManifest(): Promise<SharedManifest> {
  let raw: unknown = null
  try {
    raw = JSON.parse(await readFile(sharedManifestPath(), 'utf8')) as unknown
  } catch {
    return { version: 1, presets: {} }
  }
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const presets: Record<string, ManagedPreset> = {}
  const source = record.presets !== null && typeof record.presets === 'object' ? record.presets as Record<string, unknown> : {}
  for (const [id, value] of Object.entries(source)) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    presets[id] = {
      source: typeof entry.source === 'string' ? entry.source : '',
      syncedAt: typeof entry.syncedAt === 'string' ? entry.syncedAt : '',
      files: Array.isArray(entry.files) ? entry.files.filter((file): file is string => typeof file === 'string') : [],
    }
  }
  return { version: 1, presets }
}

/** Persist the sync manifest. */
async function writeManifest(manifest: SharedManifest): Promise<void> {
  await mkdir(agentsStorageDir(), { recursive: true, mode: 0o700 })
  const file = sharedManifestPath()
  const temp = file + '.' + process.pid.toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp'
  try {
    await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
