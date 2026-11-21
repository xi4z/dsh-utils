/**
 * `utils-agents` skill-visibility half: a host-side switchboard for the skill
 * catalog. The model-facing catalog is produced by filtering
 * `ctx.skills.snapshot()` on `invocation.modelInvocable`, so this module pins
 * `list` and `snapshot` on the registry instance and reports
 * `modelInvocable: false` for the skill names the user disabled. `get` is
 * deliberately untouched: a human can still load a disabled skill by name.
 *
 * The switchboard itself is a read-only route,
 * `GET /api/dsh-utils/skill-panel/list` (path kept for the browser half),
 * registered on the Connection API. It used to be the separate
 * `@xi4z/dsh-utils-skill-panel` component; the bundle now mounts it as part of
 * `@xi4z/dsh-utils-utils-agents`.
 *
 * @module @xi4z/dsh-utils-utils-agents/skill-panel
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCatalogSnapshot,
  SkillSummary,
  SkillViewOptions,
} from '@deepseek-ai/dsh-skill'
/** Exact Connection route that serves the panel's skill list. */
export const ROUTE_PATH = '/api/dsh-utils/skill-panel/list'

/** Reply headers shared by successful and failed route responses. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
  get(): T
}

/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>

/** The runtime shape `apply` receives (the field is volatile and optional). */
export interface SkillPanelConfig {
  readonly disabledSkills?: MaybeRef<readonly string[]>
}

/** The subset of the skill registry this component reads and pins. */
interface RegistryLike {
  list(options?: SkillViewOptions): Promise<SkillSummary[]>
  snapshot(options?: SkillViewOptions): Promise<SkillCatalogSnapshot>
  get?(name: string, options?: SkillViewOptions): Promise<unknown>
}

