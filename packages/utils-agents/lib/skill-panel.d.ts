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
import type { Context } from '@deepseek-ai/cordis';
/** Exact Connection route that serves the panel's skill list. */
export declare const ROUTE_PATH = "/api/dsh-utils/skill-panel/list";
/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
    get(): T;
}
/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>;
/** The runtime shape `apply` receives (the field is volatile and optional). */
export interface SkillPanelConfig {
    readonly disabledSkills?: MaybeRef<readonly string[]>;
}
/**
 * Activate the component.
 * @param ctx - host Cordis context; `skills` is guaranteed by {@link inject}.
 * @param config - row config; volatile fields arrive as live references.
 */
export declare function applySkillPanel(ctx: Context, config?: SkillPanelConfig): void;
export {};
