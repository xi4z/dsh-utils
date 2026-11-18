# dsh-utils

一个包，三个组件。装一次，三条挂载项各自开关、各自配置。

| 组件 | 挂载项 id | 包内入口 | 作用 |
|---|---|---|---|
| 递归技能发现 | `skill-recursive` | 子路径 `dsh-utils/skill-recursive` | 嵌套目录找 `SKILL.md`。内置提供方只读一层 |
| 无人值守审批门控 | `dsh-approval-policy` | 子路径 `dsh-utils/approval-policy` | 给审批请求设应答窗口，超时 fail-closed |
| 会话通知 | `dsh-notify` | 子路径 `dsh-utils/notify` | 会话结束/等授权/等回答时，经 Gotify 网关推送，带设备名 |

三条挂载项全走子路径。每个组件读自己 `locale` 的标题（递归Skill插件 / 无人值守审批门控 / 会话通知）。bundle 自己叫「Harness 工具集」。代价见下。

### 关于配置界面

DSH 客户端扫描器只从包根挂载行加载 `client.js`。包根行 = `name: dsh-utils`，无斜杠，未禁用。本 bundle 没有包根行。宿主不加载浏览器半侧，插件页没有每行配置表单。

配置走 `cordis.patch.yml`：bundle 给默认值，profile 按 id 覆盖。包根导出 `dsh-utils` 仍在，指向同一技能模块。要配置表单，自己加一条包根行。

## 安装

Desktop 或带插件管理器的会话：

```
plugin_manager action=install_bundle target=github:xi4z/dsh-utils
```

CLI profile：

```sh
dsh plugin --profile <profile> add github:xi4z/dsh-utils
```

本地开发：`target=<本包绝对路径>`，或 CLI `add link:<本包绝对路径>`。仓库带 `lib/`，从 GitHub 装不用再构建。

装后 patch 自动插三条挂载项，不手写挂载块。`config:` 只管配置。挂载项新增/改名要重启宿主。

## 组件一：递归技能发现

```
.dsh/skills/
├── flat-skill/SKILL.md            ← 内置提供方（本组件不管第 1 层）
└── obsidian-skills/               ← 容器目录
    ├── defuddle/SKILL.md          ← 本组件
    └── json-canvas/SKILL.md       ← 本组件
```

扫描根：项目 `.dsh/skills`、`.agents/skills`（向上找最近 `.git`）、`$DSH_HOME/skills`（默认 `~/.dsh/skills`）、`$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`），加 `extraRoots`。同名扁平技能优先：嵌套候选 rank 低一档。

| 字段 | 默认 | 含义 |
|---|---|---|
| `minDepth` | `2` | 技能第一个目录层级（相对技能根） |
| `maxDepth` | `8` | 最深扫描层级 |
| `watch` | `true` | 监听技能根，变化刷新目录 |
| `debounceMs` | `200` | 监听失效防抖 |
| `pollIntervalMs` | `2000` | 不支持递归监听时的轮询间隔 |
| `includeProjectRoots` | `true` | 扫项目级技能根 |
| `includeUserRoots` | `true` | 扫用户级技能根 |
| `followSymlinks` | `false` | 跟随符号链接目录（带环路保护） |
| `extraRoots` | `[]` | 追加技能根，绝对路径 |
| `ignoreDirs` | `[".system","node_modules",".git"]` | 永不进入的目录名 |

识别字段：`name`、`description`，可选 `whenToUse`、`disable-model-invocation`、`user-invocable`。非法文件记 warning，跳过。

## 组件二：无人值守审批门控

挂宿主 `'approval/request'` waterfall 链首（`prepend`）。判定无人值守的请求先 `next()` 给下游：窗口内有人答，用人的答案；窗口耗尽，按 fail-closed 默认值落定，turn 立即结束，不长期挂起。交互会话不改变。

| 字段 | 默认 | 含义 |
|---|---|---|
| `origins` | `[subagent, scheduled]` | 无人值守来源：`subagent` / `scheduled` / `cron` / `all` |
| `sessions` | `[]` | 按 agent id 的 glob 点名会话，命中即门控该会话所有 turn |
| `windowSeconds` | `60` | 应答窗口（秒）；`0` = 立即拒绝，不询问下游 |
| `defaultOutcome` | `rejected` | 窗口到期落定值：`rejected` 或 `unavailable`。没有 `allowed-once` |
| `defaultPermissionPreset` | `''` | 新会话权限档；`auto` 走实验性自动审批（要对应 bundle） |
| `autoReviewContent` | `true` | 窗口拒绝自动审批的请求时，把复核内容附进模型读到的工具结果 |

