# dsh-utils

DeepSeek Harness 工具 bundle：一个包、三个组件。安装一次，三条挂载项各自独立开关与配置。

| 组件 | 挂载项 id | 包内入口 | 作用 |
|---|---|---|---|
| 递归技能发现 | `skill-recursive` | 包根 `dsh-utils` | 在嵌套目录里发现 `SKILL.md`，补足内置提供方只读一层的问题 |
| 无人值守审批门控 | `dsh-approval-policy` | 子路径 `dsh-utils/approval-policy` | 给 subagent / 定时 / cron 审批请求设定应答窗口，超时按 fail-closed 落定 |
| 会话通知 | `dsh-notify` | 子路径 `dsh-utils/notify` | 会话跑完一轮、等待授权或等待回答时，经 Gotify 网关推一条带设备名的消息 |

包根入口是递归技能发现组件：浏览器半侧（`client.js`，三条挂载项各自的配置页）由 DSH 的客户端模块扫描器通过挂载项的包名发现，包根入口必须指向带 `dsh.client` 的那个包名。另外两个组件用子路径导出，因此不会和根入口抢名字。

## 安装

Desktop 应用或任一带插件管理器的会话，从仓库装：

```
plugin_manager action=install_bundle target=github:xi4z/dsh-utils
```

CLI profile：

```sh
dsh plugin --profile <profile> add github:xi4z/dsh-utils
```

本地开发用 `target=<本包绝对路径>`，或 CLI 里 `add link:<本包绝对路径>`。仓库已包含构建产物 `lib/`，从 GitHub 安装不需要再跑构建。

安装后 bundle 的 patch 自动插入三条挂载项，无需手写挂载块；`cordis.patch.yml` 里的 `config:` 只用于配置。浏览器半侧随宿主启动时的客户端模块扫描加载，安装或更新后重启宿主（或重开窗口）才会出现配置界面。

## 组件一：递归技能发现

```
.dsh/skills/
├── flat-skill/SKILL.md            ← 内置提供方（本组件不接管第 1 层）
└── obsidian-skills/               ← 容器目录
    ├── defuddle/SKILL.md          ← 本组件
    └── json-canvas/SKILL.md       ← 本组件
```

扫描根：项目根的 `.dsh/skills` 与 `.agents/skills`（会话工作目录向上找最近的 `.git`）、`$DSH_HOME/skills`（默认 `~/.dsh/skills`）、`$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`），外加 `extraRoots`。同名的扁平技能优先级更高：嵌套候选的 rank 比对应扁平根低一档。

| 字段 | 默认 | 含义 |
|---|---|---|
| `minDepth` | `2` | 允许出现技能的第一个目录层级（相对技能根） |
| `maxDepth` | `8` | 最深扫描层级 |
| `watch` | `true` | 监听技能根，文件变化后刷新技能目录 |
| `debounceMs` | `200` | 监听失效的防抖间隔 |
| `pollIntervalMs` | `2000` | 不支持递归监听时的轮询间隔 |
| `includeProjectRoots` | `true` | 扫描项目级技能根 |
| `includeUserRoots` | `true` | 扫描用户级技能根 |
| `followSymlinks` | `false` | 跟随符号链接目录（带环路保护） |
| `extraRoots` | `[]` | 追加技能根，使用绝对路径 |
| `ignoreDirs` | `[".system","node_modules",".git"]` | 永不进入的目录名 |

识别的前置字段：`name`、`description`、可选 `whenToUse`、`disable-model-invocation`、`user-invocable`。非法文件记警告并跳过。

## 组件二：无人值守审批门控

挂在宿主 `'approval/request'` waterfall 链首（`prepend` 注册）。判定为无人值守的请求先 `next()` 交给下游交互面：窗口内有人应答就用人的答案，窗口耗尽按 fail-closed 默认值落定，turn 立即结束而不是一直挂起。交互会话本组件不改变。

