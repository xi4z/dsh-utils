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
/** Exact Connection route that serves the panel's skill list. */
export const ROUTE_PATH = '/api/dsh-utils/skill-panel/list';
/** Reply headers shared by successful and failed route responses. */
const JSON_HEADERS = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
};
/**
 * Activate the component.
 * @param ctx - host Cordis context; `skills` is guaranteed by {@link inject}.
 * @param config - row config; volatile fields arrive as live references.
 */
export function applySkillPanel(ctx, config = {}) {
    const registry = ctx.skills;
    // Capture the raw service instance, not the traceable proxy: a bound proxy
    // method still resolves `this.snapshot` dynamically and would run the pinned
    // wrapper from the panel route.
    const rawRegistry = underlying(registry);
    const originals = {
        list: typeof rawRegistry?.list === 'function' ? rawRegistry.list.bind(rawRegistry) : undefined,
        snapshot: typeof rawRegistry?.snapshot === 'function' ? rawRegistry.snapshot.bind(rawRegistry) : undefined,
    };
    const restores = [];
    if (registry && originals.list) {
        const wrapped = (options) => originals.list(options).then((skills) => filterList(skills, config));
        restores.push(pin(registry, 'list', wrapped));
    }
    if (registry && originals.snapshot) {
        const wrapped = (options) => originals.snapshot(options).then((snapshot) => filterSnapshot(snapshot, config));
        restores.push(pin(registry, 'snapshot', wrapped));
    }
    if (restores.length > 0) {
        ctx.effect(() => () => {
            for (const restore of restores.reverse()) {
                try {
                    restore();
                }
                catch (error) {
                    ctx.logger.warn(`utils-agents skill-panel: cannot restore the skill catalog methods: ${errorMessage(error)}`);
                }
            }
        }, 'utils-agents skill-panel: catalog filter');
    }
    registerRoute(ctx, config, originals);
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
function pin(holder, key, value) {
    const own = Object.getOwnPropertyDescriptor(holder, key);
    Object.defineProperty(holder, key, {
        configurable: true,
        enumerable: own?.enumerable ?? false,
        writable: true,
        value,
    });
    return () => {
        const current = Object.getOwnPropertyDescriptor(holder, key);
        if (own) {
            if (current?.value === value)
                Object.defineProperty(holder, key, own);
            return;
        }
        if (current?.value === value)
            delete holder[key];
    };
}
/**
 * Register the panel's list route on Connection.
 * @param ctx - host context.
 * @param config - row config; disabled names are re-read per request.
 * @param originals - unwrapped discovery functions.
 */
function registerRoute(ctx, config, originals) {
    ctx.inject(['connection'], (scope) => {
        const connection = scope.connection;
        // A non-web host never provides Connection; the panel simply has no route.
        if (!connection)
            return;
        scope.effect(() => {
            try {
                return connection.fetch.register({
                    path: ROUTE_PATH,
                    methods: ['GET'],
                    requestBody: 'buffered',
                    fetch: (request) => handleList(ctx, config, originals, request),
                });
            }
            catch (error) {
                ctx.logger.warn(`utils-agents skill-panel: cannot register ${ROUTE_PATH}: ${errorMessage(error)}`);
                return () => Promise.resolve();
            }
        }, `utils-agents skill-panel: ${ROUTE_PATH}`);
    });
}
/**
 * Serve one panel request.
 * @param ctx - host context.
 * @param config - row config.
 * @param originals - unwrapped discovery functions.
 * @param request - incoming GET request.
 * @returns JSON response with the panel payload.
 */
async function handleList(ctx, config, originals, request) {
    try {
        return json(await describe(ctx, config, originals, request), 200);
    }
    catch (error) {
        ctx.logger.warn(`utils-agents skill-panel: cannot list skills: ${errorMessage(error)}`);
        return json({ error: errorMessage(error) }, 500);
    }
}
/**
 * Unwrap a Cordis traceable service proxy to the service instance it shadows.
 * `agentPresets.serviceFor` may return another proxy for the same registry, and
 * comparing proxies would miss the `list` this component pinned.
 * @param value - a service or proxy.
 * @returns the service instance when the value is a traceable proxy.
 */
function underlying(value) {
    if (value === null || typeof value !== 'object')
        return value;
    const original = value[Symbol.for('cordis.original')];
    return original ?? value;
}
/**
 * Build the panel payload for one request.
 * @param ctx - host context.
 * @param config - row config.
 * @param originals - unwrapped discovery functions.
 * @param request - incoming GET request.
 * @returns the payload the browser panel parses.
 */
async function describe(ctx, config, originals, request) {
    const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim() || undefined;
    const agent = sessionId === undefined ? undefined : agentOf(ctx, sessionId);
    const workingDirectory = serviceOf(ctx, 'workingDirectory');
    const cwd = await resolveCwd(ctx, agent, workingDirectory, request.signal);
    const registry = agent === undefined ? ctx.skills : scopedRegistry(ctx, agent);
    const options = {
        cwd,
        signal: request.signal,
        ...(agent === undefined ? {} : { scope: agent }),
    };
    const skills = await listWithOriginals(ctx, registry, originals, options);
    const disabled = disabledNames(config);
    const disabledSet = new Set(disabled);
    const rows = skills
        .map((skill) => describeSkill(skill, disabledSet))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
        sessionId: sessionId ?? null,
        cwd,
        complete: true,
        skills: rows,
        disabledSkills: disabled,
    };
}
/**
 * Read one host service defensively: this component ships without a dependency
 * on the optional host packages that provide them.
 * @param ctx - host context.
 * @param name - service name.
 * @returns the service, or undefined when the host does not provide it.
 */
