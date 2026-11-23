/**
 * utils-agents: the one host component for skills and presets.
 *
 * It merges what used to be three separate packages/rows:
 *
 * - nested `SKILL.md` discovery from `@xi4z/dsh-utils-main`;
 * - the model-facing skill visibility filter from
 *   `@xi4z/dsh-utils-skill-panel`;
 * - the preset panel (skills tree, Markdown editor, per-preset Git skill
 *   repository, shared presets and native-preset import/export).
 *
 * The panel picks one preset directory (or the global AGENTS.md pseudo preset)
 * and then lists its skills tree, edits its Markdown and syncs its repository.
 * All browser requests use opaque file ids; the preset id is re-resolved
 * against the configured preset roots on every call.
 *
 * @module @xi4z/dsh-utils-utils-agents
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type AgentsConfig } from './util.js';
import { type SkillDiscoveryConfig } from './skill-discovery.js';
import { type SkillPanelConfig } from './skill-panel.js';
export declare const name = "utils-agents";
/** The merged component still needs the host skill registry. */
export declare const inject: string[];
/** Raw row config: agents settings plus the merged discovery and visibility fields. */
export interface UtilsAgentsConfig extends AgentsConfig, SkillDiscoveryConfig, SkillPanelConfig {
}
/** Exact Connection routes owned by this component. */
export declare const ROUTE_PATHS: {
    readonly list: "/api/dsh-utils/utils-agents/list";
    readonly files: "/api/dsh-utils/utils-agents/files";
    readonly file: "/api/dsh-utils/utils-agents/file";
    readonly skill: "/api/dsh-utils/utils-agents/skill";
    readonly repo: "/api/dsh-utils/utils-agents/repo";
    readonly key: "/api/dsh-utils/utils-agents/key";
    readonly sync: "/api/dsh-utils/utils-agents/sync";
    readonly shared: "/api/dsh-utils/utils-agents/shared";
    readonly sharedSync: "/api/dsh-utils/utils-agents/shared-sync";
    readonly sharedRepo: "/api/dsh-utils/utils-agents/shared-repo";
    readonly sharedKey: "/api/dsh-utils/utils-agents/shared-key";
    readonly sharedPull: "/api/dsh-utils/utils-agents/shared-pull";
    readonly deployKey: "/api/dsh-utils/utils-agents/deploy-key";
    readonly update: "/api/dsh-utils/utils-agents/update";
    readonly native: "/api/dsh-utils/utils-agents/native-presets";
    readonly nativeImport: "/api/dsh-utils/utils-agents/native-presets-import";
    readonly publish: "/api/dsh-utils/utils-agents/presets-publish";
    readonly skillList: "/api/dsh-utils/skill-panel/list";
};
/**
 * Settings schema. Every field is volatile: the routes re-read the live
 * references, so saving the form takes effect without a restart.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    minDepth: z<number, number, "volatile-defined">;
    maxDepth: z<number, number, "volatile-defined">;
    watch: z<boolean, boolean, "volatile-defined">;
    debounceMs: z<number, number, "volatile-defined">;
    pollIntervalMs: z<number, number, "volatile-defined">;
    includeProjectRoots: z<boolean, boolean, "volatile-defined">;
    includeUserRoots: z<boolean, boolean, "volatile-defined">;
    includeSkillRepositories: z<boolean, boolean, "volatile-defined">;
    followSymlinks: z<boolean, boolean, "volatile-defined">;
    extraRoots: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    ignoreDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    disabledSkills: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    maxBytes: z<number, number, "volatile-defined">;
    presetDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    presetSourceDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    builtinPresets: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    extraAgentsFiles: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    scanNestedAgents: z<boolean, boolean, "volatile-defined">;
    nestedDepth: z<number, number, "volatile-defined">;
    defaultRepoUrl: z<string, string, "volatile-defined">;
    defaultBranch: z<string, string, "volatile-defined">;
    updateCheck: z<boolean, boolean, "volatile-defined">;
    updateCheckIntervalHours: z<number, number, "volatile-defined">;
    updateRegistry: z<string, string, "volatile-defined">;
    updateAutoInstall: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    minDepth: z<number, number, "volatile-defined">;
    maxDepth: z<number, number, "volatile-defined">;
    watch: z<boolean, boolean, "volatile-defined">;
    debounceMs: z<number, number, "volatile-defined">;
    pollIntervalMs: z<number, number, "volatile-defined">;
    includeProjectRoots: z<boolean, boolean, "volatile-defined">;
    includeUserRoots: z<boolean, boolean, "volatile-defined">;
    includeSkillRepositories: z<boolean, boolean, "volatile-defined">;
    followSymlinks: z<boolean, boolean, "volatile-defined">;
    extraRoots: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    ignoreDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    disabledSkills: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    maxBytes: z<number, number, "volatile-defined">;
    presetDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    presetSourceDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    builtinPresets: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    extraAgentsFiles: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    scanNestedAgents: z<boolean, boolean, "volatile-defined">;
    nestedDepth: z<number, number, "volatile-defined">;
    defaultRepoUrl: z<string, string, "volatile-defined">;
    defaultBranch: z<string, string, "volatile-defined">;
    updateCheck: z<boolean, boolean, "volatile-defined">;
    updateCheckIntervalHours: z<number, number, "volatile-defined">;
    updateRegistry: z<string, string, "volatile-defined">;
    updateAutoInstall: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
/**
 * Activate the utils-agents routes.
 * @param ctx - host Cordis context.
 * @param config - row config; volatile fields arrive as live references.
 */
export declare function apply(ctx: Context, config?: UtilsAgentsConfig): void;
