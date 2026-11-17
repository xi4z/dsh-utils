/**
 * `dsh-utils` skill-recursive component: adds nested `SKILL.md` bundles
 * (depth >= `minDepth`) to the skill catalog, leaving depth-1 discovery to the
 * built-in filesystem provider.
 *
 * The bundle's root entry (`dsh-utils`) mounts this component, because the
 * browser half (`./client.js`) renders its settings form and the client-module
 * scanner keys a package's `dsh.client` bundle on the entry's package name.
 *
 * @module dsh-utils/skill-recursive
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "skill-recursive";
export declare const inject: string[];
/**
 * Settings schema. Volatile fields are the only ones DSH exposes in the
 * Settings form and the ones the Loader can refresh in place.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    minDepth: z<number, number, "volatile-defined">;
    maxDepth: z<number, number, "volatile-defined">;
    watch: z<boolean, boolean, "volatile-defined">;
    debounceMs: z<number, number, "volatile-defined">;
    pollIntervalMs: z<number, number, "volatile-defined">;
    includeProjectRoots: z<boolean, boolean, "volatile-defined">;
    includeUserRoots: z<boolean, boolean, "volatile-defined">;
    followSymlinks: z<boolean, boolean, "volatile-defined">;
    extraRoots: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    ignoreDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    minDepth: z<number, number, "volatile-defined">;
    maxDepth: z<number, number, "volatile-defined">;
    watch: z<boolean, boolean, "volatile-defined">;
    debounceMs: z<number, number, "volatile-defined">;
    pollIntervalMs: z<number, number, "volatile-defined">;
    includeProjectRoots: z<boolean, boolean, "volatile-defined">;
    includeUserRoots: z<boolean, boolean, "volatile-defined">;
    followSymlinks: z<boolean, boolean, "volatile-defined">;
    extraRoots: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    ignoreDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, "plain">;
/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
    get(): T;
}
/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>;
/** The runtime shape `apply` receives (every field volatile, every field optional). */
export interface SkillRecursiveConfig {
    readonly minDepth?: MaybeRef<number>;
    readonly maxDepth?: MaybeRef<number>;
    readonly watch?: MaybeRef<boolean>;
    readonly debounceMs?: MaybeRef<number>;
    readonly pollIntervalMs?: MaybeRef<number>;
    readonly includeProjectRoots?: MaybeRef<boolean>;
    readonly includeUserRoots?: MaybeRef<boolean>;
    readonly followSymlinks?: MaybeRef<boolean>;
    readonly extraRoots?: MaybeRef<readonly string[]>;
    readonly ignoreDirs?: MaybeRef<readonly string[]>;
}
/**
 * Register the recursive skill provider on the host `skills` registry.
 * @param ctx - plugin context carrying the `skills` service.
 * @param config - optional row config; see {@link normalizeConfig}.
 */
export declare function apply(ctx: Context, config?: SkillRecursiveConfig): void;
export {};
