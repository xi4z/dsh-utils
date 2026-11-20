# @xi4z/dsh-utils

单包形态：`@xi4z/dsh-utils` 一个包既是 bundle 层（`cordis.patch.yml` + locale + icon），也是主组件 `utils-main` 与整个浏览器半侧的代码所在，其余四个组件以**包内 subpath** 挂载（`@xi4z/dsh-utils/workbench`）。因此 manifest 里没有任何 `@xi4z/*` 依赖，npm 名、GitHub 地址、packed tarball、本地目录四种装法都只需要这一个 spec。行 id 就是 settings 命名空间，保持稳定。

| 组件 | 挂载项 id | 包 | 作用 |
|---|---|---|---|
| 递归技能发现 + 旧技能仓库路由（主组件） | `utils-main` | `@xi4z/dsh-utils`（包根） | 嵌套目录找 `SKILL.md`；保留旧的全局技能仓库 JSON 路由；`client.js` 提供全部配置页与右侧栏 Utils 面板 |
| 无人值守审批门控 | `dsh-approval-policy` | `@xi4z/dsh-utils/approval-policy` | 给审批请求设应答窗口，超时 fail-closed |
| 会话通知 | `dsh-notify` | `@xi4z/dsh-utils/notify` | 会话结束/等授权/等回答时，经 Gotify 网关推送，带设备名 |
| 技能面板（宿主侧） | `dsh-skill-panel` | `@xi4z/dsh-utils/skill-panel` | 旧侧边栏卡片已并入 Utils；保留当前会话的模型可见性开关与配置页 |
| Utils 工作台 | `dsh-workbench` | `@xi4z/dsh-utils/workbench` | 一个侧边栏面板按预设管理 skills、技能仓库与 AGENTS.md，并从技能仓库 `.dsh` 同步共享预设 |

根包的 `locale/{en,zh}.json` 同时是 bundle 展示名与 `utils-main` 行的标题（「Harness 工具集」）；四个 subpath 行各自从 `./<subpath>/locale/*.json` 取行标题（无人值守审批门控 / 会话通知 / 技能面板 / Utils 工作台）。subpath 行不是包，DSH 不读它的 `package.json`，所以组件目录里那份 manifest 只是 tsc/测试的构建单元，不再发布。

### 关于配置界面

DSH 客户端扫描器从**包根挂载行**加载 `client.js`。根包自己声明 `dsh.client` 并导出 `./client`，而 `utils-main` 行挂的正是包根，所以这一行同时提供宿主行为（递归发现 + 技能仓库路由）和浏览器半侧；四个 subpath 行只做宿主行为，不会被当成 client source，因此不会出现 `multiple active Loader sources`。

「技能仓库」的旧全局路由仍在根包里（`src/ui-host.ts`，编译到 `lib/ui-host.js`），由 `utils-main` 行注册；但它不再有独立侧边栏卡片，新的按预设仓库同步在 `dsh-workbench`。`client.js` 现在只注册配置页和一个 Utils 侧边栏面板。停用 `utils-main` 会失去递归发现、旧仓库路由和整个配置界面；停用 `dsh-workbench` 只会失去 Utils 路由（面板显示 404 提示）。

配置写 `cordis.patch.yml`：bundle 给默认值，profile 按 id 覆盖。覆盖行**不要写 `name`**（写旧包名会被 DSH 按 name mismatch 跳过）。技能仓库的仓库地址、分支与密钥不写 profile，存在 `$DSH_HOME/storages/dsh-utils-ui.json`（沿用旧文件名）。

## 安装

一个包，四种 spec，装法都一样：

| 想要的 | `target` |
|---|---|
| 最近一次发布 | `@xi4z/dsh-utils` |
| `main` 最新提交 | `https://github.com/xi4z/dsh-utils` |
| 离线单文件 | `/abs/path/xi4z-dsh-utils-0.4.0.tgz` |
| 改代码、即时生效 | `/abs/path/dsh-utils`（绝对目录，装成 `link:`） |

```
plugin_manager action=install_bundle target=@xi4z/dsh-utils
```

```sh
dsh plugin --profile <profile> add @xi4z/dsh-utils
```

四种都不要求 registry 上有任何 `@xi4z/*` 包：四个组件是包内 subpath 行（`@xi4z/dsh-utils/workbench`），根包只依赖公共的 `@deepseek-ai/schemastery`。GitHub 地址装的是 `main` 当前状态、不钉版本；要钉就用 npm 名或 `#<commit>`。

