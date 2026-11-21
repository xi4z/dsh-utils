/**
 * Git skill repository support for the utils-agents panel.
 *
 * The repository settings live inside the preset directory at
 * .dsh-utils/repo.json, so moving a preset moves its repository config with it.
 * Pasted deploy keys are the only secrets stored outside: the per-preset keys
 * and the panel-wide key live under $DSH_HOME/storages/dsh-utils-agents and are
 * never returned to the browser. The panel-wide key is the fallback for any
 * repository (including the shared skill repository) whose own key path and
 * stored key are absent, so one private Deploy Key can pull every private
 * repository the panel tracks.
 *
 * The sync is intentionally pull-only: a missing target is cloned, an existing
 * target must be a checkout of the same repository on the configured branch,
 * and the update is a fast-forward merge. Nothing is reset or pushed.
 *
 * @module dsh-utils/utils-agents/git
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AgentsError, agentsStorageDir, directoryOf, errorMessage, exists, expandAbsolute, presetStorageName, } from './util.js';
import { scanSkills } from './presets.js';
/** Every git command is bounded. */
const GIT_TIMEOUT_MS = 120000;
/** stdout/stderr cap for one git command. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** Default folder under the preset skills/ directory. */
const DEFAULT_TARGET_SUBDIR = 'skills-repo';
/** Branch names git accepts here. */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
/** HTTPS hosts commonly authenticated with an SSH deploy key. */
const SSH_HOSTS = new Set(['github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org', 'codeberg.org']);
/** Read the per-preset repository state, filling defaults. */
export async function readRepoState(preset, options) {
    let raw = null;
    try {
        raw = JSON.parse(await readFile(repoStatePath(preset), 'utf8'));
    }
    catch {
        raw = null;
    }
    const record = raw !== null && typeof raw === 'object' ? raw : {};
    return {
        repoUrl: textValue(record.repoUrl, options.defaultRepoUrl),
        branch: textValue(record.branch, options.defaultBranch),
        targetSubdir: textValue(record.targetSubdir, DEFAULT_TARGET_SUBDIR),
        keyPath: typeof record.keyPath === 'string' ? record.keyPath : '',
        recurseSubmodules: record.recurseSubmodules !== false,
        lastSync: normalizeSync(record.lastSync),
    };
}
/** Persist the per-preset repository state. */
export async function saveRepoState(preset, state) {
    const directory = join(preset.path, '.dsh-utils');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'repo.json');
    const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
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
/** Build the repository view: settings, target status and key source. */
export async function repoView(ctx, preset, options) {
    const state = await readRepoState(preset, options);
    const target = targetPath(preset, state);
    return {
        state,
        target,
        status: await targetStatus(ctx, preset, state),
        key: await keyStatus(preset, state),
    };
}
/** Save a new repository configuration after validation. */
export async function saveRepoConfig(ctx, preset, options, body) {
    const current = await readRepoState(preset, options);
    const repoUrl = textValue(body.repoUrl, current.repoUrl);
    const branch = textValue(body.branch, current.branch);
    const targetSubdir = textValue(body.targetSubdir, current.targetSubdir);
    const keyPath = typeof body.keyPath === 'string' ? body.keyPath.trim() : current.keyPath;
    const recurseSubmodules = typeof body.recurseSubmodules === 'boolean' ? body.recurseSubmodules : current.recurseSubmodules;
    validateRepoUrl(repoUrl);
    validateBranch(branch);
    validateSubdir(targetSubdir);
    if (keyPath !== '') {
        const expanded = expandAbsolute(keyPath);
        if (!(await exists(expanded)))
            throw new AgentsError('密钥路径不存在：' + expanded, 400);
    }
    await saveRepoState(preset, { repoUrl, branch, targetSubdir, keyPath, recurseSubmodules, lastSync: current.lastSync });
    return repoView(ctx, preset, options);
}
/** Store a pasted deploy key; an empty string clears it. */
export async function saveRepoKey(preset, key) {
    const file = storedKeyPath(preset);
    if (key.trim() === '') {
        await rm(file, { force: true });
        return { source: 'none', file: undefined, hasStoredKey: false };
    }
    if (key.includes('\u0000'))
        throw new AgentsError('Deploy Key 不能包含 NUL 字符', 400);
    await mkdir(agentsStorageDir(), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        await writeFile(temp, key.trimEnd() + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, file);
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
    await chmod(file, 0o600);
    return { source: 'stored', file, hasStoredKey: true };
}
/** Synchronize the configured repository into the preset skills directory. */
export async function syncRepo(ctx, preset, options) {
    const state = await readRepoState(preset, options);
    const key = await keyStatus(preset, state);
    if (state.keyPath !== '' && key.file === undefined)
        throw new AgentsError('配置的密钥路径不存在', 409);
    const parsed = validateRepoUrl(state.repoUrl);
    validateBranch(state.branch);
    validateSubdir(state.targetSubdir);
    const target = targetPath(preset, state);
    const cloneUrl = cloneUrlFor(parsed, key.file);
    const parent = join(preset.path, 'skills');
    await mkdir(parent, { recursive: true });
    const targetExists = await exists(target);
    let message = '';
    if (!targetExists) {
        const result = await runGit(['clone', '--depth', '1', '--branch', state.branch, '--single-branch', cloneUrl, target], parent, key.file);
        if (result.code !== 0)
            throw gitError('clone 失败', result);
        message = '已 clone 分支 ' + state.branch;
    }
    else {
        if (!(await directoryOf(target)))
            throw new AgentsError('目标已存在但不是目录：' + target, 409);
        const root = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], undefined, key.file);
        if (root.code !== 0 || resolve(root.stdout.trim()) !== resolve(target)) {
            throw new AgentsError('目标目录不是该仓库的 Git checkout', 409);
        }
        const origin = await runGit(['-C', target, 'remote', 'get-url', 'origin'], undefined, key.file);
        if (origin.code !== 0)
            throw gitError('读取 origin 失败', origin);
        if (canonicalRepoUrl(origin.stdout.trim()) !== parsed.canonical) {
            throw new AgentsError('目标目录的 origin 与配置的仓库不一致', 409);
        }
        const current = await runGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined, key.file);
        if (current.code !== 0)
            throw gitError('读取当前分支失败', current);
        if (current.stdout.trim() !== state.branch) {
            throw new AgentsError('目标目录当前分支是 ' + current.stdout.trim() + '，配置分支是 ' + state.branch, 409);
        }
        // A depth-1 clone has no parent commits, so a later shallow fetch looks
        // like an unrelated history. Unshallow once, then use a normal fetch.
        const shallow = await runGit(['-C', target, 'rev-parse', '--is-shallow-repository'], undefined, key.file);
        const fetchArgs = shallow.code === 0 && shallow.stdout.trim() === 'true'
            ? ['-C', target, 'fetch', '--unshallow', 'origin', state.branch]
            : ['-C', target, 'fetch', 'origin', state.branch];
        const fetched = await runGit(fetchArgs, undefined, key.file);
        if (fetched.code !== 0)
            throw gitError('fetch 失败', fetched);
        const merged = await runGit(['-C', target, 'merge', '--ff-only', 'FETCH_HEAD'], undefined, key.file);
        if (merged.code !== 0)
            throw gitError('快进合并失败', merged);
        message = '已快进到最新提交';
    }
    if (state.recurseSubmodules) {
        const sync = await runGit(['-C', target, 'submodule', 'sync', '--recursive'], undefined, key.file);
        if (sync.code !== 0)
            ctx.logger.warn('utils-agents: submodule sync failed: ' + sync.stderr.trim());
        const update = await runGit(['-C', target, 'submodule', 'update', '--init', '--recursive'], undefined, key.file);
        if (update.code !== 0)
            ctx.logger.warn('utils-agents: submodule update failed: ' + update.stderr.trim());
    }
    const status = await targetStatus(ctx, preset, state);
    const record = {
        at: new Date().toISOString(),
        ok: true,
        commit: status.commit ?? '',
        skills: status.skills,
        message,
    };
    const next = { ...state, lastSync: record };
    await saveRepoState(preset, next);
    return { state: next, target, status, key: await keyStatus(preset, next) };
}
/** Inspect the target checkout. */
export async function targetStatus(ctx, preset, state) {
    const target = targetPath(preset, state);
    if (!(await exists(target)))
        return { exists: false, isRepo: false, branch: null, commit: null, dirty: false, skills: 0 };
    const root = await runGit(['-C', target, 'rev-parse', '--show-toplevel'], undefined, undefined);
    if (root.code !== 0 || resolve(root.stdout.trim()) !== resolve(target)) {
        return { exists: true, isRepo: false, branch: null, commit: null, dirty: false, skills: 0 };
    }
    const branch = await runGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined, undefined);
    const commit = await runGit(['-C', target, 'rev-parse', 'HEAD'], undefined, undefined);
    const dirty = await runGit(['-C', target, 'status', '--porcelain'], undefined, undefined);
    const skills = (await scanSkills(ctx, preset.path)).filter((skill) => skill.enabled).length;
    return {
        exists: true,
        isRepo: true,
        branch: branch.code === 0 ? branch.stdout.trim() : null,
        commit: commit.code === 0 ? commit.stdout.trim() : null,
        dirty: dirty.code === 0 && dirty.stdout.trim() !== '',
        skills,
    };
}
/** The SSH identity for one preset. */
export async function keyStatus(preset, state) {
    if (state.keyPath !== '') {
        let file;
        try {
            file = expandAbsolute(state.keyPath);
        }
        catch {
            return { source: 'none', file: undefined, hasStoredKey: await exists(storedKeyPath(preset)) };
        }
        if (await exists(file))
            return { source: 'path', file, hasStoredKey: await exists(storedKeyPath(preset)) };
    }
    const stored = storedKeyPath(preset);
    if (await exists(stored))
        return { source: 'stored', file: stored, hasStoredKey: true };
    const fallback = globalKeyPath();
    if (await exists(fallback))
        return { source: 'global', file: fallback, hasStoredKey: false };
    return { source: 'none', file: undefined, hasStoredKey: false };
}
/** The target checkout path; always inside preset/skills. */
export function targetPath(preset, state) {
    validateSubdir(state.targetSubdir);
    return join(preset.path, 'skills', state.targetSubdir);
}
/** .dsh-utils/repo.json for one preset. */
function repoStatePath(preset) {
    return join(preset.path, '.dsh-utils', 'repo.json');
}
/** Stored deploy key path for one preset. */
function storedKeyPath(preset) {
    return join(agentsStorageDir(), presetStorageName(preset.id) + '.key');
}
/** The panel-wide Deploy Key used when a repository has no key of its own. */
export function globalKeyPath() {
    return join(agentsStorageDir(), 'deploy-key');
}
/** The panel-wide Deploy Key status; the key's content never leaves the host. */
export async function globalKeyStatus() {
    const file = globalKeyPath();
    if (await exists(file))
        return { source: 'global', file, hasStoredKey: true };
    return { source: 'none', file: undefined, hasStoredKey: false };
}
/** Store the panel-wide Deploy Key; an empty string clears it. */
export async function saveGlobalKey(key) {
    const file = globalKeyPath();
    if (key.trim() === '') {
        await rm(file, { force: true });
        return globalKeyStatus();
    }
    if (key.includes('\u0000'))
        throw new AgentsError('Deploy Key 不能包含 NUL 字符', 400);
    await mkdir(agentsStorageDir(), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        await writeFile(temp, key.trimEnd() + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, file);
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
    await chmod(file, 0o600);
    return globalKeyStatus();
}
/** Validate and normalize a repository URL. */
export function validateRepoUrl(raw) {
    const url = raw.trim();
    if (url === '')
        throw new AgentsError('仓库地址不能为空', 400);
    if (/[\u0000-\u001f]/.test(url))
        throw new AgentsError('仓库地址不能包含控制字符', 400);
    if (/\s/.test(url))
        throw new AgentsError('仓库地址不能包含空白字符', 400);
    if (url.startsWith('-'))
        throw new AgentsError('仓库地址不能以 - 开头', 400);
    return parseRepoUrl(url);
}
/** Parse one repository URL. */
function parseRepoUrl(raw) {
    const https = /^(https?):\/\/([^/]+)\/(.+)$/i.exec(raw);
    if (https !== null) {
        const kind = https[1].toLowerCase() === 'https' ? 'https' : 'http';
        return makeRepo(kind, raw, https[2], https[3]);
    }
    const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(raw);
    if (ssh !== null)
        return makeRepo('ssh', raw, ssh[1], ssh[2]);
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(raw);
    if (scp !== null && !isAbsolute(raw) && !/^[A-Za-z]:[\\/]/.test(raw))
        return makeRepo('scp', raw, scp[1], scp[2]);
    if (raw.startsWith('file://'))
        return makeRepo('file', raw, undefined, raw.slice('file://'.length));
    if (isAbsolute(raw))
        return makeRepo('path', raw, undefined, raw);
    throw new AgentsError('无法识别的仓库地址：' + raw, 400);
}
/** Build a parsed repo record. */
function makeRepo(kind, raw, host, path) {
    const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    const canonical = (host === undefined ? '' : host.toLowerCase() + '/') + cleanPath;
    return { kind, raw, isSsh: kind === 'ssh' || kind === 'scp', host: host?.toLowerCase(), path: cleanPath, canonical };
}
/** Compare key for one repository URL. */
export function canonicalRepoUrl(raw) {
    try {
        return parseRepoUrl(raw.trim()).canonical;
    }
    catch {
        return raw.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
    }
}
/** Clone URL, rewritten to SSH when a key is present and the host supports it. */
export function cloneUrlFor(parsed, keyFile) {
    if (keyFile !== undefined && parsed.kind === 'https' && parsed.host !== undefined && SSH_HOSTS.has(parsed.host)) {
        return 'git@' + parsed.host + ':' + parsed.path + '.git';
    }
    return parsed.raw;
}
/** Validate a branch name. */
export function validateBranch(raw) {
    const value = raw.trim();
    if (value === '')
        throw new AgentsError('分支不能为空', 400);
    if (!BRANCH_PATTERN.test(value))
        throw new AgentsError('分支名不合法：' + value, 400);
    if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
        || value.includes('..') || value.includes('//')) {
        throw new AgentsError('分支名不合法：' + value, 400);
    }
    return value;
}
/** Validate the target folder under skills/. */
export function validateSubdir(raw) {
    const value = raw.trim();
    if (value === '' || value === '.' || value === '..')
        throw new AgentsError('目标子目录不合法', 400);
    if (value.includes('/') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) {
        throw new AgentsError('目标子目录只能是单层目录名', 400);
    }
    return value;
}
/** Run one git command without a shell, with prompts disabled. */
export async function runGit(args, cwd, keyFile) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (keyFile !== undefined) {
        env.GIT_SSH_COMMAND = 'ssh -i ' + JSON.stringify(keyFile) + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new';
    }
    return await new Promise((resolvePromise) => {
        execFile('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
            const candidate = error;
            resolvePromise({
                code: error === null ? 0 : typeof candidate?.code === 'number' ? candidate.code : null,
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? ''),
                timedOut: candidate?.killed === true || candidate?.signal === 'SIGTERM',
                spawnError: error !== null && typeof candidate?.code === 'string' ? String(candidate.code) : undefined,
            });
        });
    });
}
/** Build a sanitized git failure. */
function gitError(prefix, outcome) {
    const detail = outcome.stderr.trim() || outcome.spawnError || (outcome.timedOut ? 'timeout' : 'exit ' + String(outcome.code));
    return new AgentsError(prefix + '：' + detail.split(/\r?\n/).slice(0, 3).join(' / '), 500);
}
/** Read one string field or its fallback. */
function textValue(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
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
//# sourceMappingURL=git.js.map