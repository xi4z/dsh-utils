# @xi4z/dsh-utils

DeepSeek Harness 的工具 bundle。根包 `@xi4z/dsh-utils` 只做拼装：`cordis.patch.yml` 声明六个挂载行，`locale/{en,zh}.json` 提供 bundle 展示名，`icon.svg` 是图标；组件代码都在独立发布的包里，根包用同版本精确依赖把它们装起来。挂载行 id 同时是 settings 命名空间，插件页按 `@xi4z/dsh-utils#<行 id>` 定位该行的配置页。

| 组件 | 行 id | 包 | 作用 |
|---|---|---|---|
| utils-agents | `utils-agents` | `@xi4z/dsh-utils-utils-agents` | 技能与预设的宿主：嵌套 `SKILL.md` 发现、模型可见性开关，以及按预设管理 skills、技能仓库与 AGENTS.md |
| 无人值守审批门控 | `dsh-approval-policy` | `@xi4z/dsh-utils-approval-policy` | 给审批请求设应答窗口，超时 fail-closed；对外发布窗口读数 |
| QQ 审批卡片 | `dsh-approval-qq` | `@xi4z/dsh-utils-approval-qq` | 把待审批请求推成 QQ 卡片（markdown + 允许／拒绝按钮），按钮点击回填审批结论 |
| 会话通知 | `dsh-notify` | `@xi4z/dsh-utils-notify` | 会话结束 / 等授权 / 等回答时经 Gotify 网关推送，带设备名 |
| 反向代理入口 | `dsh-remote` | `@xi4z/dsh-utils-remote` | 本机回环反代：Host/Origin 改写后转发给 DSH Web，供自备隧道发布界面；desktop profile 保持原版桌面 UI 并由宿主自举首次鉴权 |
| 浏览器界面 | `utils-ui` | `@xi4z/dsh-utils-ui` | 五个宿主行的配置页 + 右侧栏 utils-agents 面板；宿主侧只有空 `apply()` |

## 安装

装一次 bundle 即可；六个组件由 pnpm 作为根包的精确版本依赖从 registry 装上。

| 想要的 | `target` |
|---|---|
| 最近一次发布 | `@xi4z/dsh-utils` |
| `main` 最新提交 | `https://github.com/xi4z/dsh-utils`（组件包仍需 registry 上有同版本） |
| 离线 | 七个 tarball（见下） |
| 改代码、即时生效 | 目录 `link:`，profile 里同时 link 六个组件 |

```
plugin_manager action=install_bundle target=@xi4z/dsh-utils
```

```sh
dsh plugin --profile <profile> add @xi4z/dsh-utils
```

根包的 `dependencies` 固定到六个 `@xi4z/dsh-utils-*`，版本与 bundle 相同，所以发布版只需要这一个 spec。GitHub 地址装的是 `main` 当前状态、不钉版本；要钉就用 npm 名或 `#<commit>`（组件仍从 registry 取同版本）。

根包 tarball 只含拼装层，组件在各自的包里。离线搬运要把七个包都 pack：

```sh
pnpm install && pnpm build
pnpm -r --filter "./packages/*" pack --pack-destination dist
pnpm pack --pack-destination dist
# 目标机器 profile 里七个 tarball 都加 file: 依赖，再装 bundle
```

本地开发装目录（`link:`，不复制文件，改完 `pnpm build` 重启宿主）。组件是精确版本依赖，profile 要把六个组件也 link 进来，pnpm 才会用本地目录而不是去 registry 解析：

```json
{
  "dependencies": {
    "@xi4z/dsh-utils": "link:/abs/path/dsh-utils",
    "@xi4z/dsh-utils-approval-policy": "link:/abs/path/dsh-utils/packages/approval-policy",
    "@xi4z/dsh-utils-approval-qq": "link:/abs/path/dsh-utils/packages/approval-qq",
    "@xi4z/dsh-utils-notify": "link:/abs/path/dsh-utils/packages/notify",
    "@xi4z/dsh-utils-remote": "link:/abs/path/dsh-utils/packages/remote",
    "@xi4z/dsh-utils-utils-agents": "link:/abs/path/dsh-utils/packages/utils-agents",
    "@xi4z/dsh-utils-ui": "link:/abs/path/dsh-utils/packages/ui"
  }
}
```

profile 的 `dsh.profile.bundles` 里是 `@xi4z/dsh-utils`。装后 bundle 的 patch 自动插六行，不手写挂载块；`config:` 只管配置。挂载项新增/改名要重启宿主。

## 配置覆盖

覆盖写在 profile 的 `cordis.patch.yml`，只写 `id` 与 `config`，`name` 交给 bundle：

```yaml
- id: utils-agents
  config:
    maxDepth: 6
    extraRoots:
      - D:/Core/Projects/Skill
- id: dsh-approval-policy
  config:
    windowSeconds: 300
- id: dsh-notify
  config:
    gotifyUrl: 'https://notify.example.com'
    # 只写密钥：显式填写，设置页可改但永不回显；不做环境变量插值
    gotifyToken: 'gtfya.该系列的token'
    dryRun: false
```

各字段与默认值见下面各组件的配置表。`utils-ui` 没有 config，只是浏览器半侧的挂载行。三个宿主行的字段全部 volatile：在插件页保存即生效，改 `cordis.patch.yml` 则需要重启。

## 发布

七个包同版本、按依赖顺序发布：六个组件在前，bundle 在后。`scripts/release.mjs` 先 `npm view` 探一遍，版本已在 registry 上就跳过（重复跑安全、失败可续）；任一包版本与根包不一致会直接报错退出。

推 GitHub 与发 npm 合成一次操作——打 tag 触发 [`publish.yml`](.github/workflows/publish.yml)：

```sh
git push                                                   # 先推代码
git tag v$(node -p "require('./package.json').version")     # 打 tag：版本号取根包 version
git push origin --follow-tags                              # 再推 tag，CI 里 build + 发布全部七个包
```

tag 必须等于根包 `package.json` 的版本，否则 job 直接失败。CI 里 `pnpm release` 按依赖顺序发七个包，带 `--provenance`。

一次性准备：npm 建一个 Automation token，存成仓库 secret `NPM_TOKEN`。scope 是公开的 `@xi4z`，token 所属账号要能用这个 scope（scope 通常是 npm 用户名或已创建的组织）。

手动发（本机 `npm login` 后，脚本逻辑与 CI 相同）：

```sh
pnpm build
pnpm release             # 按顺序发组件与 bundle；已发布版本跳过
pnpm release --dry-run   # 只看会不会发，不动 registry
```

改了任何组件都要把七个 `package.json` 的版本一起提到同一个值，再打 tag。

## 组件一：utils-agents

### 嵌套技能发现

技能根下第 1 层的扁平技能由 DSH 内置提供方处理；本组件补第 2 层及更深的技能包：

