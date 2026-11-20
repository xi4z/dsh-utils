/**
 * dsh-utils preset workbench: one component for the three surfaces that used
 * to be separate sidebar tabs.
 *
 * The panel picks one preset directory (or the global AGENTS.md pseudo preset)
 * and then:
 *
 * - lists the preset skills/ tree, toggling SKILL.md and SKILL.md.disabled;
 * - edits the preset Markdown, AGENTS.md first;
 * - clones or fast-forwards a Git skill repository into the preset skills/
 *   directory.
 *
 * All browser requests use opaque file ids; the preset id is re-resolved
 * against the configured preset roots on every call.
 *
 * @module dsh-utils/workbench
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type WorkbenchConfig } from './util.js';
export declare const name = "preset-workbench";
/** Exact Connection routes owned by this component. */
export declare const ROUTE_PATHS: {
    readonly list: "/api/dsh-utils/workbench/list";
    readonly files: "/api/dsh-utils/workbench/files";
    readonly file: "/api/dsh-utils/workbench/file";
    readonly skill: "/api/dsh-utils/workbench/skill";
    readonly repo: "/api/dsh-utils/workbench/repo";
    readonly key: "/api/dsh-utils/workbench/key";
    readonly sync: "/api/dsh-utils/workbench/sync";
    readonly shared: "/api/dsh-utils/workbench/shared";
    readonly sharedSync: "/api/dsh-utils/workbench/shared-sync";
    readonly sharedRepo: "/api/dsh-utils/workbench/shared-repo";
    readonly sharedKey: "/api/dsh-utils/workbench/shared-key";
    readonly sharedPull: "/api/dsh-utils/workbench/shared-pull";
    readonly native: "/api/dsh-utils/workbench/native-presets";
    readonly nativeImport: "/api/dsh-utils/workbench/native-presets-import";
    readonly publish: "/api/dsh-utils/workbench/presets-publish";
};
/**
 * Settings schema. Every field is volatile: the routes re-read the live
 * references, so saving the form takes effect without a restart.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    maxBytes: z<number, number, "volatile-defined">;
    presetDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    presetSourceDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    builtinPresets: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    extraAgentsFiles: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    scanNestedAgents: z<boolean, boolean, "volatile-defined">;
    nestedDepth: z<number, number, "volatile-defined">;
    defaultRepoUrl: z<string, string, "volatile-defined">;
    defaultBranch: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    maxBytes: z<number, number, "volatile-defined">;
    presetDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    presetSourceDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    builtinPresets: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    extraAgentsFiles: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    scanNestedAgents: z<boolean, boolean, "volatile-defined">;
    nestedDepth: z<number, number, "volatile-defined">;
    defaultRepoUrl: z<string, string, "volatile-defined">;
    defaultBranch: z<string, string, "volatile-defined">;
}>>, "plain">;
/**
 * Activate the workbench routes.
 * @param ctx - host Cordis context.
 * @param config - row config; volatile fields arrive as live references.
 */
export declare function apply(ctx: Context, config?: WorkbenchConfig): void;
