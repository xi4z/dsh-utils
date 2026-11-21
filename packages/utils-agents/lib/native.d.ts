/**
 * Takeover support for presets declared outside the panel.
 *
 * DSH presets normally come from Cordis rows (the shipped standard/ptc presets
 * or a bundle such as dsh-butler-preset). The panel can import every
 * non-built-in declaration as a directory preset under
 * "$DSH_HOME/.agent-presets/<id>", and publish the resulting directories into
 * the shared skill repository under ".dsh/preset" before committing/pushing.
 *
 * The built-in allowlist is configuration, so a deployment can keep additional
 * shipped ids native without changing code.
 *
 * @module dsh-utils/utils-agents/native
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Options } from './util.js';
/** One declared preset as the panel lists it. */
export interface NativePresetRow {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly builtin: boolean;
    readonly directory: boolean;
    readonly importable: boolean;
}
/** The takeover view returned to the browser. */
export interface NativePresetView {
    readonly builtin: string[];
    readonly localRoot: string;
    readonly presets: NativePresetRow[];
}
/** Outcome for one import attempt. */
export interface NativeImportResult {
    readonly id: string;
    readonly status: 'imported' | 'exists' | 'skipped' | 'error';
    readonly path?: string;
    readonly error?: string;
}
/** Outcome for one publish attempt. */
export interface PublishResult {
    readonly id: string;
    readonly files: number;
}
/** The response of one publish request. */
export interface PublishPayload {
    readonly target: string;
    readonly branch: string;
    readonly commit: string;
    readonly pushed: boolean;
    readonly results: PublishResult[];
}
/**
 * List every declared preset and whether the panel can take it over.
 * @param ctx - host context.
 * @param options - normalized settings.
 */
export declare function nativePresetView(ctx: Context, options: Options): Promise<NativePresetView>;
/**
 * Import non-built-in declarations as directory presets.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @param body - request body with optional "ids" and "force".
 */
export declare function importNativePresets(ctx: Context, options: Options, body: Record<string, unknown>): Promise<{
    results: NativeImportResult[];
    view: NativePresetView;
}>;
/**
 * Copy local non-built-in presets into the shared repository and commit/push.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @param body - request body with optional "ids", "message" and "push".
 */
export declare function publishPresets(ctx: Context, options: Options, body: Record<string, unknown>): Promise<PublishPayload>;
