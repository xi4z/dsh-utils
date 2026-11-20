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
import z from '@deepseek-ai/schemastery';
import { BODY_LIMIT_BYTES, DEFAULT_MAX_BYTES, GLOBAL_PRESET, WorkbenchError, failure, fileRow, json, normalizeOptions, optionalText, readJsonBody, readTextFile, requiredText, resolveCwd, sessionPresetOf, writeTextFile, } from './util.js';
import { discoverPresets, globalFiles, presetById, presetFiles, resolveFileId, toggleSkill, } from './presets.js';
import { readRepoState, repoView, saveRepoConfig, saveRepoKey, syncRepo, } from './git.js';
import { createLegacyBridge } from './legacy.js';
import { sharedPresetView, syncSharedPresets } from './shared.js';
import { pullSharedRepo, saveSharedRepoConfig, saveSharedRepoKey, sharedRepoView } from './global-repo.js';
export const name = 'preset-workbench';
/** Exact Connection routes owned by this component. */
export const ROUTE_PATHS = {
    list: '/api/dsh-utils/workbench/list',
    files: '/api/dsh-utils/workbench/files',
    file: '/api/dsh-utils/workbench/file',
    skill: '/api/dsh-utils/workbench/skill',
    repo: '/api/dsh-utils/workbench/repo',
    key: '/api/dsh-utils/workbench/key',
    sync: '/api/dsh-utils/workbench/sync',
    shared: '/api/dsh-utils/workbench/shared',
    sharedSync: '/api/dsh-utils/workbench/shared-sync',
    sharedRepo: '/api/dsh-utils/workbench/shared-repo',
    sharedKey: '/api/dsh-utils/workbench/shared-key',
    sharedPull: '/api/dsh-utils/workbench/shared-pull',
};
/**
 * Settings schema. Every field is volatile: the routes re-read the live
 * references, so saving the form takes effect without a restart.
 */
export const Config = z.object({
    maxBytes: z.natural().min(1024).max(BODY_LIMIT_BYTES).default(DEFAULT_MAX_BYTES)
        .description('单个 Markdown 文件的读取/写入上限（字节）。').volatile(),
    presetDirs: z.array(z.string().min(1)).default([])
        .description('额外的预设根目录；每个子目录被视为一个预设。').volatile(),
    presetSourceDirs: z.array(z.string().min(1)).default([])
        .description('额外的技能仓库目录；其 .dsh 下的预设可同步到本机。').volatile(),
    extraAgentsFiles: z.array(z.string().min(1)).default([])
        .description('全局视图额外暴露的 AGENTS.md 类绝对路径。').volatile(),
    scanNestedAgents: z.boolean().default(false)
        .description('全局视图递归寻找嵌套 AGENTS.md / CLAUDE.md。').volatile(),
    nestedDepth: z.natural().min(1).max(8).default(3)
        .description('全局视图的递归深度。').volatile(),
    defaultRepoUrl: z.string().default('https://github.com/xi4z/skills')
        .description('新预设的默认技能仓库地址。').volatile(),
    defaultBranch: z.string().default('Agent')
        .description('新预设的默认技能仓库分支。').volatile(),
});
/**
 * Activate the workbench routes.
 * @param ctx - host Cordis context.
 * @param config - row config; volatile fields arrive as live references.
 */
