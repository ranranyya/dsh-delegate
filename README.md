# dsh-delegate

DeepSeek Harness（DSH）的委托插件：让 MCP 宿主在你开启本机总开关后，调用 DSH
已配置的接口执行任务，执行结果回到宿主（例如 Codex）自行验收。

新安装时本机调用总开关默认关闭。开关状态会保存在插件设置中，重启后恢复保存值；
关闭时拒绝新的委派任务，并请求停止正在运行的任务。

> **发布状态：尚未发布。** 目前没有 GitHub 仓库、没有 npm 发布版本、没有官方渠道的
> `.tgz` 下载地址。本文件描述的是本仓库当前源码的行为；`npm pack` 生成的包只能自建
> 并使用，或在本地/临时 profile 中验证。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.1-rc.3` | `peerDependencies` 精确声明这三个版本的范围（`0.2.0-rc.2 \|\| 0.2.1-rc.2 \|\| 0.2.1-rc.3`）；DSH 启动时会用 `semver` 加 `includePrerelease` 校验 `@deepseek-ai/dsh-*` 的 peer 范围，不匹配的插件行会被拒绝加载（`skippedBundles` / denied row）。`0.2.0-rc.2` 是开发与自动测试所用版本；`0.2.1-rc.2` 在**隔离 profile** 中完成验收（未写入正式 profile）；`0.2.1-rc.3` 为宿主当前版本（声明兼容，运行时验证进行中）。其他 DSH 版本**未经验证**，请不要假定可用。 |
| Node.js | `>= 24` | 与 DSH `0.2.0-rc.2` / `0.2.1-rc.2` 运行时一致；使用了原生 ESM、`AbortSignal.timeout`、`node --test`。 |
| 操作系统 | Windows / Linux / macOS | 自动测试在 Windows + Node 24 上运行；需要 git 的工作树隔离在缺少 git 时会被显式拒绝，而不是静默降级。 |

`@earendil-works/pi-ai`（`^0.87.1`）与 `@deepseek-ai/dsh-llm-pi-ai` 是运行时
`peerDependencies`：DSH 官方 bundle 已自带，**不需要**单独安装。

## 2. 安装

DSH 的插件以 bundle 的形式装进某个 profile（`$DSH_HOME/profiles/<name>`）。装哪个
profile 由你用的前端决定，**两条路径不可混用**。

### 2.1 DSH Desktop（推荐）

Desktop 的插件由应用自身的 **Plugins manager** 负责安装、升级与卸载。Desktop 使用的
profile 是**应用保留的**：npm / `dsh plugin` CLI 对该 profile 的操作会被拒绝，因此
Desktop 侧的包操作只能交给应用完成——不要在 Desktop 的正式 profile 里执行 npm/pnpm
命令，也不要直接编辑其中的文件。

1. 在仓库根目录打出本地包（不会发布，也不会写远程仓库）：

   ```bash
   npm pack
   #    → dsh-delegate-0.1.10.tgz
   ```

2. 打开 Desktop 的 **Plugins manager**，用它的 add-plugin（添加插件）入口选择上一步生成的
   `.tgz`（或本仓库目录）完成安装。
3. 安装后打开 **Plugins → Installed plugins → dsh-delegate**：配置页就在该条目下（见第 3 节）。
4. 确认该插件行处于启用状态；Desktop 侧的重载与启用由应用控制，不通过 CLI 触发。

### 2.2 web profile（CLI，仅限非 Desktop）

如果你是自己用 `dsh` CLI 启动的 web profile，可以用 `dsh plugin`（等价于在该 profile
目录执行 pnpm）安装：

```bash
# 装进一个 profile（例：web）
dsh plugin --profile web add ./dsh-delegate-0.1.10.tgz && dsh plugin --profile web why dsh-delegate