```
.dsh/skills/
├── flat-skill/SKILL.md            ← 内置提供方
└── obsidian-skills/               ← 容器目录
    ├── defuddle/SKILL.md          ← 本组件
    └── json-canvas/SKILL.md       ← 本组件
```

扫描根按优先级：项目最近的 `.git` 下的 `.dsh/skills`、`.agents/skills`；`extraRoots`；`$DSH_HOME/skills`；`$DSH_AGENTS_HOME/skills`（两个 home 默认是 `~/.dsh` 与 `~/.agents`）；最后是 `$DSH_HOME/utils/utils.json` 里配置的 Skill 仓库（从仓库根开始，见下）。同名技能以 rank 小者为准，扁平技能优先（嵌套候选 rank 低一档）。

| 字段 | 默认 | 含义 |
|---|---|---|
| `minDepth` | `2` | 技能第一个目录层级（相对技能根） |
| `maxDepth` | `8` | 最深扫描层级 |
| `watch` | `true` | 监听技能根，变化刷新目录 |
| `debounceMs` | `200` | 监听失效防抖 |
| `pollIntervalMs` | `2000` | 不支持递归监听时的轮询间隔 |
| `includeProjectRoots` | `true` | 扫项目级技能根 |
| `includeUserRoots` | `true` | 扫用户级技能根 |
| `includeSkillRepositories` | `true` | 把 `utils.json` 配置的 Skill 仓库作为扫描根 |
| `followSymlinks` | `false` | 跟随符号链接目录（带环路保护） |
| `extraRoots` | `[]` | 追加技能根，绝对路径 |
| `ignoreDirs` | `[".system","node_modules",".git"]` | 永不进入的目录名 |

识别的 frontmatter 字段：`name`、`description`，可选 `whenToUse`、`disable-model-invocation`、`user-invocable`。非法文件记 warning，跳过。

#### 配置的 Skill 仓库：从仓库根递归 + 定时更新

`$DSH_HOME/utils/utils.json` 是 utils 的配置文件；面板「共享技能仓库」保存的就是这一份（首次读取时若文件不存在，会自动从旧的 `$DSH_HOME/storages/dsh-utils-ui.json` 迁移，旧文件保留不删；迁移不到仓库、或旧文件本身就是空配置 `{}` 时，会写入默认配置并继续使用，见下面的「默认配置」）：

```json
{
  "version": 1,
  "skillRepositories": [
    {
      "repoUrl": "git@github.com:xi4z/skills.git",
      "branch": "Agent",
      "targetDir": "/root/core/projects/skills-agent",
      "keyPath": "",
      "recurseSubmodules": true,
      "lastSync": { "at": "2026-11-22T10:00:00.000Z", "ok": true, "commit": "…", "skills": 96, "message": "已快进到最新提交" }
    }
  ],
  "autoUpdate": true,
  "autoSyncPresets": true,
  "updateIntervalMinutes": 60
}
```

- **默认配置**：文件不存在又迁移不到仓库、或旧文件本身是空配置（`{}`、`{"version":1}`，没有任何仓库和设置）时，第一次读取会把它写成默认配置——`skillRepositories` 里放一个默认共享仓库（`https://github.com/xi4z/skills`、`Agent`、`$DSH_HOME/skills/utils-skill`），`autoUpdate`/`autoSyncPresets` 为 `true`、`updateIntervalMinutes` 为 `60`。**升级前配置为空的老 profile 因此会直接变成默认配置**；已经写了任何配置（仓库或 `autoUpdate` 等设置）的文件读取时原样保留，坏掉的 JSON 只按默认值读取、不覆盖，方便手工修复。想保持空仓库列表，写一条显式设置即可（例如 `"autoUpdate": false`）。
- 每个 `targetDir` 都是一个发现根：从**仓库根**（depth 0）开始递归，仓库根自己的 `SKILL.md` 和任意深度的技能包都会进目录，不受 `minDepth` 限制；`maxDepth` 仍然生效，`ignoreDirs` 照旧跳过。
- 配置仓库的 rank 是 90，优先于项目级/用户级技能根；同一文件同时通过软链接（如 `~/.dsh/skills -> <checkout>`）被两个根看到时，按真实路径去重，只保留 rank 更小的那份。
- 定时更新：激活 5 分钟后第一次，之后每隔 `updateIntervalMinutes`（默认 60，可设 5–1440）执行 clone 或 `fetch` + `merge --ff-only`，再 `submodule sync --recursive` + `submodule update --init --recursive`；只有提交或子模块真的变了才刷新技能目录。
- 预设同步：**仓库是唯一事实来源**。`autoSyncPresets`（默认 `true`）为真时，每次定时更新后对**列表里每个仓库**执行：
  - `new` / `update`：复制到 `$DSH_HOME/.agent-presets/<id>/` 并立即注册成宿主预设，`same` 不重写；
  - 仓库里已删除、且本机存在同一预设（`shared-presets.json` 清单记录过，或内容本来就一致而被自动登记）的：删除本机 `<id>` 目录并注销；
  - **DSH 自带预设（`builtinPresets`，默认 `standard`/`ptc`/`minimal`/`creator`）豁免**，不同步、不删除；本机自己新建、清单里没有的预设也不会被删；checkout 缺失或不可读时不做任何删除。
  - 只处理 `utils.json` 里列出的 Skill 仓库，`presetSourceDirs` 等额外来源仍走面板「预设同步」手动同步；**自动方向永远不会写仓库或 push**，增删预设请在仓库里改完推送。
- 自动更新不碰脏工作区：`git status --porcelain` 有输出就跳过（面板手动「拉取」仍会失败并给出原因）；所有失败只记 warning，不 reset、不 force、不 push。
- `autoUpdate` / `autoSyncPresets` 两个开关互相独立，分别关掉「拉仓库」和「同步预设」，面板的「拉取」「同步」「发布预设」按钮仍可用。

### 模型可见性

配置页的「技能」开关列出当前会话能读到的 Skill：关掉 = 在 `ctx.skills.snapshot()` / `list()` 里把该技能标成 `modelInvocable: false`，模型下一轮拿到的 `<available_skills>` 里不再出现，手动 `/名称` 仍可加载。只能手动调用的技能显示「仅手动」，开关禁用。

技能列表过长时默认折叠（超过 8 个），标题栏显示「共 N 个 · 模型可见 M」与「展开（N）」，展开后才能逐个开关；技能较少时自动展开。折叠只影响显示，不改任何开关。

数据来源：`GET /api/dsh-utils/skill-panel/list`（Connection owner 认证）；带 `sessionId` 时用该会话的 cwd 与 preset skill 层，不带时用宿主默认工作目录。持久化在 `utils-agents` 命名空间的 `disabledSkills`（volatile，保存即生效）。这里只影响模型可见性，不改预设目录里的 `SKILL.md`；按预设开关技能在右侧栏面板的「技能」视图（重命名 `SKILL.md` / `SKILL.md.disabled`）。

