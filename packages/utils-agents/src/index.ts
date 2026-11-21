/**
 * utils-agents: the one host component for skills and presets.
 *
 * It merges what used to be three separate packages/rows:
 *
 * - nested `SKILL.md` discovery from `@xi4z/dsh-utils-main`;
 * - the model-facing skill visibility filter from
 *   `@xi4z/dsh-utils-skill-panel`;
 * - the preset panel (skills tree, Markdown editor, per-preset Git skill
 *   repository, shared presets and native-preset import/export).
 *
 * The panel picks one preset directory (or the global AGENTS.md pseudo preset)
 * and then lists its skills tree, edits its Markdown and syncs its repository.
 * All browser requests use opaque file ids; the preset id is re-resolved
 * against the configured preset roots on every call.
 *
 * @module @xi4z/dsh-utils-utils-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BODY_LIMIT_BYTES,
  DEFAULT_MAX_BYTES,
  GLOBAL_PRESET,
  AgentsError,
  failure,
  fileRow,
  json,
  normalizeOptions,
  optionalText,
  readJsonBody,
  readTextFile,
  requiredText,
  resolveCwd,
  sessionPresetOf,
  writeTextFile,
  type AgentsConfig,
} from './util.js'
import {
  discoverPresets,
  globalFiles,
  presetById,
  presetFiles,
  resolveFileId,
  toggleSkill,
} from './presets.js'
import {
  globalKeyStatus,
  readRepoState,
  repoView,
  saveGlobalKey,
  saveRepoConfig,
  saveRepoKey,
  syncRepo,
  type KeyStatus,
} from './git.js'
import { createLegacyBridge, type LegacyBridge } from './legacy.js'
import { sharedPresetView, syncSharedPresets } from './shared.js'
import { pullSharedRepo, saveSharedRepoConfig, saveSharedRepoKey, sharedRepoView } from './global-repo.js'
import { importNativePresets, nativePresetView, publishPresets } from './native.js'
import { createUpdateChecker, startUpdateWatcher, type UpdateChecker } from './update.js'
import {
  SKILL_DISCOVERY_DEFAULTS,
  applySkillDiscovery,
  type SkillDiscoveryConfig,
} from './skill-discovery.js'
import {
  ROUTE_PATH as SKILL_PANEL_ROUTE,
  applySkillPanel,
  type SkillPanelConfig,
} from './skill-panel.js'

export const name = 'utils-agents'

/** The merged component still needs the host skill registry. */
export const inject = ['skills']

/** Raw row config: agents settings plus the merged discovery and visibility fields. */
export interface UtilsAgentsConfig extends AgentsConfig, SkillDiscoveryConfig, SkillPanelConfig {}

/** Exact Connection routes owned by this component. */
export const ROUTE_PATHS = {
  list: '/api/dsh-utils/utils-agents/list',
  files: '/api/dsh-utils/utils-agents/files',
  file: '/api/dsh-utils/utils-agents/file',
  skill: '/api/dsh-utils/utils-agents/skill',
  repo: '/api/dsh-utils/utils-agents/repo',
  key: '/api/dsh-utils/utils-agents/key',
  sync: '/api/dsh-utils/utils-agents/sync',
  shared: '/api/dsh-utils/utils-agents/shared',
  sharedSync: '/api/dsh-utils/utils-agents/shared-sync',
  sharedRepo: '/api/dsh-utils/utils-agents/shared-repo',
  sharedKey: '/api/dsh-utils/utils-agents/shared-key',
  sharedPull: '/api/dsh-utils/utils-agents/shared-pull',
  deployKey: '/api/dsh-utils/utils-agents/deploy-key',
  update: '/api/dsh-utils/utils-agents/update',
  native: '/api/dsh-utils/utils-agents/native-presets',
  nativeImport: '/api/dsh-utils/utils-agents/native-presets-import',
  publish: '/api/dsh-utils/utils-agents/presets-publish',
  skillList: SKILL_PANEL_ROUTE,
} as const

/**
 * Settings schema. Every field is volatile: the routes re-read the live
 * references, so saving the form takes effect without a restart.
 */
