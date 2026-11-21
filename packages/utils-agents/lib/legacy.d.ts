/**
 * Bridge legacy directory presets into the live DSH preset registry.
 *
 * DSH 0.2.x no longer scans $DSH_HOME/.agent-presets by itself. This panel
 * still treats those directories as editable sources, so this module registers
 * each one as a real Agent preset: the declaration contains one cordis:include
 * row pointing at the directory's agent.cordis.yml. The Loader's include plugin
 * parses the same !!js entry list the legacy directory always used, and keeps
 * watching it for edits.
 *
 * @module dsh-utils/utils-agents/legacy
 */
import type { Context } from '@deepseek-ai/cordis';
import { type AgentsConfig } from './util.js';
/** Live status for one directory preset. */
export interface LegacyStatus {
    readonly registered: boolean;
    readonly broken: string | undefined;
}
/** The bridge owned by one plugin instance. */
export interface LegacyBridge {
    ensure(): Promise<void>;
    status(): Map<string, LegacyStatus>;
    dispose(): Promise<void>;
}
/**
 * Create the bridge. Registration is lazy: the first list request performs it,
 * so the route can report a useful status even when agentPresets is absent.
 */
export declare function createLegacyBridge(ctx: Context, config: AgentsConfig): LegacyBridge;
