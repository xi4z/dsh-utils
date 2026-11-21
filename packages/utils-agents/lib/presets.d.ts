/**
 * Preset discovery and preset-scoped file operations for the utils-agents panel.
 *
 * A preset is one directory under a configured preset root (default
 * $DSH_HOME/.agent-presets). The panel reads its preset.yml display name,
 * scans its skills/ tree for SKILL.md / SKILL.md.disabled, and treats the
 * preset root as the editable Markdown scope (AGENTS.md first).
 *
 * @module dsh-utils/utils-agents/presets
 */
import type { Context } from '@deepseek-ai/cordis';
import { type FileRow, type Options, type PresetInfo, type SkillRow } from './util.js';
/** Discover every preset directory in the configured roots. */
export declare function discoverPresets(ctx: Context, options: Options): Promise<PresetInfo[]>;
/** Find one preset by id; throws 404 when it is not in a configured root. */
export declare function presetById(ctx: Context, options: Options, id: string): Promise<PresetInfo>;
/** Scan skills/ for SKILL.md and SKILL.md.disabled, one row per skill directory. */
export declare function scanSkills(ctx: Context, presetPath: string): Promise<SkillRow[]>;
/** Toggle one preset skill by renaming SKILL.md and SKILL.md.disabled. */
export declare function toggleSkill(preset: PresetInfo, relPath: string, enabled: boolean): Promise<SkillRow>;
/** All Markdown files for one preset, AGENTS.md first. */
export declare function presetFiles(ctx: Context, preset: PresetInfo): Promise<FileRow[]>;
/** Build the opaque id for one preset file. */
export declare function presetFileId(presetPath: string, rel: string): string;
/** Build the opaque id for one global AGENTS-family file. */
export declare function globalFileId(path: string): string;
/** Resolve one opaque file id to a path and browser row. */
export declare function resolveFileId(ctx: Context, options: Options, id: string, cwd: string): Promise<{
    row: FileRow;
    path: string;
    preset: PresetInfo | null;
}>;
/** Global AGENTS.md family for the global pseudo preset. */
export declare function globalFiles(ctx: Context, options: Options, cwd: string): Promise<FileRow[]>;