export const Config = z.object({
  // -- nested SKILL.md discovery (merged from @xi4z/dsh-utils-main) --
  minDepth: z.natural().min(1).default(SKILL_DISCOVERY_DEFAULTS.minDepth)
    .description('第一个可能包含 SKILL.md 的目录层级。').volatile(),
  maxDepth: z.natural().min(1).default(SKILL_DISCOVERY_DEFAULTS.maxDepth)
    .description('递归扫描的最深目录层级。').volatile(),
  watch: z.boolean().default(SKILL_DISCOVERY_DEFAULTS.watch)
    .description('技能文件变化后刷新技能目录。').volatile(),
  debounceMs: z.natural().default(SKILL_DISCOVERY_DEFAULTS.debounceMs)
    .description('监听失效的合并间隔（毫秒）。').volatile(),
  pollIntervalMs: z.natural().min(250).default(SKILL_DISCOVERY_DEFAULTS.pollIntervalMs)
    .description('不支持递归监听时的兜底轮询间隔（毫秒）。').volatile(),
  includeProjectRoots: z.boolean().default(SKILL_DISCOVERY_DEFAULTS.includeProjectRoots)
    .description('扫描项目级 .dsh/skills 与 .agents/skills。').volatile(),
  includeUserRoots: z.boolean().default(SKILL_DISCOVERY_DEFAULTS.includeUserRoots)
    .description('扫描用户级技能根。').volatile(),
  followSymlinks: z.boolean().default(SKILL_DISCOVERY_DEFAULTS.followSymlinks)
    .description('跟随符号链接目录（带环路保护）。').volatile(),
  extraRoots: z.array(z.string().min(1)).default([...SKILL_DISCOVERY_DEFAULTS.extraRoots])
    .description('额外的技能根目录。').volatile(),
  ignoreDirs: z.array(z.string().min(1)).default([...SKILL_DISCOVERY_DEFAULTS.ignoreDirs])
    .description('永不进入的目录名。').volatile(),
  // -- model-facing skill visibility (merged from @xi4z/dsh-utils-skill-panel) --
  disabledSkills: z.array(z.string()).default([])
    .description('模型技能目录里隐藏的技能名；仍可手动加载。').volatile(),
  // -- preset panel, skill repositories and AGENTS.md --
  maxBytes: z.natural().min(1024).max(BODY_LIMIT_BYTES).default(DEFAULT_MAX_BYTES)
    .description('单个 Markdown 文件的读取/写入上限（字节）。').volatile(),
  presetDirs: z.array(z.string().min(1)).default([])
    .description('额外的预设根目录；每个子目录被视为一个预设。').volatile(),
  presetSourceDirs: z.array(z.string().min(1)).default([])
    .description('额外的技能仓库目录；其 .dsh 下的预设可同步到本机。').volatile(),
  builtinPresets: z.array(z.string().min(1)).default(['standard', 'ptc', 'minimal', 'creator'])
    .description('保留为原生的预设 id；其余原生声明可导入为目录预设。').volatile(),
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
  updateCheck: z.boolean().default(true)
    .description('定时检查 npm 上 @xi4z/dsh-utils 的发布版本。').volatile(),
  updateCheckIntervalHours: z.natural().min(1).max(168).default(6)
    .description('两次自动版本检查之间的小时数。').volatile(),
  updateRegistry: z.string().default('https://registry.npmjs.org')
    .description('查询发布版本用的 npm registry 地址。').volatile(),
  updateAutoInstall: z.boolean().default(true)
    .description('查到新版本后在后台执行 pnpm add 自动安装（重启后生效；link/file 安装会跳过）。').volatile(),
})