### 面板：预设、技能仓库与 AGENTS.md

顶部选择预设（或「全局 / 项目 AGENTS.md」），下面四个视图：

| 视图 | 作用 |
|---|---|
| 技能 | 列出 `<preset>/skills/` 下的 `SKILL.md` / `SKILL.md.disabled`，显示名称、描述、路径；开关直接重命名文件；「编辑 SKILL.md」跳到 Markdown 视图 |
| Markdown | 列出该预设的 `AGENTS.md`（缺失也列出，保存即创建）以及全部 `.md` / `.md.disabled`；带草稿、还原、重读、`Ctrl/Cmd+S` |
| 技能仓库 | 仓库地址、分支、`skills/` 下的目标子目录、密钥路径、Deploy Key、递归子模块；保存设置与「同步（拉取）」 |
| 预设同步 | 配置共享技能仓库（仓库地址、分支、检出目录、Deploy Key）并 clone/快进私有仓库；读取其 `.dsh/preset` 下的共享预设，逐条或全部复制到 `$DSH_HOME/.agent-presets/`；导入非内置原生预设，并发布目录预设到共享仓库、提交推送 |

目录预设注册：宿主启动、首次打开面板或点「刷新」时，把每个含 `agent.cordis.yml` 的目录注册成真正的 agent preset（声明一个 `cordis:include` 行）。注册成功后 DSH 的预设选择器就能选到它；加载失败会在面板列出 `broken` 诊断。新增目录不必重启，面板「刷新」即补注册。

预设来自 `$DSH_HOME/.agent-presets/<id>/`、`$DSH_AGENTS_HOME/.agent-presets/<id>/` 与 `presetDirs`，顶部显示 `preset.yml` 的 name/description。「全局 / 项目」视图列出 `$DSH_HOME/AGENTS.md`、`$DSH_AGENTS_HOME/AGENTS.md`，以及项目根到当前目录的 `AGENTS.md` / `CLAUDE.md`（含 `.local` 变体）链；`scanNestedAgents` 再向下递归。全局/项目 AGENTS.md 由 `dsh-agent-instructions` 读取。

#### 技能仓库同步

仓库同步只拉取：

- 目标 `<preset>/skills/<targetSubdir>` 不存在：`git clone --depth 1 --branch <branch> --single-branch`；
- 已存在：必须是同一仓库的 checkout、当前分支等于配置分支；`fetch` + `merge --ff-only`，浅克隆首次同步会 `--unshallow`；
- 子模块可选：`git submodule sync --recursive` + `update --init --recursive`，失败只记 warning；
- 不 reset、不 force、不推送。

Deploy Key 按预设保存到 `$DSH_HOME/storages/dsh-utils-agents/<preset>.key`（600），接口不回显；也可以填「密钥路径」指向已有私钥。公开 `https://` / `file://` 可免密钥。

#### 私有仓库与通用 Deploy Key

面板底部固定有一栏**通用 Deploy Key**：粘贴一个 OpenSSH 私钥并保存，之后所有由这个面板发起的 clone / fetch，在缺少更具体的密钥时都会使用它。查找顺序：

1. 该仓库自己配置的「密钥路径」；
2. 该仓库保存的 Deploy Key（技能仓库按预设、预设同步按共享仓库）；
3. 面板底部的通用 Deploy Key。

私钥写入 `$DSH_HOME/storages/dsh-utils-agents/deploy-key`（600），接口只回 `source`，从不回显内容；清空输入再点「保存/清除」即删除。HTTPS 地址在存在密钥时改写为 `git@<host>:<path>.git`；SSH 地址（`git@host:path`）直接用它。拉取仍然只读：clone 或 `fetch` + `merge --ff-only`，不 reset、不 push。

#### 共享预设同步（`.dsh`）

跟踪技能的 Git 仓库可以顺带携带预设：仓库根下的 `.dsh/preset` 目录被当作只读来源，面板把其中的预设目录复制到本机 `$DSH_HOME/.agent-presets/<id>/`，同步完立即注册成真正的 agent preset。支持的布局：

```text
<repo>/.dsh/preset/<id>/           # 推荐：一个仓库携带多个预设
<repo>/.dsh/preset/                # 目录本身就是一个预设（preset.yml / agent.cordis.yml 直接放在这里）
<repo>/.dsh/presets/<id>/          # 别名
<repo>/.dsh/.agent-presets/<id>/   # 别名，镜像 $DSH_HOME 结构
<repo>/.dsh/<id>/                  # 目录内需有 preset.yml 或 agent.cordis.yml
```

预设目录必须带 `preset.yml` 或 `agent.cordis.yml`；单个预设目录形式的 id 取 `preset.yml` 的 `id`，没有就取目录名。

扫描来源：当前选中预设同步出来的技能仓库 checkout（`<preset>/skills/<targetSubdir>`）、共享技能仓库的 checkout（`$DSH_HOME/utils/utils.json` 的 `skillRepositories[0].targetDir`，默认 `$DSH_HOME/skills/utils-skill`）、`$DSH_HOME/skills` 及其带 `.dsh` 的一级子目录，以及配置项 `presetSourceDirs` 里列出的额外仓库，按真实路径去重。仓库本身不会被修改。

共享技能仓库在面板里直接配置：仓库地址、分支、检出目录、可选密钥路径、Deploy Key 私钥；点「拉取」做 clone 或 `fetch` + `merge --ff-only`（浅克隆先 `--unshallow`，子模块可选），完成后 `.dsh/preset` 自动出现在下面的来源列表。检出目录就是**仓库根目录**，可以是任意绝对路径（如 `~/core/projects/skills`、`~/.dsh/skills-src/skills`），不必叫 `.dsh`，也不需要指向 `~/.dsh`；预设固定从 `<检出目录>/.dsh/preset` 读取。

存储：

- 设置：`$DSH_HOME/utils/utils.json`（`skillRepositories[]` 里的 `repoUrl` / `branch` / `targetDir` / `keyPath` / `recurseSubmodules` / `lastSync`，以及 `autoUpdate` / `autoSyncPresets` / `updateIntervalMinutes`）
- 迁移：`$DSH_HOME/utils/utils.json` 不存在时读取一次旧的 `$DSH_HOME/storages/dsh-utils-ui.json` 并写回新文件；旧文件保留。旧文件里没有仓库、或旧配置本身为空时，写回的是默认配置（默认共享仓库 + 默认开关）
- Deploy Key：`$DSH_HOME/storages/dsh-utils-ui.deploy-key`（600，不返回浏览器；密钥不是配置，仍留在 `storages`）
- 通用 Deploy Key：`$DSH_HOME/storages/dsh-utils-agents/deploy-key`（600，不返回浏览器）
- 密钥优先级：`keyPath` 指向的私钥 > 该仓库保存的 Deploy Key > 通用 Deploy Key > 无；公开 `https://` / `file://` 可免密钥