| 字段 | 默认 | 含义 |
|---|---|---|
| `origins` | `[subagent, scheduled]` | 判定为无人值守的来源：`subagent` / `scheduled` / `cron` / `all` |
| `sessions` | `[]` | 按 agent id 的 glob 点名会话，命中即门控该会话所有 turn |
| `windowSeconds` | `60` | 应答窗口（秒）；`0` 即立即拒绝且不询问下游 |
| `defaultOutcome` | `rejected` | 窗口到期落定值：`rejected` 或 `unavailable`（没有 `allowed-once`） |
| `defaultPermissionPreset` | `''` | 新会话写入的权限档；`auto` 走实验性自动审批（需要对应 bundle） |
| `autoReviewContent` | `true` | 窗口拒绝的是自动审批发起的请求时，把复核内容附进模型读到的工具结果 |

判定粒度：`sessions` 命中与 `all` 是会话级；`subagent` 看 `session.header.origin`；`scheduled` / `cron` 看会话最后一条带溯源的 user 消息的 `source.kind`（`runtime-context`、`skill-catalog` 这类合成注入会被跳过，人插过话就不门控）。审计由宿主的 `approval/asked` + `approval/decided` 写进会话日志，本组件不写日志、不落盘状态。

随包附带技能 `dsh-approval-policy-config`，是这套配置的交互向导。

## 组件三：会话通知

会话的每轮跑完、或 agent 挂起在「等你回答 / 等你授权」时，推一条消息到你指定的出口。出口默认是**公网 Gotify 网关**：插件不持有 Bot 凭据、不建 WebSocket、不引额外依赖，只发一个 HTTP POST；任何能上网的设备（笔记本、家里的服务器、云主机）装同一份 bundle、填上网关地址和 token 就能发。每条消息带**发送设备名**（默认取主机名），多台机器共用一个 QQ 时也能一眼看出是哪台跑完的。

### 接线方式

```
session/event  →  累积"刚结束这一轮"的 reason + 最后一条 assistant 文本
agent/status   →  running → idle 的边沿 = 整个任务干完的那一刻
                ↓
       渲染中文摘要（含设备名）→ POST {gotifyUrl}/message → relay → QQ
```

为什么不用 `turn/end` 直接发：`agent/status` 的 idle 边沿才代表"整个任务结束"（含子任务收敛），且天然带上去重语义；`turn/end` 只负责提供结束原因和回复文本。

### 事件来源：只读会话日志

早期实现挂过 `approval/request` 与 `user-questions/request` 两个 waterfall 监听，实测**根 context 的监听器收不到**（agent 作用域派发被过滤，加 `{ global: true }` 也没解决）。本组件改为全部从 `session/event` 这个日志流推导：

| 通知类型 | 日志信号 | 去抖 |
|---|---|---|
| 会话完成/出错/中止 | `turn/end` 的 `reason.kind` | 无 |
| 等待你回答 | `tool/call` 且 `name` 为 `ask_user_question` / `exit_plan_mode` | `questionDelayMs`（默认 2500），`tool/result` 到达即取消 |
| 需要授权 | `approval/asked` | `approvalDelayMs`（默认 3000），`approval/decided` 到达即取消 |

去抖的意义：如果人在 2.5 秒内已经在界面上答了、或策略自动裁决了，就不打扰你。

### 配置

`cordis.patch.yml` 的 `config`、插件页的配置表单，或环境变量（环境变量优先，适合把 token 放在外面）。全部字段 volatile：改完即时生效，无需重启。