判定粒度：`sessions` 命中与 `all` 是会话级。`subagent` 看 `session.header.origin`。`scheduled` / `cron` 看最后一条带溯源 user 消息的 `source.kind`。合成注入（`runtime-context`、`skill-catalog`）跳过；人插过话就不门控。审计由宿主 `approval/asked` + `approval/decided` 写会话日志。本组件不写日志、不落盘。

随包技能 `dsh-approval-policy-config`：配置向导。

## 组件三：会话通知

每轮跑完，或 agent 挂起在「等你回答 / 等你授权」，推一条消息到指定出口。出口默认**公网 Gotify 网关**。插件不持 Bot 凭据、不建 WebSocket、不加依赖，只发一个 HTTP POST。任何能上网的设备（笔记本、服务器、云主机）装同一份 bundle、填网关地址和 token 就能发。每条消息带**发送设备名**（默认主机名），多台机器共用一个 QQ 也能分清。

### 接线

```
session/event  →  累积"刚结束这一轮"的 reason + 最后一条 assistant 文本
agent/status   →  running → idle 的边沿 = 整个任务干完的那一刻
                ↓
       渲染中文摘要（含设备名）→ POST {gotifyUrl}/message → relay → QQ
```

不用 `turn/end` 直接发：`agent/status` 的 idle 边沿才是"整个任务结束"（含子任务收敛），天然去重。`turn/end` 只给结束原因和回复文本。

### 事件来源：只读会话日志

早期挂过 `approval/request` 与 `user-questions/request` 两个 waterfall 监听。实测**根 context 的监听器收不到**（agent 作用域派发被过滤，加 `{ global: true }` 也没解决）。改为全从 `session/event` 推导：

| 通知类型 | 日志信号 | 去抖 |
|---|---|---|
| 会话完成/出错/中止 | `turn/end` 的 `reason.kind` | 无 |
| 等待你回答 | `tool/call`，`name` 为 `ask_user_question` / `exit_plan_mode` | `questionDelayMs`（默认 2500），`tool/result` 到达取消 |
| 需要授权 | `approval/asked` | `approvalDelayMs`（默认 3000），`approval/decided` 到达取消 |

去抖：人 2.5 秒内界面答了，或策略自动裁决了，就不打扰。

### 配置

`cordis.patch.yml` 的 `config`，或环境变量。环境变量优先。字段全 volatile：改完即生效，不重启。

| 字段 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | — | `true` | 总开关 |
| `transport` | — | `gotify` | `gotify` = 公网网关；`onebot` 直连 NapCat 已废弃，仅兼容旧配置 |
| `deviceName` | `DSH_QQ_NOTIFY_DEVICE` | 主机名 | 设备唯一名，多设备区分基础 |
| `deviceLabel` | `DSH_QQ_NOTIFY_DEVICE_LABEL` | 同 `deviceName` | 给人看的名字，用于 `{device}` 与标题前缀 |
| `deviceInTitle` | — | `false` | `true` 时 Gotify 标题加 `[设备名]` 前缀 |
| `gotifyUrl` | `DSH_QQ_NOTIFY_GOTIFY_URL` | `''` | 网关地址，如 `https://notify.example.com` |
| `gotifyToken` | `DSH_QQ_NOTIFY_GOTIFY_TOKEN` | `''` | 该系列的 Gotify application token |
| `gotifyPriority` | — | `3` | 默认优先级，`targets` 未单独指定时用 |
| `gotifyHeaders` | `DSH_QQ_NOTIFY_GOTIFY_HEADERS`（JSON） | `{}` | 追加请求头，用于反代 Basic Auth 等 |
| `targets` | `DSH_QQ_NOTIFY_TARGETS`（JSON） | `[]` | 多目标列表；非空时不用 `gotifyUrl` / `gotifyToken` |
| `notifyOnReasons` | — | `[completed, error, aborted]` | 通知的结束原因：`completed` / `error` / `aborted` / `blocked` |
| `notifyOnApproval` | — | `true` | 等审批决定时通知 |
| `notifyOnQuestion` | — | `true` | 等用户回答时通知 |
| `questionDelayMs` | — | `2500` | 提问通知去抖窗口 |
| `approvalDelayMs` | — | `3000` | 审批通知去抖窗口 |
| `template` | — | 见下 | 会话结束通知格式 |
| `questionTemplate` | — | 见下 | 提问通知格式 |
| `approvalTemplate` | — | 见下 | 审批请求通知格式 |
| `includeSubagents` | — | `false` | 子会话（subagent）也通知？ |
| `summaryChars` | — | `120` | `{reply}` 纯文本化后截断长度 |
| `timeoutMs` | — | `8000` | 单次 HTTP 超时，失败自动重试 1 次 |
| `dryRun` | — | `true` | **默认开**：只打日志不发消息。确认配置再关 |
| `traceFile` | — | `''` | 可选 JSONL 诊断轨迹（排障），空则不记 |