同步规则：

- 逐文件写临时文件再 rename；内容相同则跳过，按源文件保留可执行位；跳过符号链接与 `.git` / `node_modules` 等忽略目录；单文件上限 8 MiB；
- 「删除源中已移除的文件」只删**上一次同步清单里记录过、这次源里已消失**的文件，本机自己加的文件和预设里的 `.dsh-utils/repo.json` 不会被删；
- 同步清单在 `$DSH_HOME/storages/dsh-utils-agents/shared-presets.json`（600），用于显示「已接管」与上次同步时间；
- 状态：`new`（本地没有）、`update`（文件内容不同）、`same`（已一致）、`invalid`（id 不合法，拒绝同步）。

#### 原生预设接管与发布

DSH 的预设除了目录版，还可能来自 Cordis 声明（随包内置的 `standard` / `ptc`，或 `dsh-butler-preset` 这类 bundle）。面板的「原生预设接管」会列出注册表里的全部声明：

- `builtinPresets`（默认 `standard`、`ptc`、`minimal`、`creator`）保留原生，不导入；
- 其余声明若是「可导入」，点「导入到本地预设」后调用注册表的 `readDocument(id)`，把组合 YAML 写成 `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`，并把 name/description 写进 `preset.yml`（已存在的目录默认跳过，避免覆盖本地修改）；
- 导入后立即注册；不会删除/停用任何原生声明。

「发布非内置预设」把本机所有非内置目录预设复制到共享仓库的 `.dsh/preset/<id>/`，然后：

- 只 `git add` / `git commit` 路径 `.dsh/preset`，不碰仓库里的其他改动；
- 勾选推送时执行 `git push origin HEAD:<分支>`，分支必须等于共享仓库配置里的分支；
- 共享仓库必须是已拉取的 Git checkout；提交信息可自定义，默认 `presets: sync from dsh-utils`。

#### 版本检查

面板顶部显示当前 bundle 版本、安装来源徽标（npm / GitHub / 本地）和「检查更新」按钮。宿主按 `updateCheckIntervalHours`（默认 6 小时）在后台检查，激活后约 15 秒先查一次；远端比当前版本新时，按钮旁出现「有新版本 x.y.z」。

查哪里取决于 profile 里 `@xi4z/dsh-utils` 的安装方式（读 profile 的 `package.json`）：

| 安装方式 | 检查目标 |
|---|---|
| registry spec（`^0.4.0`、`latest` 等） | `<registry>/@xi4z%2Fdsh-utils/latest`（默认 `https://registry.npmjs.org`） |
| GitHub spec（`github:owner/repo`、`owner/repo`、`git+https://…#ref`、`git@github.com:owner/repo`） | `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/package.json`；`ref` 取 `#` 后的分支/tag/sha（默认 `HEAD`），公开仓库免 token |
| `link:` / `file:` / 读不到 profile 清单 | 没有远端可比，标为「本地」，仍对比 npm `latest` 作参考 |

**自动安装**（`updateAutoInstall`，默认开）：查到更新且安装方式可更新时，后台在 profile 目录执行：

- registry 安装 → `pnpm add @xi4z/dsh-utils@<version> --save-exact`；
- GitHub 安装 → `pnpm add <profile 里的 spec>`（分支/标签会重新解析到该 ref 的最新提交）；
- 固定 40 位 commit 的 Git spec、`link:`、`file:` 一律跳过（没有可移动的远端）。

安装失败会回滚 `package.json` 与 `pnpm-lock.yaml` 并显示原因；同一版本只自动装一次。装完必须重启 `dsh web` 才生效——面板显示「已自动更新到 x.y.z（重启 dsh web 生效）」，安装中每 3 秒刷新一次状态。

- 每次只请求一个 URL，8 秒超时；失败不重试、不弹窗，只把错误写进面板并保留上一次读到的版本。
- 结果缓存到 `$DSH_HOME/storages/dsh-utils-agents/update.json`（600）：重启后先显示缓存，首次检查完成再覆盖。
- 「检查更新」按钮立即查询；与后台检查撞车时复用同一个请求。
- `updateCheck: false` 只关掉后台检查（按钮仍然可用）。
- 私有 GitHub 仓库读不到（HTTP 404）时显示「检查失败」，需要手动更新。

### 路由

全部走 Connection owner 认证：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/dsh-utils/utils-agents/list` | 预设列表、技能、AGENTS.md 元数据、全局文件；带 `sessionId` 时用该会话 cwd |
| `GET` | `/api/dsh-utils/utils-agents/files?presetId=…` | 一个预设或全局目标的 Markdown 文件 |
| `GET / POST` | `/api/dsh-utils/utils-agents/file` | 读文件；POST `{id, content, baseMtimeMs, sessionId?}` 原子写入 |
| `POST` | `/api/dsh-utils/utils-agents/skill` | `{presetId, path, enabled}`，重命名 SKILL.md |
| `GET / POST` | `/api/dsh-utils/utils-agents/repo` | 读/存每个预设的仓库设置 |
| `POST` | `/api/dsh-utils/utils-agents/key` | `{presetId, key}`，保存或清除 Deploy Key |
| `POST` | `/api/dsh-utils/utils-agents/sync` | `{presetId}`，clone 或快进 |
| `GET` | `/api/dsh-utils/utils-agents/shared?presetId=…` | 扫描技能仓库 `.dsh` 下的共享预设及同步状态 |
| `POST` | `/api/dsh-utils/utils-agents/shared-sync` | `{presetId, ids?, prune?}`，把共享预设复制到本机预设目录 |
| `GET / POST` | `/api/dsh-utils/utils-agents/shared-repo` | 读/存共享技能仓库设置 |
| `POST` | `/api/dsh-utils/utils-agents/shared-key` | `{key}`，保存或清除共享仓库 Deploy Key |
| `POST` | `/api/dsh-utils/utils-agents/shared-pull` | 用配置的 Deploy Key（或通用 Deploy Key）clone 或快进共享技能仓库 |
| `GET / POST` | `/api/dsh-utils/utils-agents/deploy-key` | 读/存面板通用的 Deploy Key；只回 `source`，不回显内容 |
| `GET / POST` | `/api/dsh-utils/utils-agents/update` | 读缓存/立即检查远端版本（npm 或 GitHub，按安装方式） |
| `GET` | `/api/dsh-utils/utils-agents/native-presets` | 列出注册表里的预设及内置 / 已是目录预设 / 可导入状态 |
| `POST` | `/api/dsh-utils/utils-agents/native-presets-import` | `{ids?, force?}`，把非内置声明导出为目录预设 |
| `POST` | `/api/dsh-utils/utils-agents/presets-publish` | `{ids?, message?, push?}`，发布到共享仓库并提交/推送 |
| `GET` | `/api/dsh-utils/skill-panel/list` | 模型可见性开关的 Skill 列表（带 `sessionId` 时用该会话） |

### 配置

全 volatile，保存即生效：

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
| `updateCheck` | `true` | 后台定时检查发布版本 |
| `updateCheckIntervalHours` | `6` | 两次自动检查之间的小时数（1–168） |
| `updateRegistry` | `https://registry.npmjs.org` | 查询发布版本用的 registry，可换镜像 |
| `updateAutoInstall` | `true` | 查到新版本就后台执行 `pnpm add` 自动安装（重启后生效） |

