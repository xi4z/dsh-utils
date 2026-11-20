/**
 * `dsh-utils` notify component: push a message through a Gotify gateway when a
 * session finishes a turn, or when the agent is blocked on an approval or a
 * question.
 *
 * The gateway is addressed by URL, so the component works from any machine that
 * can reach it over the internet: one device token, one app token, no local
 * NapCat/OneBot service required. Every message carries the sending device's
 * name so multiple machines sharing one gateway stay distinguishable.
 *
 * Wiring (all read from the session log, never from a waterfall the root
 * context cannot receive):
 *
 *   session/event    -> accumulate the finished turn's reason + final assistant text
 *   agent/status     -> the idle edge is the moment the whole task is done
 *   tool/call        -> ask_user_question / exit_plan_mode is the "parked waiting
 *                       for a human" signal, debounced; tool/result cancels it
 *   approval/asked   -> the agent is blocked on a yes/no decision, debounced;
 *                       approval/decided (auto-decided) cancels it
 *
 * Delivery is plain `fetch` to `POST {gotifyUrl}/message`; no WebSocket, no
 * heartbeat, no extra dependency. The legacy OneBot path is kept for
 * compatibility but Gotify is the default outlet.
 *
 * The bundle mounts this component under the entry id `dsh-notify`
 * (`dsh-utils/notify`); that entry id is also its settings namespace, so the
 * browser half renders a live configuration page for it. Every Config field is
 * volatile: the component re-reads the values on each event, so a save in the
 * settings page takes effect without a restart.
 *
 * Ported from `@local/dsh-plugin-qq-notify` 0.2.0 — same message
 * templates, same environment overrides (`DSH_QQ_NOTIFY_*`), same delivery
 * semantics — with the settings schema, live config reads, and the
 * `dsh-utils` bundle wiring added.
 *
 * @module dsh-utils/notify
 */
import { appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import z from '@deepseek-ai/schemastery';
export const name = 'dsh-notify';
export const inject = ['agents'];
/** Turn-end reasons a deployment may subscribe to. */
export const NOTIFY_REASONS = ['completed', 'error', 'aborted', 'blocked'];
/** Defaults applied when a Config field or an environment override is absent. */
const DEFAULTS = {
    enabled: true,
    /** 'gotify' = 统一网关（每个系列一把 token，公网可达）；'onebot' = 历史直连，保留兼容。 */
    transport: 'gotify',
    endpoint: 'http://127.0.0.1:3000',
    token: '',
    targetType: 'private',
    targetId: '',
    /** transport=gotify 时使用；targets 非空时作为默认目标的兜底。 */
    gotifyUrl: '',
    gotifyToken: '',
    gotifyPriority: 3,
    /** 追加到每个 Gotify 请求上的头（反代 Basic Auth、自定义路由等）。 */
    gotifyHeaders: {},
    /** 多目标：每个目标是一把独立的网关凭据/系列；devices 非空时只有命中的设备才投递。 */
    targets: [],
    /** 设备标识：默认取主机名；deviceLabel 是给人看的名字（默认同 deviceName）。 */
    deviceName: '',
    deviceLabel: '',
    /** 是否把设备名加到 Gotify 标题前缀（正文本就能带 {device}）。 */
    deviceInTitle: false,
    notifyOnReasons: ['completed', 'error', 'aborted'],
    notifyOnApproval: true,
    notifyOnQuestion: true,
    /** 提问/审批先等这么久；期间若拿到结果（人已在 UI 回答/策略已自动裁决）就取消推送。 */
    questionDelayMs: 2500,
    approvalDelayMs: 3000,
    includeSubagents: false,
    summaryChars: 120,
    timeoutMs: 8000,
    /** 默认只记日志不发消息：确认配置无误后再关。 */
    dryRun: true,
    traceFile: '',
    /** Mustache-lite message templates; empty means the built-in default. */
    template: '',
    approvalTemplate: '',
    questionTemplate: '',
};
/** Environment overrides, so a deployment can inject secrets without editing the patch. */
const ENV = {
    endpoint: 'DSH_QQ_NOTIFY_URL',
    token: 'DSH_QQ_NOTIFY_TOKEN',
    targetType: 'DSH_QQ_NOTIFY_TARGET_TYPE',
    targetId: 'DSH_QQ_NOTIFY_TARGET_ID',
    gotifyUrl: 'DSH_QQ_NOTIFY_GOTIFY_URL',
    gotifyToken: 'DSH_QQ_NOTIFY_GOTIFY_TOKEN',
    deviceName: 'DSH_QQ_NOTIFY_DEVICE',
    deviceLabel: 'DSH_QQ_NOTIFY_DEVICE_LABEL',
    targets: 'DSH_QQ_NOTIFY_TARGETS',
    gotifyHeaders: 'DSH_QQ_NOTIFY_GOTIFY_HEADERS',
};
/** Values that must be parsed as JSON when they come from the environment. */
const ENV_JSON = new Set(['targets', 'gotifyHeaders']);
/**
 * Settings-page schema. Every key is volatile: the Loader hands `apply` live
 * references and the component re-reads them on use, so the configuration page
 * writes take effect immediately.
 */
export const Config = z.object({
    enabled: z.boolean().default(DEFAULTS.enabled).description('Master switch for this device.').volatile(),
    transport: z.union(['gotify', 'onebot']).default(DEFAULTS.transport).description('Delivery outlet; onebot is legacy.').volatile(),
    endpoint: z.string().default(DEFAULTS.endpoint).description('Legacy OneBot HTTP endpoint.').volatile(),
    token: z.string().default(DEFAULTS.token).description('Legacy OneBot access token.').volatile(),
    targetType: z.union(['private', 'group']).default(DEFAULTS.targetType).description('Legacy OneBot recipient kind.').volatile(),
    targetId: z.string().default(DEFAULTS.targetId).description('Legacy OneBot recipient id.').volatile(),
    gotifyUrl: z.string().default(DEFAULTS.gotifyUrl).description('Gotify gateway base URL.').volatile(),
    gotifyToken: z.string().default(DEFAULTS.gotifyToken).description('Gotify application token; supports ${ENV} references.').volatile(),
    gotifyPriority: z.natural().default(DEFAULTS.gotifyPriority).description('Default message priority.').volatile(),
    gotifyHeaders: z.any().default({}).description('Extra request headers for the gateway.').volatile(),
    targets: z.any().default([]).description('Multiple gateway targets; supports ${ENV} in url/token and urlEnv/tokenEnv.').volatile(),
    deviceName: z.string().default(DEFAULTS.deviceName).description('Device identity; empty = hostname.').volatile(),
    deviceLabel: z.string().default(DEFAULTS.deviceLabel).description('Human-readable device name for {device}.').volatile(),
    deviceInTitle: z.boolean().default(DEFAULTS.deviceInTitle).description('Prefix the Gotify title with the device label.').volatile(),
    notifyOnReasons: z.array(z.union(NOTIFY_REASONS)).default([...DEFAULTS.notifyOnReasons]).description('Turn-end reasons that notify.').volatile(),
    notifyOnApproval: z.boolean().default(DEFAULTS.notifyOnApproval).description('Notify when an approval decision is pending.').volatile(),
    notifyOnQuestion: z.boolean().default(DEFAULTS.notifyOnQuestion).description('Notify when a question is waiting for you.').volatile(),
    questionDelayMs: z.natural().default(DEFAULTS.questionDelayMs).description('Question debounce; an answer inside it suppresses the push.').volatile(),
    approvalDelayMs: z.natural().default(DEFAULTS.approvalDelayMs).description('Approval debounce; an automatic decision inside it suppresses the push.').volatile(),
    includeSubagents: z.boolean().default(DEFAULTS.includeSubagents).description('Also notify sessions that are not roots.').volatile(),
    summaryChars: z.natural().default(DEFAULTS.summaryChars).description('Plain-text budget for {reply}.').volatile(),
    timeoutMs: z.natural().min(100).default(DEFAULTS.timeoutMs).description('Single HTTP timeout; one retry follows.').volatile(),
    dryRun: z.boolean().default(DEFAULTS.dryRun).description('Log the payload instead of sending it.').volatile(),
    traceFile: z.string().default(DEFAULTS.traceFile).description('Optional JSONL diagnostics file.').volatile(),
    template: z.string().default(DEFAULTS.template).description('Turn-end message template; empty = built-in default.').volatile(),
    questionTemplate: z.string().default(DEFAULTS.questionTemplate).description('Question message template; empty = built-in default.').volatile(),
    approvalTemplate: z.string().default(DEFAULTS.approvalTemplate).description('Approval message template; empty = built-in default.').volatile(),
});
/** Reading a Loader volatile reference, or a plain value, as one concrete value. */
function unwrap(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/** A trimmed non-empty string, or the fallback. */
function str(value, fallback = '') {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}
/** A string that preserves its own whitespace (templates). */
function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
/** Read one environment variable, trimmed; unset or blank yields ''. */
function envValue(name) {
    const found = process.env[name];
    return typeof found === 'string' ? found.trim() : '';
}
/**
 * Expand `${NAME}` and `${NAME:-fallback}` references against the process
 * environment, so a deployment can keep gateway secrets outside the patch file.
 * An unset or blank variable expands to the fallback (or to ''), leaving the
 * target without a token instead of sending the literal reference.
 */
export function expandEnv(value) {
    return String(value ?? '').replace(/\${([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?}/g, (_whole, name, fallback) => {
        const found = envValue(name);
        return found !== '' ? found : (fallback ?? '');
    });
}
/** A finite number at or above `minimum`, or the fallback. */
function num(value, fallback, minimum = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}
/** A boolean, accepting the YAML/env spellings `'true'` / `'false'`. */
function bool(value, fallback) {
    if (typeof value === 'boolean')
        return value;
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    return fallback;
}
/** The OS hostname, or 'unknown' when the platform refuses. */
function safeHostname() {
    try {
        return hostname() || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/** Keep only string/number request headers; ignore everything else. */
export function normalizeHeaders(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return out;
    for (const [key, value] of Object.entries(raw)) {
        if (typeof key !== 'string' || key.trim() === '')
            continue;
        if (typeof value !== 'string' && typeof value !== 'number')
            continue;
        out[key.trim()] = expandEnv(value);
    }
    return out;
}
/**
 * Normalize `targets` into a predictable list; bad entries are dropped.
 * A target with only one of url/token is kept so delivery can warn about the
 * exact target name instead of silently disappearing.
 */
export function normalizeTargets(raw, fallbackPriority = 3) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            continue;
        const record = entry;
        let url = typeof record.url === 'string' ? expandEnv(record.url).trim() : '';
        let token = typeof record.token === 'string' ? expandEnv(record.token).trim() : '';
        // `urlEnv` / `tokenEnv` name the variable outright; they win over the
        // literal reference form and keep per-target secrets out of the patch file.
        if (typeof record.urlEnv === 'string' && record.urlEnv.trim() !== '')
            url = envValue(record.urlEnv.trim());
        if (typeof record.tokenEnv === 'string' && record.tokenEnv.trim() !== '')
            token = envValue(record.tokenEnv.trim());
        if (!url && !token)
            continue;
        out.push({
            name: typeof record.name === 'string' && record.name.trim() !== ''
                ? record.name.trim()
                : `target-${out.length + 1}`,
            url,
            token,
            priority: Number.isFinite(record.priority) ? Number(record.priority) : fallbackPriority,
            devices: Array.isArray(record.devices)
                ? record.devices.filter((device) => typeof device === 'string' && device.trim() !== '').map((device) => device.trim())
                : [],
        });
    }
    return out;
}
/** A target with no `devices` list applies everywhere; otherwise match name or label. */
export function targetMatchesDevice(target, cfg) {
    if (!target || !Array.isArray(target.devices) || target.devices.length === 0)
        return true;
    return target.devices.includes(cfg.deviceName) || target.devices.includes(cfg.deviceLabel);
}
/**
 * Resolve the live Config into one concrete option set: defaults, then the
 * settings values, then the environment overrides (so a deployment can keep
 * secrets out of the patch file).
 */
export function normalizeOptions(config) {
    const value = (key) => unwrap(config?.[key]);
    const options = {
        enabled: bool(value('enabled'), DEFAULTS.enabled),
        transport: value('transport') === 'onebot' ? 'onebot' : 'gotify',
        endpoint: str(expandEnv(value('endpoint')), DEFAULTS.endpoint),
        token: str(expandEnv(value('token')), DEFAULTS.token),
        targetType: value('targetType') === 'group' ? 'group' : 'private',
        targetId: str(expandEnv(value('targetId')), DEFAULTS.targetId),
        gotifyUrl: str(expandEnv(value('gotifyUrl')), DEFAULTS.gotifyUrl),
        gotifyToken: str(expandEnv(value('gotifyToken')), DEFAULTS.gotifyToken),
        gotifyPriority: num(value('gotifyPriority'), DEFAULTS.gotifyPriority),
        gotifyHeaders: normalizeHeaders(value('gotifyHeaders')),
        targets: normalizeTargets(value('targets'), num(value('gotifyPriority'), DEFAULTS.gotifyPriority)),
        deviceName: str(value('deviceName')),
        deviceLabel: str(value('deviceLabel')),
        deviceInTitle: bool(value('deviceInTitle'), DEFAULTS.deviceInTitle),
        notifyOnReasons: reasonsOf(value('notifyOnReasons')),
        notifyOnApproval: bool(value('notifyOnApproval'), DEFAULTS.notifyOnApproval),
        notifyOnQuestion: bool(value('notifyOnQuestion'), DEFAULTS.notifyOnQuestion),
        questionDelayMs: num(value('questionDelayMs'), DEFAULTS.questionDelayMs),
        approvalDelayMs: num(value('approvalDelayMs'), DEFAULTS.approvalDelayMs),
        includeSubagents: bool(value('includeSubagents'), DEFAULTS.includeSubagents),
        summaryChars: num(value('summaryChars'), DEFAULTS.summaryChars, 1),
        timeoutMs: num(value('timeoutMs'), DEFAULTS.timeoutMs, 1),
        dryRun: bool(value('dryRun'), DEFAULTS.dryRun),
        traceFile: str(value('traceFile'), DEFAULTS.traceFile),
        template: text(value('template'), DEFAULTS.template),
        questionTemplate: text(value('questionTemplate'), DEFAULTS.questionTemplate),
        approvalTemplate: text(value('approvalTemplate'), DEFAULTS.approvalTemplate),
    };
    for (const [key, envKey] of Object.entries(ENV)) {
        const raw = process.env[envKey];
        if (typeof raw !== 'string' || raw.trim() === '')
            continue;
        if (ENV_JSON.has(key)) {
            try {
                const parsed = JSON.parse(raw);
                if (key === 'targets')
                    options.targets = normalizeTargets(parsed, options.gotifyPriority);
                else
                    options.gotifyHeaders = normalizeHeaders(parsed);
            }
            catch {
                // A malformed JSON env var must not stop the component; keep the YAML value.
            }
        }
        else if (key === 'targetType') {
            options.targetType = raw.trim() === 'group' ? 'group' : 'private';
        }
        else if (key === 'deviceName' || key === 'deviceLabel') {
            options[key] = raw.trim();
        }
        else {
            const target = key;
            if (target === 'targets' || target === 'gotifyHeaders')
                continue;
            options[target] = raw.trim();
        }
    }
    // Device identity: an empty value falls back to the OS hostname, which is
    // what makes notifications from several machines distinguishable.
    options.deviceName = options.deviceName || safeHostname();
    options.deviceLabel = options.deviceLabel || options.deviceName;
    options.targets = options.targets.length > 0
        ? options.targets
        : [{
                name: 'default',
                url: options.gotifyUrl,
                token: options.gotifyToken,
                priority: options.gotifyPriority,
                devices: [],
            }];
    return options;
}
/** Keep only known reasons; an empty list falls back to the defaults. */
function reasonsOf(raw) {
    const kept = Array.isArray(raw) ? raw.filter((reason) => NOTIFY_REASONS.includes(reason)) : [];
    return kept.length > 0 ? kept : DEFAULTS.notifyOnReasons;
}
/** Join the text blocks of one assistant message. */
function textOf(content) {
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'text') {
            const value = block.text;
            if (typeof value === 'string' && value.trim() !== '')
                parts.push(value.trim());
        }
    }
    return parts.join('\n');
}
/** Flatten to one line and cut at `limit` characters (ellipsis included). */
function truncate(value, limit) {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
    return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`;
}
/**
 * Turn assistant Markdown into a short plain-text snippet for the gateway.
 *
 * Fenced code blocks are dropped entirely (they are long and unreadable once
 * flattened); inline code keeps its text; emphasis markers, headings, list
 * bullets, table pipes and HTML tags are removed. Single underscores are left
 * alone so `session_id` survives. The result is then cut at `limit`, preferring
 * a sentence boundary when one is reasonably close to the end.
 */
export function plain(text, limit = 120) {
    let value = String(text ?? '').replace(/\r\n?/g, '\n');
    value = value.replace(/```[\s\S]*?```/g, ' ');
    value = value.replace(/```[\s\S]*$/g, ' ');
    value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    value = value.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    value = value.replace(/^\s{0,3}>\s?/gm, '');
    value = value.replace(/^\s{0,3}[-*+]\s+/gm, '');
    value = value.replace(/^\s{0,3}\d+[.)]\s+/gm, '');
    // Markdown table rows: drop the whole row (two or more pipes) rather than
    // flattening cells into an unreadable "a b 1 2".
    value = value.replace(/^[^\n]*\|[^\n]*\|[^\n]*$/gm, ' ');
    value = value.replace(/\|/g, ' ');
    value = value.replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ');
    value = value.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
    value = value.replace(/(\*\*|__)(.*?)\1/g, '$2');
    value = value.replace(/~~(.*?)~~/g, '$1');
    value = value.replace(/(?<![\w*])\*(?=\S)([^*]*?)(?<=\S)\*(?![\w*])/g, '$1');
    // Underscore emphasis only when it is not inside an identifier (session_id).
    value = value.replace(/(?<![\w])_(?=\S)([^_]*?)(?<=\S)_(?![\w])/g, '$1');
    value = value.replace(/<[^>\n]{1,80}>/g, ' ');
    value = value.replace(/\s+/g, ' ').trim();
    if (value.length <= limit)
        return value;
    const head = value.slice(0, limit);
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'));
    const kept = cut >= Math.floor(limit * 0.6) ? head.slice(0, cut + 1) : head.slice(0, Math.max(0, limit - 1));
    return `${kept.trimEnd()}…`;
}
/** Chinese labels for the four turn-end reasons. */
const REASON_LABEL = {
    completed: '完成',
    error: '出错',
    aborted: '被中止',
    blocked: '被阻塞',
};
/** The model-facing tool whose call means the task is parked waiting for a human. */
const ASK_USER_TOOL = 'ask_user_question';
/** Plan-mode exit also raises a review question through the unlogged channel. */
const EXIT_PLAN_TOOL = 'exit_plan_mode';
/** Parse `ask_user_question` tool arguments defensively (older logs, odd providers). */
export function parseQuestions(raw) {
    let parsed;
    try {
        parsed = JSON.parse(String(raw ?? ''));
    }
    catch {
        return [];
    }
    const list = parsed?.questions;
    if (!Array.isArray(list))
        return [];
    const out = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object')
            continue;
        const record = entry;
        if (typeof record.question !== 'string')
            continue;
        out.push({
            question: record.question,
            ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
            ...(typeof record.header === 'string' ? { header: record.header } : {}),
            options: Array.isArray(record.options)
                ? record.options
                    .filter((option) => !!option && typeof option === 'object' && typeof option.label === 'string')
                    .map((option) => option.label)
                : [],
        });
    }
    return out;
}
/** Parse `exit_plan_mode` tool arguments into the reviewed plan text. */
export function parsePlan(raw) {
    try {
        const parsed = JSON.parse(String(raw ?? ''));
        const plan = parsed?.plan;
        return typeof plan === 'string' ? plan : undefined;
    }
    catch {
        return undefined;
    }
}
/** Placeholder syntax: `{name}`. Unknown placeholders are left untouched. */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
/**
 * Fill a template. A line containing only a label whose value is empty
 * (`目录: ` / `回复: `) is dropped, so one template serves every outcome.
 */