# 启动（首次启动会自动把插件 bundle 追加到 dsh.profile.bundles）
dsh --profile web
```

> **不要用这条路径装进 Desktop。** Desktop 的 profile 是保留的，npm/CLI 对它的操作会被
> 拒绝；Desktop 的安装、升级和卸载都在应用内的 Plugins manager 完成。上面的命令只适用于
> 你自己用 CLI 启动的 web profile。

### 说明与注意

- **不要装进你正在用的正式 profile 做试验。** 建议先用一次性 profile：
  `dsh plugin --profile dsh-delegate-try add ./dsh-delegate-0.1.10.tgz`，再把
  `DSH_HOME` 指向临时目录做隔离验证。该命令同样只用于 CLI profile。
- 该包声明了 `@deepseek-ai/dsh-*` 的 peer，若你的包管理器默认自动安装 peer，
  安装过程会尝试解析这些版本。可显式关闭：`npm_config_auto_install_peers=false`
  （pnpm）或 `--legacy-peer-deps`（npm）。宿主运行时已经提供这些包，插件运行时
  通过 DSH 的 runtime resolution 解析它们。
- 包的 `dsh.bundle.patch`（`cordis.patch.yml`）只做一件事：插入 id 为
  `dsh-delegate` 的插件行。安装完仍需要**启用**该插件行（见下）。

### 启用 / 重载

- 插件的启用状态就是插件行是否 `disabled`；Desktop 中在 **Plugins → Installed plugins**
  里查看并切换。
- DSH web profile 模板默认开启 HMR：修改 `cordis.patch.yml` 或包内容后会自动重载；
  其他 profile 模板只在启动时应用补丁，需要**重启 dsh 进程**。
- 禁用插件会卸载它注册的所有路由、UI 入口和内存中的授权；禁用后必须重启或等待 HMR
  重载才会真正消失。

## 3. 界面位置

配置页注册在 Plugins manager 的 **keyed** 槽位 `plugins.bundle.config` 上，key 即包名
`dsh-delegate`：

- **Desktop**：**Plugins → Installed plugins → dsh-delegate**，打开该条目的配置页。
- **CLI web profile**：同一个 Plugins 页面，入口相同。

它**不是**设置对话框里的独立导航项：旧的 `settings.section`（设置 → 「DSH 委托」）已
移除。页面分区：

1. **本机调用授权**——单一开关。关闭后拒绝新提交并请求停止运行中的任务。
2. **API 管理**——从 DSH 已注册的接口中选择；模型和推理强度由 DSH 当前目录同步。
3. **执行设置**——provider / 模型 / 推理强度 / 超时 / 最大并发 / 工作区隔离。
4. **附加审查**——独立 provider / 模型 / 强度；默认关闭，与授权无关。
5. **任务记录**——状态、实际 provider/model/effort、变更文件、diff、验证证据。
6. **Codex 集成**——一键安装 Codex 子智能体文件并登记 MCP 条目（见 6.1）；三种状态分开显示。

界面只负责切换本机调用能力和配置；任务由 MCP 宿主提交。

**对话不再是一个设置。** 目录级的「复用上一次对话」开关已移除：每次新的提交都会在它实际执行
目录对应的 Workspace 里**新开**一条 DSH 会话，即使这个目录此前跑过任务、即使旧设置文档里
还留着 `conversation.mode: "reuse"`。只有 `delegate_submit` 显式带上
`continueFromTaskId` 的**跟进任务**才会续接那一条任务会话（同 Workspace、同 Session）。
详见 `docs/conversation-placement.md`。

## 4. 本机调用开关

- 新安装默认关闭；安装、提示词内容和模型调用都不会自动开启它。
- 开启后，本机 MCP 可以提交 DSH 委派任务。关闭时执行门会先关闭，再保存设置；
  正在运行的任务会收到取消请求。
- 关闭后状态查询、读取已有任务结果和取消任务仍可用；只有新任务提交被拒绝。
- 插件仅在 DSH webserver 绑定回环地址时注册执行面。开启期间，同一台电脑上能访问
  本机端口的其他进程也可能提交任务；这个开关是本机能力控制，不是针对同账号进程的安全隔离。

## 5. API / 模型 / 强度 / 审查配置要点

- 接口列表来自 DSH 的原生 LLM provider 注册表；插件不会让用户再次填写接口地址或 API 密钥。
- 模型和推理强度来自 DSH 的精确模型元数据；模型能力变化后可在界面同步。
- 推理强度以模型声明为准；不支持的组合**直接拒绝**，不会静默忽略，也不会回退到 Harness 默认值。
- 无自动回退：未选 provider / 未注册路由 / 模型不可用 → 拒绝执行。
- 附加审查：默认关闭；开启后是**独立的只读审查** agent（独立 provider/模型/强度、
  只读工具与工作区），只把结论返回宿主，不自批、不触发自动修复循环。

## 6. MCP（stdio）接入

包内可执行文件 `bin/dsh-delegate-mcp.js`（bin 名 `dsh-delegate-mcp`）实现了五个工具：
`delegate_status` / `delegate_preflight` / `delegate_submit` / `delegate_result` / `delegate_cancel`。
它**不提供**授权、配置写入或凭据读写工具。

在需要调用委派工具的 MCP 宿主中添加 stdio server（以下为通用配置示意；Codex 用见 6.1，
插件会替你写这条并给出正确路径）：

```json
{
  "mcpServers": {
    "dsh-delegate": {
      "command": "node",
      "args": ["<包目录>/bin/dsh-delegate-mcp.js"]
    }
  }
}
```

- 不需要创建连接、签发令牌或设置 `DSH_DELEGATE_TOKEN`。MCP 进程通过回环地址连接
  DSH。插件启动时会把当前回环地址写入 `$DSH_HOME/data/dsh-delegate/runtime-endpoint.json`；MCP
  每次工具调用前都会重新读取，因此 DSH 重启并更换端口后无需改 Codex 配置。
- 默认发现路径使用 `DSH_HOME`，未设置时为 `~/.dsh`。若 DSH 和 MCP 宿主使用不同的 DSH_HOME，
  可通过 `DSH_DELEGATE_DISCOVERY_FILE` 指向该发现文件。`DSH_DELEGATE_BASE_URL` 仅作为手动固定地址覆盖。
- 工具为 `delegate_status`、`delegate_preflight`、`delegate_submit`、`delegate_result` 和 `delegate_cancel`。
- 开关关闭时，`delegate_submit` 返回 `DELEGATION_DISABLED`；状态、预检、结果和取消工具仍可使用。
  `delegate_preflight` 只读取工作区事实，不创建任何东西，因此不受开关和并发上限限制。

**任务会话与跟进（`continueFromTaskId`）**：`delegate_submit` 有一个可选字段
`continueFromTaskId`。

- **省略**：永远新开一条 DSH 会话。同一目录之前跑过多少任务都不影响，旧设置里残留的
  `conversation.mode: "reuse"` 也不会让新提交接续任何旧对话。
- **填写**：声明本次提交是某个先前任务的跟进，必须续接**那一条**任务会话（同 Workspace、同
  Session）。只用于属于同一任务的修改、纠正或重试；无关任务一律省略，不要"为了保留上下文"
  随手复用 id。
- 续接是**失败即拒绝**：未知/已被清理的父任务、仍在运行的父任务、没有产生对话的失败任务、
  不同源仓库、不同执行目录、已删除或身份不符的工作树、已不存在的 Session，都会被拒绝
  （`JOB_CONTINUATION_REFUSED`，具体原因在 `error.details.session`），**不会**悄悄改成新开会话。
- 工作区状态会被保留：共享模式的任务在原目录继续；隔离工作树的跟进任务仍使用父任务的原始
  `workspacePath` 做授权和预检，由插件内部恢复**同一棵**受管工作树继续上一次未提交的改动。
  不要把内部 `execution.workspacePath` 当成新的授权路径，也不要切换隔离模式；同一任务链由工作区锁串行化。

**派工前预检（`delegate_preflight`）**：只读检查一个绝对工作区路径——是否 Git 仓库、是否有
提交、是否有未提交改动、变更文件总数和一个有上限的路径清单，并给出建议隔离
（`worktree` / `shared` / `block`）与稳定的原因码。它**不会**创建提交、stash、worktree
或任务，也不改任何设置：

| 工作区事实 | `isolation` | `reason` |
|---|---|---|
| 干净仓库 | `worktree` | `PREFLIGHT_CLEAN_REPOSITORY` |
| 有未提交改动，且未显式允许 | `block`（`decisionRequired: true`） | `PREFLIGHT_DIRTY_NEEDS_DECISION` |
| 有未提交改动，且传了 `allowShared: true` | `shared`（`sharedExplicit: true`） | `PREFLIGHT_DIRTY_SHARED_EXPLICIT` |
| 不是 Git 仓库 / 没有提交 / 不是仓库根目录 | `block` | `PREFLIGHT_NOT_A_REPOSITORY` / `PREFLIGHT_NO_COMMITS` / … |
| git 不可用或读取失败 | `block` | `PREFLIGHT_GIT_UNAVAILABLE` / `PREFLIGHT_GIT_FAILED` |
| 路径是相对路径、不存在或不是目录 | `block` | `PREFLIGHT_WORKSPACE_INVALID` / `PREFLIGHT_NOT_A_DIRECTORY` |

脏工作区**不会**被自动降级为共享执行：指挥官根据任务和变更路径判断能否安全地原地执行，
并在派工前说明事实和理由；任务与既有修改的归属或影响不清时才暂停询问。决定使用 `shared`
后，再次预检时传 `allowShared: true`，并在 `delegate_submit` 中只覆盖
`{ isolation: "shared" }`，使实际任务与预检决策一致。`allowShared` 是单次调用的确认，
不是保存的偏好设置；provider、model、思考强度和 timeout 仍由插件设置决定。

### 6.1 Codex 集成（设置页一键安装）

Codex 是唯一支持的宿主。**「Codex 集成」**分页提供一个明确的按钮动作：点击一次即可完成

1. 安装自定义子智能体文件 `CODEX_HOME/agents/dsh-delegate.toml`（未设置 `CODEX_HOME`
   时为 `%USERPROFILE%\.codex\agents\dsh-delegate.toml`）；
2. 在 `CODEX_HOME/config.toml` 里登记本包自带的 stdio MCP 服务
   `mcp_servers.dsh-delegate`，让子智能体可以使用 `delegate_status` /
   `delegate_preflight` / `delegate_submit` / `delegate_result` / `delegate_cancel`。

需要说明的边界（分页里也有同样的提示）：

- **只有点击才会新建，启动只做受限刷新。** 打开分页、安装/升级 `.tgz` 都不会碰 Codex 目录；
  新建 agent、登记或迁移 `config.toml` 条目、移除托管项都只能通过「安装 / 更新 Codex 集成」
  「仅修复 MCP 配置」「移除插件托管项」三个按钮。唯一的例外是**插件启动时的一次受限迁移**：
  只有当 `agents/dsh-delegate.toml` 与某个**已发布版本的模板逐字节相同**（枚举的摘要表）时，
  才会把它刷新为当前版本；它**不会**创建缺失的 agent、不会创建 `agents/` 目录、不会写
  `config.toml`，正文被改过或来源不明的文件一律不动。「刷新状态」和分页打开时的读取都只是只读诊断。
- **不覆盖、不删除你写的文件。** 同名但内容不同的 `agents/dsh-delegate.toml` 会被保留，
  界面报告为「不属于已知版本」；只有与**某个已发布版本逐字节相同**的托管文件才会被更新或删除，
  仅版本号变旧、正文被改过一字的文件都不会动。`config.toml` 里由插件写入的条目带托管标记注释；
  **没有该标记**的同名条目（即使 `command`/`args` 与插件要写的完全一致）同样视为你自己写的，
  安装、修复、移除都不会改动它，界面报告为冲突并说明原因。
- **旧桌面命令只做受限迁移。** 带托管标记、当前包 `args` 和完整 env 结构的条目，若 command
  的路径 basename 正好是 `DeepSeek Harness.exe`，重新安装或修复时会只把 command 迁移到已验证的
  Node 运行时；裸命令、相似 exe、旧 args 或额外 env 仍按冲突处理并保持原样。
- **只改自己那一项配置。** MCP 条目用结构化定位器按行区间写入，`config.toml` 里其他表、
  注释、顺序、以及其他 MCP 服务都原样保留；行尾为 CRLF 的文件同样按 CRLF 写回，不会整篇被
  改写成 LF。文档存在无法定位的语法时整体拒绝写入。
- **路径来自正在运行的插件。** 登记的可执行文件是当前安装的包里的
  `bin/dsh-delegate-mcp.js`；`command` 是**运行本插件的 Node.js 运行时**，而不是 Codex 自身
  PATH 里的 `node`，也不是桌面应用自身的 exe：

  - 插件跑在普通 Node.js 进程里时，`command` 就是该进程的 Node 可执行文件（`process.execPath`）；
  - 插件跑在 **DSH Desktop（Electron）** 里时，应用可执行文件是 `DeepSeek Harness.exe`，
    **绝不会**被写进 Codex 配置（否则 Codex 会再启动一个 GUI 而不是 MCP 服务）。此时使用
    DSH 随包携带的 Node：`<resources>/runtime/primary-runtime/dependencies/node/bin/node.exe`
    （Windows；其他平台为同目录的 `node`）。`<resources>` 优先取应用暴露的 resources 目录，
    缺失时从应用可执行文件所在目录推导出 `resources`；
  - 若随包 Node 不存在或不在预期位置，可用环境变量指定**绝对路径**（仅接受现存普通文件，
    相对路径、目录、链接、裸命令名都会被忽略）：`DSH_NODE_PATH` →
    `DSH_NODE_EXECUTABLE` → `CODEX_MCP_NODE_PATH`（按此优先级）；
  - 以上都不可用时**明确失败**（`MCP_EXECUTABLE_UNRESOLVED`）：不会写入任何指向 GUI exe 或
    裸 `node` 的条目，设置页与 `status` 会给出拒绝原因。

  若 DSH 使用非默认 `DSH_HOME`，条目里会额外固定 `env.DSH_DELEGATE_DISCOVERY_FILE`，
  让 MCP 进程找到同一份运行时发现文件。
- **三种状态分开显示，互不代表。**「Codex 子智能体文件」「Codex MCP 条目」
  「DSH 本机调用开关」各占一行；安装文件**不会**打开本机调用开关，开关关闭时
  `delegate_submit` 仍会被拒绝。
- **安装后需要 Codex 重新载入。** 新开会话或重启 Codex 才会读到新的子智能体和 MCP 条目。
  Codex 官方文档说明了[自定义子智能体](https://learn.chatgpt.com/docs/agent-configuration/subagents)和
  [MCP 连接](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)；这些文档支持 agent 配置与
  MCP 继承，但**没有**说明当前 Codex 桌面版/CLI 的输入框支持用 `@dsh-delegate` 选中该子智能体。
  本插件因此**不宣称**任何 Codex 界面支持这种 `@` 直接调用，只保证子智能体文件与 MCP 工具存在，
  由你通过 Codex 自身提供的选择方式指派它。
- **触发规则写死在 agent 文件里**（见 `codex/dsh-delegate.toml`）：只有在父请求明确指派
  （例如写出 `@dsh-delegate`、从智能体列表中选择它，或明确要求把该实现任务交给 DSH）时才派发；
  仅仅在无关问题里提到 DSH / DeepSeek / 本插件**不是**派发请求。派发前先调用
  `delegate_status` 检查开关，再调用 `delegate_preflight` 读取工作区事实：干净仓库按插件设置里
  的 **worktree** 隔离派发；**脏仓库不会被自动降级**，指挥官根据任务和变更路径判断能否安全共享，
  并在派工前说明事实与理由；归属或风险不清时才暂停询问。决定共享后用 `allowShared: true` 再预检，
  并在提交任务时只覆盖 `{ isolation: "shared" }`；无法判断或其他原因导致 `block` 时停止并报告。
  派工说明里要带上工作区事实与隔离理由。provider / 模型 / 推理强度 / 超时仍由插件设置决定，
  再轮询**同一个**任务，把状态、实际 provider/model/effort、
  变更文件、验证证据交回 Codex。子智能体不得为了“让预检通过”去提交、stash、清理或回滚工作区。
  执行完成不等于验收：验收仍由 Codex 负责。
  **跟进规则**同样写在 agent 文件里：只有属于同一个先前任务的修改/纠正/重试才带上最新的那个
  任务 id 作为 `continueFromTaskId`；无关任务一律省略，省略即新开对话。隔离工作树的跟进任务
  保持父任务的原始授权路径，由插件恢复同一棵内部工作树。

也可以用命令行执行同一套动作（脚本化 / CI 用，与设置页共用一份实现）：

```bash
node bin/dsh-delegate-codex-agent.js install   # 安装/更新子智能体 + MCP 条目
node bin/dsh-delegate-codex-agent.js status    # 只读诊断
node bin/dsh-delegate-codex-agent.js repair    # 只修复 MCP 条目
node bin/dsh-delegate-codex-agent.js remove    # 只删除插件托管项
```

退出码：`0` 完成，`2` 因冲突/拒绝而未改动，`1` 失败。

## 7. 凭据隔离

- provider、地址和密钥由 DSH 自己管理；插件通过 DSH 原生 provider 调用现有配置。
- 插件配置和任务结果不复制或返回 DSH 的密钥。导出配置只含非敏感选择与执行设置。

## 8. 升级 / 导出 / 卸载 / 回滚

```bash
# Desktop：在 Plugins manager 里对已安装的 dsh-delegate 执行更新 / 卸载
# （先 npm pack 出新 .tgz，再用 add-plugin 添加新版本）。
# 不要在 Desktop 的正式 profile 下执行下面的 CLI 命令。

