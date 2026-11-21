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

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { agentsStorageDir, errorMessage, type Options } from './util.js'

/** File holding the last published-version answer. */
const CACHE_FILE_NAME = 'update.json'

/** One HTTP request to the registry or GitHub is bounded. */
const REQUEST_TIMEOUT_MS = 8000

/** One `pnpm add` run is bounded. */
const INSTALL_TIMEOUT_MS = 180000

/** The first automatic check runs shortly after activation, off the boot path. */
const FIRST_CHECK_DELAY_MS = 15000

/** A Git ref pinned to a commit cannot move, so it is never re-added. */
const PINNED_REF = /^[0-9a-f]{40,64}$/i

/** Where the newest version is read from. */
export type UpdateSourceKind = 'npm' | 'git' | 'local'

/** The state of one automatic install attempt. */
export interface UpdateInstall {
  /** idle: nothing to do; installing: pnpm is running; installed: restart to apply; failed: see message. */
  readonly phase: 'idle' | 'installing' | 'installed' | 'failed'
  /** The version being installed. */
  readonly version: string | null
  /** Why the install failed, or the restart reminder after success. */
  readonly message: string | null
  /** When the last phase change happened. */
  readonly at: string | null
}

/** The durable and returned shape of one update check. */
export interface UpdateStatus {
  /** The version this component runs from; the bundle root package's version. */
  readonly current: string
  /** The last successfully read remote version, if any. */
  readonly latest: string | null
  /** Whether `latest` is newer than `current`. */
  readonly updateAvailable: boolean
  /** Which remote the answer describes: npm, GitHub, or none for a local install. */
  readonly source: UpdateSourceKind
  /** The exact remote the answer came from (registry base URL or raw GitHub URL). */
  readonly origin: string
  /** When `latest` was read successfully. */
  readonly checkedAt: string | null
  /** When the last attempt finished, successful or not. */
  readonly attemptedAt: string | null
  /** Why the last check failed; null after a successful one. */
  readonly error: string | null
  /** The last automatic install attempt. */
  readonly install: UpdateInstall
}

/** What the panel needs to describe the schedule. */
export interface UpdateSchedule {
  readonly enabled: boolean
  readonly intervalHours: number
  readonly registry: string
}

/** How this bundle was installed in the profile. */
interface InstallSource {
  readonly kind: UpdateSourceKind
  /** The profile dependency spec, when it could be read. */
  readonly spec: string | null
  /** A GitHub repository parsed from a Git spec. */
  readonly git?: { readonly owner: string; readonly repo: string; readonly ref: string }
}

/** One install command for the profile. */
export interface InstallCommand {
  /** The profile directory `pnpm add` runs in. */
  readonly dir: string
  /** The package spec to add. */
  readonly spec: string
  /** Whether to save an exact registry version. */
  readonly exact: boolean
}

/** Runs one install; tests replace it. */
export type InstallRunner = (command: InstallCommand) => Promise<void>

/** Parsed semantic version: numeric core plus prerelease tail. */
interface ParsedVersion {
  readonly core: readonly [number, number, number]
  readonly pre: string
}

/** Parse `1.2.3`, `v1.2.3` and `1.2.3-beta.1`; null when it is not semver. */
function parseVersion(raw: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (match === null) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? '' }
}

/**
 * Compare two semantic versions, ignoring build metadata.
 * @returns negative when left is older, 0 when equal, positive when newer.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index] - b.core[index]
    if (delta !== 0) return delta
  }
  // A release is newer than its prereleases; between prereleases the plain
  // lexical order is enough for the tags this project publishes.
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre < b.pre ? -1 : 1
}

/** The running bundle's manifest: the package name to ask about and its version. */
async function packageIdentity(): Promise<{ name: string; version: string }> {
  // lib/update.js -> packages/utils-agents -> package root.
  const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const name = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : '@xi4z/dsh-utils'
  const version = typeof manifest.version === 'string' && manifest.version.trim() !== '' ? manifest.version.trim() : '0.0.0'
  return { name, version }
}

/** The profile directory the host reports, if it reports one. */
function profileDir(ctx: Context): string | null {
  let service: unknown
  try {
    service = typeof (ctx as unknown as { get?: (name: string) => unknown }).get === 'function'
      ? (ctx as unknown as { get: (name: string) => unknown }).get('profileContext')
      : undefined
  } catch {
    service = undefined
  }
  const candidate = (service ?? (ctx as unknown as { profileContext?: unknown }).profileContext) as { dir?: unknown } | undefined
  const dir = candidate?.dir
  return typeof dir === 'string' && dir.trim() !== '' ? dir : null
}