export function apply(ctx, config = {}) {
    const legacy = createLegacyBridge(ctx, config);
    ctx.effect(() => () => { void legacy.dispose(); }, 'workbench: legacy preset bridge');
    // Register directory presets as soon as the registry exists, so the normal
    // preset picker sees them even before the Utils panel is opened.
    ctx.inject(['agentPresets'], () => {
        void legacy.ensure().catch((error) => {
            ctx.logger.warn('workbench: legacy preset registration failed: ' + String(error));
        });
    });
    ctx.inject(['connection'], (scope) => {
        const connection = scope.connection;
        if (!connection)
            return;
        registerRoute(scope, ctx, connection, ROUTE_PATHS.list, ['GET'], (request) => handleList(ctx, config, legacy, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.files, ['GET'], (request) => handleFiles(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.file, ['GET', 'POST'], (request) => handleFile(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.skill, ['POST'], (request) => handleSkill(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.repo, ['GET', 'POST'], (request) => handleRepo(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.key, ['POST'], (request) => handleKey(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.sync, ['POST'], (request) => handleSync(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.shared, ['GET'], (request) => handleShared(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.sharedSync, ['POST'], (request) => handleSharedSync(ctx, config, legacy, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.sharedRepo, ['GET', 'POST'], (request) => handleSharedRepo(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.sharedKey, ['POST'], (request) => handleSharedKey(ctx, config, request));
        registerRoute(scope, ctx, connection, ROUTE_PATHS.sharedPull, ['POST'], (request) => handleSharedPull(ctx, config, request));
    });
}
/**
 * Register one route and log a refusal instead of throwing out of activation.
 */
function registerRoute(scope, ctx, connection, path, methods, fetch) {
    scope.effect(() => {
        try {
            return connection.fetch.register({ path, methods, requestBody: 'buffered', fetch });
        }
        catch (error) {
            ctx.logger.warn('workbench: cannot register ' + path + ': ' + String(error));
            return () => Promise.resolve();
        }
    }, 'workbench: ' + path);
}
/** GET /list: every preset plus the global AGENTS.md family. */
async function handleList(ctx, config, legacy, request) {
    try {
        const options = normalizeOptions(config);
        const sessionId = optionalText(new URL(request.url).searchParams.get('sessionId'));
        const cwd = await resolveCwd(ctx, sessionId, request.signal);
        await legacy.ensure();
        const statuses = legacy.status();
        const presets = (await discoverPresets(ctx, options)).map((preset) => {
            const status = statuses.get(preset.id);
            return { ...preset, registered: status?.registered === true, broken: status?.broken };
        });
        const sessionPreset = sessionPresetOf(ctx, sessionId);
        const matching = sessionPreset === null ? undefined : presets.find((preset) => preset.id === sessionPreset);
        const defaultPresetId = matching?.id ?? presets[0]?.id ?? GLOBAL_PRESET;
        const global = await globalFiles(ctx, options, cwd);
        return json({
            sessionId,
            cwd,
            sessionPreset,
            defaultPresetId,
            presets,
            global: {
                id: GLOBAL_PRESET,
                name: '全局 / 项目',
                description: '用户级与项目级 AGENTS.md；不管理预设技能。',
                files: global,
            },
        }, 200);
    }
    catch (error) {
        return failure(ctx, 'cannot list presets', error);
    }
}
/** GET /files: Markdown inventory for one preset or the global target. */
async function handleFiles(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        const presetId = requiredText(new URL(request.url).searchParams.get('presetId'), '缺少 presetId');
        if (presetId === GLOBAL_PRESET) {
            const cwd = await resolveCwd(ctx, optionalText(new URL(request.url).searchParams.get('sessionId')), request.signal);
            return json({ presetId, preset: null, files: await globalFiles(ctx, options, cwd) }, 200);
        }
        const preset = await presetById(ctx, options, presetId);
        return json({ presetId, preset, files: await presetFiles(ctx, preset) }, 200);
    }
    catch (error) {
        return failure(ctx, 'cannot list preset files', error);
    }
}
/** GET/POST /file: read or atomically write one Markdown file. */
async function handleFile(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        const sessionId = optionalText(new URL(request.url).searchParams.get('sessionId'));
        const cwd = await resolveCwd(ctx, sessionId, request.signal);
        if (request.method === 'POST') {
            const body = await readJsonBody(request);
            if (body === null || typeof body !== 'object' || Array.isArray(body))
                throw new WorkbenchError('请求体必须是 JSON 对象', 400);
            const record = body;
            const id = requiredText(record.id, '缺少文件 id');
            const content = typeof record.content === 'string' ? record.content : undefined;
            if (content === undefined)
                throw new WorkbenchError('content 必须是字符串', 400);
            const baseMtimeMs = typeof record.baseMtimeMs === 'number' && Number.isFinite(record.baseMtimeMs) ? record.baseMtimeMs : null;
            const resolved = await resolveFileId(ctx, options, id, cwd);
            const written = await writeTextFile(resolved.path, content, baseMtimeMs, options.maxBytes);
            const row = await fileRow(id, resolved.row.label, resolved.path, resolved.row.presetId, resolved.row.kind);
            return json({ file: { ...row, scope: resolved.row.scope }, bytes: written.bytes }, 200);
        }
        const id = requiredText(new URL(request.url).searchParams.get('id'), '缺少文件 id');
        const resolved = await resolveFileId(ctx, options, id, cwd);
        if (!resolved.row.exists)
            return json({ file: resolved.row, content: '' }, 200);
        if (!resolved.row.editable)
            throw new WorkbenchError('这个文件不是可编辑的普通文件', 409);
        const content = (await readTextFile(resolved.path, options.maxBytes)).content;
        return json({ file: resolved.row, content }, 200);
    }
    catch (error) {
        return failure(ctx, 'cannot handle file', error);
    }
}
/** POST /skill: toggle one preset skill by renaming SKILL.md. */
async function handleSkill(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new WorkbenchError('请求体必须是 JSON 对象', 400);
        const record = body;
        const presetId = requiredText(record.presetId, '缺少 presetId');
        const path = requiredText(record.path, '缺少 skill path');
        const enabled = record.enabled === true;
        const preset = await presetById(ctx, options, presetId);
        return json({ skill: await toggleSkill(preset, path, enabled) }, 200);
    }
    catch (error) {
        return failure(ctx, 'cannot toggle skill', error);
    }
}
/** GET/POST /repo: read or save the per-preset repository settings. */
async function handleRepo(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        if (request.method === 'GET') {
            const presetId = requiredText(new URL(request.url).searchParams.get('presetId'), '缺少 presetId');
            const preset = await presetById(ctx, options, presetId);
            return json(await repoView(ctx, preset, options), 200);
        }
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new WorkbenchError('请求体必须是 JSON 对象', 400);
        const record = body;
        const presetId = requiredText(record.presetId, '缺少 presetId');
        const preset = await presetById(ctx, options, presetId);
        return json(await saveRepoConfig(ctx, preset, options, record), 200);
    }
    catch (error) {
        return failure(ctx, 'cannot update repository', error);
    }
}
/** POST /key: store or clear the pasted deploy key. */
async function handleKey(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new WorkbenchError('请求体必须是 JSON 对象', 400);
        const record = body;
        const presetId = requiredText(record.presetId, '缺少 presetId');
        const key = typeof record.key === 'string' ? record.key : '';
        const preset = await presetById(ctx, options, presetId);
        const saved = await saveRepoKey(preset, key);
        return json({ key: saved, state: await readRepoState(preset, options) }, 200);
    }
    catch (error) {
        return failure(ctx, 'cannot save deploy key', error);
    }
}
/** GET /shared: presets carried by the skill repositories' .dsh directory. */
async function handleShared(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        const presetId = requiredText(new URL(request.url).searchParams.get('presetId'), '缺少 presetId');
        const preset = await presetById(ctx, options, presetId);
        return json(await sharedPresetView(ctx, options, preset), 200);
    }
    catch (error) {
        return failure(ctx, 'cannot list shared presets', error);
    }
}
/** POST /shared-sync: copy .dsh presets into the local preset home. */
async function handleSharedSync(ctx, config, legacy, request) {
    try {
        const options = normalizeOptions(config);
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new WorkbenchError('请求体必须是 JSON 对象', 400);
        const record = body;
        const presetId = requiredText(record.presetId, '缺少 presetId');
        const preset = await presetById(ctx, options, presetId);
        const payload = await syncSharedPresets(ctx, options, preset, record);
        // Register anything newly copied so it appears in the preset picker at once.
        try {
            await legacy.ensure();
        }
        catch (error) {
            ctx.logger.warn('workbench: preset registration after shared sync failed: ' + String(error));
        }
        return json(payload, 200);
    }
    catch (error) {
        return failure(ctx, 'cannot sync shared presets', error);
    }
}
/** GET/POST /shared-repo: stored settings for the tracked skill repository. */
async function handleSharedRepo(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        if (request.method === 'GET')
            return json(await sharedRepoView(ctx, options), 200);
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new WorkbenchError('请求体必须是 JSON 对象', 400);
        return json(await saveSharedRepoConfig(ctx, options, body), 200);
    }
    catch (error) {
        return failure(ctx, 'cannot save shared repository', error);
    }
}
/** POST /shared-key: store or clear the shared repository Deploy Key. */
async function handleSharedKey(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new WorkbenchError('请求体必须是 JSON 对象', 400);
        const record = body;
        const key = typeof record.key === 'string' ? record.key : '';
        return json(await saveSharedRepoKey(ctx, options, key), 200);
    }
    catch (error) {
        return failure(ctx, 'cannot save shared deploy key', error);
    }
}
/** POST /shared-pull: clone or fast-forward the tracked skill repository. */
async function handleSharedPull(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        return json(await pullSharedRepo(ctx, options), 200);
    }
    catch (error) {
        return failure(ctx, 'cannot pull shared repository', error);
    }
}
/** POST /sync: clone or fast-forward the preset repository. */
async function handleSync(ctx, config, request) {
    try {
        const options = normalizeOptions(config);
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new WorkbenchError('请求体必须是 JSON 对象', 400);
        const record = body;
        const presetId = requiredText(record.presetId, '缺少 presetId');
        const preset = await presetById(ctx, options, presetId);
        return json(await syncRepo(ctx, preset, options), 200);
    }
    catch (error) {
        return failure(ctx, 'cannot sync repository', error);
    }
}
//# sourceMappingURL=index.js.map