技能发现字段见上面的表；`disabledSkills` 见「模型可见性」。宿主半侧在 `packages/utils-agents/src/`（`index.ts` 路由、`presets.ts` 预设/技能/文件、`git.ts` 预设仓库同步、`global-repo.ts` 共享仓库与定时刷新、`utils-config.ts` 配置读写、`skill-repo-updater.ts` 定时器、`skill-discovery.ts` 递归发现、`update.ts` 发布版本检查），浏览器半侧在 `@xi4z/dsh-utils-ui` 的 `client.js`。停用 `utils-agents` 行后路由消失，侧边栏面板显示 404 提示。

## 组件二：无人值守审批门控

挂宿主 `'approval/request'` waterfall 链首（`prepend`）。判定无人值守的请求先 `next()` 给下游：窗口内有人答，用人的答案；窗口耗尽，按 fail-closed 默认值落定，turn 立即结束，不长期挂起。**请求一旦落定就撤回仍未回答的提示**，不管是谁落定的：门控把自己的 controller 融进请求的 signal，窗口到期、下游（网页/ACP/自动审批）作答、或外部人类渠道通过 `approvalPolicyInfo.withdraw(request, outcome)` 报回答案时都会 abort，宿主随即取消那条转发的 Remote 请求，网页审批卡片和侧栏「等待审批」标记一起消失，不会堆成一片已经决定过的旧卡片。交互会话不改变。

| 字段 | 默认 | 含义 |
|---|---|---|
| `origins` | `[subagent, scheduled]` | 无人值守来源：`subagent` / `scheduled` / `cron` / `interactive` / `all`；`interactive` = 人类驱动的 turn 也进窗口（会话进行中的审批） |
| `sessions` | `[]` | 按 agent id 的 glob 点名会话，命中即门控该会话所有 turn |
| `windowSeconds` | `60` | 应答窗口（秒）；`0` = 立即拒绝，不询问下游 |
| `defaultOutcome` | `rejected` | 窗口到期落定值：`rejected` 或 `unavailable`。没有 `allowed-once` |
| `defaultPermissionPreset` | `''` | 新会话权限档；`auto` 走实验性自动审批（要对应 bundle） |
| `autoReviewContent` | `true` | 窗口拒绝自动审批的请求时，把复核内容附进模型读到的工具结果 |

判定粒度：`sessions` 命中与 `all` 是会话级。`subagent` 看 `session.header.origin`。`scheduled` / `cron` 看最后一条带溯源 user 消息的 `source.kind`。合成注入（`runtime-context`、`skill-catalog`）跳过；默认人插过话就不门控。`interactive` 是机器来源的补集：最后一条溯源消息是 `user` / `user-question-reply` 且不是 subagent 时也门控——即**会话进行中的审批**同样有截止时间；它不覆盖未知溯源（那仍然只有 `all` 覆盖），可与机器来源组合（`[subagent, scheduled, interactive]` ≈ 除 cron 外全覆盖）。审计由宿主 `approval/asked` + `approval/decided` 写会话日志；本组件不写日志、不落盘。

## 组件三：QQ 审批卡片

把 dsh 的 `approval/request` 桥到 QQ：一个待审批请求，除了网页卡片，还会在 QQ 里出现一张带「允许一次／拒绝」按钮的 markdown 卡片。点按钮即回答审批；不点则按无人值守门控的窗口自动拒绝。

边界很清楚：

| 谁 | 负责 |
|---|---|
| 本组件（DSH 内） | 是否镜像、卡片文案、与网页竞速、把按钮点击落回 waterfall |
| relay（`gotify-qq-relay`） | 发卡、收 `INTERACTION_CREATE`、3 秒内 ack、存点击、点击后发被动回执 |
| 无人值守门控（`approval-policy`） | 唯一期限：`windowSeconds`。本组件通过 `approvalPolicyInfo` 服务读它，不自己设 TTL |

### 时序

```text
审批挂起
  └─ 本组件 prepend 监听 approval/request
       ├─ 立刻 next()：网页卡片照常弹，门控窗口开始计时
       ├─ 防抖 sendDelayMs：期间自动裁决/网页抢答 → 不出卡
       └─ 出卡（正文含「N 秒内未处理将自动拒绝」）
            ├─ 网页先答 / 门控到期 → POST settle ignored（静默关闭）
            └─ 点击 → relay ack(0) → 长轮询取到 clicked
                 → 调 approvalPolicyInfo.withdraw(request, 结果) 关掉网页那张卡
                 → 回填 allowed-once / rejected → POST settle（默认静默，不发回执）
```

门控到期时，本组件看到的是一次**撤回**（abort 原因 `UnattendedApprovalWindowExpired`）：卡片照旧静默关闭（settle `ignored`，原因 `auto-rejected`），但回给宿主的是门控自己的 fail-closed 结果——不会把这次「拒绝」记成 `cancelled`，模型读到的仍是拒绝。反向同理：网页先答时门控会以 `UnattendedApprovalSettledElsewhere` 撤回，本组件把卡片 settle 成 `answered-elsewhere` 并回填对方的结果。

### 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关；关闭时完全不碰 waterfall |
| `relayUrl` | `''` | relay 审批基地址，以 `/approval` 结尾，如 `https://notify.xiaz.work/_qq/approval` |
| `sharedKey` | `''` | relay 侧鉴权：relay 没配 `approval.key` 时复用它的 `gotify.clientToken`，这里填同一把；**只写密钥**，显式填写，不回显、不插值 |
| `deviceLabel` | 主机名 | 卡片上的设备名 |
| `sendDelayMs` | `1200` | 发卡防抖；自动裁决落在此窗口内就不打扰 |
| `pollWaitSeconds` | `25` | 长轮询窗口；点击到恢复通常 <1s |
| `timeoutMs` | `10000` | 单次 relay HTTP 超时 |
| `includeSubagents` | `true` | 是否也镜像子代理会话的审批 |
| `dryRun` | `false` | 只记日志不发卡 |
| `allowReceipt` / `denyReceipt` | `''` | 点击后的被动回执文案；**默认空 = 不发回调**，点完只 ack，不推消息 |
| `translateEnglish` | `true` | 英文审批原因（多见于自动审批升级）先经宿主模型翻成中文再出卡 |
| `translateTimeoutMs` | `4000` | 翻译预算；超时/失败保留英文原文，不阻塞审批 |
| `translateProvider` / `translateModel` | `''` | 翻译用的模型路由；留空 = 宿主的 `agentDefaultModel` 当前选择 |