/** One exact Connection Fetch route. */
interface ConnectionLike {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly string[]
      readonly requestBody: string
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Activate the utils-agents routes.
 * @param ctx - host Cordis context.
 * @param config - row config; volatile fields arrive as live references.
 */
export function apply(ctx: Context, config: UtilsAgentsConfig = {}): void {
  // The two former components are host-only halves of this one now; the browser
  // half in @xi4z/dsh-utils-ui still renders their pages on this row.
  applySkillDiscovery(ctx, config)
  applySkillPanel(ctx, config)

  const legacy = createLegacyBridge(ctx, config)
  const updates = createUpdateChecker(ctx, () => normalizeOptions(config))
  startUpdateWatcher(ctx, updates, () => normalizeOptions(config))
  ctx.effect(() => () => { void legacy.dispose() }, 'utils-agents: legacy preset bridge')
  // Register directory presets as soon as the registry exists, so the normal
  // preset picker sees them even before the Utils panel is opened.
  ctx.inject(['agentPresets'], () => {
    void legacy.ensure().catch((error) => {
      ctx.logger.warn('utils-agents: legacy preset registration failed: ' + String(error))
    })
  })
  ctx.inject(['connection'], (scope) => {
    const connection = (scope as unknown as { connection?: ConnectionLike }).connection
    if (!connection) return
    registerRoute(scope, ctx, connection, ROUTE_PATHS.list, ['GET'], (request) => handleList(ctx, config, legacy, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.files, ['GET'], (request) => handleFiles(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.file, ['GET', 'POST'], (request) => handleFile(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.skill, ['POST'], (request) => handleSkill(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.repo, ['GET', 'POST'], (request) => handleRepo(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.key, ['POST'], (request) => handleKey(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.sync, ['POST'], (request) => handleSync(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.shared, ['GET'], (request) => handleShared(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.sharedSync, ['POST'], (request) => handleSharedSync(ctx, config, legacy, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.sharedRepo, ['GET', 'POST'], (request) => handleSharedRepo(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.sharedKey, ['POST'], (request) => handleSharedKey(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.sharedPull, ['POST'], (request) => handleSharedPull(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.deployKey, ['GET', 'POST'], (request) => handleDeployKey(ctx, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.update, ['GET', 'POST'], (request) => handleUpdate(ctx, config, updates, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.native, ['GET'], (request) => handleNative(ctx, config, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.nativeImport, ['POST'], (request) => handleNativeImport(ctx, config, legacy, request))
    registerRoute(scope, ctx, connection, ROUTE_PATHS.publish, ['POST'], (request) => handlePublish(ctx, config, request))
  })
}

/**
 * Register one route and log a refusal instead of throwing out of activation.
 */
function registerRoute(
  scope: Context,
  ctx: Context,
  connection: ConnectionLike,
  path: string,
  methods: readonly string[],
  fetch: (request: Request) => Promise<Response>,
): void {
  scope.effect(() => {
    try {
      return connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })
    } catch (error) {
      ctx.logger.warn('utils-agents: cannot register ' + path + ': ' + String(error))
      return () => Promise.resolve()
    }
  }, 'utils-agents: ' + path)
}

/** GET /list: every preset plus the global AGENTS.md family. */
async function handleList(ctx: Context, config: AgentsConfig, legacy: LegacyBridge, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const sessionId = optionalText(new URL(request.url).searchParams.get('sessionId'))
    const cwd = await resolveCwd(ctx, sessionId, request.signal)
    await legacy.ensure()
    const statuses = legacy.status()
    const presets = (await discoverPresets(ctx, options)).map((preset) => {
      const status = statuses.get(preset.id)
      return { ...preset, registered: status?.registered === true, broken: status?.broken }
    })
    const sessionPreset = sessionPresetOf(ctx, sessionId)
    const matching = sessionPreset === null ? undefined : presets.find((preset) => preset.id === sessionPreset)
    const defaultPresetId = matching?.id ?? presets[0]?.id ?? GLOBAL_PRESET
    const global = await globalFiles(ctx, options, cwd)
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
    }, 200)
  } catch (error) {
    return failure(ctx, 'cannot list presets', error)
  }
}

/** GET /files: Markdown inventory for one preset or the global target. */
async function handleFiles(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const presetId = requiredText(new URL(request.url).searchParams.get('presetId'), '缺少 presetId')
    if (presetId === GLOBAL_PRESET) {
      const cwd = await resolveCwd(ctx, optionalText(new URL(request.url).searchParams.get('sessionId')), request.signal)
      return json({ presetId, preset: null, files: await globalFiles(ctx, options, cwd) }, 200)
    }
    const preset = await presetById(ctx, options, presetId)
    return json({ presetId, preset, files: await presetFiles(ctx, preset) }, 200)
  } catch (error) {
    return failure(ctx, 'cannot list preset files', error)
  }
}

/** GET/POST /file: read or atomically write one Markdown file. */
async function handleFile(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const sessionId = optionalText(new URL(request.url).searchParams.get('sessionId'))
    const cwd = await resolveCwd(ctx, sessionId, request.signal)
    if (request.method === 'POST') {
      const body = await readJsonBody(request)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
      const record = body as Record<string, unknown>
      const id = requiredText(record.id, '缺少文件 id')
      const content = typeof record.content === 'string' ? record.content : undefined
      if (content === undefined) throw new AgentsError('content 必须是字符串', 400)
      const baseMtimeMs = typeof record.baseMtimeMs === 'number' && Number.isFinite(record.baseMtimeMs) ? record.baseMtimeMs : null
      const resolved = await resolveFileId(ctx, options, id, cwd)
      const written = await writeTextFile(resolved.path, content, baseMtimeMs, options.maxBytes)
      const row = await fileRow(id, resolved.row.label, resolved.path, resolved.row.presetId, resolved.row.kind)
      return json({ file: { ...row, scope: resolved.row.scope }, bytes: written.bytes }, 200)
    }
    const id = requiredText(new URL(request.url).searchParams.get('id'), '缺少文件 id')
    const resolved = await resolveFileId(ctx, options, id, cwd)
    if (!resolved.row.exists) return json({ file: resolved.row, content: '' }, 200)
    if (!resolved.row.editable) throw new AgentsError('这个文件不是可编辑的普通文件', 409)
    const content = (await readTextFile(resolved.path, options.maxBytes)).content
    return json({ file: resolved.row, content }, 200)
  } catch (error) {
    return failure(ctx, 'cannot handle file', error)
  }
}

/** POST /skill: toggle one preset skill by renaming SKILL.md. */
async function handleSkill(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    const record = body as Record<string, unknown>
    const presetId = requiredText(record.presetId, '缺少 presetId')
    const path = requiredText(record.path, '缺少 skill path')
    const enabled = record.enabled === true
    const preset = await presetById(ctx, options, presetId)
    return json({ skill: await toggleSkill(preset, path, enabled) }, 200)
  } catch (error) {
    return failure(ctx, 'cannot toggle skill', error)
  }
}

/** GET/POST /repo: read or save the per-preset repository settings. */
async function handleRepo(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    if (request.method === 'GET') {
      const presetId = requiredText(new URL(request.url).searchParams.get('presetId'), '缺少 presetId')
      const preset = await presetById(ctx, options, presetId)
      return json(await repoView(ctx, preset, options), 200)
    }
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    const record = body as Record<string, unknown>
    const presetId = requiredText(record.presetId, '缺少 presetId')
    const preset = await presetById(ctx, options, presetId)
    return json(await saveRepoConfig(ctx, preset, options, record), 200)
  } catch (error) {
    return failure(ctx, 'cannot update repository', error)
  }
}

/** POST /key: store or clear the pasted deploy key. */
async function handleKey(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    const record = body as Record<string, unknown>
    const presetId = requiredText(record.presetId, '缺少 presetId')
    const key = typeof record.key === 'string' ? record.key : ''
    const preset = await presetById(ctx, options, presetId)
    const saved: KeyStatus = await saveRepoKey(preset, key)
    return json({ key: saved, state: await readRepoState(preset, options) }, 200)
  } catch (error) {
    return failure(ctx, 'cannot save deploy key', error)
  }
}

/** GET /shared: presets carried by the skill repositories' .dsh directory. */
async function handleShared(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const presetId = requiredText(new URL(request.url).searchParams.get('presetId'), '缺少 presetId')
    const preset = await presetById(ctx, options, presetId)
    return json(await sharedPresetView(ctx, options, preset), 200)
  } catch (error) {
    return failure(ctx, 'cannot list shared presets', error)
  }
}

/** POST /shared-sync: copy .dsh presets into the local preset home. */
async function handleSharedSync(ctx: Context, config: AgentsConfig, legacy: LegacyBridge, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    const record = body as Record<string, unknown>
    const presetId = requiredText(record.presetId, '缺少 presetId')
    const preset = await presetById(ctx, options, presetId)
    const payload = await syncSharedPresets(ctx, options, preset, record)
    // Register anything newly copied so it appears in the preset picker at once.
    try {
      await legacy.ensure()
    } catch (error) {
      ctx.logger.warn('utils-agents: preset registration after shared sync failed: ' + String(error))
    }
    return json(payload, 200)
  } catch (error) {
    return failure(ctx, 'cannot sync shared presets', error)
  }
}

/** GET /native-presets: declared presets the panel could take over. */
async function handleNative(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    return json(await nativePresetView(ctx, normalizeOptions(config)), 200)
  } catch (error) {
    return failure(ctx, 'cannot list native presets', error)
  }
}

/** POST /native-presets-import: export non-built-in declarations as directories. */
async function handleNativeImport(ctx: Context, config: AgentsConfig, legacy: LegacyBridge, request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    const payload = await importNativePresets(ctx, normalizeOptions(config), body as Record<string, unknown>)
    try {
      await legacy.ensure()
    } catch (error) {
      ctx.logger.warn('utils-agents: preset registration after native import failed: ' + String(error))
    }
    return json(payload, 200)
  } catch (error) {
    return failure(ctx, 'cannot import native presets', error)
  }
}

/** POST /presets-publish: copy local presets into the shared repository and push. */
async function handlePublish(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    return json(await publishPresets(ctx, normalizeOptions(config), body as Record<string, unknown>), 200)
  } catch (error) {
    return failure(ctx, 'cannot publish presets', error)
  }
}

/** GET/POST /shared-repo: stored settings for the tracked skill repository. */
async function handleSharedRepo(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    if (request.method === 'GET') return json(await sharedRepoView(ctx, options), 200)
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    return json(await saveSharedRepoConfig(ctx, options, body as Record<string, unknown>), 200)
  } catch (error) {
    return failure(ctx, 'cannot save shared repository', error)
  }
}

