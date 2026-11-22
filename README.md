# @xi4z/dsh-utils

DeepSeek Harness 的工具 bundle。根包 `@xi4z/dsh-utils` 只做拼装：`cordis.patch.yml` 声明四个挂载行，`locale/{en,zh}.json` 提供 bundle 展示名，`icon.svg` 是图标；组件代码都在独立发布的包里，根包用同版本精确依赖把它们装起来。挂载行 id 同时是 settings 命名空间，插件页按 `@xi4z/dsh-utils#<行 id>` 定位该行的配置页。

| 组件 | 行 id | 包 | 作用 |
|---|---|---|---|
| utils-agents | `utils-agents` | `@xi4z/dsh-utils-utils-agents` | 技能与预设的宿主：嵌套 `SKILL.md` 发现、模型可见性开关，以及按预设管理 skills、技能仓库与 AGENTS.md |
| 无人值守审批门控 | `dsh-approval-policy` | `@xi4z/dsh-utils-approval-policy` | 给审批请求设应答窗口，超时 fail-closed |
| 会话通知 | `dsh-notify` | `@xi4z/dsh-utils-notify` | 会话结束 / 等授权 / 等回答时经 Gotify 网关推送，带设备名 |
| 浏览器界面 | `utils-ui` | `@xi4z/dsh-utils-ui` | 三个宿主行的配置页 + 右侧栏 utils-agents 面板；宿主侧只有空 `apply()` |

## 安装

装一次 bundle 即可；四个组件由 pnpm 作为根包的精确版本依赖从 registry 装上。

| 想要的 | `target` |
|---|---|
| 最近一次发布 | `@xi4z/dsh-utils` |
| `main` 最新提交 | `https://github.com/xi4z/dsh-utils`（组件包仍需 registry 上有同版本） |
| 离线 | 五个 tarball（见下） |
| 改代码、即时生效 | 目录 `link:`，profile 里同时 link 四个组件 |

```
plugin_manager action=install_bundle target=@xi4z/dsh-utils
```

```sh
dsh plugin --profile <profile> add @xi4z/dsh-utils
```

根包的 `dependencies` 固定到四个 `@xi4z/dsh-utils-*`，版本与 bundle 相同，所以发布版只需要这一个 spec。GitHub 地址装的是 `main` 当前状态、不钉版本；要钉就用 npm 名或 `#<commit>`（组件仍从 registry 取同版本）。

根包 tarball 只含拼装层，组件在各自的包里。离线搬运要把五个包都 pack：

```sh
pnpm install && pnpm build
pnpm -r --filter "./packages/*" pack --pack-destination dist
pnpm pack --pack-destination dist
# 目标机器 profile 里五个 tarball 都加 file: 依赖，再装 bundle
```

本地开发装目录（`link:`，不复制文件，改完 `pnpm build` 重启宿主）。组件是精确版本依赖，profile 要把四个组件也 link 进来，pnpm 才会用本地目录而不是去 registry 解析：

```json
{
  "dependencies": {
    "@xi4z/dsh-utils": "link:/abs/path/dsh-utils",
    "@xi4z/dsh-utils-approval-policy": "link:/abs/path/dsh-utils/packages/approval-policy",
    "@xi4z/dsh-utils-notify": "link:/abs/path/dsh-utils/packages/notify",
    "@xi4z/dsh-utils-utils-agents": "link:/abs/path/dsh-utils/packages/utils-agents",
    "@xi4z/dsh-utils-ui": "link:/abs/path/dsh-utils/packages/ui"
  }
}
```

profile 的 `dsh.profile.bundles` 里是 `@xi4z/dsh-utils`。装后 bundle 的 patch 自动插四行，不手写挂载块；`config:` 只管配置。挂载项新增/改名要重启宿主。

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
    gotifyUrl: '${DSH_GOTIFY_URL}'
    gotifyToken: '${DSH_GOTIFY_TOKEN}'
    dryRun: false
