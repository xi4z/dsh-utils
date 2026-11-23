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

import type { Context } from '@deepseek-ai/cordis'
import { updateSkillRepositories } from './global-repo.js'
import { errorMessage } from './util.js'
import { readUtilsConfig } from './utils-config.js'

/** First refresh runs well after startup, so activation stays cheap. */
const FIRST_UPDATE_DELAY_MS = 5 * 60_000

/** Fallback cadence when the document cannot be read. */
const FALLBACK_INTERVAL_MINUTES = 60

/** Callbacks the periodic refresh needs from the owning component. */
export interface SkillRepositoryUpdaterHooks {
  /** Refresh the skill catalog after a changed checkout. */
  readonly invalidateSkills: () => void
  /** Copy presets carried by the configured repositories into the preset home. */
  readonly syncPresets: () => Promise<void>
}

/**
 * Start the periodic Skill repository refresh.
 * @param ctx - plugin context for warnings and lifecycle.
 * @param hooks - catalog refresh and preset sync callbacks.
 */
export function startSkillRepositoryUpdater(ctx: Context, hooks: SkillRepositoryUpdaterHooks): void {
  let disposed = false
  let timer: NodeJS.Timeout | undefined

  const schedule = (delayMs: number): void => {
    if (disposed) return
    timer = setTimeout(() => { void tick() }, delayMs)
    // A pending refresh must not keep a headless process alive.
    timer.unref?.()
  }

  const tick = async (): Promise<void> => {
    if (disposed) return
    let intervalMinutes = FALLBACK_INTERVAL_MINUTES
    try {
      const snapshot = await readUtilsConfig()
      intervalMinutes = snapshot.config.updateIntervalMinutes
      if (snapshot.config.autoUpdate) {
        const results = await updateSkillRepositories(ctx)
        if (results.some((result) => result.changed)) hooks.invalidateSkills()
        for (const result of results) {
          if (result.skipped) ctx.logger.debug('utils-agents: ' + result.targetDir + ': ' + result.message)
        }
      }
      if (snapshot.config.autoSyncPresets && snapshot.config.skillRepositories.length > 0) {
        try {
          await hooks.syncPresets()
        } catch (error) {
          ctx.logger.warn('utils-agents: scheduled preset sync failed: ' + errorMessage(error))
        }
      }
    } catch (error) {
      ctx.logger.warn('utils-agents: scheduled skill repository update failed: ' + errorMessage(error))
    }
    if (disposed) return
    try {
      intervalMinutes = (await readUtilsConfig()).config.updateIntervalMinutes
    } catch {
      // Keep the last known cadence when the document is unreadable.
    }
    schedule(Math.max(1, intervalMinutes) * 60_000)
  }

  schedule(FIRST_UPDATE_DELAY_MS)
  ctx.effect(() => () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
  }, 'utils-agents: skill repository updater')
}
