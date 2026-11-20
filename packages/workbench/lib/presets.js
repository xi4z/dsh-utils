/**
 * Preset discovery and preset-scoped file operations for the workbench.
 *
 * A preset is one directory under a configured preset root (default
 * $DSH_HOME/.agent-presets). The workbench reads its preset.yml display name,
 * scans its skills/ tree for SKILL.md / SKILL.md.disabled, and treats the
 * preset root as the editable Markdown scope (AGENTS.md first).
 *
 * @module dsh-utils/workbench/presets
 */
import { lstat, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { AGENTS_CANDIDATES, GLOBAL_PRESET, IGNORED_DIRS, WorkbenchError, agentsHome, decodeIdPart, dshHome, encodeIdPart, errorMessage, exists, expandAbsolute, fileRow, findProjectRoot, insideJoin, presetRoots, projectChain, scopeOf, walkFiles, } from './util.js';
/** Deepest walk inside one preset. */
const PRESET_MAX_DEPTH = 8;
/** Discover every preset directory in the configured roots. */
export async function discoverPresets(ctx, options) {
    const presets = [];
    for (const root of presetRoots(options)) {
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                ctx.logger.debug('workbench: cannot read preset root ' + root + ': ' + errorMessage(error));
            continue;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.'))
                continue;
            const path = join(root, entry.name);
            presets.push(await describePreset(ctx, entry.name, path, options));
        }
    }
    return presets;
}
/** Find one preset by id; throws 404 when it is not in a configured root. */
export async function presetById(ctx, options, id) {
    const presets = await discoverPresets(ctx, options);
    const found = presets.find((preset) => preset.id === id);
    if (found === undefined)
        throw new WorkbenchError('未知的预设：' + id, 404);
    return found;
}
/** Build the browser row for one discovered preset. */
async function describePreset(ctx, id, path, options) {
    const meta = await readPresetMeta(path);
    const skills = await scanSkills(ctx, path);
    return {
        id,
        name: meta.name === '' ? id : meta.name,
        description: meta.description,
        path,
        skills,
        agents: await fileRow(agentsId(path), 'AGENTS.md', join(path, 'AGENTS.md'), id, 'agents'),
    };
}
/** Read name/description from preset.yml with a deliberately small parser. */
async function readPresetMeta(presetPath) {
    let text;
    try {
        text = await readFile(join(presetPath, 'preset.yml'), 'utf8');
    }
    catch {
        return { name: '', description: '' };
    }
    const values = parseSimpleYaml(text);
    return { name: values.name ?? '', description: values.description ?? '' };
}
/** Parse top-level scalar keys, including simple folded/literal blocks. */
function parseSimpleYaml(text) {
    const values = {};
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index]);
        if (match === null)
            continue;
        const key = match[1];
        let value = match[2].trim();
        if (value === '>-' || value === '>' || value === '|' || value === '|-') {
            const parts = [];
            while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
                index += 1;
                parts.push(lines[index].trim());
            }
            value = parts.join(' ').trim();
        }
        values[key] = unquote(value);
    }
    return values;
}
/** Strip YAML quotes from one scalar. */
function unquote(value) {
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
        return value.slice(1, -1).replace(/''/g, "'");
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return value;
}
/** Scan skills/ for SKILL.md and SKILL.md.disabled, one row per skill directory. */
export async function scanSkills(ctx, presetPath) {
    const root = join(presetPath, 'skills');
    if (!(await exists(root)))
        return [];
    const files = [];
    await walkFiles(root, PRESET_MAX_DEPTH, new Set(IGNORED_DIRS), (path) => {
        const name = basename(path);
        if (name === 'SKILL.md' || name === 'SKILL.md.disabled')
            files.push(path);
    }, ctx);
    const byDirectory = new Map();
    for (const path of files) {
        const rel = relative(presetPath, path).split(sep).join('/');
        const directory = dirname(rel);
        const enabled = basename(path) === 'SKILL.md';
        const existing = byDirectory.get(directory);
        if (existing !== undefined && existing.enabled)
            continue;
        const meta = await readSkillMeta(path);
        const row = {
            name: meta.name === '' ? basename(directory) : meta.name,
            description: meta.description,
            path: rel,
            enabled,
            size: await fileSize(path),
            mtimeMs: await fileMtime(path),
        };
        byDirectory.set(directory, row);
    }
    return [...byDirectory.values()].sort((left, right) => left.name.localeCompare(right.name));
}
/** Read name/description from one SKILL.md frontmatter. */
async function readSkillMeta(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch {
        return { name: '', description: '' };
    }
    if (!text.startsWith('---'))
        return { name: '', description: '' };
    const end = text.indexOf('\n---', 3);
    if (end < 0)
        return { name: '', description: '' };
    const values = parseSimpleYaml(text.slice(3, end));
    return { name: values.name ?? '', description: values.description ?? '' };
}
/** File size, or 0 when it disappears. */
async function fileSize(path) {
    try {
        const info = await lstat(path);
        return info.isFile() ? info.size : 0;
    }
    catch {
        return 0;
    }
}
/** File mtime, or null when it disappears. */
async function fileMtime(path) {
    try {
        const info = await lstat(path);
        return Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
    }
    catch {
        return null;
    }
}
/** Toggle one preset skill by renaming SKILL.md and SKILL.md.disabled. */
export async function toggleSkill(preset, relPath, enabled) {
    const normalized = relPath.split(sep).join('/');
    if (!normalized.startsWith('skills/') || normalized.includes('..'))
        throw new WorkbenchError('技能路径不合法', 400);
    const name = basename(normalized);
    if (name !== 'SKILL.md' && name !== 'SKILL.md.disabled')
        throw new WorkbenchError('只允许切换 SKILL.md', 400);
    const sourceName = enabled ? 'SKILL.md.disabled' : 'SKILL.md';
    if (name !== sourceName)
        throw new WorkbenchError('开关状态与文件名不一致', 400);
    const source = insideJoin(preset.path, normalized);
    const targetRel = enabled ? normalized.slice(0, -'.disabled'.length) : normalized + '.disabled';
    const target = insideJoin(preset.path, targetRel);
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isFile())
        throw new WorkbenchError('技能文件不是普通文件', 409);
    if (await exists(target))
        throw new WorkbenchError('目标文件已存在：' + relative(preset.path, target), 409);
    await rename(source, target);
    const meta = await readSkillMeta(target);
    return {
        name: meta.name === '' ? basename(dirname(targetRel)) : meta.name,
        description: meta.description,
        path: targetRel,
        enabled,
        size: await fileSize(target),
        mtimeMs: await fileMtime(target),
    };
}
/** All Markdown files for one preset, AGENTS.md first. */
export async function presetFiles(ctx, preset) {
    const paths = [];
    await walkFiles(preset.path, PRESET_MAX_DEPTH, new Set(IGNORED_DIRS), (path) => {
        if (path === preset.agents.path)
            return;
        const lower = path.toLowerCase();
        if (!lower.endsWith('.md') && !lower.endsWith('.md.disabled'))
            return;
        paths.push(path);
    }, ctx);
    const rows = [preset.agents];
    for (const path of paths) {
        const rel = relative(preset.path, path).split(sep).join('/');
        rows.push(await fileRow(presetFileId(preset.path, rel), rel, path, preset.id, kindOf(path)));
    }
    return rows.sort((left, right) => {
        if (left.kind === 'agents' && right.kind !== 'agents')
            return -1;
        if (right.kind === 'agents' && left.kind !== 'agents')
            return 1;
        return left.label.localeCompare(right.label);
    });
}
/** Classify one Markdown file inside a preset. */
function kindOf(path) {
    const name = basename(path);
    return name === 'SKILL.md' || name === 'SKILL.md.disabled' ? 'skill' : 'reference';
}
/** Build the opaque id for one preset file. */
export function presetFileId(presetPath, rel) {
    return 'preset:' + encodeIdPart(presetPath) + ':' + encodeIdPart(rel);
}
/** Build the opaque id for one global AGENTS-family file. */
export function globalFileId(path) {
    return 'global:' + encodeIdPart(path);
}
/** The preset AGENTS.md id. */
function agentsId(presetPath) {
    return presetFileId(presetPath, 'AGENTS.md');
}
/** Resolve one opaque file id to a path and browser row. */
export async function resolveFileId(ctx, options, id, cwd) {
    if (id.startsWith('global:')) {
        const path = decodeIdPart(id.slice('global:'.length));
        const row = (await globalFiles(ctx, options, cwd)).find((candidate) => candidate.path === path);
        if (row === undefined)
            throw new WorkbenchError('未知的全局文件 id', 404);
        return { row, path, preset: null };
    }
    if (!id.startsWith('preset:'))
        throw new WorkbenchError('未知的文件 id', 404);
    const rest = id.slice('preset:'.length);
    const at = rest.indexOf(':');
    if (at <= 0)
        throw new WorkbenchError('预设文件 id 不合法', 400);
    const presetPath = decodeIdPart(rest.slice(0, at));
    const rel = decodeIdPart(rest.slice(at + 1));
    const presets = await discoverPresets(ctx, options);
    const preset = presets.find((candidate) => resolve(candidate.path) === resolve(presetPath));
    if (preset === undefined)
        throw new WorkbenchError('未知的预设路径', 404);
    const lower = rel.toLowerCase();
    if ((!lower.endsWith('.md') && !lower.endsWith('.md.disabled')) || rel.includes('..'))
        throw new WorkbenchError('只允许编辑 .md / .md.disabled 文件', 400);
    const path = insideJoin(preset.path, rel);
    const row = await fileRow(id, rel.split(sep).join('/'), path, preset.id, rel === 'AGENTS.md' ? 'agents' : kindOf(path));
    return { row, path, preset };
}
/** Global AGENTS.md family for the global pseudo preset. */
export async function globalFiles(ctx, options, cwd) {
    const rows = [];
    const add = async (path, label, scope) => {
        const row = await fileRow(globalFileId(path), label, path, GLOBAL_PRESET, 'global');
        rows.push({ ...row, scope });
    };
    await add(join(dshHome(), 'AGENTS.md'), 'AGENTS.md', '用户全局 · $DSH_HOME');
    await add(join(agentsHome(), 'AGENTS.md'), 'AGENTS.md', '共享全局 · $DSH_AGENTS_HOME');
    const projectRoot = await findProjectRoot(cwd);
    for (const dir of projectChain(projectRoot, cwd)) {
        for (const candidate of AGENTS_CANDIDATES) {
            const path = join(dir, candidate);
            const present = await exists(path);
            const primary = candidate === 'AGENTS.md' && (dir === cwd || dir === projectRoot);
            if (!present && !primary)
                continue;
            await add(path, candidate, scopeOf(dir, cwd, projectRoot));
        }
    }
    if (options.scanNestedAgents) {
        const known = new Set(rows.map((row) => row.path));
        const nested = [];
        await walkFiles(cwd, options.nestedDepth, new Set(IGNORED_DIRS), (path) => {
            const name = basename(path);
            if ((name === 'AGENTS.md' || name === 'CLAUDE.md') && !known.has(path))
                nested.push(path);
        }, ctx);
        for (const path of nested)
            await add(path, basename(path), relative(projectRoot, dirname(path)) || '.');
    }
    for (const raw of options.extraAgentsFiles) {
        try {
            await add(expandAbsolute(raw), basename(expandAbsolute(raw)), '额外文件');
        }
        catch {
            // Invalid extras are ignored.
        }
    }
    return rows;
}
//# sourceMappingURL=presets.js.map