离线单文件由 `pnpm pack` 产出，本身就是自包含的：

```sh
pnpm install && pnpm build
pnpm pack --pack-destination dist      # → dist/xi4z-dsh-utils-0.4.0.tgz
# 复制到目标机器后：
plugin_manager action=install_bundle target=/abs/path/xi4z-dsh-utils-0.4.0.tgz
```

本地开发直接装目录（`link:`，不复制文件，改完 `pnpm build` 重启宿主）：

```sh
cd /path/to/dsh-utils
pnpm install && pnpm build
plugin_manager action=install_bundle target=/abs/path/to/dsh-utils
```

> 别给根包加回 `@xi4z/*` 依赖，也别把版本写成 `workspace:^`：那会毁掉"一条 spec 装全套"——`workspace:` 只在仓库内 `pnpm publish`/`pnpm pack` 时被改写成版本号，profile 从 git 或 tarball 装时 pnpm 拿到的是字面量，直接报 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。

profile 的 `dsh.profile.bundles` 里是 `@xi4z/dsh-utils`。装后 bundle 的 patch 自动插五行，不手写挂载块；`config:` 只管配置。挂载项新增/改名要重启宿主。

从单包/无 scope 版本升级：

1. profile 依赖只留 `@xi4z/dsh-utils`，把 `dsh-utils`、`dsh-utils-*`、`@xi4z/dsh-utils-approval-policy` 这类的 link 全删掉（组件已并入根包，多留会变成不识别的孤儿依赖）；
2. `dsh.profile.bundles` 里的旧名换成 `@xi4z/dsh-utils`；
3. profile `cordis.patch.yml` 的组件覆盖行不要写 `name:`（只留 `id` + `config`）；旧的 `id: dsh-utils-ui` 覆盖行删掉（该行已并入 `utils-main`）；
4. 重启宿主。技能仓库设置、Deploy Key、上次同步记录都不用重填。

## 发布

只有一个包要发。`scripts/release.mjs` 先 `npm view` 探一遍，**版本已在 registry 上就跳过**，所以重复跑安全、失败后重跑能从断点续上。

推 GitHub 与发 npm 可以合成一次操作——打 tag 触发 [`publish.yml`](.github/workflows/publish.yml)：

```sh
git push                                    # 先推代码
git tag v0.4.0 && git push origin v0.4.0    # 再推 tag，CI 里 build + 发布
```

tag 必须等于根包 `package.json` 的版本，否则 job 直接失败（防止把 0.4.0 的代码发成 0.3.9）。CI 里 `pnpm release` 只发根包（组件都在包里），带 `--provenance`。

一次性准备：npm 建一个 Automation token，存成仓库 secret `NPM_TOKEN`。scope 是公开的 `@xi4z`，token 所属账号要能用这个 scope（scope 通常是 npm 用户名或已创建的组织）。

手动发（本机 `npm login` 后，脚本逻辑与 CI 相同）：

```sh
pnpm build
pnpm release             # 发根包；版本已在 registry 上就跳过
pnpm release --dry-run   # 只看会不会发，不动 registry
```

组件改了不用单独发布：它们随根包一起走，`packages/<名>/lib` 和 `locale` 都进 `files`，`pnpm pack` 后即自包含。只发一个包也意味着版本只有一个——改了任何组件都要提根包版本号。

## 组件一（`utils-main`）：递归技能发现、旧仓库路由与浏览器 UI

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

直接合并 `@local/dsh-plugin-qq-notify` 0.2.0：模板、占位符、环境变量名、投递语义不变。只搬进 `@xi4z/dsh-utils`，补配置表单与热生效。

1. profile `package.json` 去掉 `@local/dsh-plugin-qq-notify`（依赖与 `dsh.profile.bundles` 两处），改装本包。重启后旧 bundle 的 `qq-notify` 挂载项消失。
2. 旧 `cordis.patch.yml` 里 `id: qq-notify` 行下的 `config:`，整体挪到新 `id: dsh-notify` 行下。字段名一致，不改写。
3. 两个 id 不能同时挂，否则同一事件发两遍。旧命名空间 `qq-notify` 的存量值不读取。按第 2 步搬。
4. 环境变量（`DSH_QQ_NOTIFY_*`）不改。

## 组件四：技能面板（宿主侧）