/** Original discovery functions captured before the instance methods are pinned. */
interface Originals {
  readonly list?: (options?: SkillViewOptions) => Promise<SkillSummary[]>
  readonly snapshot?: (options?: SkillViewOptions) => Promise<SkillCatalogSnapshot>
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

/** One row of the route payload. */
interface SkillPanelRow {
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  path?: string
  modelInvocable: boolean
  userInvocable: boolean
  enabled: boolean
}

/** The route payload; the browser panel parses this exact shape. */
interface SkillPanelPayload {
  sessionId: string | null
  cwd: string
  complete: boolean
  skills: SkillPanelRow[]
  disabledSkills: string[]
}

/**
 * Activate the component.
 * @param ctx - host Cordis context; `skills` is guaranteed by {@link inject}.
 * @param config - row config; volatile fields arrive as live references.
 */
export function applySkillPanel(ctx: Context, config: SkillPanelConfig = {}): void {
  const registry = (ctx as unknown as { skills?: RegistryLike }).skills
  // Capture the raw service instance, not the traceable proxy: a bound proxy
  // method still resolves `this.snapshot` dynamically and would run the pinned
  // wrapper from the panel route.
  const rawRegistry = underlying(registry) as RegistryLike | undefined
  const originals: Originals = {
    list: typeof rawRegistry?.list === 'function' ? rawRegistry.list.bind(rawRegistry) : undefined,
    snapshot: typeof rawRegistry?.snapshot === 'function' ? rawRegistry.snapshot.bind(rawRegistry) : undefined,
  }

  const restores: Array<() => void> = []
  if (registry && originals.list) {
    const wrapped = (options?: SkillViewOptions): Promise<SkillSummary[]> =>
      originals.list!(options).then((skills) => filterList(skills, config))
    restores.push(pin(registry as unknown as Record<string, unknown>, 'list', wrapped))
  }
  if (registry && originals.snapshot) {
    const wrapped = (options?: SkillViewOptions): Promise<SkillCatalogSnapshot> =>
      originals.snapshot!(options).then((snapshot) => filterSnapshot(snapshot, config))
    restores.push(pin(registry as unknown as Record<string, unknown>, 'snapshot', wrapped))
  }
  if (restores.length > 0) {
    ctx.effect(() => () => {
      for (const restore of restores.reverse()) {
        try {
          restore()
        } catch (error) {
          ctx.logger.warn(`utils-agents skill-panel: cannot restore the skill catalog methods: ${errorMessage(error)}`)
        }
      }
    }, 'utils-agents skill-panel: catalog filter')
  }

  registerRoute(ctx, config, originals)
}

/**
 * Replace one own or inherited method with a filtered wrapper and return the
 * exact undo. An inherited method is shadowed with an own property and removed
 * again so the prototype implementation comes back.
 * @param holder - registry instance being pinned.
 * @param key - method name.
 * @param value - wrapper to install.
 * @returns undo that restores the previous descriptor or deletes the shadow.
 */
function pin(holder: Record<string, unknown>, key: string, value: unknown): () => void {
  const own = Object.getOwnPropertyDescriptor(holder, key)
  Object.defineProperty(holder, key, {
    configurable: true,
    enumerable: own?.enumerable ?? false,
    writable: true,
    value,
  })
  return () => {
    const current = Object.getOwnPropertyDescriptor(holder, key)
    if (own) {
      if (current?.value === value) Object.defineProperty(holder, key, own)
      return
    }
    if (current?.value === value) delete holder[key]
  }
}

/**
 * Register the panel's list route on Connection.
 * @param ctx - host context.
 * @param config - row config; disabled names are re-read per request.
 * @param originals - unwrapped discovery functions.
 */
function registerRoute(ctx: Context, config: SkillPanelConfig, originals: Originals): void {
  ctx.inject(['connection'], (scope) => {
    const connection = (scope as unknown as { connection?: ConnectionLike }).connection
    // A non-web host never provides Connection; the panel simply has no route.
    if (!connection) return
    scope.effect(() => {
      try {
        return connection.fetch.register({
          path: ROUTE_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleList(ctx, config, originals, request),
        })
      } catch (error) {
        ctx.logger.warn(`utils-agents skill-panel: cannot register ${ROUTE_PATH}: ${errorMessage(error)}`)
        return () => Promise.resolve()
      }
    }, `utils-agents skill-panel: ${ROUTE_PATH}`)
  })
}

/**
 * Serve one panel request.
 * @param ctx - host context.
 * @param config - row config.
 * @param originals - unwrapped discovery functions.
 * @param request - incoming GET request.
 * @returns JSON response with the panel payload.
 */
async function handleList(
  ctx: Context,
  config: SkillPanelConfig,
  originals: Originals,
  request: Request,
): Promise<Response> {
  try {
    return json(await describe(ctx, config, originals, request), 200)
  } catch (error) {
    ctx.logger.warn(`utils-agents skill-panel: cannot list skills: ${errorMessage(error)}`)
    return json({ error: errorMessage(error) }, 500)
  }
}

/**
 * Unwrap a Cordis traceable service proxy to the service instance it shadows.
 * `agentPresets.serviceFor` may return another proxy for the same registry, and
 * comparing proxies would miss the `list` this component pinned.
 * @param value - a service or proxy.
 * @returns the service instance when the value is a traceable proxy.
 */
function underlying(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const original = (value as Record<symbol, unknown>)[Symbol.for('cordis.original')]
  return original ?? value
}

/**
 * Build the panel payload for one request.
 * @param ctx - host context.
 * @param config - row config.
 * @param originals - unwrapped discovery functions.
 * @param request - incoming GET request.
 * @returns the payload the browser panel parses.
 */
async function describe(
  ctx: Context,
  config: SkillPanelConfig,
  originals: Originals,
  request: Request,
): Promise<SkillPanelPayload> {
  const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim() || undefined
  const agent = sessionId === undefined ? undefined : agentOf(ctx, sessionId)
  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  const cwd = await resolveCwd(ctx, agent, workingDirectory, request.signal)
  const registry = agent === undefined ? (ctx as unknown as { skills?: RegistryLike }).skills : scopedRegistry(ctx, agent)
  const options: SkillViewOptions = {
    cwd,
    signal: request.signal,
    ...(agent === undefined ? {} : { scope: agent as never }),
  }
  const skills = await listWithOriginals(ctx, registry, originals, options)
  const disabled = disabledNames(config)
  const disabledSet = new Set(disabled)
  const rows = skills
    .map((skill) => describeSkill(skill, disabledSet))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    sessionId: sessionId ?? null,
    cwd,
    complete: true,
    skills: rows,
    disabledSkills: disabled,
  }
}

