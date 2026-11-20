/**
 * Takeover support for presets declared outside the workbench.
 *
 * DSH presets normally come from Cordis rows (the shipped standard/ptc presets
 * or a bundle such as dsh-butler-preset). The workbench can import every
 * non-built-in declaration as a directory preset under
 * "$DSH_HOME/.agent-presets/<id>", and publish the resulting directories into
 * the shared skill repository under ".dsh/preset" before committing/pushing.
 *
 * The built-in allowlist is configuration, so a deployment can keep additional
 * shipped ids native without changing code.
 *
 * @module dsh-utils/workbench/native
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { discoverPresets } from './presets.js';
import { readSharedRepoState, sharedKeyStatus } from './global-repo.js';
import { runGit } from './git.js';
import { WorkbenchError, dshHome, errorMessage, exists, serviceOf, stringList, } from './util.js';
import { sharedPresetId } from './shared.js';
/** Directory trees never copied into the shared repository. */
const IGNORED_PUBLISH_DIRS = new Set(['.git', 'node_modules', '.dsh-utils', '.temp', '.tmp']);
/**
 * List every declared preset and whether the workbench can take it over.
 * @param ctx - host context.
 * @param options - normalized settings.
 */
export async function nativePresetView(ctx, options) {
    const registry = nativeRegistry(ctx);
    const rows = registry === undefined ? [] : await registry.list();
    const directories = new Map();
    for (const preset of await discoverPresets(ctx, options))
        directories.set(preset.id, preset.path);
    return {
        builtin: options.builtinPresets,
        localRoot: join(dshHome(), '.agent-presets'),
        presets: rows.map((row) => {
            const builtin = options.builtinPresets.includes(row.id);
            const directory = directories.has(row.id);
            return {
                id: row.id,
                name: row.name === undefined || row.name === '' ? row.id : row.name,
                description: row.description ?? '',
                builtin,
                directory,
                importable: !builtin && !directory,
            };
        }),
    };
}
/**
 * Import non-built-in declarations as directory presets.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @param body - request body with optional "ids" and "force".
 */
export async function importNativePresets(ctx, options, body) {
    const registry = nativeRegistry(ctx);
    if (registry === undefined || typeof registry.readDocument !== 'function') {
        throw new WorkbenchError('宿主没有提供 agentPresets.readDocument，无法导出原生预设', 409);
    }
    const requested = stringList(body.ids);
    const force = body.force === true;
    const listed = await nativePresetView(ctx, options);
    const targets = requested.length === 0
        ? listed.presets.filter((row) => row.importable)
        : listed.presets.filter((row) => requested.includes(row.id));
    if (requested.length > 0 && targets.length === 0)
        throw new WorkbenchError('没有找到要导入的预设：' + requested.join(', '), 404);
    const results = [];
    for (const row of targets) {
        if (row.builtin) {
            results.push({ id: row.id, status: 'skipped', error: '内置预设不导入' });
            continue;
        }
        const id = sharedPresetId(row.id);
        if (id === null) {
            results.push({ id: row.id, status: 'error', error: '预设 id 不能作为目录名' });
            continue;
        }
        const target = join(dshHome(), '.agent-presets', id);
        if (await exists(target) && !force) {
            results.push({ id, status: 'exists', path: target });
            continue;
        }
        try {
            const document = await registry.readDocument(row.id);
            if (typeof document.content !== 'string' || document.content.trim() === '') {
                throw new WorkbenchError('预设组合为空，拒绝导入', 409);
            }
            await mkdir(join(target, 'skills'), { recursive: true, mode: 0o755 });
            await writeAtomic(join(target, 'preset.yml'), presetYaml(document.name ?? row.name, document.description ?? row.description));
            await writeAtomic(join(target, 'agent.cordis.yml'), document.content);
            results.push({ id, status: 'imported', path: target });
            ctx.logger.info('workbench: imported native preset ' + id);
        }
        catch (error) {
            const message = errorMessage(error);
            ctx.logger.warn('workbench: cannot import native preset ' + row.id + ': ' + message);
            results.push({ id: row.id, status: 'error', error: message });
        }
    }
    return { results, view: await nativePresetView(ctx, options) };
}
/**
 * Copy local non-built-in presets into the shared repository and commit/push.
 * @param ctx - host context.
 * @param options - normalized settings.
 * @param body - request body with optional "ids", "message" and "push".
 */