右侧栏的「技能」卡片已并入组件五 Utils 工作台，不再单独注册。宿主侧仍保留原来的模型可见性开关与配置页：列出当前会话能读取到的 Skill（模型技能目录），每行一个开关。

开关语义：关掉 = 在 `ctx.skills.snapshot()` / `list()` 里把该技能标成 `modelInvocable: false`，模型下一轮拿到的 `<available_skills>` 里不再出现；**手动 `/名称` 仍可加载**。不是 modelInvocable 的技能（只能手动调用的）显示「仅手动」，开关禁用。

数据来源：`GET /api/dsh-utils/skill-panel/list`（Connection owner 认证）。带 `sessionId` 时用该会话的 cwd 与 preset skill 层；不带时用宿主默认工作目录。返回按名称排序，`enabled = modelInvocable && !disabled`。

持久化：写 profile settings 的 `dsh-skill-panel` 命名空间：

```yaml
- id: dsh-skill-panel
  config:
    disabledSkills: []
```

`disabledSkills` 是 volatile，保存即生效、不用重启。面板本身不落盘。

注意：这里只影响当前会话的模型可见性，不改预设目录里的 `SKILL.md`。按预设开关技能请用 Utils 工作台（重命名 `SKILL.md` / `SKILL.md.disabled`）。

### 旧技能仓库路由

`utils-main` 仍注册旧的全局仓库路由 `/api/dsh-utils-ui/*`（存储 `dsh-utils-ui.json`、`.deploy-key`），但不再有侧边栏卡片。新面板的「预设同步」也读写同一份存储与 Deploy Key 文件，用来拉取私有技能仓库；旧数据和旧路由保留，停用 `dsh-workbench` 不会影响它们。

## 组件五：Utils 工作台

一个侧边栏面板，把原来的「技能」「技能仓库」「Markdown」三张卡片合在一起，并把 `~/.dsh/.agent-presets/<id>/` 注册成真正的 agent preset。顶部选择预设（或「全局 / 项目 AGENTS.md」），下面四个视图：

| 视图 | 作用 |
|---|---|
| 技能 | 列出 `<preset>/skills/` 下的 `SKILL.md` / `SKILL.md.disabled`，显示名称、描述、路径；开关直接重命名文件；「编辑 SKILL.md」跳到 Markdown 视图 |
| Markdown | 列出该预设的 `AGENTS.md`（缺失也列出，保存即创建）以及全部 `.md` / `.md.disabled`；带草稿、还原、重读、`Ctrl/Cmd+S` |
| 技能仓库 | 仓库地址、分支、`skills/` 下的目标子目录、密钥路径、Deploy Key、递归子模块；保存设置与「同步（拉取）」 |
| 预设同步 | 配置共享技能仓库（仓库地址、分支、检出目录、Deploy Key）并 clone/快进私有仓库；读取其 `.dsh/preset` 下的共享预设，逐条或全部复制到 `$DSH_HOME/.agent-presets/`；导入非内置原生预设，并发布目录预设到共享仓库、提交推送 |

目录预设注册：宿主启动、首次打开 Utils 或点“刷新”时，会把每个含 `agent.cordis.yml` 的目录注册成真正的 agent preset（声明一个 `cordis:include` 行）。注册成功后 DSH 的预设选择器就能选到它；加载失败会在面板列出 `broken` 诊断。

预设来自 `$DSH_HOME/.agent-presets/<id>/`（以及 `presetDirs`）；顶部显示 `preset.yml` 的 name/description。全局视图保留 `$DSH_HOME/AGENTS.md`、`$DSH_AGENTS_HOME/AGENTS.md` 与项目根到当前目录的 AGENTS.md 链。

目录预设会被 Utils **注册成真正的 agent preset**：每个目录声明一个 `cordis:include` 行指向它的 `agent.cordis.yml`，由 Loader 用原来的 `!!js` 入口列表解析并持续监听。注册成功后，DSH 的预设选择器会出现 `code`、`a-ce` 等目录预设；加载失败会在面板显示 `broken` 诊断。宿主启动时就会注册；首次打开 Utils 或点“刷新”也会补注册新增目录，不必重启。全局/项目 AGENTS.md 仍由 `dsh-agent-instructions` 读取。

仓库同步只拉取：