function serviceOf(ctx, name) {
    const get = ctx.get;
    if (typeof get !== 'function')
        return undefined;
    try {
        return get.call(ctx, name);
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve a live Agent for a session id.
 * @param ctx - host context.
 * @param sessionId - browser-supplied session id.
 * @returns the live Agent, or undefined for an unknown session.
 */
function agentOf(ctx, sessionId) {
    const agents = serviceOf(ctx, 'agents');
    if (agents === undefined || typeof agents.get !== 'function')
        return undefined;
    try {
        return agents.get(sessionId);
    }
    catch {
        return undefined;
    }
}
/**
 * Pick the skill registry a live Agent reads: a preset scoped layer when the
 * Agent runs in one, otherwise the host registry.
 * @param ctx - host context.
 * @param agent - live Agent.
 * @returns the skill registry to list.
 */
function scopedRegistry(ctx, agent) {
    const presets = serviceOf(ctx, 'agentPresets');
    if (presets !== undefined && typeof presets.serviceFor === 'function') {
        try {
            const scoped = presets.serviceFor(agent, 'skills');
            if (scoped !== undefined && scoped !== null)
                return scoped;
        }
        catch (error) {
            ctx.logger.debug(`utils-agents skill-panel: preset skill layer lookup failed: ${errorMessage(error)}`);
        }
    }
    return ctx.skills;
}
/**
 * Resolve the workspace root used for discovery.
 * @param ctx - host context.
 * @param agent - live Agent, if any.
 * @param workingDirectory - `ctx.workingDirectory`, if the host provides it.
 * @param signal - request cancellation.
 * @returns an absolute directory.
 */
async function resolveCwd(ctx, agent, workingDirectory, signal) {
    if (agent !== undefined && workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
        try {
            const cwd = await workingDirectory.ensure(agent, signal);
            if (typeof cwd === 'string' && cwd !== '')
                return cwd;
        }
        catch (error) {
            ctx.logger.debug(`utils-agents skill-panel: working directory lookup failed: ${errorMessage(error)}`);
        }
    }
    const sessionCwd = agent?.session?.header?.cwd;
    if (typeof sessionCwd === 'string' && sessionCwd !== '')
        return sessionCwd;
    const fallback = workingDirectory?.defaultDirectory;
    if (typeof fallback === 'string' && fallback !== '')
        return fallback;
    return process.cwd();
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
async function listWithOriginals(ctx, registry, originals, options) {
    if (registry === undefined)
        throw new Error('skill registry is unavailable');
    const host = ctx.skills;
    const same = underlying(registry) === underlying(host);
    if (same && originals.snapshot !== undefined) {
        // `SkillRegistry.list()` delegates to `this.snapshot()`. Even the captured
        // `list` would resolve that through the pinned proxy, so read the captured
        // raw snapshot for the panel's unfiltered view.
        const snapshot = await originals.snapshot(options);
        return snapshot.skills;
    }
    const target = underlying(registry);
    if (typeof target.snapshot === 'function') {
        return (await target.snapshot(options)).skills;
    }
    if (typeof target.list !== 'function')
        throw new Error('skill registry does not expose list()');
    return target.list(options);
}
/**
 * Read the configured disabled names, trimming and de-duplicating them.
 * @param config - row config, possibly holding a volatile reference.
 * @returns normalized names; never cached across calls.
 */
function disabledNames(config) {
    const ref = config?.disabledSkills;
    let raw = ref;
    if (ref !== null && typeof ref === 'object' && typeof ref.get === 'function') {
        try {
            raw = ref.get();
        }
        catch {
            return [];
        }
    }
    if (!Array.isArray(raw))
        return [];
    const names = [];
    const seen = new Set();
    for (const entry of raw) {
        if (typeof entry !== 'string')
            continue;
        const value = entry.trim();
        if (value === '' || seen.has(value))
            continue;
        seen.add(value);
        names.push(value);
    }
    return names;
}
/**
 * Hide disabled skills from one summary array without mutating it.
 * @param skills - registry summaries.
 * @param config - row config.
 * @returns the same array when nothing is disabled, else a mapped copy.
 */
function filterList(skills, config) {
    if (!Array.isArray(skills))
        return skills;
    const disabled = disabledNames(config);
    if (disabled.length === 0)
        return skills;
    const set = new Set(disabled);
    return skills.map((skill) => hideSkill(skill, set));
}
/**
 * Report disabled skills as model-uninvocable in one catalog observation.
 * @param snapshot - registry observation.
 * @param config - row config.
 * @returns the same observation when nothing is disabled, else a mapped copy.
 */
function filterSnapshot(snapshot, config) {
    if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.skills))
        return snapshot;
    const skills = filterList(snapshot.skills, config);
    if (skills === snapshot.skills)
        return snapshot;
    return { ...snapshot, skills };
}
/**
 * Mark one disabled skill as model-uninvocable.
 * @param skill - registry summary.
 * @param disabled - normalized disabled name set.
 * @returns a patched summary, or the input when it is not disabled.
 */
function hideSkill(skill, disabled) {
    if (skill === null || typeof skill !== 'object')
        return skill;
    if (typeof skill.name !== 'string' || !disabled.has(skill.name))
        return skill;
    if (typeof skill.invocation?.modelInvocable === 'boolean' && skill.invocation.modelInvocable === false)
        return skill;
    return {
        ...skill,
        invocation: { ...(skill.invocation ?? {}), modelInvocable: false },
    };
}
/**
 * Project one summary into the route row shape.
 * @param skill - registry summary.
 * @param disabled - normalized disabled name set.
 * @returns the browser-facing row.
 */
function describeSkill(skill, disabled) {
    const modelInvocable = skill.invocation?.modelInvocable !== false;
    const userInvocable = skill.invocation?.userInvocable !== false;
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
    };
}
/**
 * Build one JSON response.
 * @param value - payload.
 * @param status - HTTP status.
 * @returns the response.
 */
function json(value, status) {
    return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}
/**
 * Render an unknown error for a log line or route payload.
 * @param error - thrown value.
 * @returns its message.
 */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=skill-panel.js.map