没有 TTL 字段：卡片上的倒计时来自 `approval-policy.windowSeconds`。把门控窗口调大，卡片上的数字会跟着变；`approval-policy` 未安装时没有倒计时，卡片一直有效到被回答或会话中断。

英文原因的处理：自动审批的 `reason` 常常是英文（`Auto review denied tool ...`）。出卡前会做一次纯文本、无工具的一次性模型调用（`ctx.llm`）翻成中文，保留工具名、命令、路径不译；模型不可用、超时或返回不含中文时**保留英文原文**继续出卡。翻译结果按原文缓存（最多 100 条），不会每次重复调用。

### relay 侧

`config.json` 增加一段（**不用再建单独密钥**）：

```json
{
  "approval": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8787,
    "route": "1"
  }
}
```

- 鉴权复用 relay 顶层已有的 `gotify.clientToken`：DSH 的 `sharedKey` 填同一把即可。
  `approval.key` 仍可作为显式覆盖。

- `route` 指向发卡的私聊系列（默认 `1`）；审批卡片只支持单聊。
- relay 会额外连一条 QQ 机器人 WebSocket（只订阅 `INTERACTION`），与现有 Gotify 单向投递并行；同一 shard 只能有一个连接，所以不要再起第二个 relay 实例。
- 端点：`POST /approval`、`GET /approval/{askId}?wait=N`、`POST /approval/{askId}/settle`、`GET /healthz`；鉴权头 `X-Approval-Key` 或 `X-Gotify-Key`（同一把 token）。

openresty 反代一条受保护路径：

```nginx
location ^~ /_qq/approval {
    limit_req zone=qqapproval burst=10 nodelay;
    proxy_pass http://127.0.0.1:8787;
    proxy_read_timeout 35s;   # 长轮询 25s + 余量
    client_max_body_size 8k;
}
```

点击后默认**不回任何消息**：relay 只 ack、关单，按钮停止 loading。若显式配了 `allowReceipt` / `denyReceipt`，才用事件被动回复（`event_id = INTERACTION_CREATE:<id>`，不消耗主动消息额度）发一条回执。自动拒绝/网页抢先的卡片静默关闭，之后再点按钮只会被 ack、不会再生效。

## 组件四：会话通知

每轮跑完，或 agent 挂起在「等你回答 / 等你授权」，推一条消息到指定出口。出口默认**公网 Gotify 网关**。插件不持 Bot 凭据、不建 WebSocket、不加依赖，只发一个 HTTP POST。任何能上网的设备（笔记本、服务器、云主机）装同一份 bundle、填网关地址和 token 就能发。每条消息带**发送设备名**（默认主机名），多台机器共用一个 QQ 也能分清。

### 接线

```
session/event  →  记录这一轮的结束原因 + 最后一条 assistant 文本
tool/call      →  ask_user_question / exit_plan_mode = 挂起等人
approval/asked →  挂起等授权
agent/status   →  running → idle 的边沿 = 整个任务结束
                ↓
       渲染中文摘要（含设备名）→ POST {gotifyUrl}/message → relay → QQ
```

### 事件来源：只读会话日志

| 通知类型 | 日志信号 | 去抖 |
|---|---|---|
| 会话完成/出错/中止/阻塞 | `turn/end` 的 `reason.kind` | 无 |
| 等待你回答 | `tool/call`，`name` 为 `ask_user_question` / `exit_plan_mode` | `questionDelayMs`（默认 2500），`tool/result` 到达取消 |
| 需要授权 | `approval/asked` | `approvalDelayMs`（默认 3000），`approval/decided` 到达取消 |

在去抖窗口内界面答了，或策略自动裁决了，就不打扰。

### 配置

`cordis.patch.yml` 的 `config`，或插件页设置。字段全 volatile：改完即生效，不重启。`gotifyToken` 是**只写密钥**：设置页可以修改，但永不回显，也按字面量使用（不做 `${ENV}` 插值、不读环境变量）。

| 字段 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | — | `true` | 总开关 |
| `transport` | — | `gotify` | `gotify` = 公网网关；`onebot` = 直连 NapCat 的兼容出口 |
| `deviceName` | `DSH_QQ_NOTIFY_DEVICE` | 主机名 | 设备唯一名，多设备区分基础 |
| `deviceLabel` | `DSH_QQ_NOTIFY_DEVICE_LABEL` | 同 `deviceName` | 给人看的名字，用于 `{device}` 与标题前缀 |
| `deviceInTitle` | — | `false` | `true` 时 Gotify 标题加 `[设备名]` 前缀 |
| `gotifyUrl` | `DSH_QQ_NOTIFY_GOTIFY_URL` | `''` | 网关地址，如 `https://notify.example.com` |
| `gotifyToken` | — | `''` | 该系列的 Gotify application token；**只写密钥**，显式填写，不回显、不插值；设置页只显示是否已存在（留空保存保持不变）；全角标点/前缀大小写/漏点会自动纠正 |
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
| `dryRun` | — | `true` | 默认开：只打日志不发消息。确认配置再关 |
| `traceFile` | — | `''` | 可选 JSONL 诊断轨迹（排障），空则不记 |

`transport: onebot` 时才读 `endpoint`（默认 `http://127.0.0.1:3000`）、`token`、`targetType`（`private` / `group`）、`targetId`，对应 `DSH_QQ_NOTIFY_URL`、`DSH_QQ_NOTIFY_TOKEN`、`DSH_QQ_NOTIFY_TARGET_TYPE`、`DSH_QQ_NOTIFY_TARGET_ID`。

### 密钥：显式配置、只写不回显

`gotifyToken` 声明为 schemastery 的 `role('secret')`：DSH 设置接口在把配置发给浏览器前会剥掉实际值，只留下「是否已设置」；设置页因此不回显 token，只显示「当前已存在密钥 / 当前未设置密钥」，输入框留空保存会保持现有密钥，填入新值才替换。空字符串在 schema 层归一为「未设置」，所以这个状态不会因为默认空值而误报。运行时组件仍从 live config 读到真实值，配置写在 profile 的 `cordis.patch.yml` 或插件页里均可，且按字面量使用。