- 目标 `<preset>/skills/<targetSubdir>` 不存在：`git clone --depth 1 --branch <branch> --single-branch`；
- 已存在：必须是同一仓库的 checkout、当前分支等于配置分支；`fetch` + `merge --ff-only`，浅克隆首次同步会 `--unshallow`，避免 unrelated histories；
- 子模块可选：`git submodule sync --recursive` + `update --init --recursive`，失败只记 warning；
- 不 reset、不 force、不推送。

Deploy Key 按预设保存到 `$DSH_HOME/storages/dsh-utils-workbench/<preset>.key`（600），接口不回显；也可以填「密钥路径」指向已有私钥，路径优先。公开 `https://` / `file://` 可免密钥。

#### 共享预设同步（`.dsh`）

跟踪技能的 Git 仓库可以顺带携带预设：仓库根下的 `.dsh/preset` 目录被当作只读来源，面板把其中的预设目录复制到本机 `$DSH_HOME/.agent-presets/<id>/`，同步完立即由 legacy 桥注册成真正的 agent preset。支持的布局：

```text
<repo>/.dsh/preset/<id>/           # 推荐：一个仓库携带多个预设
<repo>/.dsh/preset/                # 目录本身就是一个预设（preset.yml / agent.cordis.yml 直接放在这里）
<repo>/.dsh/presets/<id>/          # 兼容别名
<repo>/.dsh/.agent-presets/<id>/   # 兼容别名，镜像 $DSH_HOME 结构
<repo>/.dsh/<id>/                  # 兼容：目录内需有 preset.yml 或 agent.cordis.yml
```

预设目录必须带 `preset.yml` 或 `agent.cordis.yml`；单个预设目录形式的 id 取 `preset.yml` 的 `id`，没有就取目录名。

扫描来源：当前选中预设同步出来的技能仓库 checkout（`<preset>/skills/<targetSubdir>`）、共享技能仓库的 checkout（`$DSH_HOME/storages/dsh-utils-ui.json` 的 `targetDir`，默认 `$DSH_HOME/skills/herskill`）、`$DSH_HOME/skills` 及其带 `.dsh` 的一级子目录，以及配置项 `presetSourceDirs` 里列出的额外仓库，按真实路径去重。仓库本身不会被修改。

**共享技能仓库与 Deploy Key**：面板里可直接配置被跟踪的技能仓库——仓库地址、分支、检出目录、可选密钥路径、Deploy Key 私钥，点「拉取」做 clone 或 `fetch` + `merge --ff-only`（浅克隆先 `--unshallow`，子模块可选），完成后 `.dsh/preset` 自动出现在下面的来源列表。私有仓库填 Deploy Key 即可；密钥只在保存时写入、接口不回显。

检出目录就是**仓库根目录**，可以是任意绝对路径（如 `~/core/projects/skills`、`~/.dsh/skills-src/skills`），不必叫 `.dsh`，也不需要指向 `~/.dsh`；预设固定从 `<检出目录>/.dsh/preset` 读取。

存储与旧全局路由兼容，两处看到的是同一份配置：

- 设置：`$DSH_HOME/storages/dsh-utils-ui.json`（`repoUrl` / `branch` / `targetDir` / `keyPath` / `recurseSubmodules` / `lastSync`）
- Deploy Key：`$DSH_HOME/storages/dsh-utils-ui.deploy-key`（600，不返回浏览器）
- 密钥优先级：`keyPath` 指向的私钥 > 面板保存的 Deploy Key > 无；公开 `https://` / `file://` 可免密钥

同步规则：

- 逐文件写临时文件再 rename；内容相同则跳过，按源文件保留可执行位；跳过符号链接与 `.git` / `node_modules` 等忽略目录；单文件上限 8 MiB；
- 「删除源中已移除的文件」只删**上一次同步清单里记录过、这次源里已消失**的文件，本机自己加的文件和预设里的 `.dsh-utils/repo.json` 不会被删；
- 同步清单在 `$DSH_HOME/storages/dsh-utils-workbench/shared-presets.json`（600），用于显示「已接管」与上次同步时间；
- 状态：`new`（本地没有）、`update`（文件内容不同）、`same`（已一致）、`invalid`（id 不合法，拒绝同步）。

#### 原生预设接管与发布

DSH 的预设除了目录版，还可能来自 Cordis 声明（随包内置的 `standard`/`ptc`，或 `dsh-butler-preset` 这类 bundle）。面板的「原生预设接管」会列出注册表里的全部声明：