`endpoint` / `token` / `targetType` / `targetId` 只在 `transport: onebot` 旧直连路径用，对应 `DSH_QQ_NOTIFY_URL` 等环境变量。

### 密钥走环境变量

字符串字段支持 `${NAME}` / `${NAME:-默认值}` 插值。范围：`gotifyUrl`、`gotifyToken`、`endpoint`、`token`、`targetId`、`gotifyHeaders` 的值，`targets[]` 的 `url` / `token`。

变量未设或为空，展开成空串。该目标缺 token 就跳过，记 warning。**不发字面量** `${...}`。插值在每次投递前解析，密钥不进日志。

```yaml
- id: dsh-notify
  config:
    gotifyUrl: '${DSH_GOTIFY_URL}'
    gotifyToken: '${DSH_GOTIFY_TOKEN}'
    targets:
      - name: qq-home
        urlEnv: DSH_GOTIFY_URL
        tokenEnv: DSH_GOTIFY_TOKEN
```

`targets[]` 也支持 `urlEnv` / `tokenEnv`：直接写变量名，优先于字面量字段。整表覆盖的环境变量优先级最高：`DSH_QQ_NOTIFY_GOTIFY_URL`、`DSH_QQ_NOTIFY_GOTIFY_TOKEN`、`DSH_QQ_NOTIFY_TARGETS` 等（见上表）。

### 多设备：都能发，也能分清是谁

公网网关对任何来源 IP 开放（按 token/IP 限流）。其他设备不用部 relay，不用 NapCat，不用开本机端口。

1. **设备身份**：`deviceName` 留空自动取 `os.hostname()`。建议设 `deviceLabel`（办公本、家里的服务器），渲染进 `{device}`。
2. **各自一套 token**：Gotify 里给每台设备建一个 application（一个「系列」）。token 用环境变量注入，别每台共用一把：

   ```sh
   export DSH_QQ_NOTIFY_DEVICE='laptop-01'
   export DSH_QQ_NOTIFY_DEVICE_LABEL='随身本'
   export DSH_QQ_NOTIFY_GOTIFY_TOKEN='gtfya.该设备的token'
   ```

   系列不同，QQ 收件人也能在 relay 侧不同（见 relay 路由表）。

3. **一套配置分发多台设备**：用 `targets` + `devices` 让每个目标只对命中设备生效。`devices` 空 = 所有设备都发：

   ```yaml
   targets:
     - name: qq-home
       url: 'https://notify.example.com'
       token: 'gtfya.home-series-token'
       priority: 3
       devices: ['办公本']
     - name: qq-laptop
       url: 'https://notify.example.com'
       token: 'gtfya.laptop-series-token'
       priority: 5
       devices: ['laptop-01']
   ```

   配 `targets` 后不读 `gotifyUrl` / `gotifyToken` / `gotifyPriority`。每目标可单设 `priority`。一条事件并发发所有命中目标，一个失败不影响其他。

### 自定义消息格式

正文由模板决定。只改 `template` / `questionTemplate` / `approvalTemplate`：

```yaml
template: |
  [DSH] 会话{status}
  设备: {device}
  会话: {sessionId}
  目录: {cwd}
  结果: {status}
  错误: {error}
  回复: {reply}
```

会话结束（`template`）可用：

| 占位符 | 值 |
|---|---|
| `{status}` | 中文结果：完成 / 出错 / 被中止 / 被阻塞 |
| `{kind}` | 原始原因：`completed` / `error` / `aborted` / `blocked` |
| `{device}` | `deviceLabel`，默认主机名 |
| `{host}` | `deviceName`（默认 `os.hostname()`） |
| `{sessionId}` | 会话 id 去 `session-` 前缀，取前 8 位 |
| `{cwd}` | 会话工作目录 |
| `{reply}` | 最后一条 assistant 文本，去 Markdown，按 `summaryChars` 截断 |
| `{error}` | 失败信息（仅 `error` 有值），去 Markdown，截 120 字 |
| `{date}` / `{time}` | 本机日期 / 时间 |

提问通知额外可用 `{question}` / `{detail}` / `{options}`。审批通知额外可用 `{tool}` / `{reason}`。三类模板都支持 `{device}`、`{host}`、`{sessionId}`、`{cwd}`、`{date}`、`{time}`。