# CLI web profile 的升级：换成本地新包或（将来）新版本
dsh plugin --profile web add ./dsh-delegate-0.1.10.tgz

# 导出：界面里"导出非敏感配置"按钮，或用只读 API
#   GET /api/dsh-delegate/settings
# 导出物只含 provider/worker/review 等非敏感字段，可保存为复用预设。

# CLI web profile 的卸载
dsh plugin --profile web remove dsh-delegate
```

- Desktop 的安装、升级、卸载都属于应用自己的插件操作；npm/`dsh plugin` 命令会被保留
  profile 拒绝，因此不要改用 CLI 去"绕过"。
- 卸载后插件行仍可能留在 `cordis.patch.yml` 里，插件行找不到包会被跳过并打印
  `skippedBundles`；把对应行删掉即可干净移除。（Desktop 侧由应用管理，不要手工改文件。）
- 回滚：把旧 `.tgz` 重新 `add` 回去即可；数据目录 `$DSH_HOME/data/dsh-delegate`
  保存设置与任务历史，升级/回滚都不会自动删除它。schema 带版本号，读取时会校验。
- 插件卸载或禁用后，其路由和运行中的任务会随生命周期清理；持久化开关值仍保存在插件数据目录。
- 插件卸载**不会**自动删除它写进 Codex 的托管项：请在卸载前于「Codex 集成」分页点
  「移除插件托管项」（或运行 `dsh-delegate-codex-agent remove`）。卸载后包已不在，
  那条 MCP 条目就会指向不存在的文件。

## 9. 限制（请如实理解）

- **没有发布渠道**：无 GitHub 仓库、无 npm 版本、无签名产物、无自动更新。
- **DSH 版本锁定**：只验证了 `0.2.0-rc.2` 与 `0.2.1-rc.2` 两个版本；其中 `0.2.1-rc.2`
  的验收在**隔离 profile** 中完成。`0.2.1-rc.3` 是当前宿主版本，peer 范围已声明，
  但**尚未完成运行时验证**。其他版本会被 peer 门禁拒绝，或行为未知。
- **本机开关不是进程身份认证**：开关开启时，能连接本机 DSH 端口的同机进程可以提交任务。
  不要在不可信的本机环境中开启；它不能防御同账号的恶意进程。
- **工作树隔离需要 git**：默认 `worktree` 隔离要求源目录是已提交的 git 仓库；
  否则显式拒绝。`shared` 模式不是隔离，界面会如实标注。
- **审查不是批准**：附加审查只产出发现，不代表宿主验收；任务完成状态是
  "等待宿主审查"，不是"已通过"。
- **Codex 集成的限制**：
  - 只支持 Codex；不提供 Claude Code 等其它宿主的集成。
  - **不宣称**当前 Codex 桌面版/CLI 支持用 `@dsh-delegate` 在输入框直接选中该子智能体：
    这取决于 Codex 版本自身是否提供提及选择，仓库内没有官方文档或运行时证据支持该说法。
    插件只保证子智能体文件与 MCP 条目存在；安装后必须让 Codex 重新载入。
  - 仅管理 `agents/dsh-delegate.toml` 与 `config.toml` 里的 `mcp_servers.dsh-delegate`
    一项；不修改 Codex 的其他设置，不删除用户自己写的同名文件。所有权按内容证明：
    MCP 条目必须有本插件的托管标记注释，agent 文件必须与当前模板或某个**已发布版本逐字节相同**，
    否则一律视为你的文件并拒绝改动。
  - 只做结构化的**最小行区间**编辑（不重排、不重写整个 `config.toml`，保留 CRLF 行尾）；
    遇到无法定位的 TOML 语法时整体拒绝写入，而不是猜测。
  - 首次安装 agent 文件使用排他创建：若文件在状态读取与写入之间被别的进程创建，
    会报告冲突而不会覆盖。
  - 安装/修复不会打开本机调用开关；开关仍由操作者在第 4 节的位置单独控制。

## 10. 开发

```bash
npm install          # 安装开发依赖（仅本仓库内）
npm test             # node --test --test-concurrency=1 tests/*.test.js（当前 794 项）
npm run check:client # scripts/build-client.mjs --check，校验 lib/client.js 与源码一致
npm run build:client # 由 src/client/index.jsx 重建 lib/client.js
npm run pack:dry     # npm pack --dry-run
```

`lib/client.js` 是构建产物，必须与源码一致；`--check` 会重建到临时目录并对比。
客户端 bundle 只允许请求平台模块表里的 `react` / `react/jsx-runtime`，因此
`package.json` 不需要 `dsh.client.external`。

Codex 集成相关的自动化测试（全部在临时 `CODEX_HOME` 中运行，不触碰真实
`~/.codex`）：

| 文件 | 覆盖 |
| --- | --- |
| `tests/codex-toml.test.js` | TOML 定位/最小行区间编辑：注释、多行数组、内联表、Windows 路径、拒绝畸形文档 |
| `tests/codex-integration.test.js` | 路径与可执行文件推导（普通 Node / Electron / 随包 Node / 环境变量 / 失败即拒绝）、幂等安装、用户文件保留、MCP 冲突拒绝、写入保真、路由契约、只读 status |
| `tests/codex-agent.test.js` | 本版本之前的 `manageCodexAgent` 兼容入口 |
| `tests/codex-ui.test.js` | 设置页流程：`init` 只读、每个动作恰好一次 POST、三种状态分离、构建产物含面板与限制说明 |

## 许可证

MIT，见 [LICENSE](./LICENSE)。
