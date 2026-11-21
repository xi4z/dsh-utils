/**
 * Shared skill repository support for the utils-agents panel.
 *
 * The repository configured here is the tracked skills checkout: the panel
 * clones or fast-forwards it with an optional Deploy Key, and the shared
 * preset scanner reads ".dsh/preset" from that checkout. When the shared
 * repository has no key path and no key of its own, the panel-wide Deploy Key
 * from git.js is used, so a private skills checkout pulls without extra setup.
 * Settings and the pasted key intentionally keep the storage the former global
 * repository route used ($DSH_HOME/storages/dsh-utils-ui.json and
 * dsh-utils-ui.deploy-key), so an upgraded profile keeps its repository and key.
 *
 * @module dsh-utils/utils-agents/global-repo
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalRepoUrl, cloneUrlFor, globalKeyPath, runGit, validateBranch, validateRepoUrl, } from './git.js';
import { IGNORED_DIRS, AgentsError, directoryOf, dshHome, errorMessage, exists, expandAbsolute, walkFiles, } from './util.js';
/** Legacy state file name; the old global route reads the same document. */
const STATE_FILE_NAME = 'dsh-utils-ui.json';
/** Legacy deploy-key file name; never returned to the browser. */
const KEY_FILE_NAME = 'dsh-utils-ui.deploy-key';
/** Depth used when counting skills in the shared checkout. */
const SKILL_SCAN_DEPTH = 8;
/** Read the shared repository settings, filling defaults. */
export async function readSharedRepoState(options) {
    const fallback = {
        repoUrl: options.defaultRepoUrl,
        branch: options.defaultBranch,
        targetDir: join(dshHome(), 'skills', 'herskill'),
        keyPath: '',
        recurseSubmodules: true,
        lastSync: null,
    };
    let raw = null;
    try {
        raw = JSON.parse(await readFile(sharedRepoStatePath(), 'utf8'));
    }
    catch {
        return fallback;
    }
    const record = raw !== null && typeof raw === 'object' ? raw : {};
    return {
        repoUrl: textValue(record.repoUrl, fallback.repoUrl),
        branch: textValue(record.branch, fallback.branch),
        targetDir: absoluteValue(record.targetDir, fallback.targetDir),
        keyPath: typeof record.keyPath === 'string' ? record.keyPath : '',
        recurseSubmodules: record.recurseSubmodules !== false,
        lastSync: normalizeSync(record.lastSync),
    };
}
/** Read the shared repository settings plus checkout and key status. */
export async function sharedRepoView(ctx, options) {
    const state = await readSharedRepoState(options);
    return { state, target: await targetStatus(ctx, state), key: await sharedKeyStatus(state) };
}
/** Save new shared repository settings after validation. */
export async function saveSharedRepoConfig(ctx, options, body) {
    const current = await readSharedRepoState(options);
    const repoUrl = textValue(body.repoUrl, current.repoUrl);
    const branch = textValue(body.branch, current.branch);
    const targetDir = textValue(body.targetDir, current.targetDir);
    const keyPath = typeof body.keyPath === 'string' ? body.keyPath.trim() : current.keyPath;
    const recurseSubmodules = typeof body.recurseSubmodules === 'boolean' ? body.recurseSubmodules : current.recurseSubmodules;
    validateRepoUrl(repoUrl);
    validateBranch(branch);
    let resolvedTarget;
    try {
        resolvedTarget = expandAbsolute(targetDir);
    }
    catch (error) {
        throw new AgentsError('检出目录必须是绝对路径：' + errorMessage(error), 400);
    }
    if (keyPath !== '') {
        try {
            if (!(await exists(expandAbsolute(keyPath))))
                throw new AgentsError('密钥路径不存在：' + keyPath, 400);
        }
        catch (error) {
            if (error instanceof AgentsError)
                throw error;
            throw new AgentsError('密钥路径不合法：' + keyPath, 400);
        }
    }
    await writeSharedRepoState({
        repoUrl,
        branch,
        targetDir: resolvedTarget,
        keyPath,
        recurseSubmodules,
        lastSync: current.lastSync,
    });
    return sharedRepoView(ctx, options);
}
/** Store a pasted Deploy Key; an empty string clears it. */
export async function saveSharedRepoKey(ctx, options, key) {
    const file = sharedStoredKeyPath();
    if (key.trim() === '') {
        await rm(file, { force: true });
        return sharedRepoView(ctx, options);
    }
    if (key.includes(String.fromCharCode(0)))
        throw new AgentsError('Deploy Key 不能包含 NUL 字符', 400);
    await mkdir(join(dshHome(), 'storages'), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomSuffix() + '.tmp';
    try {
        await writeFile(temp, key.trimEnd() + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, file);
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
    await chmod(file, 0o600);
    return sharedRepoView(ctx, options);
}
/** Clone or fast-forward the shared repository with the configured key. */
export async function pullSharedRepo(ctx, options) {
    const state = await readSharedRepoState(options);
    const key = await sharedKeyStatus(state);
    if (state.keyPath !== '' && key.file === undefined)
        throw new AgentsError('配置的密钥路径不存在', 409);
    const parsed = validateRepoUrl(state.repoUrl);
    validateBranch(state.branch);
    if (!isAbsolute(state.targetDir))
        throw new AgentsError('检出目录必须是绝对路径', 400);
    const target = state.targetDir;
    const cloneUrl = cloneUrlFor(parsed, key.file);
    let message = '';
    if (!(await exists(target))) {
        await mkdir(dirname(target), { recursive: true });
        const cloned = await runGit(['clone', '--depth', '1', '--branch', state.branch, '--single-branch', cloneUrl, target], undefined, key.file);
        if (cloned.code !== 0)
            throw pullError('克隆仓库失败', cloned);
        message = '已 clone 分支 ' + state.branch;
    }
    else {
        if (!(await directoryOf(target)))
            throw new AgentsError('检出目录已存在但不是目录：' + target, 409);
        const root = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], undefined, key.file);
        if (root.code !== 0 || resolve(root.stdout.trim()) !== resolve(target)) {
            throw new AgentsError('检出目录不是该仓库的 Git checkout', 409);
        }
        const origin = await runGit(['-C', target, 'remote', 'get-url', 'origin'], undefined, key.file);
        if (origin.code !== 0)
            throw pullError('读取 origin 失败', origin);
        if (canonicalRepoUrl(origin.stdout.trim()) !== parsed.canonical) {
            throw new AgentsError('检出目录的 origin 与配置的仓库不一致', 409);
        }
        const current = await runGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined, key.file);
        if (current.code !== 0)
            throw pullError('读取当前分支失败', current);
        if (current.stdout.trim() !== state.branch) {
            throw new AgentsError('检出目录当前分支是 ' + current.stdout.trim() + '，配置分支是 ' + state.branch, 409);
        }
        const shallow = await runGit(['-C', target, 'rev-parse', '--is-shallow-repository'], undefined, key.file);
        const fetchArgs = shallow.code === 0 && shallow.stdout.trim() === 'true'
            ? ['-C', target, 'fetch', '--unshallow', 'origin', state.branch]
            : ['-C', target, 'fetch', 'origin', state.branch];
        const fetched = await runGit(fetchArgs, undefined, key.file);
        if (fetched.code !== 0)
            throw pullError('fetch 失败', fetched);
        const merged = await runGit(['-C', target, 'merge', '--ff-only', 'FETCH_HEAD'], undefined, key.file);
        if (merged.code !== 0)
            throw pullError('快进合并失败', merged);
        message = '已快进到最新提交';
    }
    if (state.recurseSubmodules) {
        const sync = await runGit(['-C', target, 'submodule', 'sync', '--recursive'], undefined, key.file);
        if (sync.code !== 0)
            ctx.logger.warn('utils-agents: shared submodule sync failed: ' + sync.stderr.trim());
        const update = await runGit(['-C', target, 'submodule', 'update', '--init', '--recursive'], undefined, key.file);
        if (update.code !== 0)
            ctx.logger.warn('utils-agents: shared submodule update failed: ' + update.stderr.trim());
    }
    const status = await targetStatus(ctx, { ...state });
    await writeSharedRepoState({
        ...state,
        lastSync: {
            at: new Date().toISOString(),
            ok: true,
            commit: status.commit ?? '',
            skills: status.skills,
            message,
        },
    });
    return sharedRepoView(ctx, options);
}
/** The legacy state path shared with the old global route. */
export function sharedRepoStatePath() {
    return join(dshHome(), 'storages', STATE_FILE_NAME);
}
/** The legacy deploy-key path shared with the old global route. */
export function sharedStoredKeyPath() {
    return join(dshHome(), 'storages', KEY_FILE_NAME);
}
/** The SSH identity for the shared repository. */
export async function sharedKeyStatus(state) {
    if (state.keyPath !== '') {
        let file;
        try {
            file = expandAbsolute(state.keyPath);
        }
        catch {
            return { source: 'none', file: undefined, hasStoredKey: await exists(sharedStoredKeyPath()) };
        }
        if (await exists(file))
            return { source: 'path', file, hasStoredKey: await exists(sharedStoredKeyPath()) };
    }
    const stored = sharedStoredKeyPath();
    if (await exists(stored))
        return { source: 'stored', file: stored, hasStoredKey: true };
    const fallback = globalKeyPath();
    if (await exists(fallback))
        return { source: 'global', file: fallback, hasStoredKey: false };
    return { source: 'none', file: undefined, hasStoredKey: false };
}
/** Inspect the shared checkout. */
async function targetStatus(ctx, state) {
    const target = state.targetDir;
    if (!(await exists(target)))
        return { exists: false, isRepo: false, branch: null, commit: null, dirty: false, skills: 0 };
    const root = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], undefined, undefined);
    if (root.code !== 0 || resolve(root.stdout.trim()) !== resolve(target)) {
        return { exists: true, isRepo: false, branch: null, commit: null, dirty: false, skills: 0 };
    }
    const branch = await runGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined, undefined);
    const commit = await runGit(['-C', target, 'rev-parse', 'HEAD'], undefined, undefined);
    const dirty = await runGit(['-C', target, 'status', '--porcelain'], undefined, undefined);
    const skills = await countSkills(ctx, target);
    return {
        exists: true,
        isRepo: true,
        branch: branch.code === 0 ? branch.stdout.trim() : null,
        commit: commit.code === 0 ? commit.stdout.trim() : null,
        dirty: dirty.code === 0 && dirty.stdout.trim() !== '',
        skills,
    };
}
/** Count enabled SKILL.md files inside the shared checkout. */
async function countSkills(ctx, root) {
    let count = 0;
    await walkFiles(root, SKILL_SCAN_DEPTH, new Set(IGNORED_DIRS), (path) => {
        if (path.endsWith('/SKILL.md') || path.endsWith('\\SKILL.md'))
            count += 1;
    }, ctx);
    return count;
}
/** Persist the shared repository settings. */
async function writeSharedRepoState(state) {
    const file = sharedRepoStatePath();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomSuffix() + '.tmp';
    try {
        await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, file);
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
    await chmod(file, 0o600);
}
/** Build a sanitized git failure. */
function pullError(prefix, outcome) {
    const detail = outcome.stderr.trim() || outcome.spawnError || (outcome.timedOut ? 'timeout' : 'exit ' + String(outcome.code));
    return new AgentsError(prefix + '：' + detail.split(/\r?\n/).slice(0, 3).join(' / '), 500);
}
/** Read one string field or its fallback. */
function textValue(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}
/** Read one absolute path field or its fallback. */
function absoluteValue(value, fallback) {
    if (typeof value !== 'string' || value.trim() === '')
        return fallback;
    try {
        return expandAbsolute(value);
    }
    catch {
        return fallback;
    }
}
/** Normalize a persisted sync record. */
function normalizeSync(raw) {
    if (raw === null || typeof raw !== 'object')
        return null;
    const record = raw;
    return {
        at: typeof record.at === 'string' ? record.at : '',
        ok: record.ok === true,
        commit: typeof record.commit === 'string' ? record.commit : '',
        skills: typeof record.skills === 'number' ? record.skills : 0,
        message: typeof record.message === 'string' ? record.message : '',
    };
}
/** Short random suffix for one temporary file. */
function randomSuffix() {
    return process.pid.toString(36) + Math.random().toString(36).slice(2, 8);
}
//# sourceMappingURL=global-repo.js.map