/** POST /shared-key: store or clear the shared repository Deploy Key. */
async function handleSharedKey(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    const record = body as Record<string, unknown>
    const key = typeof record.key === 'string' ? record.key : ''
    return json(await saveSharedRepoKey(ctx, options, key), 200)
  } catch (error) {
    return failure(ctx, 'cannot save shared deploy key', error)
  }
}

/** POST /shared-pull: clone or fast-forward the tracked skill repository. */
async function handleSharedPull(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    return json(await pullSharedRepo(ctx, options), 200)
  } catch (error) {
    return failure(ctx, 'cannot pull shared repository', error)
  }
}

/** GET/POST /update: the published bundle version and its last check. */
async function handleUpdate(ctx: Context, config: AgentsConfig, checker: UpdateChecker, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const schedule = { enabled: options.updateCheck, intervalHours: options.updateCheckIntervalHours, registry: options.updateRegistry }
    const update = request.method === 'GET' ? await checker.status() : await checker.check()
    return json({ update, schedule }, 200)
  } catch (error) {
    return failure(ctx, 'cannot check the published version', error)
  }
}

/** GET/POST /deploy-key: the panel-wide Deploy Key for private repositories. */
async function handleDeployKey(ctx: Context, request: Request): Promise<Response> {
  try {
    if (request.method === 'GET') return json({ key: await globalKeyStatus() }, 200)
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    const record = body as Record<string, unknown>
    const key = typeof record.key === 'string' ? record.key : ''
    return json({ key: await saveGlobalKey(key) }, 200)
  } catch (error) {
    return failure(ctx, 'cannot save the shared deploy key', error)
  }
}

/** POST /sync: clone or fast-forward the preset repository. */
async function handleSync(ctx: Context, config: AgentsConfig, request: Request): Promise<Response> {
  try {
    const options = normalizeOptions(config)
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AgentsError('请求体必须是 JSON 对象', 400)
    const record = body as Record<string, unknown>
    const presetId = requiredText(record.presetId, '缺少 presetId')
    const preset = await presetById(ctx, options, presetId)
    return json(await syncRepo(ctx, preset, options), 200)
  } catch (error) {
    return failure(ctx, 'cannot sync repository', error)
  }
}