| 字段 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | — | `true` | 总开关 |
| `transport` | — | `gotify` | `gotify` 为公网网关；`onebot` 直连 NapCat 已废弃，仅兼容旧配置 |
| `deviceName` | `DSH_QQ_NOTIFY_DEVICE` | 主机名 | 设备唯一名，多设备区分的基础 |
| `deviceLabel` | `DSH_QQ_NOTIFY_DEVICE_LABEL` | 同 `deviceName` | 给人看的名字，用于 `{device}` 与标题前缀 |
| `deviceInTitle` | — | `false` | `true` 时 Gotify 标题加 `[设备名]` 前缀 |
| `gotifyUrl` | `DSH_QQ_NOTIFY_GOTIFY_URL` | `''` | 网关地址，如 `https://notify.example.com` |
| `gotifyToken` | `DSH_QQ_NOTIFY_GOTIFY_TOKEN` | `''` | 该系列的 Gotify application token |
| `gotifyPriority` | — | `3` | 默认优先级，`targets` 未单独指定时使用 |
| `gotifyHeaders` | `DSH_QQ_NOTIFY_GOTIFY_HEADERS`（JSON） | `{}` | 追加请求头，用于反代 Basic Auth 等 |
| `targets` | `DSH_QQ_NOTIFY_TARGETS`（JSON） | `[]` | 多目标列表，见下；非空时不再使用 `gotifyUrl` / `gotifyToken` |
| `notifyOnReasons` | — | `[completed, error, aborted]` | 哪些结束原因通知：`completed` / `error` / `aborted` / `blocked` |
| `notifyOnApproval` | — | `true` | 等待审批决定时是否通知 |
| `notifyOnQuestion` | — | `true` | 等待用户回答时是否通知 |
| `questionDelayMs` | — | `2500` | 提问通知的去抖窗口 |
| `approvalDelayMs` | — | `3000` | 审批通知的去抖窗口 |
| `template` | — | 见下 | 会话结束通知的固定格式 |
| `questionTemplate` | — | 见下 | 提问通知的固定格式 |
| `approvalTemplate` | — | 见下 | 审批请求通知的固定格式 |
| `includeSubagents` | — | `false` | 是否连子会话（subagent）也通知 |
| `summaryChars` | — | `120` | `{reply}` 纯文本化后的截断长度 |
| `timeoutMs` | — | `8000` | 单次 HTTP 超时，失败自动重试 1 次 |
| `dryRun` | — | `true` | **默认开**：只打日志不发消息，确认配置后再关 |
| `traceFile` | — | `''` | 可选 JSONL 诊断轨迹（排障用），空则不记录 |

`endpoint` / `token` / `targetType` / `targetId` 只在 `transport: onebot` 的旧直连路径下使用，对应 `DSH_QQ_NOTIFY_URL` 等环境变量。

### 多设备：每台机器都能通知，也能分清是谁

公网网关对任何来源 IP 开放（仅按 token/IP 限流），所以其他设备上不需要部署 relay、不需要 NapCat，也不需要本机开任何端口：

1. **设备身份**：`deviceName` 留空即自动取 `os.hostname()`；建议再设 `deviceLabel`（如办公本、家里的服务器），它会渲染进 `{device}` 占位符。
2. **各自一套 token**：在 Gotify 里给每台设备建一个 application（一个「系列」），把 token 用环境变量注入，避免每台设备都拿到同一把：

   ```sh
   export DSH_QQ_NOTIFY_DEVICE='laptop-01'
   export DSH_QQ_NOTIFY_DEVICE_LABEL='随身本'
   export DSH_QQ_NOTIFY_GOTIFY_TOKEN='gtfya.该设备的token'
   ```

   系列不同，QQ 收件人也可以在 relay 侧不同（见 relay 的路由表）。

3. **一套配置分发多台设备**：不想逐机改配置时，用 `targets` + `devices` 让每个目标只对命中的设备生效（`devices` 为空 = 所有设备都发）：

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

   配了 `targets` 后就不再读取 `gotifyUrl` / `gotifyToken` / `gotifyPriority`；每个目标可单独设 `priority`，一条事件会并发发往所有命中目标，某个目标失败不影响其他。

### 自定义消息格式

消息正文由模板决定，改格式只改 `template` / `questionTemplate` / `approvalTemplate`：

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
| `{kind}` | 原始原因字符串：`completed` / `error` / `aborted` / `blocked` |
| `{device}` | `deviceLabel`，默认等于主机名 |
| `{host}` | `deviceName`（默认 `os.hostname()`） |
| `{sessionId}` | 会话 id 去掉 `session-` 前缀后的前 8 位 |
| `{cwd}` | 会话工作目录 |
| `{reply}` | 最后一条 assistant 文本，去 Markdown 并按 `summaryChars` 截断 |
| `{error}` | 失败信息（仅 `error` 原因有值），去 Markdown 后截断 120 字 |
| `{date}` / `{time}` | 本机日期 / 时间 |

提问通知额外可用 `{question}` / `{detail}` / `{options}`；审批通知额外可用 `{tool}` / `{reason}`；三类模板都支持 `{device}`、`{host}`、`{sessionId}`、`{cwd}`、`{date}`、`{time}`。