/** The dependency spec this profile installed the bundle from. */
async function profileSpec(ctx: Context, name: string): Promise<string | null> {
  const dir = profileDir(ctx)
  if (dir === null) return null
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    const groups = [manifest.dependencies, manifest.devDependencies]
    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue
      const spec = (group as Record<string, unknown>)[name]
      if (typeof spec === 'string' && spec.trim() !== '') return spec.trim()
    }
  } catch {
    // A profile without a readable manifest is treated as a local install.
  }
  return null
}

/**
 * Read a GitHub repository out of a pnpm Git spec: `github:owner/repo`,
 * `owner/repo`, `git+https://github.com/owner/repo.git#<ref>`, or the SSH form.
 * A `#path:` parameter is dropped; the first remaining parameter is the ref.
 */
export function parseGitSpec(spec: string): { owner: string; repo: string; ref: string } | null {
  let text = spec.trim()
  if (text === '') return null
  let ref = 'HEAD'
  const hash = text.indexOf('#')
  if (hash !== -1) {
    const fragment = text.slice(hash + 1)
    text = text.slice(0, hash)
    const parts = fragment.split('&').filter((part) => part !== '' && !part.startsWith('path:'))
    if (parts.length > 0) ref = parts[0]
  }
  text = text.replace(/^git\+/, '')
  const patterns: readonly RegExp[] = [
    /^github:([^/\s]+)\/([^\s]+)$/i,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
    /^git@github\.com:([^/\s]+)\/([^\s]+)$/i,
    /^(?:ssh|https?):\/\/(?:git@)?github\.com\/([^/\s]+)\/([^\s]+)$/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match === null) continue
    const owner = match[1]
    const repo = match[2].replace(/\.git$/i, '').replace(/\/+$/, '')
    if (owner === '' || repo === '') return null
    return { owner, repo, ref }
  }
  return null
}

/** Classify one profile spec. */
function classifySpec(spec: string | null): InstallSource {
  if (spec === null) return { kind: 'local', spec }
  const text = spec.trim()
  if (/^(link|file|workspace):/i.test(text) || isAbsolute(text)) return { kind: 'local', spec: text }
  const git = parseGitSpec(text)
  if (git !== null) return { kind: 'git', spec: text, git }
  return { kind: 'npm', spec: text }
}

/** The URL of one GitHub package manifest for the parsed ref. */
function gitManifestUrl(git: { owner: string; repo: string; ref: string }): string {
  const ref = git.ref.split('/').map((part) => encodeURIComponent(part)).join('/')
  return 'https://raw.githubusercontent.com/' + encodeURIComponent(git.owner) + '/' + encodeURIComponent(git.repo) + '/' + ref + '/package.json'
}

/** Read a manifest's version, refusing anything that is not a semver string. */
async function fetchVersion(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const body = await response.json() as Record<string, unknown>
  const version = typeof body.version === 'string' ? body.version.trim() : ''
  if (parseVersion(version) === null) throw new Error('answer carries no version')
  return version
}

/** The npm `latest` document for one package. */
async function fetchNpmLatest(registry: string, name: string): Promise<string> {
  const base = registry.replace(/\/+$/, '')
  return await fetchVersion(base + '/' + name.replace('/', '%2F') + '/latest')
}

/** Run `pnpm add` in the profile; the only place this component writes there. */
async function runPnpmAdd(command: InstallCommand): Promise<void> {
  const args = command.exact ? ['add', command.spec, '--save-exact'] : ['add', command.spec]
  await new Promise<void>((resolvePromise, reject) => {
    execFile('pnpm', args, {
      cwd: command.dir,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: '1' },
    }, (error, _stdout, stderr) => {
      if (error === null) {
        resolvePromise()
        return
      }
      const detail = String(stderr ?? '').trim().split(/\r?\n/).slice(0, 3).join(' / ')
      reject(new Error('pnpm add failed' + (detail === '' ? '' : ': ' + detail)))
    })
  })
}

/** The install command for one source and target version; null when it must not install. */
export function installCommand(source: InstallSource, profile: string, name: string, version: string): InstallCommand | null {
  if (source.kind === 'local') return null
  if (source.kind === 'npm') return { dir: profile, spec: name + '@' + version, exact: true }
  const spec = source.spec
  if (spec === null) return null
  // A commit-pinned spec cannot move; re-adding it would only reinstall the same tree.
  if (source.git !== undefined && PINNED_REF.test(source.git.ref)) return null
  return { dir: profile, spec, exact: false }
}