```

各字段与默认值见下面各组件的配置表。`utils-ui` 没有 config，只是浏览器半侧的挂载行。三个宿主行的字段全部 volatile：在插件页保存即生效，改 `cordis.patch.yml` 则需要重启。

## 发布

五个包同版本、按依赖顺序发布：四个组件在前，bundle 在后。`scripts/release.mjs` 先 `npm view` 探一遍，版本已在 registry 上就跳过（重复跑安全、失败可续）；任一包版本与根包不一致会直接报错退出。

推 GitHub 与发 npm 合成一次操作——打 tag 触发 [`publish.yml`](.github/workflows/publish.yml)：

```sh
git push                                    # 先推代码
git tag v0.7.1 && git push origin v0.7.1    # 再推 tag，CI 里 build + 发布全部五个包
```

tag 必须等于根包 `package.json` 的版本，否则 job 直接失败。CI 里 `pnpm release` 按依赖顺序发五个包，带 `--provenance`。

一次性准备：npm 建一个 Automation token，存成仓库 secret `NPM_TOKEN`。scope 是公开的 `@xi4z`，token 所属账号要能用这个 scope（scope 通常是 npm 用户名或已创建的组织）。

手动发（本机 `npm login` 后，脚本逻辑与 CI 相同）：

```sh
pnpm build
pnpm release             # 按顺序发组件与 bundle；已发布版本跳过
pnpm release --dry-run   # 只看会不会发，不动 registry
```

改了任何组件都要把五个 `package.json` 的版本一起提到同一个值，再打 tag。

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

扫描根按优先级：项目最近的 `.git` 下的 `.dsh/skills`、`.agents/skills`；`extraRoots`；`$DSH_HOME/skills`；`$DSH_AGENTS_HOME/skills`（两个 home 默认是 `~/.dsh` 与 `~/.agents`）。同名技能以先列出的根为准，扁平技能优先（嵌套候选 rank 低一档）。

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

识别的 frontmatter 字段：`name`、`description`，可选 `whenToUse`、`disable-model-invocation`、`user-invocable`。非法文件记 warning，跳过。

### 模型可见性

配置页的「技能」开关列出当前会话能读到的 Skill：关掉 = 在 `ctx.skills.snapshot()` / `list()` 里把该技能标成 `modelInvocable: false`，模型下一轮拿到的 `<available_skills>` 里不再出现，手动 `/名称` 仍可加载。只能手动调用的技能显示「仅手动」，开关禁用。

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

扫描来源：当前选中预设同步出来的技能仓库 checkout（`<preset>/skills/<targetSubdir>`）、共享技能仓库的 checkout（`$DSH_HOME/storages/dsh-utils-ui.json` 的 `targetDir`，默认 `$DSH_HOME/skills/herskill`）、`$DSH_HOME/skills` 及其带 `.dsh` 的一级子目录，以及配置项 `presetSourceDirs` 里列出的额外仓库，按真实路径去重。仓库本身不会被修改。

共享技能仓库在面板里直接配置：仓库地址、分支、检出目录、可选密钥路径、Deploy Key 私钥；点「拉取」做 clone 或 `fetch` + `merge --ff-only`（浅克隆先 `--unshallow`，子模块可选），完成后 `.dsh/preset` 自动出现在下面的来源列表。检出目录就是**仓库根目录**，可以是任意绝对路径（如 `~/core/projects/skills`、`~/.dsh/skills-src/skills`），不必叫 `.dsh`，也不需要指向 `~/.dsh`；预设固定从 `<检出目录>/.dsh/preset` 读取。

存储：

- 设置：`$DSH_HOME/storages/dsh-utils-ui.json`（`repoUrl` / `branch` / `targetDir` / `keyPath` / `recurseSubmodules` / `lastSync`）
- Deploy Key：`$DSH_HOME/storages/dsh-utils-ui.deploy-key`（600，不返回浏览器）
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

技能发现字段见上面的表；`disabledSkills` 见「模型可见性」。宿主半侧在 `packages/utils-agents/src/`（`index.ts` 路由、`presets.ts` 预设/技能/文件、`git.ts` 仓库同步、`update.ts` 发布版本检查），浏览器半侧在 `@xi4z/dsh-utils-ui` 的 `client.js`。停用 `utils-agents` 行后路由消失，侧边栏面板显示 404 提示。

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

判定粒度：`sessions` 命中与 `all` 是会话级。`subagent` 看 `session.header.origin`。`scheduled` / `cron` 看最后一条带溯源 user 消息的 `source.kind`。合成注入（`runtime-context`、`skill-catalog`）跳过；人插过话就不门控。审计由宿主 `approval/asked` + `approval/decided` 写会话日志；本组件不写日志、不落盘。

## 组件三：会话通知

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

`cordis.patch.yml` 的 `config`，或环境变量。环境变量优先。字段全 volatile：改完即生效，不重启。

| 字段 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | — | `true` | 总开关 |
| `transport` | — | `gotify` | `gotify` = 公网网关；`onebot` = 直连 NapCat 的兼容出口 |
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
| `dryRun` | — | `true` | 默认开：只打日志不发消息。确认配置再关 |
| `traceFile` | — | `''` | 可选 JSONL 诊断轨迹（排障），空则不记 |

`transport: onebot` 时才读 `endpoint`（默认 `http://127.0.0.1:3000`）、`token`、`targetType`（`private` / `group`）、`targetId`，对应 `DSH_QQ_NOTIFY_URL`、`DSH_QQ_NOTIFY_TOKEN`、`DSH_QQ_NOTIFY_TARGET_TYPE`、`DSH_QQ_NOTIFY_TARGET_ID`。

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