`gotifyToken`（以及 `targets[].token`）在投递前会做一次**兜底**：去掉首尾空白、零宽字符和包裹引号，全角 ASCII 和中文标点转半角（`。`→`.`），`gtfya` / `gtfyc` 前缀转小写并补上漏掉的分隔点。修完仍有非 ASCII 字符的目标直接跳过并记 warning，不再让 `fetch` 在构造请求头时抛 `Cannot convert argument to a ByteString`。

> token 只能从 Gotify 创建 application 时显示的那一次复制。`gotify.db` 的 `applications.token` 列存的是摘要而不是可用凭据，从数据库/备份里抄出来的值一律 401。

其余字符串字段仍支持 `${NAME}` / `${NAME:-默认值}` 插值：`gotifyUrl`、`endpoint`、`token`、`targetId`、`gotifyHeaders` 的值，`targets[]` 的 `url` / `token`。

变量未设或为空，展开成空串。该目标缺 token 就跳过，记 warning。**不发字面量** `${...}`。插值在每次投递前解析，密钥不进日志。

```yaml
- id: dsh-notify
  config:
    gotifyUrl: '${DSH_GOTIFY_URL}'
    gotifyToken: 'gtfya.该系列的token'   # 只写密钥：必须是字面量
    targets:
      - name: qq-home
        urlEnv: DSH_GOTIFY_URL
        tokenEnv: DSH_GOTIFY_TOKEN
```

`targets[]` 也支持 `urlEnv` / `tokenEnv`：直接写变量名，优先于字面量字段。对象级的环境覆盖仍可用 `DSH_QQ_NOTIFY_GOTIFY_URL`、`DSH_QQ_NOTIFY_TARGETS` 等；`DSH_QQ_NOTIFY_GOTIFY_TOKEN` 已移除——`gotifyToken` 只认显式字面量。`targets[].token` 位于 JSON 数组内，无法标记 secret，需要保密时用 `tokenEnv`。

### 多设备：都能发，也能分清是谁

公网网关对任何来源 IP 开放（按 token/IP 限流）。其他设备不用部署 relay，不用 NapCat，不用开本机端口。

1. **设备身份**：`deviceName` 留空自动取 `os.hostname()`。建议设 `deviceLabel`（办公本、家里的服务器），渲染进 `{device}`。
2. **各自一套 token**：Gotify 里给每台设备建一个 application（一个「系列」）。`gotifyToken` 写在每台设备自己的 profile `cordis.patch.yml`（或插件页）里，别每台共用一把：

   ```yaml
   - id: dsh-notify
     config:
       deviceName: 'laptop-01'
       deviceLabel: '随身本'
       gotifyToken: 'gtfya.该设备的token'
   ```

   系列不同，relay 侧就可以把不同系列路由到不同 QQ 收件人。需要环境变量时改用 `targets[].tokenEnv`。

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

   配 `targets` 后不读 `gotifyUrl` / `gotifyToken`；`gotifyPriority` 仍作为未单独指定优先级的回退值。每目标可单设 `priority`。一条事件并发发所有命中目标，一个失败不影响其他。

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

## 组件五：反向代理入口

`dsh-remote` 在本机回环端口起一个反向代理，把「自备隧道」接进来的请求转给 DSH Web：

```
浏览器 → 你的隧道（TLS + 你自己的鉴权） → 127.0.0.1:3079 → 127.0.0.1:<webServer.port>
```

它不提供隧道，也不取代你的鉴权；它只负责让 DSH 认这笔请求。

**对外端口固定，上游端口每次启动重新解析。** Desktop 的 Host 默认由操作系统分配端口（`apps/desktop`：listen on an OS-assigned port，避免和 `dsh web` 的 3080 撞车），只有打 `webserver.config.port` 补丁才会固定。所以代理自己始终监听配置里的 `listenPort`（默认 3079），而 `webServer.port` 在**每个请求**上重新读取：宿主重启换了端口，隧道侧不用改，代理也不会指着一个死端口。

### 为什么不能把隧道直接指向 3080

DSH Web 有三道门，任意一道都会把远端挡在外面：

| 门 | 远端看到的现象 |
|---|---|
| 只监听回环（`--host 0.0.0.0` 被硬拒绝） | 隧道必须转发到 `127.0.0.1` |
| `/api` 的 Host/Origin 栅栏 | 公网 Host 一律 403；只把 Host 改回回环、Origin 仍是公网，也是 403 |
| 每个 RPC 都要 `dsh-auth-*` cookie，签名绑定 authority | 远端没有 cookie；`?token=` 是进程启动时随机生成、只在宿主本地可见 |

代理因此只做三件事：把 `Host`/`Origin`/`Referer` 改写成回环权威；转发 HTTP、SSE 与 WebSocket；首页拿到 401 时 302 一次到**宿主自己签发**的带 token 地址。它不读 `.credentials.yaml`、不伪造 cookie、不改文档。

### profile 判定与 UI 策略

激活时按强度顺序判定：`process.versions.electron`（Electron Node 模式的桌面宿主）→ desktop；`DSH_PROFILE`；argv 里的 `--profile desktop` 或 `…/profiles/desktop/` 路径；宿主是否挂了桌面服务；都没有则 unknown。

| profile | 默认策略 | 行为 |
|---|---|---|
| desktop | `preserve-desktop-ui` | 原版桌面界面原样转发，不注入客户端模块、不改 HTML、不替换 fallback；首次未登录由代理引导到宿主签发的 token 地址（Desktop 不打印启动 URL，只有宿主能签） |
| web | `passthrough` | 你已经有启动行打印的 token 地址，代理只转发，不额外跳转 |
| unknown | 视 `publicUrl` | 配了公网地址就按 desktop 策略自举，否则 passthrough |

`strategy: auto` 走上面的表；`preserve-desktop-ui` / `passthrough` 可以强制。判断结果与原因写在启动日志和状态路由里。

### 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关；和隧道一起打开 |
| `listenHost` | `127.0.0.1` | 代理监听地址；非回环需要 `allowRemoteListen: true` |
| `listenPort` | `3079` | 隧道转发到的本机端口 |
| `publicUrl` | `''` | 公网 HTTPS 根地址，如 `https://dsh.example.com/`；desktop 自举鉴权需要它 |
| `strategy` | `auto` | `auto` / `preserve-desktop-ui` / `passthrough` |
| `autoBootstrap` | `true` | 首页 401 时是否 302 到宿主签发的 token 地址 |
| `autoSignIn` | `true` | 直接访问宿主端口时的自动登录：没有 cookie 就用宿主自己的 launch token 换 cookie；与 `enabled` 无关 |
| `signInMaxPerMinute` | `30` | 直接端口自动登录的跳转预算，防止浏览器拒收 cookie 时来回跳 |
| `allowRemoteListen` | `false` | 允许非回环监听；只在隧道拨不到回环时才打开 |
| `bootstrapMaxPerMinute` | `6` | 每个来源每分钟的跳转预算，防止 cookie 被拒时来回跳 |
| `logAuthCookie` | `true` | 把宿主刚签发的 `dsh-auth-*` cookie 回显到宿主日志 |

