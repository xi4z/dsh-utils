# dsh-utils

DeepSeek Harness 工具 bundle：一个包、两个组件。安装一次，两条挂载项各自独立开关与配置。

| 组件 | 挂载项 id | 包内入口 | 作用 |
|---|---|---|---|
| 递归技能发现 | `skill-recursive` | 包根 `dsh-utils` | 在嵌套目录里发现 `SKILL.md`，补足内置提供方只读一层的问题 |
| 无人值守审批门控 | `dsh-approval-policy` | 子路径 `dsh-utils/approval-policy` | 给 subagent / 定时 / cron 审批请求设定应答窗口，超时按 fail-closed 落定 |

包根入口是递归技能发现组件：浏览器半侧（`client.js`，两条挂载项各自的配置页）由 DSH 的客户端模块扫描器通过挂载项的包名发现，包根入口必须指向带 `dsh.client` 的那个包名。

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

安装后 bundle 的 patch 自动插入两条挂载项，无需手写挂载块；`cordis.patch.yml` 里的 `config:` 只用于配置。浏览器半侧随宿主启动时的客户端模块扫描加载，安装或更新后重启宿主（或重开窗口）才会出现配置界面。

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
```

两个 id 同时就是 settings 命名空间，浏览器侧通过 `ctx.configForms` 直接读写它们，所以配置既能写进 `cordis.patch.yml`，也能在界面里改：插件页 → Harness 工具集 → 任一组件的行 → 该行的配置入口，打开的页面里只有这个组件的字段和一个「保存」。

包内 `client.js` 用 `ctx.configForms.whileServed(['skill-recursive','dsh-approval-policy'], …)` 把每条挂载项的配置页注册到 `plugins.row.config`（key = `dsh-utils#<挂载项 id>`）：宿主没有向浏览器暴露某个命名空间时，对应页面不会出现，也不会渲染空表单。写入走宿主 settings 文档，两个组件的配置字段全部 volatile，保存后即时生效，无需重启。

## 包结构

```
dsh-utils/
├── cordis.patch.yml      两条挂载项
├── client.js             浏览器半侧：每条挂载项一页配置表单
├── locale/{en,zh}.json   bundle 展示名与描述
├── icon.svg
├── skills/dsh-approval-policy-config/SKILL.md
├── src/                  两个组件的 TypeScript 源
│   ├── skill-recursive.ts
│   └── approval-policy.ts
└── lib/                  tsc 产物（含 .d.ts 与 source map）
```

## 开发

```sh
npm install
npm run build     # tsc -> lib/
npm test          # 构建 + client.js 语法检查 + node --test（62 个用例）
```

## 兼容性

DeepSeek Harness `0.2.1-rc.5` 及以上，Node.js 22.19 及以上。运行时除 `@deepseek-ai/schemastery` 外不引入其它依赖。

## License

[MIT](LICENSE)