`{reply}` / `{error}` / 审批 `{reason}` 先转**纯文本**：代码块整段丢；行内代码留文字；标题/列表符号/表格竖线/加粗斜体/链接语法全去；连续空白压一个空格。`session_id` 这类下划线标识符不受影响。

两条替换规则：

- **值为空的行整行删**。上例 `completed` 时「错误: {error}」自动消失。不用两套模板。
- **不认识的占位符原样保留**，方便发现拼写错误。`{sesionId}` 会原样出现。

效果：

```
[DSH] 会话完成
设备: 办公本
会话: 878e75f4
目录: /root/core
结果: 完成
回复: 部署完成，3 个服务均已健康
```

### 出口（Gotify 网关）

网关收 `POST {gotifyUrl}/message`，body `{title, message, priority}`，鉴权 `X-Gotify-Key`。正文按「首行当标题、其余当正文」拆，relay 再拼回「标题 + 换行 + 正文」。

`deviceInTitle: true` 时标题变「[设备名] 原标题」。`gotifyHeaders` 自定义头合并进请求，但 `X-Gotify-Key` 始终以当前目标 token 为准，自定义头不能覆盖。

历史：2026-11-07 前是 NapCat/OneBot 直连（`endpoint` + `targetId`）。NapCat 容器与 AstrBot 已删。不要再按旧文档在 NapCat WebUI 开 HTTP 服务器。

### 从 @local/dsh-plugin-qq-notify 迁移

直接合并 `@local/dsh-plugin-qq-notify` 0.2.0：模板、占位符、环境变量名、投递语义不变。只搬进 `dsh-utils`，补配置表单与热生效。

1. profile `package.json` 去掉 `@local/dsh-plugin-qq-notify`（依赖与 `dsh.profile.bundles` 两处），改装本包。重启后旧 bundle 的 `qq-notify` 挂载项消失。
2. 旧 `cordis.patch.yml` 里 `id: qq-notify` 行下的 `config:`，整体挪到新 `id: dsh-notify` 行下。字段名一致，不改写。
3. 两个 id 不能同时挂，否则同一事件发两遍。旧命名空间 `qq-notify` 的存量值不读取。按第 2 步搬。
4. 环境变量（`DSH_QQ_NOTIFY_*`）不改。

## 配置写法

```yaml
- id: skill-recursive
  name: dsh-utils
  config:
    maxDepth: 6
    extraRoots:
      - D:/Core/Projects/Skill
- id: dsh-approval-policy
  name: dsh-utils/approval-policy
  config:
    origins: [subagent, scheduled, cron]
    windowSeconds: 300
    defaultOutcome: rejected
- id: dsh-notify
  name: dsh-utils/notify
  config:
    transport: gotify
    gotifyUrl: https://notify.example.com
    gotifyToken: gtfya.该系列的token
    deviceLabel: 办公本
    dryRun: false
```

三个 id 同时是 settings 命名空间。配置写 `cordis.patch.yml`：bundle 给默认，profile 按 id 覆盖。本 bundle 不挂包根行，插件页无每行配置表单（原因见「关于配置界面」）。组件启用/停用、运行状态照常显示。

`client.js` 保留：用 `ctx.configForms.whileServed(['skill-recursive','dsh-approval-policy','dsh-notify'], …)` 把三条挂载项配置页注册到 `plugins.row.config`（key = `dsh-utils#<挂载项 id>`）。只有额外挂 `name: dsh-utils` 包根行时，宿主才加载它。三个组件字段全 volatile，写入走宿主 settings 文档，保存即生效。

## 包结构

```
dsh-utils/
├── cordis.patch.yml      三条挂载项
├── client.js             浏览器半侧（仅包根挂载行存在时加载）
├── locale/{en,zh}.json   bundle 展示名与描述
├── locale/skill-recursive/  技能发现行的独立标题
├── locale/approval-policy/  审批门控行的独立标题
├── locale/notify/           通知行的独立标题
├── icon.svg
├── skills/dsh-approval-policy-config/SKILL.md
├── src/                  三个组件 TypeScript 源
│   ├── skill-recursive.ts
│   ├── approval-policy.ts
│   └── notify.ts
└── lib/                  tsc 产物（含 .d.ts 与 source map）
```

## 开发

```sh
npm install
npm run build     # tsc -> lib/
npm test          # 构建 + client.js 语法检查 + node --test（99 个用例）
```

## 兼容性

DeepSeek Harness `0.2.1-rc.5` 及以上。Node.js 22.19 及以上。运行时除 `@deepseek-ai/schemastery` 外无其他依赖。

## License

[MIT](LICENSE)
