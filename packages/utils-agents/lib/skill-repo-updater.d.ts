/**
 * Periodic refresh of the configured Skill repositories.
 *
 * A configured checkout is only useful while it keeps moving, and a skill
 * repository usually carries its skills in submodules. This watcher fast-forwards
 * every repository from `$DSH_HOME/utils/utils.json` and refreshes its
 * submodules, then invalidates the skill catalog when something actually
 * changed. It never merges over a dirty working tree, never resets, and never
 * pushes; failures stay warnings.
 *
 * After the pull it can also mirror the presets a checkout carries under
 * `.dsh/preset` into `$DSH_HOME/.agent-presets` (`autoSyncPresets`). The
 * repository is the only source of truth: the pass adds new presets, updates
 * changed ones, and removes local copies whose preset disappeared upstream.
 * Nothing is ever published or deleted in the repository from here.
 *
 * The cadence is read from the same document on every tick, so editing
 * `autoUpdate`, `autoSyncPresets` or `updateIntervalMinutes` takes effect
 * without a restart.
 *
 * @module dsh-utils/utils-agents/skill-repo-updater
 */
import type { Context } from '@deepseek-ai/cordis';
/** Callbacks the periodic refresh needs from the owning component. */
export interface SkillRepositoryUpdaterHooks {
    /** Refresh the skill catalog after a changed checkout. */
    readonly invalidateSkills: () => void;
    /** Copy presets carried by the configured repositories into the preset home. */
    readonly syncPresets: () => Promise<void>;
}
/**
 * Start the periodic Skill repository refresh.
 * @param ctx - plugin context for warnings and lifecycle.
 * @param hooks - catalog refresh and preset sync callbacks.
 */
export declare function startSkillRepositoryUpdater(ctx: Context, hooks: SkillRepositoryUpdaterHooks): void;