/** Restore the two files an install may rewrite, so a failed run leaves the profile as it was. */
async function restoreProfile(dir: string, saved: readonly { name: string; text: string | null }[]): Promise<void> {
  for (const file of saved) {
    const path = join(dir, file.name)
    try {
      if (file.text === null) await rm(path, { force: true })
      else await writeFile(path, file.text)
    } catch {
      // A read-only profile keeps whatever pnpm left; the failure is reported anyway.
    }
  }
}

/** The cache path under the panel's storage directory. */
function cachePath(): string {
  return join(agentsStorageDir(), CACHE_FILE_NAME)
}

/** One install state that has not been attempted. */
const IDLE_INSTALL: UpdateInstall = { phase: 'idle', version: null, message: null, at: null }

/** Normalize a persisted install state. */
function normalizeInstall(raw: unknown): UpdateInstall {
  if (raw === null || typeof raw !== 'object') return IDLE_INSTALL
  const record = raw as Record<string, unknown>
  const phase = record.phase
  if (phase !== 'installing' && phase !== 'installed' && phase !== 'failed') return IDLE_INSTALL
  return {
    phase,
    version: typeof record.version === 'string' && record.version !== '' ? record.version : null,
    message: typeof record.message === 'string' && record.message !== '' ? record.message : null,
    at: typeof record.at === 'string' && record.at !== '' ? record.at : null,
  }
}