export async function publishPresets(ctx, options, body) {
    const requested = stringList(body.ids);
    const push = body.push !== false;
    const message = typeof body.message === 'string' && body.message.trim() !== '' ? body.message.trim() : 'presets: sync from dsh-utils';
    const state = await readSharedRepoState(options);
    const key = await sharedKeyStatus(state);
    if (state.keyPath !== '' && key.file === undefined)
        throw new WorkbenchError('配置的密钥路径不存在', 409);
    const target = state.targetDir;
    if (!(await exists(target)))
        throw new WorkbenchError('共享仓库尚未检出，请先在“共享技能仓库”里拉取：' + target, 409);
    const keyArg = key.file;
    const root = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], undefined, keyArg);
    if (root.code !== 0 || resolve(root.stdout.trim()) !== resolve(target)) {
        throw new WorkbenchError('共享仓库不是该仓库的 Git checkout：' + target, 409);
    }
    const branch = await runGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined, key.file);
    if (branch.code !== 0)
        throw pullError('读取当前分支失败', branch);
    if (branch.stdout.trim() !== state.branch) {
        throw new WorkbenchError('共享仓库当前分支是 ' + branch.stdout.trim() + '，配置分支是 ' + state.branch, 409);
    }
    const presets = (await discoverPresets(ctx, options))
        .filter((preset) => !options.builtinPresets.includes(preset.id))
        .filter((preset) => requested.length === 0 || requested.includes(preset.id));
    if (requested.length > 0 && presets.length === 0)
        throw new WorkbenchError('没有找到要发布的预设：' + requested.join(', '), 404);
    const results = [];
    for (const preset of presets) {
        const destination = join(target, '.dsh', 'preset', preset.id);
        const files = await copyPresetTree(ctx, preset.path, destination);
        results.push({ id: preset.id, files });
    }
    const added = await runGit(['-C', target, 'add', '--', '.dsh/preset'], undefined, key.file);
    if (added.code !== 0)
        throw pullError('暂存共享预设失败', added);
    let commit = '';
    const staged = await runGit(['-C', target, 'diff', '--cached', '--quiet', '--', '.dsh/preset'], undefined, key.file);
    if (staged.code !== 0) {
        const committed = await runGit(['-C', target, 'commit', '-m', message, '--', '.dsh/preset'], undefined, key.file);
        if (committed.code !== 0)
            throw pullError('提交共享预设失败', committed);
        const head = await runGit(['-C', target, 'rev-parse', 'HEAD'], undefined, key.file);
        commit = head.code === 0 ? head.stdout.trim() : '';
    }
    let pushed = false;
    if (push && commit !== '') {
        const pushedResult = await runGit(['-C', target, 'push', 'origin', 'HEAD:' + state.branch], undefined, key.file);
        if (pushedResult.code !== 0)
            throw pullError('推送共享预设失败', pushedResult);
        pushed = true;
    }
    return { target, branch: state.branch, commit, pushed, results };
}
/** Locate the live preset registry. */
function nativeRegistry(ctx) {
    const service = serviceOf(ctx, 'agentPresets');
    if (service === undefined || typeof service.list !== 'function')
        return undefined;
    return service;
}
/** Copy one preset directory, skipping local-only trees and symlinks. */
async function copyPresetTree(ctx, source, destination) {
    let count = 0;
    const walk = async (dir) => {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                ctx.logger.debug('workbench: cannot scan ' + dir + ': ' + errorMessage(error));
            return;
        }
        for (const entry of entries) {
            if (IGNORED_PUBLISH_DIRS.has(entry.name))
                continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(path);
                continue;
            }
            if (!entry.isFile())
                continue;
            const rel = relative(source, path);
            const target = join(destination, rel);
            await mkdir(dirname(target), { recursive: true, mode: 0o755 });
            const content = await readFile(path);
            await writeAtomic(target, content);
            count += 1;
        }
    };
    await mkdir(destination, { recursive: true, mode: 0o755 });
    await walk(source);
    return count;
}
/** Render one preset.yml document. */
function presetYaml(name, description) {
    const lines = ['name: ' + JSON.stringify(name)];
    if (description !== '')
        lines.push('description: ' + JSON.stringify(description));
    return lines.join('\n') + '\n';
}
/** Write one file through a temporary sibling. */
async function writeAtomic(target, content) {
    const temp = join(dirname(target), '.' + basename(target) + '.' + process.pid.toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp');
    try {
        await writeFile(temp, content, { mode: 0o644, flag: 'wx' });
        await rename(temp, target);
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
}
/** Build a sanitized git failure. */
function pullError(prefix, outcome) {
    const detail = outcome.stderr.trim() || outcome.spawnError || (outcome.timedOut ? 'timeout' : 'exit ' + String(outcome.code));
    return new WorkbenchError(prefix + '：' + detail.split(/\r?\n/).slice(0, 3).join(' / '), 500);
}
//# sourceMappingURL=native.js.map