- `builtinPresets`（默认 `standard`、`ptc`、`minimal`、`creator`）保留原生，不导入；
- 其余声明若是「可导入」，点「导入到本地预设」后调用注册表的 `readDocument(id)`，把组合 YAML 写成 `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`，并把 name/description 写进 `preset.yml`（已存在的目录默认跳过，避免覆盖本地修改）；
- 导入后由 legacy 桥在下一次刷新时注册；不会删除/停用任何原生声明。

「发布非内置预设」把本机所有非内置目录预设复制到共享仓库的 `.dsh/preset/<id>/`，然后：

- 只 `git add` / `git commit` 路径 `.dsh/preset`，不碰仓库里的其他改动；
- 勾选推送时执行 `git push origin HEAD:<分支>`，分支必须等于共享仓库配置里的分支；
- 共享仓库必须是已拉取的 Git checkout；提交信息可自定义，默认 `presets: sync from dsh-utils`。

路由（Connection owner 认证）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/dsh-utils/workbench/list` | 预设列表、技能、AGENTS.md 元数据、全局文件；带 `sessionId` 时用该会话 cwd |
| `GET` | `/api/dsh-utils/workbench/files?presetId=…` | 一个预设或全局目标的 Markdown 文件 |
| `GET / POST` | `/api/dsh-utils/workbench/file` | 读文件；POST `{id, content, baseMtimeMs, sessionId?}` 原子写入 |
| `POST` | `/api/dsh-utils/workbench/skill` | `{presetId, path, enabled}`，重命名 SKILL.md |
| `GET / POST` | `/api/dsh-utils/workbench/repo` | 读/存每个预设的仓库设置 |
| `POST` | `/api/dsh-utils/workbench/key` | `{presetId, key}`，保存或清除 Deploy Key |
| `POST` | `/api/dsh-utils/workbench/sync` | `{presetId}`，clone 或快进 |
| `GET` | `/api/dsh-utils/workbench/shared?presetId=…` | 扫描技能仓库 `.dsh` 下的共享预设及同步状态 |
| `POST` | `/api/dsh-utils/workbench/shared-sync` | `{presetId, ids?, prune?}`，把共享预设复制到本机预设目录 |
| `GET / POST` | `/api/dsh-utils/workbench/shared-repo` | 读/存共享技能仓库设置（与旧全局路由同一份存储） |
| `POST` | `/api/dsh-utils/workbench/shared-key` | `{key}`，保存或清除共享仓库 Deploy Key |
| `POST` | `/api/dsh-utils/workbench/shared-pull` | 用配置的 Deploy Key clone 或快进共享技能仓库 |
| `GET` | `/api/dsh-utils/workbench/native-presets` | 列出注册表里的预设及内置/已目录/可导入状态 |
| `POST` | `/api/dsh-utils/workbench/native-presets-import` | `{ids?, force?}`，把非内置声明导出为目录预设 |
| `POST` | `/api/dsh-utils/workbench/presets-publish` | `{ids?, message?, push?}`，发布到共享仓库并提交/推送 |

配置（全 volatile，保存即生效）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxBytes` | `524288` | 单文件读写上限（字节） |
| `presetDirs` | `[]` | 额外的预设根目录；每个子目录视为一个预设 |
| `presetSourceDirs` | `[]` | 额外的共享预设来源（技能仓库绝对路径）；读取其 `.dsh` 下的预设 |
| `builtinPresets` | `['standard','ptc','minimal','creator']` | 保留为原生的预设 id；其余声明可导入为目录预设 |
| `extraAgentsFiles` | `[]` | 全局视图额外暴露的 AGENTS.md 类绝对路径 |
| `scanNestedAgents` | `false` | 全局视图递归寻找嵌套 AGENTS.md |
| `nestedDepth` | `3` | 全局视图递归深度 |
| `defaultRepoUrl` | `https://github.com/xi4z/skills` | 新预设的默认仓库地址 |
| `defaultBranch` | `Agent` | 新预设的默认分支 |

宿主半侧在 `packages/workbench/src/`（`index.ts` 路由、`presets.ts` 预设/技能/文件、`git.ts` 仓库同步），浏览器半侧仍是根包的 `client.js`。停用 `dsh-workbench` 行后路由消失，侧边栏 Utils 面板显示 404 提示。

## 配置写法

覆盖行只写 `id` 与 `config`，`name` 交给 bundle：

