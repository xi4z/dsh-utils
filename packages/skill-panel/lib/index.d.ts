/**
 * `dsh-utils` skill-panel component: a host-side switchboard for the skill
 * catalog. The model-facing catalog is produced by filtering
 * `ctx.skills.snapshot()` on `invocation.modelInvocable`, so this component
 * pins `list` and `snapshot` on the registry instance and reports
 * `modelInvocable: false` for the skill names the user disabled. `get` is
 * deliberately untouched: a human can still load a disabled skill by name.
 *
 * The switchboard itself is a read-only route,
 * `GET /api/dsh-utils/skill-panel/list`, registered on the Connection API.
 * It reads the live Agent's workspace and skill layer so the panel matches the
 * catalog the current session actually sees, and it always calls the pinned
 * (unwrapped) discovery function, so disabled skills stay visible in the panel
 * with an off switch.
 *
 * @module dsh-utils/skill-panel
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "skill-panel";
export declare const inject: string[];
/** Exact Connection route that serves the panel's skill list. */
export declare const ROUTE_PATH = "/api/dsh-utils/skill-panel/list";
/**
 * Settings schema. `disabledSkills` is volatile, so the Loader hands
 * {@link apply} a live reference and the component re-reads it on every call.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    disabledSkills: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    disabledSkills: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, "plain">;
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
export declare function apply(ctx: Context, config?: SkillPanelConfig): void;
export {};