/**
 * Read one host service defensively: this component ships without a dependency
 * on the optional host packages that provide them.
 * @param ctx - host context.
 * @param name - service name.
 * @returns the service, or undefined when the host does not provide it.
 */
function serviceOf(ctx: Context, name: string): Record<string, unknown> | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name) as Record<string, unknown> | undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a live Agent for a session id.
 * @param ctx - host context.
 * @param sessionId - browser-supplied session id.
 * @returns the live Agent, or undefined for an unknown session.
 */
function agentOf(ctx: Context, sessionId: string): Record<string, any> | undefined {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || typeof agents.get !== 'function') return undefined
  try {
    return (agents.get as (id: string) => Record<string, any> | undefined)(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Pick the skill registry a live Agent reads: a preset scoped layer when the
 * Agent runs in one, otherwise the host registry.
 * @param ctx - host context.
 * @param agent - live Agent.
 * @returns the skill registry to list.
 */
function scopedRegistry(ctx: Context, agent: Record<string, any>): RegistryLike | undefined {
  const presets = serviceOf(ctx, 'agentPresets')
  if (presets !== undefined && typeof presets.serviceFor === 'function') {
    try {
      const scoped = (presets.serviceFor as (agent: unknown, name: string) => unknown)(agent, 'skills')
      if (scoped !== undefined && scoped !== null) return scoped as RegistryLike
    } catch (error) {
      ctx.logger.debug(`utils-agents skill-panel: preset skill layer lookup failed: ${errorMessage(error)}`)
    }
  }
  return (ctx as unknown as { skills?: RegistryLike }).skills
}

/**
 * Resolve the workspace root used for discovery.
 * @param ctx - host context.
 * @param agent - live Agent, if any.
 * @param workingDirectory - `ctx.workingDirectory`, if the host provides it.
 * @param signal - request cancellation.
 * @returns an absolute directory.
 */
async function resolveCwd(
  ctx: Context,
  agent: Record<string, any> | undefined,
  workingDirectory: Record<string, any> | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (agent !== undefined && workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
    try {
      const cwd = await (workingDirectory.ensure as (agent: unknown, signal?: AbortSignal) => Promise<unknown>)(agent, signal)
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch (error) {
      ctx.logger.debug(`utils-agents skill-panel: working directory lookup failed: ${errorMessage(error)}`)
    }
  }
  const sessionCwd = agent?.session?.header?.cwd
  if (typeof sessionCwd === 'string' && sessionCwd !== '') return sessionCwd
  const fallback = workingDirectory?.defaultDirectory
  if (typeof fallback === 'string' && fallback !== '') return fallback
  return process.cwd()
}

/**
 * List skills through the captured (unwrapped) function, so the panel always
 * sees disabled skills and can render their off switches.
 * @param ctx - host context.
 * @param registry - registry selected for this request.
 * @param originals - captured discovery functions.
 * @param options - lookup options.
 * @returns winning skill summaries.
 */
async function listWithOriginals(
  ctx: Context,
  registry: RegistryLike | undefined,
  originals: Originals,
  options: SkillViewOptions,
): Promise<SkillSummary[]> {
  if (registry === undefined) throw new Error('skill registry is unavailable')
  const host = (ctx as unknown as { skills?: RegistryLike }).skills
  const same = underlying(registry) === underlying(host)
  if (same && originals.snapshot !== undefined) {
    // `SkillRegistry.list()` delegates to `this.snapshot()`. Even the captured
    // `list` would resolve that through the pinned proxy, so read the captured
    // raw snapshot for the panel's unfiltered view.
    const snapshot = await originals.snapshot(options)
    return snapshot.skills
  }
  const target = underlying(registry) as RegistryLike
  if (typeof target.snapshot === 'function') {
    return (await target.snapshot(options)).skills
  }
  if (typeof target.list !== 'function') throw new Error('skill registry does not expose list()')
  return target.list(options)
}

/**
 * Read the configured disabled names, trimming and de-duplicating them.
 * @param config - row config, possibly holding a volatile reference.
 * @returns normalized names; never cached across calls.
 */
function disabledNames(config: SkillPanelConfig | undefined): string[] {
  const ref = config?.disabledSkills
  let raw: unknown = ref
  if (ref !== null && typeof ref === 'object' && typeof (ref as VolatileRef<unknown>).get === 'function') {
    try {
      raw = (ref as VolatileRef<unknown>).get()
    } catch {
      return []
    }
  }
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const value = entry.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    names.push(value)
  }
  return names
}

/**
 * Hide disabled skills from one summary array without mutating it.
 * @param skills - registry summaries.
 * @param config - row config.
 * @returns the same array when nothing is disabled, else a mapped copy.
 */
function filterList(skills: SkillSummary[], config: SkillPanelConfig): SkillSummary[] {
  if (!Array.isArray(skills)) return skills
  const disabled = disabledNames(config)
  if (disabled.length === 0) return skills
  const set = new Set(disabled)
  return skills.map((skill) => hideSkill(skill, set))
}

/**
 * Report disabled skills as model-uninvocable in one catalog observation.
 * @param snapshot - registry observation.
 * @param config - row config.
 * @returns the same observation when nothing is disabled, else a mapped copy.
 */
function filterSnapshot(snapshot: SkillCatalogSnapshot, config: SkillPanelConfig): SkillCatalogSnapshot {
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.skills)) return snapshot
  const skills = filterList(snapshot.skills, config)
  if (skills === snapshot.skills) return snapshot
  return { ...snapshot, skills }
}