```yaml
- id: utils-main
  config:
    maxDepth: 6
    extraRoots:
      - D:/Core/Projects/Skill
- id: dsh-approval-policy
  config:
    origins: [subagent, scheduled, cron]
    windowSeconds: 300
    defaultOutcome: rejected
- id: dsh-notify
  config:
    transport: gotify
    gotifyUrl: https://notify.example.com
    gotifyToken: gtfya.该系列的token
    deviceLabel: 办公本
    dryRun: false
- id: dsh-skill-panel
  config:
    disabledSkills: []
- id: dsh-workbench
  config:
    maxBytes: 524288
    presetDirs: []
    extraAgentsFiles: []
    scanNestedAgents: false
    nestedDepth: 3
    defaultRepoUrl: https://github.com/xi4z/skills
    defaultBranch: Agent
```

五个组件 id（`utils-main` + 四个 subpath 组件）同时是 settings 命名空间；配置写 `cordis.patch.yml`：bundle 给默认，profile 按 id 覆盖。根包声明 `dsh.client`，`utils-main` 这个包根行同时让宿主加载 `client.js`；插件页每个挂载项都有配置页，右侧栏只有一个 Utils 面板。组件启用/停用、运行状态照常显示。

根包的 `client.js` 用 `ctx.configForms.whileServed(['utils-main','dsh-approval-policy','dsh-notify','dsh-skill-panel','dsh-workbench'], …)` 把五个组件配置页注册到 `plugins.row.config`（key = `@xi4z/dsh-utils#<挂载项 id>`），并注册 `sidebar.right.pane.tab` 的 Utils 面板。五个组件的配置字段全 volatile，写入走宿主 settings 文档，保存即生效；Utils 的仓库设置存在各预设的 `.dsh-utils/repo.json`，Deploy Key 存在 storages，Markdown 直接落盘。

## 包结构

```
@xi4z/dsh-utils/            唯一的可安装包：bundle + 全部五个组件
├── package.json              bundle patch/locale/icon + subpath exports + dsh.client
├── pnpm-workspace.yaml       只用来把 packages/* 当 tsc/测试的构建单元
├── cordis.patch.yml          五行：utils-main（包根）+ 四个 subpath 行
├── locale/{en,zh}.json       bundle 展示名与 utils-main 行标题
├── icon.svg
├── skills/dsh-approval-policy-config/SKILL.md
├── client.js                 浏览器半侧：配置页 + 右侧栏 Utils 面板
├── src/{index.ts,ui-host.ts} utils-main：递归发现 + 旧技能仓库路由
├── lib/…                     编译产物（index.js / ui-host.js）
├── scripts/release.mjs       只发根包，已发布版本跳过
├── test/                     根包测试（utils-main / ui-host / client / 布局守卫）
└── packages/
    ├── approval-policy/      → 导出为 @xi4z/dsh-utils/approval-policy
    ├── notify/               → 导出为 @xi4z/dsh-utils/notify
    ├── skill-panel/          → 导出为 @xi4z/dsh-utils/skill-panel
    └── workbench/            → 导出为 @xi4z/dsh-utils/workbench
```

`packages/<名>/` 仍是标准的插件源码目录（`src/index.ts` + `locale/` + 自己的 `package.json` 供 tsc 与包内测试用），但**不单独发布**：根包的 `exports["./<名>"]` 指向它的 `lib/index.js`，`exports["./<名>/locale/*.json"]` 指向它的 locale，`files` 里的 `packages/*/lib` 与 `packages/*/locale` 负责打进 tarball。加组件＝新建 `packages/<名>/`，再在根 `package.json` 加两条 `exports`（入口 + locale）、在 `files` 已覆盖的前提下加一行 patch；`test/layout.test.mjs` 会检查这三处是否对齐。

## 开发

```sh
pnpm install
pnpm build     # 根包（utils-main）+ packages/* 的 tsc -> lib/
pnpm test      # 构建 + client.js 语法检查 + 布局守卫 + 各包 node --test（176 个用例）
```

## 兼容性

DeepSeek Harness `0.2.2-rc.1` 及以上。Node.js 22.19 及以上。运行时依赖 `@deepseek-ai/schemastery`；`client.js` 只依赖宿主提供的 React 运行时。Utils 面板需要宿主带右侧栏（web 组合默认带）。

## License

[MIT](LICENSE)