export function fill(template, values) {
    return String(template)
        .replace(PLACEHOLDER, (whole, key) => (Object.hasOwn(values, key) ? String(values[key] ?? '') : whole))
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .filter((line) => !/^[^:：]*[:：]$/.test(line))
        .join('\n')
        .trim();
}
/** Local date/time placeholders. */
function stamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return {
        date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    };
}
/** Default turn-end template. */
export const DEFAULT_TEMPLATE = [
    '[DSH] 会话{status}',
    '设备: {device}',
    '会话: {sessionId}',
    '目录: {cwd}',
    '结果: {status}',
    '错误: {error}',
    '回复: {reply}',
].join('\n');
/** Default question template. */
export const DEFAULT_QUESTION_TEMPLATE = [
    '[DSH] 需要你回答',
    '设备: {device}',
    '会话: {sessionId}',
    '目录: {cwd}',
    '问题: {question}',
    '补充: {detail}',
    '选项: {options}',
].join('\n');
/** Default approval template. */
export const DEFAULT_APPROVAL_TEMPLATE = [
    '[DSH] 需要授权',
    '设备: {device}',
    '会话: {sessionId}',
    '目录: {cwd}',
    '操作: {tool}',
    '原因: {reason}',
].join('\n');
/** Compact body of a turn-completion message. */
export function renderMessage(input) {
    const values = {
        sessionId: String(input.sessionId).replace(/^session-/, '').slice(0, 8),
        cwd: input.cwd ?? '',
        status: REASON_LABEL[input.reason ?? ''] ?? String(input.reason ?? ''),
        kind: input.reason ?? '',
        reply: plain(input.reply, input.summaryChars ?? 120),
        error: plain(input.error, 120),
        device: input.device ?? '',
        host: input.host ?? input.device ?? '',
        ...stamp(),
    };
    return fill(input.template || DEFAULT_TEMPLATE, values) || `[DSH] 会话${values.status}`;
}
/** Compact body of a question-request message (the agent is blocked on you). */
export function renderQuestionMessage(input) {
    const values = {
        sessionId: String(input.sessionId).replace(/^session-/, '').slice(0, 8),
        cwd: input.cwd ?? '',
        question: plain(input.question, 200),
        detail: plain(input.detail, 160),
        options: plain(input.options, 160),
        device: input.device ?? '',
        host: input.host ?? input.device ?? '',
        ...stamp(),
    };
    return fill(input.template || DEFAULT_QUESTION_TEMPLATE, values) || '[DSH] 需要你回答';
}
/** Compact body of an approval-request message. */
export function renderApprovalMessage(input) {
    const values = {
        sessionId: String(input.sessionId).replace(/^session-/, '').slice(0, 8),
        cwd: input.cwd ?? '',
        tool: input.toolName ?? '',
        reason: plain(input.reason, 200),
        device: input.device ?? '',
        host: input.host ?? input.device ?? '',
        ...stamp(),
    };
    return fill(input.template || DEFAULT_APPROVAL_TEMPLATE, values) || '[DSH] 需要授权';
}
/** Build a trace sink that appends JSONL to `file` (read live, so the setting is hot). */
function makeTrace(file) {
    return (stage, data = {}) => {
        const path = file();
        if (!path)
            return;
        try {
            appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), stage, ...data })}\n`);
        }
        catch {
            // Diagnostics must never break notification delivery.
        }
    };
}
/** POST one OneBot 11 action; throws on transport failure or a non-ok retcode. */
export async function callAction(cfg, action, body) {
    const base = cfg.endpoint.endsWith('/') ? cfg.endpoint : `${cfg.endpoint}/`;
    const url = new URL(action, base);
    const headers = { 'content-type': 'application/json' };
    if (cfg.token)
        headers.authorization = `Bearer ${cfg.token}`;
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${truncate(raw, 200)}`);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return raw;
    }
    if (parsed && typeof parsed === 'object' && parsed.status === 'failed') {
        const record = parsed;
        throw new Error(`OneBot retcode ${String(record.retcode)}: ${truncate(String(record.message ?? record.wording ?? ''), 200)}`);
    }
    return parsed;
}
/**
 * 经 Gotify 网关投递。把渲染好的正文拆成「首行作标题、其余作正文」，
 * relay 端再拼回 `标题\n正文`，与直连模式输出一致。
 *
 * One message can fan out to several targets (several gateways, or several
 * app tokens / recipients). Targets may be pinned to devices, so the same
 * config can be shared by every machine and each one only sends to its own
 * recipients. Failures are isolated per target.
 */