/**
 * Mark one disabled skill as model-uninvocable.
 * @param skill - registry summary.
 * @param disabled - normalized disabled name set.
 * @returns a patched summary, or the input when it is not disabled.
 */
function hideSkill(skill: SkillSummary, disabled: ReadonlySet<string>): SkillSummary {
  if (skill === null || typeof skill !== 'object') return skill
  if (typeof skill.name !== 'string' || !disabled.has(skill.name)) return skill
  if (typeof skill.invocation?.modelInvocable === 'boolean' && skill.invocation.modelInvocable === false) return skill
  return {
    ...skill,
    invocation: { ...(skill.invocation ?? {}), modelInvocable: false },
  } as SkillSummary
}

/**
 * Project one summary into the route row shape.
 * @param skill - registry summary.
 * @param disabled - normalized disabled name set.
 * @returns the browser-facing row.
 */
function describeSkill(skill: SkillSummary, disabled: ReadonlySet<string>): SkillPanelRow {
  const modelInvocable = skill.invocation?.modelInvocable !== false
  const userInvocable = skill.invocation?.userInvocable !== false
  return {
    name: skill.name,
    description: skill.description,
    ...(typeof skill.whenToUse === 'string' && skill.whenToUse !== '' ? { whenToUse: skill.whenToUse } : {}),
    source: skill.source,
    provider: skill.provider,
    ...(typeof skill.path === 'string' && skill.path !== '' ? { path: skill.path } : {}),
    modelInvocable,
    userInvocable,
    enabled: modelInvocable && !disabled.has(skill.name),
  }
}

/**
 * Build one JSON response.
 * @param value - payload.
 * @param status - HTTP status.
 * @returns the response.
 */
function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/**
 * Render an unknown error for a log line or route payload.
 * @param error - thrown value.
 * @returns its message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