`publicUrl`、`strategy`、`autoBootstrap`、`bootstrapMaxPerMinute`、`autoSignIn`、`signInMaxPerMinute` 是 volatile 字段，保存即生效；`listenHost`/`listenPort` 在激活时读取，改了要重启宿主。

### 直接端口自动登录

代理只处理走了隧道的那条路；宿主自己打印的 `127.0.0.1:3080` 是另一扇门，隧道没开、或者浏览器把启动 URL 弄丢了，人就卡在 `401 dsh web authentication required`。`autoSignIn` 补的就是这一扇：

1. 浏览器 `GET /`，没有 `dsh-auth-*` cookie，URL 也没带 token；
2. 插件用宿主自己的 `browserAuth.launchToken` 回 `303 Location: /?token=<launchToken>`；
3. 宿主的 `BrowserAuth` 校验 token、签发 cookie，再 `303` 回干净的 `/`；
4. 地址栏停在 `/`，之后的页面、`/api`、WebSocket 都沿用这张 cookie。

它只包裹 `authorizeIndex()`，不读凭据、不伪造 cookie：token 是否有效、cookie 怎么签、Host/Origin 栅栏都留在宿主原逻辑里。已经带 token 的请求直接交给宿主，token 无效时看到的就是宿主的 `401`，不会来回弹；浏览器不收 cookie 的情况由每分钟跳转预算兜底（默认 30 次），用尽后交回 `401` 并告警一次。

它与代理的 `autoBootstrap` 是两套入口：那个在反代层接 401，这个在宿主索引层接 401，可以各自开关。

### 安全边界

- 代理不持有任何凭据：它只改请求头，`dsh-auth-*` 始终由宿主签发与校验。
- 默认只监听回环；`allowRemoteListen` 是显式例外。
- 它不是鉴权层。DSH 只有 owner 一个主体，进门即拥有本机全部权限（工具、凭据、文件），**隧道侧的口令/设备白名单/短时令牌才是唯一那道门**。
- 状态路由 `/_dsh_utils_remote/status` 只对回环来源开放，返回判定结果、上游地址与计数，不含 token。
- `logAuthCookie` 打开时，宿主日志会出现 `dsh-remote: auth cookie minted for <ip>: dsh-auth-…=…`。这行里就是**一枚可用的 30 天会话凭据**：它不离开本机，但任何能读日志的人（含发给 agent 的日志、备份、工单附件）都能拿它登录。不需要排障时建议关掉。

### 验证

1. patch 里 `enabled: true`、填好 `publicUrl`，重启宿主；
2. `curl -s http://127.0.0.1:3079/_dsh_utils_remote/status`：应看到 `profile`、`strategy`、`upstream`；宿主重启后 `upstream` 会变，而 3079 不变；
3. 首次公网访问后宿主日志应出现 `auth cookie minted for …`（`logAuthCookie: true` 时）；
4. 公网地址第一次访问应 302 到 `?token=…`，跟随后 200 且是原版界面；
5. 隧道只对你的鉴权入口开放，不要把 3079 直接暴露。

## 组件六：utils-ui（浏览器半侧）

宿主半侧只有一个空 `apply()`，`client.js` 提供全部界面。`packages/ui/package.json` 声明 `dsh.client` 并导出 `./client`；patch 的 `utils-ui` 行挂裸包名，DSH 的客户端扫描器因此把 `client.js` 挂在这一行。五个宿主行不声明 `dsh.client`。

- 配置页：`plugins.row.config`，key 是 `@xi4z/dsh-utils#<行 id>`；utils-agents 一页含「递归技能发现 / 模型可见性 / 预设与技能仓库」三块，审批门控、QQ 审批卡片与通知各一页。每个配置区的「保存」旁有「恢复默认」：一次点击只对本区 `user` 层出现过的字段发 `unset`，回落到宿主的 base／默认值；本节没有用户覆盖时按钮置灰。技能列表超过 8 个默认折叠，避免把下面的配置区挤下去。
- 右侧栏：`sidebar.right.pane.tab` 的 `utils-agents` 面板，路由全部由 `@xi4z/dsh-utils-utils-agents` 提供。
- 两套 Deploy Key 的保存/清除、技能仓库配置、版本检查与自动安装都在这个面板里。
- 保存失败会带回宿主的真实原因：页面直接调 `settings.mutate`，把 `settings/conflict`（并显示两端的 revision）、`settings/rejected` 等失败原文显示在保存按钮旁；技能开关的总线同样显示原因后再还原。写失败后条目被重载或 revision 变化时，刷新页面再保存即可。

停用 `utils-ui` 只失去界面与面板，五个宿主行继续工作。

## 包结构

```
@xi4z/dsh-utils/            只做拼装的 bundle：patch + locale + icon，无组件代码
├── package.json              dsh.bundle.patch；dependencies = 六个同版本组件
├── pnpm-workspace.yaml       把 packages/* 串成一个 workspace，本地链接同版本组件
├── cordis.patch.yml          六行：按裸包名挂六个组件
├── locale/{en,zh}.json       bundle 展示名
├── icon.svg
├── src/index.ts              空入口
├── scripts/release.mjs       按依赖顺序发七个包，已发布版本跳过
├── test/layout.test.mjs      布局守卫
└── packages/                 六个独立发布包
    ├── approval-policy/      @xi4z/dsh-utils-approval-policy   行 dsh-approval-policy
    ├── approval-qq/          @xi4z/dsh-utils-approval-qq      行 dsh-approval-qq
    ├── notify/               @xi4z/dsh-utils-notify
    ├── remote/               @xi4z/dsh-utils-remote            行 dsh-remote
    ├── utils-agents/         @xi4z/dsh-utils-utils-agents   行 utils-agents
    └── ui/                   @xi4z/dsh-utils-ui             行 utils-ui + client.js
```

`packages/<名>/` 各自是标准插件包（`src/index.ts` + `locale/` + `package.json`），与根包同版本发布。

## 开发

```sh
pnpm install
pnpm build     # 根包空入口 + packages/* 六个组件
pnpm test      # 构建 + client.js 语法检查 + 布局守卫 + 各包的 node --test
```

## 兼容性

DeepSeek Harness `>=0.2.2-rc.1 <0.4.0-0`，Node.js 22.19 及以上。宿主组件运行时依赖 `@deepseek-ai/schemastery`；`@xi4z/dsh-utils-ui` 的 `client.js` 只依赖宿主提供的 React 运行时。utils-agents 面板需要宿主带右侧栏（web 组合默认带）。

## License

[MIT](LICENSE)