async function deliverViaGotify(ctx, cfg, payload, trace) {
    const targets = cfg.targets.filter((target) => targetMatchesDevice(target, cfg));
    if (targets.length === 0) {
        ctx.logger.warn(`dsh-notify: no gotify target matches device "${cfg.deviceLabel}", skipping send`);
        trace('deliver', { mode: 'skip', why: 'no target for device', device: cfg.deviceLabel });
        return;
    }
    const [title, ...rest] = String(payload).split('\n');
    const finalTitle = cfg.deviceInTitle ? `[${cfg.deviceLabel}] ${title}` : title;
    const message = rest.join('\n');
    const results = await Promise.allSettled(targets.map((target) => sendGotifyTarget(ctx, cfg, target, finalTitle, message, trace)));
    logGotifyFailures(ctx, cfg, results);
}
/** Fire one Gotify POST at one target, retrying once on transient failure. */
async function sendGotifyTarget(ctx, cfg, target, title, message, trace) {
    if (cfg.dryRun) {
        ctx.logger.info(`dsh-notify: dryRun, would POST gotify target=${target.name} url=${target.url} `
            + `device=${cfg.deviceLabel} ${JSON.stringify({ title, message, priority: target.priority })}`);
        trace('deliver', { mode: 'dryRun', transport: 'gotify', target: target.name, device: cfg.deviceLabel });
        return;
    }
    if (!target.url || !target.token) {
        ctx.logger.warn(`dsh-notify: target "${target.name}" is missing url or token, skipping`);
        trace('deliver', { mode: 'skip', why: 'target config missing', target: target.name });
        return;
    }
    const url = `${target.url.replace(/\/+$/, '')}/message`;
    const body = { title, message, priority: target.priority };
    // Custom headers come first so the auth/content headers cannot be clobbered.
    const headers = { ...cfg.gotifyHeaders, 'content-type': 'application/json', 'X-Gotify-Key': target.token };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(cfg.timeoutMs),
            });
            const raw = await response.text();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}: ${raw.slice(0, 160)}`);
            ctx.logger.info(`dsh-notify: delivered via gotify target=${target.name} device=${cfg.deviceLabel} (${title})`);
            trace('deliver', { mode: 'ok', transport: 'gotify', target: target.name, attempt });
            return;
        }
        catch (error) {
            trace('deliver', {
                mode: 'fail', transport: 'gotify', target: target.name, attempt, error: errorMessage(error),
            });
            if (attempt === 2)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
    }
}
/** Log a per-target summary without leaking tokens. */
function logGotifyFailures(ctx, cfg, results) {
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length === 0)
        return;
    const detail = failed
        .map((result) => String(result.reason?.message ?? result.reason))
        .join('; ');
    ctx.logger.warn(`dsh-notify: ${failed.length}/${results.length} gotify target(s) failed on ${cfg.deviceLabel}: ${detail}`);
}
/** One delivery attempt with a single retry for transient failures. */
async function deliver(ctx, cfg, payload, trace) {
    if (cfg.transport === 'gotify')
        return deliverViaGotify(ctx, cfg, payload, trace);
    const action = cfg.targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
    // Segment form: the text is never parsed as CQ codes, so a reply containing
    // `[CQ:at,qq=all]` cannot inject an action into the group.
    const message = [{ type: 'text', data: { text: payload } }];
    const body = cfg.targetType === 'group'
        ? { group_id: cfg.targetId, message }
        : { user_id: cfg.targetId, message };
    if (cfg.dryRun) {
        ctx.logger.info(`dsh-notify: dryRun, would POST ${action} ${JSON.stringify(body)}`);
        trace('deliver', { mode: 'dryRun', action, targetId: cfg.targetId });
        return;
    }
    if (!cfg.targetId) {
        ctx.logger.warn('dsh-notify: targetId is empty, skipping send');
        trace('deliver', { mode: 'skip', why: 'targetId empty' });
        return;
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            await callAction(cfg, action, body);
            ctx.logger.info(`dsh-notify: delivered ${action} to ${cfg.targetType} ${cfg.targetId}`);
            trace('deliver', { mode: 'ok', action, targetId: cfg.targetId, attempt });
            return;
        }
        catch (error) {
            trace('deliver', { mode: 'fail', action, attempt, error: errorMessage(error) });
            if (attempt === 2) {
                ctx.logger.warn(`dsh-notify: delivery failed after ${attempt} attempts: ${errorMessage(error)}`);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    }
}
/** Read `error.message` off an unknown thrown value. */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Activate the component.
 * @param ctx - host Cordis context.
 * @param config - row config from cordis.patch.yml or the settings document;
 *   volatile fields arrive as live references.
 */
export function apply(ctx, config = {}) {
    const read = () => normalizeOptions(config);
    const trace = makeTrace(() => normalizeOptions(config).traceFile);
    const logger = ctx.logger;
    const initial = read();
    const targetSummary = initial.targets
        .filter((target) => targetMatchesDevice(target, initial))
        .map((target) => target.name)
        .join(',') || '<none>';
    logger.info(`dsh-notify: active (device=${initial.deviceLabel}, transport=${initial.transport}, targets=${targetSummary}, `
        + `reasons=${initial.notifyOnReasons.join(',')}, approval=${initial.notifyOnApproval}, dryRun=${initial.dryRun})`);
    trace('activate', {
        deviceName: initial.deviceName,
        deviceLabel: initial.deviceLabel,
        transport: initial.transport,
        targets: initial.targets.map((target) => target.name),
        reasons: initial.notifyOnReasons,
        notifyOnApproval: initial.notifyOnApproval,
        dryRun: initial.dryRun,
    });
    /** Per-session record of the most recent finished turn. */
    const turns = new Map();
    /**
     * Get (or seed) the record for one session. State must not depend on having
     * seen `turn/start`: a component activated mid-turn never sees it.
     */
    const stateOf = (id) => {
        let current = turns.get(id);
        if (!current) {
            current = { turn: undefined, reason: undefined, error: undefined, reply: '', notified: false };
            turns.set(id, current);
        }
        return current;
    };
    /** Debounce timers keyed by call/approval id; a matching result cancels them. */
    const pending = new Map();
    const schedule = (key, delayMs, produce) => {
        if (pending.has(key))
            return;
        const timer = setTimeout(() => {
            pending.delete(key);
            try {
                void deliver(ctx, read(), produce(), trace);
            }
            catch (error) {
                trace('schedule-error', { key, error: errorMessage(error) });
            }
        }, Number(delayMs) > 0 ? Number(delayMs) : 2500);
        pending.set(key, timer);
    };
    const cancel = (key) => {
        const timer = pending.get(key);
        if (timer !== undefined) {
            clearTimeout(timer);
            pending.delete(key);
        }
    };
    const onSessionEvent = (session, event) => {
        const cfg = read();
        if (!cfg.enabled)
            return;
        const id = session.id;
        // SessionEvent is an envelope: { type, seq, time, data }. Tolerate a bare
        // payload too, so a shape change degrades instead of silently no-op'ing.
        const data = (event.data ?? event);
        switch (event.type) {
            case 'turn/start':
                turns.set(id, { turn: data.turn, reason: undefined, error: undefined, reply: '', notified: false });
                break;
            case 'assistant/message':
                stateOf(id).reply = textOf(data.message?.content);
                break;
            case 'turn/end': {
                const current = stateOf(id);
                current.turn = data.turn;
                current.reason = data.reason?.kind ?? 'unknown';
                current.error = data.reason?.error?.message;
                trace('turn/end', { sessionId: id, turn: data.turn, reason: data.reason?.kind });
                break;
            }
            // 用户提问：会话日志里没有 user-questions 事件，工具调用本身就是"挂起等人"的信号。
            case 'tool/call': {
                if (!cfg.notifyOnQuestion)
                    break;
                const callId = String(data.callId ?? '');
                if (!callId)
                    break;
                if (data.name === ASK_USER_TOOL) {
                    trace('wait/question', { sessionId: id, callId });
                    schedule(`q:${callId}`, cfg.questionDelayMs, () => {
                        const questions = parseQuestions(data.arguments);
                        return renderQuestionMessage({
                            sessionId: id,
                            cwd: session.header?.cwd,
                            question: questions[0]?.question,
                            detail: questions[0]?.detail,
                            options: (questions[0]?.options ?? []).join(' / '),
                            template: cfg.questionTemplate,
                            device: cfg.deviceLabel,
                            host: cfg.deviceName,
                        });
                    });
                }
                else if (data.name === EXIT_PLAN_TOOL) {
                    trace('wait/plan', { sessionId: id, callId });
                    schedule(`p:${callId}`, cfg.questionDelayMs, () => renderQuestionMessage({
                        sessionId: id,
                        cwd: session.header?.cwd,
                        question: '计划已提交，等待你确认',
                        detail: parsePlan(data.arguments),
                        template: cfg.questionTemplate,
                        device: cfg.deviceLabel,
                        host: cfg.deviceName,
                    }));
                }
                break;
            }
            case 'tool/result': {
                const callId = String(data.message?.toolCallId ?? data.callId ?? '');
                if (callId) {
                    cancel(`q:${callId}`);
                    cancel(`p:${callId}`);
                }
                break;
            }
            // 审批：日志里有 approval/asked；短时间内拿到 decided 说明是自动裁决，不必打扰。
            case 'approval/asked': {
                if (!cfg.notifyOnApproval)
                    break;
                const askId = String(data.id ?? '');
                if (!askId)
                    break;
                trace('wait/approval', { sessionId: id, toolName: data.toolName });
                schedule(`a:${askId}`, cfg.approvalDelayMs, () => renderApprovalMessage({
                    sessionId: id,
                    cwd: session.header?.cwd,
                    toolName: typeof data.toolName === 'string' ? data.toolName : undefined,
                    reason: typeof data.reason === 'string' ? data.reason : undefined,
                    template: cfg.approvalTemplate,
                    device: cfg.deviceLabel,
                    host: cfg.deviceName,
                }));
                break;
            }
            case 'approval/decided': {
                cancel(`a:${String(data.id ?? '')}`);
                break;
            }
            default:
                break;
        }
    };
    const onAgentStatus = (payload) => {
        const cfg = read();
        if (!cfg.enabled)
            return;
        // Only the idle edge matters. It is not paired with a `running` edge on
        // purpose: a component activated mid-turn never saw that edge, and
        // `turn/end` already marks exactly one notify-worthy turn.
        if (payload.status !== 'idle')
            return;
        const agent = payload.agent;
        let isRoot = true;
        try {
            const registry = ctx.agents;
            const roots = registry.roots?.() ?? registry.list?.() ?? [];
            isRoot = roots.some((root) => root.id === agent.id);
        }
        catch (error) {
            trace('roots-error', { error: errorMessage(error) });
        }
        const state = turns.get(agent.id);
        trace('agent/idle', {
            sessionId: agent.id,
            isRoot,
            turn: state?.turn,
            reason: state?.reason,
            notified: state?.notified,
            matched: state ? cfg.notifyOnReasons.includes(state.reason) : false,
        });
        if (!cfg.includeSubagents && !isRoot)
            return;
        if (!state || state.notified)
            return;
        if (!cfg.notifyOnReasons.includes(state.reason))
            return;
        state.notified = true;
        const payloadText = renderMessage({
            sessionId: agent.id,
            cwd: agent.session?.header?.cwd,
            reason: state.reason,
            error: state.error,
            reply: state.reply,
            summaryChars: cfg.summaryChars,
            template: cfg.template,
            device: cfg.deviceLabel,
            host: cfg.deviceName,
        });
        void deliver(ctx, cfg, payloadText, trace);
    };
    const disposeSession = ctx.on('session/event', onSessionEvent);
    const disposeStatus = ctx.on('agent/status', onAgentStatus);
    ctx.effect(() => () => {
        if (typeof disposeSession === 'function')
            disposeSession();
        if (typeof disposeStatus === 'function')
            disposeStatus();
        for (const timer of pending.values())
            clearTimeout(timer);
        pending.clear();
    });
}
//# sourceMappingURL=index.js.map