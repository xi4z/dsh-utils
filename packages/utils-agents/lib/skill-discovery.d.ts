/**
 * `utils-agents` skill-discovery half: recursive `SKILL.md` discovery in nested
 * skill folders.
 *
 * The provider adds nested skill bundles (depth >= `minDepth`) to the skill
 * catalog, leaving depth-1 discovery to the built-in filesystem provider. It
 * used to be the separate `@xi4z/dsh-utils-main` component; the bundle now
 * mounts it as part of `@xi4z/dsh-utils-utils-agents`.
 *
 * @module @xi4z/dsh-utils-utils-agents/skill-discovery
 */
import type { Context } from '@deepseek-ai/cordis';
/** Provider name reported in the skill catalog. */
export declare const PROVIDER_NAME = "utils-agents";
export declare const SKILL_DISCOVERY_DEFAULTS: {
    minDepth: number;
    maxDepth: number;
    watch: boolean;
    debounceMs: number;
    pollIntervalMs: number;
    includeProjectRoots: boolean;
    includeUserRoots: boolean;
    includeSkillRepositories: boolean;
    followSymlinks: boolean;
    extraRoots: string[];
    ignoreDirs: string[];
};
/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
    get(): T;
}
/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>;
/** The runtime shape `apply` receives (every field volatile, every field optional). */
export interface SkillDiscoveryConfig {
    readonly minDepth?: MaybeRef<number>;
    readonly maxDepth?: MaybeRef<number>;
    readonly watch?: MaybeRef<boolean>;
    readonly debounceMs?: MaybeRef<number>;
    readonly pollIntervalMs?: MaybeRef<number>;
    readonly includeProjectRoots?: MaybeRef<boolean>;
    readonly includeUserRoots?: MaybeRef<boolean>;
    readonly includeSkillRepositories?: MaybeRef<boolean>;
    readonly followSymlinks?: MaybeRef<boolean>;
    readonly extraRoots?: MaybeRef<readonly string[]>;
    readonly ignoreDirs?: MaybeRef<readonly string[]>;
}
/** Handle returned by {@link applySkillDiscovery} for out-of-band refreshes. */
export interface SkillDiscoveryHandle {
    /** Invalidate the catalog, for example after a Skill repository was pulled. */
    refresh(): void;
}
/**
 * Register the recursive skill provider on the host `skills` registry.
 * @param ctx - plugin context carrying the `skills` service.
 * @param config - optional row config; see {@link normalizeConfig}.
 * @returns a handle that refreshes the catalog from outside the provider.
 */
export declare function applySkillDiscovery(ctx: Context, config?: SkillDiscoveryConfig): SkillDiscoveryHandle;
export {};