公网网关对任何来源 IP 开放（按 token/IP 限流）。其他设备不用部署 relay，不用 NapCat，不用开本机端口。

1. **设备身份**：`deviceName` 留空自动取 `os.hostname()`。建议设 `deviceLabel`（办公本、家里的服务器），渲染进 `{device}`。
2. **各自一套 token**：Gotify 里给每台设备建一个 application（一个「系列」）。token 用环境变量注入，别每台共用一把：

   ```sh
   export DSH_QQ_NOTIFY_DEVICE='laptop-01'
   export DSH_QQ_NOTIFY_DEVICE_LABEL='随身本'
   export DSH_QQ_NOTIFY_GOTIFY_TOKEN='gtfya.该设备的token'
   ```

   系列不同，relay 侧就可以把不同系列路由到不同 QQ 收件人。

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

## 组件四：utils-ui（浏览器半侧）

宿主半侧只有一个空 `apply()`，`client.js` 提供全部界面。`packages/ui/package.json` 声明 `dsh.client` 并导出 `./client`；patch 的 `utils-ui` 行挂裸包名，DSH 的客户端扫描器因此把 `client.js` 挂在这一行。三个宿主行不声明 `dsh.client`。

- 配置页：`plugins.row.config`，key 是 `@xi4z/dsh-utils#<行 id>`；utils-agents 一页含「递归技能发现 / 模型可见性 / 预设与技能仓库」三块，审批与通知各一页。
- 右侧栏：`sidebar.right.pane.tab` 的 `utils-agents` 面板，路由全部由 `@xi4z/dsh-utils-utils-agents` 提供。
- 两套 Deploy Key 的保存/清除、技能仓库配置、版本检查与自动安装都在这个面板里。

停用 `utils-ui` 只失去界面与面板，三个宿主行继续工作。

## 包结构

```
@xi4z/dsh-utils/            只做拼装的 bundle：patch + locale + icon，无组件代码
├── package.json              dsh.bundle.patch；dependencies = 四个同版本组件
├── pnpm-workspace.yaml       把 packages/* 串成一个 workspace，本地链接同版本组件
├── cordis.patch.yml          四行：按裸包名挂四个组件
├── locale/{en,zh}.json       bundle 展示名
├── icon.svg
├── src/index.ts              空入口
├── scripts/release.mjs       按依赖顺序发五个包，已发布版本跳过
├── test/layout.test.mjs      布局守卫
└── packages/                 四个独立发布包
    ├── approval-policy/      @xi4z/dsh-utils-approval-policy
    ├── notify/               @xi4z/dsh-utils-notify
    ├── utils-agents/         @xi4z/dsh-utils-utils-agents   行 utils-agents
    └── ui/                   @xi4z/dsh-utils-ui             行 utils-ui + client.js
```

`packages/<名>/` 各自是标准插件包（`src/index.ts` + `locale/` + `package.json`），与根包同版本发布。

## 开发

```sh
pnpm install
pnpm build     # 根包空入口 + packages/* 四个组件
pnpm test      # 构建 + client.js 语法检查 + 布局守卫 + 各包的 node --test
```

## 兼容性

DeepSeek Harness `>=0.2.2-rc.1 <0.4.0-0`，Node.js 22.19 及以上。宿主组件运行时依赖 `@deepseek-ai/schemastery`；`@xi4z/dsh-utils-ui` 的 `client.js` 只依赖宿主提供的 React 运行时。utils-agents 面板需要宿主带右侧栏（web 组合默认带）。

## License

[MIT](LICENSE)
