/**
 * Shared preset sources for the utils-agents panel.
 *
 * A skill repository may carry a ".dsh" directory that mirrors part of the DSH
 * home, so presets can travel with the skills instead of being copied by hand.
 * This module discovers those presets and copies them into
 * "$DSH_HOME/.agent-presets"; the existing legacy bridge then registers the
 * result as real Agent presets.
 *
 * Accepted layouts inside one repository root:
 *
 * - ".dsh/preset/<id>/" (canonical)
 * - ".dsh/preset/" itself when it holds "preset.yml" or "agent.cordis.yml"
 * - ".dsh/presets/<id>/" and ".dsh/.agent-presets/<id>/" (tolerated aliases)
 * - ".dsh/<id>/" when the directory holds "preset.yml" or "agent.cordis.yml"
 *
 * Sources are read-only: the repository checkout is never modified. Writes are
 * limited to the local preset home, and a removed source file is only deleted
 * when the caller asks for a pruning sync.
 *
 * @module dsh-utils/utils-agents/shared
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Options, type PresetInfo } from './util.js';
/** Status of one source preset against the local preset home. */
export type SharedStatus = 'new' | 'update' | 'same' | 'invalid';
/** Where a source repository came from. */
export type SharedSourceKind = 'preset-repo' | 'global-repo' | 'skills-home' | 'extra';
/** One preset found in a shared repository. */
export interface SharedPresetView {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly status: SharedStatus;
    readonly sourceKind: SharedSourceKind;
    readonly sourceRoot: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly skills: number;
    readonly files: number;
    readonly managed: boolean;
    readonly lastSyncAt: string | null;
    readonly reason?: string;
}
/** One repository root that was scanned. */
export interface SharedSourceView {
    readonly path: string;
    readonly kind: SharedSourceKind;
    readonly exists: boolean;
    readonly presets: SharedPresetView[];
}
/** The complete shared-preset view returned to the browser. */
export interface SharedListView {
    readonly localRoot: string;
    readonly sources: SharedSourceView[];
}
/** One record remembered from a previous sync. */
interface ManagedPreset {
    readonly source: string;
    readonly syncedAt: string;
    readonly files: string[];
}
/** The on-disk sync manifest. */
interface SharedManifest {
    readonly version: 1;
    readonly presets: Record<string, ManagedPreset>;
}
/** Outcome for one preset sync. */
export interface SharedSyncResult {
    readonly id: string;
    readonly status: SharedStatus;
    readonly written: number;
    readonly removed: number;
    readonly skipped: string[];
    readonly error?: string;
}
/** The response of one sync request. */
export interface SharedSyncPayload {
    readonly results: SharedSyncResult[];
    readonly view: SharedListView;
}
/**
 * Scan every known repository for ".dsh" presets.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @param preset - the selected preset, whose synced checkout is also a source.
 * @returns the source roots with their preset rows.
 */
export declare function sharedPresetView(ctx: Context, options: Options, preset: PresetInfo | null): Promise<SharedListView>;
/**
 * Copy the requested source presets into the DSH preset home.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @param preset - the selected preset, used to locate its repository checkout.
 * @param body - request body with optional "ids" and "prune".
 * @returns per-preset results plus the refreshed view.
 */
export declare function syncSharedPresets(ctx: Context, options: Options, preset: PresetInfo | null, body: Record<string, unknown>): Promise<SharedSyncPayload>;
/** Payload of one automatic preset pass. */
export interface AutoPresetSyncPayload extends SharedSyncPayload {
    /** Preset ids whose local copy was removed because the repository dropped them. */
    readonly removed: string[];
}
/**
 * Mirror the presets carried by the configured Skill repositories into the
 * preset home.
 *
 * The repository is the only source of truth: new and outdated presets are
 * copied, and a preset the repository no longer carries is removed locally when
 * an earlier pass synced it (the manifest records that ownership). Built-in
 * presets and presets that only ever existed locally are never touched, and a
 * checkout that is missing or unreadable never triggers a removal.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @returns per-preset results, removed ids, and the refreshed view.
 */
export declare function autoSyncSharedPresets(ctx: Context, options: Options): Promise<AutoPresetSyncPayload>;
/** The storage path of the shared-preset manifest. */
export declare function sharedManifestPath(): string;
/** Normalize one preset directory name into a safe id, or null. */
export declare function sharedPresetId(name: string): string | null;
/** Read the sync manifest, tolerating a missing or broken file. */
export declare function readManifest(): Promise<SharedManifest>;
export {};