`{reply}` / `{error}` / 审批的 `{reason}` 都会先转成**纯文本**：代码块整段丢弃、行内代码保留文字、标题/列表符号/表格竖线/加粗斜体/链接语法全部去掉，连续空白压成一个空格；`session_id` 这类下划线标识符不受影响。

两条替换规则：

- **值为空的行会被整行删掉**。上例在 `completed` 时「错误: {error}」那行自动消失，不用写两套模板。
- **不认识的占位符原样保留**，方便发现拼写错误（`{sesionId}` 会原样出现在消息里）。

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

网关收 `POST {gotifyUrl}/message`，body 是 `{title, message, priority}`，鉴权用 `X-Gotify-Key`；正文按「首行当标题、其余当正文」拆，relay 端再拼回「标题 + 换行 + 正文」。

`deviceInTitle: true` 时标题变成「[设备名] 原标题」；`gotifyHeaders` 里的自定义头会合并进请求，但 `X-Gotify-Key` 始终以当前目标的 token 为准（不能被自定义头覆盖）。

历史：2026-11-07 之前这里是 NapCat/OneBot 直连（`endpoint` + `targetId`），NapCat 容器与 AstrBot 已整体删除，不要再按旧文档在 NapCat WebUI 里开 HTTP 服务器。

### 从 @local/dsh-plugin-qq-notify 迁移

本组件是 `@local/dsh-plugin-qq-notify` 0.2.0 的直接合并：模板、占位符、环境变量名、投递语义都不变，只是搬进了 `dsh-utils` 并补上配置表单与热生效。

1. 在 profile 的 `package.json` 里去掉 `@local/dsh-plugin-qq-notify`（依赖与 `dsh.profile.bundles` 两处），改装本包；宿主启动时旧 bundle 的 `qq-notify` 挂载项随之消失。
2. 把旧 `cordis.patch.yml` 里 `id: qq-notify` 行下 `config:` 的内容整体挪到新 `id: dsh-notify` 行下。字段名完全一致，不用改写。
3. 两个 id 不能同时挂着，否则同一条事件会发两遍。旧设置命名空间 `qq-notify` 的存量值不会被读取，按第 2 步搬到新行即可。
4. 环境变量（`DSH_QQ_NOTIFY_*`）不需要改。

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

三个 id 同时就是 settings 命名空间，浏览器侧通过 `ctx.configForms` 直接读写它们，所以配置既能写进 `cordis.patch.yml`，也能在界面里改：插件页 → 递归Skill插件（`dsh-utils` bundle）→ 任一组件的行 → 该行的配置入口，打开的页面里只有这个组件的字段和一个「保存」。

包内 `client.js` 用 `ctx.configForms.whileServed(['skill-recursive','dsh-approval-policy','dsh-notify'], …)` 把每条挂载项的配置页注册到 `plugins.row.config`（key = `dsh-utils#<挂载项 id>`）：宿主没有向浏览器暴露某个命名空间时，对应页面不会出现，也不会渲染空表单。写入走宿主 settings 文档，三个组件的配置字段全部 volatile，保存后即时生效，无需重启。

## 包结构

```
dsh-utils/
├── cordis.patch.yml      三条挂载项
├── client.js             浏览器半侧：每条挂载项一页配置表单
├── locale/{en,zh}.json   bundle 展示名与描述（根组件行的标题也读这份）
├── locale/approval-policy/  审批门控行的独立标题
├── locale/notify/           通知行的独立标题
├── icon.svg
├── skills/dsh-approval-policy-config/SKILL.md
├── src/                  三个组件的 TypeScript 源
│   ├── skill-recursive.ts
│   ├── approval-policy.ts
│   └── notify.ts
└── lib/                  tsc 产物（含 .d.ts 与 source map）
```

## 开发

```sh
npm install
npm run build     # tsc -> lib/
npm test          # 构建 + client.js 语法检查 + node --test（96 个用例）
```

## 兼容性

DeepSeek Harness `0.2.1-rc.5` 及以上，Node.js 22.19 及以上。运行时除 `@deepseek-ai/schemastery` 外不引入其它依赖。

## License

[MIT](LICENSE)