/** Read the cached answer, ignoring anything malformed. */
async function readCache(): Promise<UpdateStatus | null> {
  let raw: unknown = null
  try {
    raw = JSON.parse(await readFile(cachePath(), 'utf8')) as unknown
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const current = typeof record.current === 'string' ? record.current : ''
  if (current === '') return null
  const source = record.source === 'git' || record.source === 'local' ? record.source : 'npm'
  return {
    current,
    latest: typeof record.latest === 'string' && record.latest !== '' ? record.latest : null,
    updateAvailable: record.updateAvailable === true,
    source,
    // A cache written before the source split stored the npm registry here.
    origin: typeof record.origin === 'string' && record.origin !== ''
      ? record.origin
      : typeof record.registry === 'string' ? record.registry : '',
    checkedAt: typeof record.checkedAt === 'string' && record.checkedAt !== '' ? record.checkedAt : null,
    attemptedAt: typeof record.attemptedAt === 'string' && record.attemptedAt !== '' ? record.attemptedAt : null,
    error: typeof record.error === 'string' && record.error !== '' ? record.error : null,
    install: normalizeInstall(record.install),
  }
}

/** Persist the answer atomically with mode 600; failures are the caller's business. */
async function writeCache(status: UpdateStatus): Promise<void> {
  await mkdir(agentsStorageDir(), { recursive: true, mode: 0o700 })
  const file = cachePath()
  const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp'
  try {
    await writeFile(temp, JSON.stringify(status, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** One update checker per mounted component. */
export interface UpdateChecker {
  /** The last known answer, reading the cache on first use. */
  status(): Promise<UpdateStatus>
  /** Ask the remote now; concurrent calls share one request. */
  check(): Promise<UpdateStatus>
}

/**
 * Create the checker for one component instance.
 * @param ctx - host context, read for the profile directory the spec lives in.
 * @param options - live settings snapshot; registry and auto-install are read per check.
 * @param runner - how an install runs; defaults to `pnpm add` in the profile.
 */
export function createUpdateChecker(ctx: Context, options: () => Options, runner: InstallRunner = runPnpmAdd): UpdateChecker {
  let cached: UpdateStatus | null = null
  let loading: Promise<UpdateStatus> | null = null
  let inFlight: Promise<UpdateStatus> | null = null
  let source: InstallSource | null = null
  let installing = false

  const resolveSource = async (): Promise<InstallSource> => {
    if (source !== null) return source
    const identity = await packageIdentity()
    source = classifySpec(await profileSpec(ctx, identity.name))
    return source
  }

  const seed = async (): Promise<UpdateStatus> => {
    const identity = await packageIdentity()
    const install = await resolveSource()
    const stored = await readCache()
    const origin = stored !== null && stored.origin !== ''
      ? stored.origin
      : install.kind === 'git' && install.git !== undefined ? gitManifestUrl(install.git) : options().updateRegistry
    const latest = stored?.latest ?? null
    // A restart applies an install the cache still marks as done for the old version,
    // and an "installing" entry left behind by a killed process is stale.
    const storedInstall = stored?.install ?? IDLE_INSTALL
    const pending = storedInstall.phase === 'installed' && storedInstall.version === identity.version
      ? IDLE_INSTALL
      : storedInstall.phase === 'installing'
        ? { phase: 'failed', version: storedInstall.version, message: '上次自动更新被中断（进程退出）', at: storedInstall.at }
        : storedInstall
    return {
      current: identity.version,
      latest,
      updateAvailable: latest !== null && compareVersions(latest, identity.version) > 0,
      source: install.kind,
      origin,
      checkedAt: stored?.checkedAt ?? null,
      attemptedAt: stored?.attemptedAt ?? null,
      error: stored?.error ?? null,
      install: pending,
    }
  }

  const status = async (): Promise<UpdateStatus> => {
    if (cached !== null) return cached
    loading ??= seed().then((value) => {
      cached = value
      return value
    }).finally(() => { loading = null })
    return loading
  }

  /** Install one update in the background and publish the outcome. */
  const installInBackground = (command: InstallCommand, version: string): void => {
    if (installing) return
    installing = true
    void (async () => {
      const saved = await Promise.all(['package.json', 'pnpm-lock.yaml'].map(async (name) => {
        try {
          return { name, text: await readFile(join(command.dir, name), 'utf8') }
        } catch {
          return { name, text: null }
        }
      }))
      let phase: UpdateInstall
      try {
        await runner(command)
        phase = { phase: 'installed', version, message: '已安装，重启 dsh web 后生效', at: new Date().toISOString() }
      } catch (error) {
        await restoreProfile(command.dir, saved)
        phase = { phase: 'failed', version, message: errorMessage(error), at: new Date().toISOString() }
      }
      const current = cached
      if (current !== null) {
        cached = { ...current, install: phase }
        try {
          await writeCache(cached)
        } catch {
          // A read-only home still keeps the in-memory answer.
        }
      }
      installing = false
    })()
  }

  const check = async (): Promise<UpdateStatus> => {
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      const previous = await status()
      const identity = await packageIdentity()
      const install = await resolveSource()
      const settings = options()
      const attemptedAt = new Date().toISOString()
      const git = install.git
      const origin = install.kind === 'git' && git !== undefined ? gitManifestUrl(git) : settings.updateRegistry
      let next: UpdateStatus
      try {
        const latest = install.kind === 'git' && git !== undefined
          ? await fetchVersion(origin)
          : await fetchNpmLatest(settings.updateRegistry, identity.name)
        next = {
          ...previous,
          current: identity.version,
          latest,
          updateAvailable: compareVersions(latest, identity.version) > 0,
          source: install.kind,
          origin,
          checkedAt: attemptedAt,
          attemptedAt,
          error: null,
        }
        const directory = profileDir(ctx)
        const alreadyInstalled = previous.install.phase === 'installed' && previous.install.version === latest
        const command = next.updateAvailable && settings.updateAutoInstall && directory !== null
          && previous.install.phase !== 'installing' && !alreadyInstalled
          ? installCommand(install, directory, identity.name, latest)
          : null
        if (command !== null) {
          next = { ...next, install: { phase: 'installing', version: latest, message: null, at: attemptedAt } }
          cached = next
          try {
            await writeCache(next)
          } catch {
            // The in-memory state still drives the panel.
          }
          installInBackground(command, latest)
          return next
        }
      } catch (error) {
        next = {
          ...previous,
          current: identity.version,
          updateAvailable: previous.latest !== null && compareVersions(previous.latest, identity.version) > 0,
          source: install.kind,
          origin,
          attemptedAt,
          error: errorMessage(error),
        }
      }
      cached = next
      try {
        await writeCache(next)
      } catch {
        // A read-only home must not turn a failed check into a failed request.
      }
      return next
    })().finally(() => { inFlight = null })
    return inFlight
  }

  return { status, check }
}

/**
 * Run the automatic checks: one shortly after activation, then at the
 * configured interval. The next delay is recomputed after every run, so an
 * interval edited in the panel is picked up without a restart.
 */
export function startUpdateWatcher(ctx: Context, checker: UpdateChecker, options: () => Options): void {
  let disposed = false
  let timer: NodeJS.Timeout | undefined

  const schedule = (delayMs: number): void => {
    if (disposed) return
    timer = setTimeout(tick, delayMs)
    // A pending check must not keep a headless process alive.
    timer.unref?.()
  }

  const tick = async (): Promise<void> => {
    if (disposed) return
    const current = options()
    if (current.updateCheck) {
      try {
        await checker.check()
      } catch (error) {
        ctx.logger.warn('utils-agents: published-version check failed: ' + errorMessage(error))
      }
    }
    if (disposed) return
    // Keep the timer alive even while checks are disabled, so enabling them in
    // the panel takes effect on the next tick without a restart.
    const next = options()
    schedule(Math.max(1, next.updateCheckIntervalHours) * 3_600_000)
  }

  schedule(FIRST_CHECK_DELAY_MS)
  ctx.effect(() => () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
  }, 'utils-agents: update watcher')
}
