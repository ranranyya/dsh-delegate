# dsh-delegate

DeepSeek Harness（DSH）的委托插件：让 MCP 宿主在你开启本机总开关后，调用 DSH
已配置的接口执行任务，执行结果回到宿主（例如 Codex）自行验收。

新安装时本机调用总开关默认关闭。开关状态会保存在插件设置中，重启后恢复保存值；
关闭时拒绝新的委派任务，并请求停止正在运行的任务。

> **发布状态：`1.2.0`（静默等待与独立控制通道的修订版本）。** 源码仓库和可下载的 Release
> 位于 [GitHub](https://github.com/ranranyya/dsh-delegate)。npm 尚未作为安装渠道发布；
> GitHub Release 附带的 `.tgz` 是推荐的安装包。`1.1.0` 的静默等待说明见
> [`docs/silent-wait.md`](./docs/silent-wait.md)；`1.2.0` 修正了其中三处真实问题（等待中断的
> 语义、串行宿主下的控制能力、已安装 Codex 集成升级遗漏），见第 7.4 节。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.1-rc.3` / `0.2.2-rc.1` | `peerDependencies` 精确声明这四个版本的范围（`0.2.0-rc.2 \|\| 0.2.1-rc.2 \|\| 0.2.1-rc.3 \|\| 0.2.2-rc.1`）；DSH 启动时会用 `semver` 加 `includePrerelease` 校验 `@deepseek-ai/dsh-*` 的 peer 范围，不匹配的插件行会被拒绝加载（`skippedBundles` / denied row）。`0.2.0-rc.2` 是开发与自动测试所用版本；`0.2.1-rc.2` 在**隔离 profile** 中完成验收（未写入正式 profile）；`0.2.1-rc.3` 为上一宿主版本（本次没有在它上面重新做原生全量验证）；`0.2.2-rc.1` 是本次新增支持的 DSH Desktop 原生运行时（原生源码已审计；原生 base+web+delegate 全量 profile 加载、stdio MCP、runner 模型路由回读、沙箱策略回读均已在隔离夹具中通过；但**没有真实模型调用、没有实际沙箱命令、没有生产 Desktop 安装**）。之前声明过的版本一个都没有移除。其他 DSH 版本**未经验证**，请不要假定可用。逐版本状态见 [`docs/runtime-compatibility.md`](./docs/runtime-compatibility.md)。 |
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
   #    → dsh-delegate-1.2.0.tgz
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
dsh plugin --profile web add ./dsh-delegate-1.2.0.tgz && dsh plugin --profile web why dsh-delegate

# 启动（首次启动会自动把插件 bundle 追加到 dsh.profile.bundles）
dsh --profile web
```

> **不要用这条路径装进 Desktop。** Desktop 的 profile 是保留的，npm/CLI 对它的操作会被
> 拒绝；Desktop 的安装、升级和卸载都在应用内的 Plugins manager 完成。上面的命令只适用于
> 你自己用 CLI 启动的 web profile。

### 说明与注意

- **不要装进你正在用的正式 profile 做试验。** 建议先用一次性 profile：
  `dsh plugin --profile dsh-delegate-try add ./dsh-delegate-1.2.0.tgz`，再把
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

包内可执行文件 `bin/dsh-delegate-mcp.js`（bin 名 `dsh-delegate-mcp`）实现了六个工具：
`delegate_status` / `delegate_preflight` / `delegate_submit` / `delegate_result` / `delegate_cancel` /
`delegate_permission_decide`。
它**不提供**授权、配置写入或凭据读写工具。`delegate_permission_decide` 是唯一一条窄例外：
它只能回答一个**已经挂起**的「单次调用授权请求」，给 `allow-once`（仅这一次调用可继续）或
`reject`。它不能创建或扩大任何**长期有效**的授权，不能修改设置、凭据、本机开关、提供方/模型或隔离方式，
也不能预先批准后续调用。

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
- 工具为 `delegate_status`、`delegate_preflight`、`delegate_submit`、`delegate_result`、
  `delegate_cancel` 和 `delegate_permission_decide`。
- 开关关闭时，`delegate_submit` 与 `delegate_permission_decide` 返回 `DELEGATION_DISABLED`；状态、
  预检、结果和取消工具仍可使用。`delegate_preflight` 只读取工作区事实，不创建任何东西，因此不受
  开关和并发上限限制。

**任务会话与跟进（`continueFromTaskId`）**：`delegate_submit` 有一个可选字段
`continueFromTaskId`。

- **省略**：永远新开一条 DSH 会话。同一目录之前跑过多少任务都不影响，旧设置里残留的
  `conversation.mode: "reuse"` 也不会让新提交接续任何旧对话。
- **填写**：声明本次提交是某个先前任务的跟进，必须续接**那一条**任务会话（同 Workspace、同
  Session）。只用于属于同一任务的修改、纠正或重试；无关任务一律省略，不要"为了保留上下文"
  随手复用 id。
- **续接必须由同一已验证 `connectionId` 发起。** 连接身份取自本次请求认证后的连接记录，不是
  请求体里自称的值；父任务一侧的身份也必须是被证明过的。不同连接**禁止接管**别人的任务：
  按 task id 续接别的连接的任务会被当作不存在（`JOB_TASK_NOT_FOUND`，与"没有这个任务"不可区分，
  因此不能用来探测别的连接有哪些 task id），**不存在** permission handoff，也**不**按连接
  label 或任何其他可见名字做匹配。
- **同一进程用 live 记录，重启后用持久记录互证。** 父任务仍在内存里时，归属由那条 live 记录
  自己的 `connectionId` 直接比对；进程重启后内存已空，持久化的"任务→会话"映射只说明会话在
  哪里，从不说它属于谁、也不说那次运行如何结束，因此必须再读一份持久 job history
  （`HistoryStore`）作为第二权威：那条记录说出**同一个** owner、一个**可续接的终态**，以及
  相同的源仓库与执行目录。缺一边就不能证明归属，一律拒绝。
- **缺失、损坏、被淘汰或不能证明的，一律拒绝。** 未知的 task id、已超出保留上限被淘汰的
  记录、读不出的历史、被截断（`truncation` 非空）而不能当作完整证据的记录、未记录的终态、
  重启中断留下的 `interrupted`、仍在 `pending`/`running` 的父任务、没有产生过对话的失败任务、
  不同源仓库、不同执行目录、已删除或身份不符的工作树、已不存在的 Session，都会被拒绝
  （`JOB_CONTINUATION_REFUSED`，`error.details.session` 给出具体原因），**不会**悄悄改成新开会话。
- **`local-mcp` 是一个明确固定的身份，不是通配符。** 本机开关这条路径下，连接身份固定为
  `local-mcp` 并和其他连接一样**精确比对**；它既不等于"null"，也不代表"所有远程连接"。
  没有经过验证的连接身份的请求不能证明自己拥有任何一个持久化父任务，因此被拒绝，而不会被
  当成"任意归属"放行。
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
   `delegate_preflight` / `delegate_submit` / `delegate_result` / `delegate_cancel` /
   `delegate_permission_decide`。

需要说明的边界（分页里也有同样的提示）：

- **只有点击才会新建，启动只做受限刷新。** 打开分页、安装/升级 `.tgz` 都不会碰 Codex 目录；
  新建 agent、登记或迁移 `config.toml` 条目、移除托管项都只能通过「安装 / 更新 Codex 集成」
  「仅修复 MCP 配置」「移除插件托管项」三个按钮。唯一的例外是**插件启动时的一次受限迁移**：
  只有当 `agents/dsh-delegate.toml` 与某个**已发布版本的模板逐字节相同**（枚举的摘要表）时，
  才会把它刷新为当前版本；比较的是**原始字节**，插件不会把 CRLF 归一化成 LF 再比，也不会改写
  你文件的行尾。已发布版本若同时存在打包的 CRLF 与 LF 文本两种字节形态，摘要表会为两种形态各列
  一条，两条都是精确的已发布身份。它**不会**创建缺失的 agent、不会创建 `agents/` 目录、不会写
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

已安装的托管 MCP 条目会在插件启动时**自动**原地补齐缺失的 `tool_timeout_sec`（入口脚本正好是
本安装时）。入口路径已经指向旧安装的条目不会被启动自检改写：请用「安装 / 更新 Codex 集成」或
「仅修复 MCP 配置」显式采纳，只有在证明旧路径是同一包的真实安装后才会改写。显式按钮仍然是
未安装时唯一会创建条目的动作。

## 7. 凭据隔离

- provider、地址和密钥由 DSH 自己管理；插件通过 DSH 原生 provider 调用现有配置。
- 插件配置和任务结果不复制或返回 DSH 的密钥。导出配置只含非敏感选择与执行设置。

## 7.1 Worker 会话权限（0.1.12 起适配 DSH 0.2.2）

受委派的 worker 任务由插件在**投递提示词之前**装入 DSH 原生的会话权限，并通过 DSH 自己的
服务读回：

- 沙箱模式固定为 `workspace-write`。审批策略有两个值，且**只有一种情况**是 `ask`：
  本次运行带着一个**已武装、且绑定到该 Agent** 的逐次授权桥。其余所有运行（没有桥、桥未武装、
  桥已释放、桥绑在别的 Agent 上）都保持 `never`。`never` 是**确定性拒绝**，不是自动批准：
  提权请求会被直接拒绝，不会停留在等待一个本插件无法回答的审批框。
- 写入策略与审批策略各写一次 Session 事件（`sandbox/mode`、`approval/policy`），随后必须由
  `ctx.sandboxPolicy.resolve({ session })` 与 `ctx.approval.effectivePolicy(session)` **读回**，
  且读回的模式、审批立场、工作区根目录都要与写入值和该会话自身目录一致；任一项缺失、拒绝回答
  或读回不符，任务在投递提示词前就以 `RUN_SANDBOX_POLICY_UNAVAILABLE` 失败；桥无法武装时以
  `RUN_PERMISSION_BRIDGE_UNAVAILABLE` 失败。不会以“看起来受限”的状态运行。
- 每轮（包括 `continueFromTaskId` 的跟进）都会重新应用一次，因此续接的会话收敛到当前契约，
  不会沿用更早、可能是交互式的策略。
- **附加审查与普通会话不受影响**：只读审查使用它自己的只读工具与工作区组合，不进入上面的
  worker 沙箱流程，也不会拿到逐次授权桥；插件的审批应答器只注册在本次 worker 运行自己的
  Agent 作用域上，对其他会话的请求一律放行给它原本的应答者。
- 系统临时区（`tmpdir()`）是 DSH 原生平台层的例外，不是本插件授予的写权限。
- **DSH 0.2.2 起**：判定模型路线走原生的 `agent.model.select()` / `agent.model.current()`
  （持久化的 `model/selection` 事件），工作者的策略读回也在原生服务完成异步初始化之后按轮进行。
  插件不按版本号分支，而是按**实际探测到的能力**分支：能力存在的运行时走现代路径，能力缺失的
  运行时走旧路径；读回失败在任何路径上都是投递提示词之前的严格失败，不会以“未声明的路线”运行。
  细节与逐版本对照见 [`docs/runtime-compatibility.md`](./docs/runtime-compatibility.md)。
- 续接的会话身份规则见第 6 节（同一已验证 `connectionId`、重启后与持久 history 互证）。这条
  能力在本轮候选构建里实现，验收由 Codex 另行出报告；本文件**不声称** DSH Desktop 真实安装
  已通过，也不声称做过真实攻击复现。
- 其余未完成项：DSH Desktop 正式版本上的真实安装验收尚未完成；`0.2.2-rc.1` 上的插件全量加载
  与真实模型执行也尚未完成。不要把它们当作已验证。

详见 `docs/worker-permissions.md`。

## 7.2 逐次调用授权桥（1.0.0）

> **状态：** 本项目内测试通过，但**生产验收尚未完成**。安装后必须在 Desktop 插件管理器中升级本插件，
> 再重连 MCP 或开启新会话，才能看到 `delegate_permission_decide`；真实的 provider → 指挥官 → 恢复执行
> 端到端验收仍需在目标 Desktop profile 中完成。任何单元测试数量或 mock 都不能替代那次验收。

worker 请求把**某一次调用**的沙箱权限提升时，那次调用会暂停执行，请求出现在
`delegate_result` 的 `permission.pending` 里：任务状态仍是 `running`，阶段为
`awaiting-permission` —— 既不失败，也不算执行完成，工作区锁与并发槽位仍归该任务。本机指挥官
通过 `delegate_permission_decide` 给出 `allow-once`（仅这一次调用可继续）或 `reject`。

- **绑定**：任务、Session、工具名、一次性 `requestId`、原生 `callId`，以及对**真实参数**的
  精确指纹。真实参数从 Session 日志的 `tool/call` 事件按 `callId` 读取，**不是** worker 自己
  写的理由；那段理由会作为「工作进程的说法」单独标注，不参与决定。
- **不是授权扩张**：它不能创建或扩大任何账号/工作区/会话授权，不能修改设置、凭据、本机开关、
  提供方、模型、推理强度或隔离方式，也不能预先批准后续调用。`allow-once` 只对那一次调用有效，
  下一次提权要重新请求；会话的常规沙箱模式始终是 `workspace-write`。
- **不是自动放行、不是第二个模型审查、不依赖人工点击**：决定者是当前的本机指挥官。
- **允许的代价**：`allow-once` 必须同时满足——报出该请求的精确 `fingerprint`；发布的参数是
  **完整**的（`permission.pending.completeness` 为 `complete`，没有被任何上限截断）；决定时
  重新读取 Session 日志中同一位置的 `tool/call` 且内容逐字节一致；该调用所在回合仍然打开。
  任一项不满足就拒绝这次允许（`PERMISSION_EVIDENCE_INCOMPLETE` / `PERMISSION_REQUEST_CHANGED`）。
  `reject` 不需要指纹也不需要完整证据，因为拒绝永远安全。
- **诚实的边界**：该工具**不在** worker 原生声明的工具目录里，所以 worker 的模型不会被交给它
  ——这是一条**工具面限制**。它**不代表**同一操作系统用户下的任意 shell 进程无法直接调用那个
  共享的本地 MCP 端点。开关模式刻意只用一个共享的 `local-mcp` 身份、不签发用户令牌，因此本机
  进程可以自称指挥官；本契约不依赖任何调用方自称的角色。
- **等待不占用执行超时**：等待期间执行截止时间被**真正暂停**（计时器解除、已用时间结算），所以
  一次比剩余预算更长的等待不会让任务超时；恢复后按剩余预算重新计时。请求自己另有固定上限
  （默认 10 分钟，上限 30 分钟）。取消、关闭开关、撤销、Agent 释放、插件卸载和该上限都会结算等待
  并把计时器/监听器复原；重启后不会把任何已存的决定重放成新的允许。
- **诚实的限制**：开关模式刻意使用同一个 `local-mcp` 连接身份，所以本插件**不**声称能对抗同一
  操作系统用户下的任意本地代码。决定只作用于调用者自己这个连接名下的任务（别人的任务按
  「不存在」处理），但这不构成进程级安全边界。

细节与原生 API 依据见 `docs/worker-permissions.md`。

## 7.3 静默等待与集中审查（1.1.0）

正常推进的任务**不再**需要派工方一遍遍读结果。默认 5 分钟安静后，插件在本机做一次
**只读自检**；10 分钟仍然安静，才把 `attention` 报告给派工方。真实推进（模型输出、推理、
工具调用与结果）只会**重置**计时，属于内部事实，不会叫醒任何人。

- 只读自检：看执行器是否还在、当前阶段、有没有待决定的调用、正在跑哪个工具。
  **不调用任何大模型**，不读代码差异，不改任务状态、不动时限。
- 安静不等于失败，单个工具跑得久也不等于失败；插件不会因为时长而判失败、取消或重启。
- 连接心跳、结果轮询、页面刷新都不算进展；否则真正卡住的执行器会永远"看起来在动"。
- 提醒有冷却：同一次静默里到点报一次，之后要再过同样的间隔才会再报。
- 间隔是全局设置（`monitoring.selfCheckSeconds` / `monitoring.attentionSeconds`，存成整秒），
  项目覆盖和单任务覆盖都不能改它。设置页在「执行设置」里的**进阶：静默监控间隔**卡片，
  以分钟呈现、按秒保存，也可以点页面底部的「保存设置」一起保存。
- 修改只影响**之后新提交**的任务；运行中的任务保留它开始时冻结的那份间隔快照。
- 任务记录页在有进行中任务、且页面可见时每 5 秒只读刷新一次；终端状态的任务不会触发刷新。
  详情里显示阶段、最近进展、当前工具与其耗时、无进展诊断；旧版本写的记录会如实显示
  “未采集到”，不会编造空闲时间。

Codex 子智能体现在按「提交 → `delegate_wait` 同一任务」运作：`heartbeat` 是内部心跳，
不会送到模型；`attention` 是提问、默认继续等；`permission` 审查这一次调用后决定再继续等；
`ready`/`failed`/`cancelled` 只读**一次**完整证据；`interrupted`/`wait-limit` 立刻重新等待
同一任务。托管 MCP 条目会写入 `tool_timeout_sec = 3660`，让认这个字段的客户端允许一次默认
60 分钟的等待跑完；客户端如果应用自己的默认工具超时（Codex 的历史默认是一分钟），仍可能提前
结束等待，这是插件不能解除的客户端限制。

升级后的操作：设置页 → Codex 集成 → **安装 / 更新 Codex 集成**，然后让 Codex 重新载入
（新开会话或重启）。

完整说明见 [`docs/silent-wait.md`](./docs/silent-wait.md)。

**这不是省 token 的承诺**：插件只改变"什么时候把什么告诉派工方"，不控制 Codex 自己的上下文
与思考开销，也不做节省量的估算。

## 7.4 1.2.0：等待中断、独立控制通道与已安装集成升级

`1.1.0` 的真实验收报告指出了三个问题，本版本逐一修正。这里如实写明**改了什么、没改什么**。

### 等待中断 ≠ 执行中断

`delegate_wait` 的 `interrupted` 原来被当成终态返回，而插件发出的 `interrupted` 多数时候
只是**观察者自己的这次请求结束**（调用方取消、连接断开、引擎在重建时释放了等待者）。任务
仍在运行，宿主却以为执行结束了。

- 现在由**任务记录**决定：`state` 是 `pending`/`running` 且 `endedAt` 为 `null` 时，这次
  中断只算“本次观察结束”，答案带着真实状态与 `terminal: false` 返回，指令要求**继续等同一
  `taskId`**。一次调用不再在内部重发观察——真实被释放的观察者会让每次观察都立刻返回
  `interrupted`，旧写法会把一次 `delegate_wait` 变成无界的请求风暴。
- 真正来自重启历史的 `state: interrupted` 才是不可恢复的终态：`terminal: true`，并明确告诉
  宿主**不要**继续盲等同一任务。
- 中断同时带着真实结局时按结局返回：`awaiting-host-review` 是 `ready`（所以审查不会被挡住），
  `failed`/`cancelled` 各按自己返回。
- 状态缺失、或本构建不认识的状态一律**不做断言**：`terminal: false`，指令要求先核对；既不宣称
  “已停止”，也不宣称“仍在运行”，更不把未知状态当成重启历史。
- `ready`/`failed`/`cancelled` 自己的行为不变；`ready` 不会凭原因编造 `state: "ready"`，缺失
  任务状态时 `state` 为 `null`。
- 任务记录页把真实的 `interrupted` 历史显示为「已中断（进程重启后不会继续执行）」，不会
  再显示成“仍在运行”。

### 串行宿主下的独立控制通道

插件自己的 stdio MCP 服务器**本来就支持并发**（一个长 `delegate_wait` 在飞时，status、cancel
照样能被回答）。瓶颈在外层宿主：一次只转发一个工具调用的客户端，会让整条 MCP 连接被等待占住。

- 不承诺改变 Codex 的调度器，也不把长等待退化成轮询。新增独立本地控制程序
  `dsh-delegate-control`（`bin/dsh-delegate-control.js`，已注册到 `package.json` 的 `bin`），
  用**同一个** `createExecutionClient` 和端点发现调用现有 loopback 执行面：
  - `status <taskId>`：用 `observe` + **最小有界观察**（`waitMs: 1`）取一次紧凑状态（无 diff、无对话、无密钥）。
    这里**不是** `waitMs: 0`：引擎和监控都把非正的等待当成“没指定上界”，会替换成 25 秒的默认长等待，
    那样一次状态查询就会超出这条命令自己的预算；
  - `cancel <taskId>`：只停止指定的那个任务。
  - 没有提交、设置、总开关、批量取消或默认放行；不新增权限、开关、配置接口或常驻后台进程。
  - **整次命令一份总预算**：默认 **10 秒**，`DSH_DELEGATE_CONTROL_TIMEOUT_MS` 只能把它**调小**
    （填更大的值会被夹回 10 秒；缺省或不可用的 `timeoutMs` 同样按 10 秒算）。预算通过调用方
    `AbortSignal` 生效，并**对本次调用禁用观察重试**，所以断线时不会去跑 1 秒/2 秒/5 秒的退避，
    也不会有请求在命令回答之后还在跑。没有 `Promise.race`，没有遗留后台请求或进程。
    任何断线或超时都是有界 JSON + 非零退出码（超时的 `code` 是 `CONTROL_TIMEOUT`），没有堆栈、没有秘密；
    stdout 只有一个稳定的 JSON 文档，诊断走 stderr；`0` = 有答案，`1` = 被拒绝或超时，`2` = 用法错误。
  - 普通等待**不会周期性调用 status**；这个通道只在操作者显式调用时发起请求。
- 等待监听断开只会释放观察，**取消必须是显式 `cancel`**。
- 子智能体规则同步：只有用户明确要求停止/查看任务、而宿主把同一条 MCP 连接阻塞住时，才用
  与已配置 MCP 脚本同目录的这个控制程序；普通等待期间保持静默。
- 工具目录补上了准确的 MCP `annotations`（`readOnlyHint` 等），帮助支持并发的客户端识别长等待
  是只读调用。注解**不是**修复：串行客户端照样忽略它，这正是上面独立通道存在的原因。

### 已安装 Codex 集成的升级

`1.1.0` 的启动自检只刷新 agent 文件。因此从 `1.0.0` 升上来的已安装 MCP 表仍然只有
`command`/`args`、缺 `tool_timeout_sec = 3660`；客户端可能因此更早结束一次 60 分钟的等待
（Codex 的历史默认是一分钟）。这个字段只能**请求**客户端放宽时长，不能解除客户端自身的限制。

- 启动自检现在也检查已安装的托管 MCP 条目：只有能证明是本插件写入的（带托管标记注释、
  command 是本包的 Node 命令、`args[0]` 正好是本安装的 `dsh-delegate-mcp.js`）**且**缺
  `tool_timeout_sec` 的条目，才会在原地补齐。入口路径已经指向旧安装的条目只会被报告为
  `conflict`，启动不会替操作者改路径。
- 「安装 / 更新 Codex 集成」或「仅修复 MCP 配置」是唯一会采纳旧路径的入口：它要求旧路径是
  真实安装（真实的 root/bin/入口文件，`package.json` 的 `name` 是本包且
  `bin["dsh-delegate-mcp"]` 映射到该入口），并在写入前重查当前 config 指纹、边界和条目所有权；
  期间有任何改动就拒绝。
- **绝不会**在未安装时创建配置、不会采纳同名非托管条目或用户改写过形态的条目、不穿过
  `$CODEX_HOME` 或 `agents/` 上的符号链接/junction（现在连 MCP 条目的**报告**都不再穿链接）、
  不触碰其他 MCP 与设置；写入仍是原子 + 备份形态，并在写前重新读取并重新判定，发生漂移就拒绝。
  备份目录的**整条祖先链**都会被检查：备份目录之上任何一级是符号链接/junction、不可验证或
  不是目录都拒绝升级，缺失层级逐级创建并复核，绝不沿链接把完整 config 写出去。
- 已发布的 `1.1.0` 子智能体文件（CRLF 与 LF 两种字节形态）已加入精确识别列表，所以旧
  agent 能安全升级；`1.1.0` 之前、正文已变的历史版本按各自已发布的精确摘要识别。
- 设置页保留显式「安装 / 更新 Codex 集成」按钮，并显示 `outdated` 的**具体漂移项**与说明。

### 本版本没有做什么

- 没有再次执行 DSH Desktop 正式 profile 上的端到端真实模型运行，也没有实测宿主串行时控制通道的
  现场行为（自动测试用的是本机 mock 执行面与真实 stdio 夹具，不依赖真实模型）。
- 不提交、不推送、不发布；npm 仍未作为安装渠道。

## 8. 升级 / 导出 / 卸载 / 回滚

```bash
# Desktop：在 Plugins manager 里对已安装的 dsh-delegate 执行更新 / 卸载
# （先 npm pack 出新 .tgz，再用 add-plugin 添加新版本）。
# 不要在 Desktop 的正式 profile 下执行下面的 CLI 命令。

# CLI web profile 的升级：换成本地新包或（将来）新版本
dsh plugin --profile web add ./dsh-delegate-1.2.0.tgz

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

- **发布渠道**：当前通过 GitHub Release 分发；尚未发布到 npm，也没有签名产物或自动更新。
- **DSH 版本锁定**：`peerDependencies` 与 `engines.dsh` 精确声明四个版本（`0.2.0-rc.2`、
  `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.2-rc.1`），其余版本会被 peer 门禁拒绝。其中
  `0.2.0-rc.2` 是开发与自动测试版本，`0.2.1-rc.2` 的验收在**隔离 profile** 中完成，
  `0.2.1-rc.3` 为上一宿主版本（本次未在它上面重新做原生全量验证），`0.2.2-rc.1` 是本次新增支持的原生
  运行时——原生源码已审计，原生 base+web+delegate 全量 profile 加载、stdio MCP、runner 模型路由
  回读与沙箱策略回读均已在隔离夹具中通过，但**没有真实模型调用**、**没有实际沙箱命令**，
  也**没有**在生产 Desktop profile 上做端到端安装运行。逐版本状态见
  [`docs/runtime-compatibility.md`](./docs/runtime-compatibility.md)。
- **更早的插件版本会被新宿主的门禁跳过**：`0.2.2-rc.1` 宿主不会加载未声明该版本的旧插件
  （即上一版与更早的构建），而是报 `skippedBundles` / denied row。想在新宿主上使用本插件的
  行为，需要升级插件，而不是放宽门禁。
- **本机开关不是进程身份认证**：开关开启时，能连接本机 DSH 端口的同机进程可以提交任务。
  不要在不可信的本机环境中开启；它不能防御同账号的恶意进程。
- **逐次授权桥同样不是进程级边界**：开关模式刻意只用一个 `local-mcp` 连接身份，所以
  `delegate_permission_decide` 的调用者身份就是那个共享身份。决定只会作用于**调用者自己这个
  连接名下的任务**（别人的任务按"不存在"处理，无法借此试探其他任务），但本插件**不声称**能
  对抗同一操作系统用户下的任意本地代码。桥不引入新的令牌、签名或角色标签。
- **静默监控不是进度模型**：插件不计算完成百分比，不预测剩余时间，也不读取代码内容来判断
  “是否在推进”。它只看执行器是否真的产生了事件。一次 `attention` 是提示，不是结论；
  一个非常安静但确实在工作的长步骤，也可能到达提醒阈值。
- **不承诺省多少 token**：`1.1.0` 起改变的是"什么时候把什么告诉派工方"。Codex 自己的上下文、
  思考与工具往返开销不由本插件控制，本插件也不做节省量的估算或承诺。
- **只在有人观察时运行**：没有派工方在等待时，监控不启动定时器、不消耗资源，也不会提醒。
- **等待中断不等于执行中断**：`delegate_wait` 返回的 `interrupted` 只描述这次等待；任务仍在
  `pending`/`running` 时它是非终态，答案里带着真实任务状态。只有任务记录本身是 `interrupted`
  （重启历史）才是终态。不要把这两个概念混为一谈，也不要把非终态答案当作执行结束。
- **串行宿主下没有通用的“并发”承诺**：插件自己的 MCP 传输支持并发，但客户端一次只转发一个调用时，
  同一条连接仍会被长等待占住。可用的是独立控制程序（`dsh-delegate-control status|cancel <taskId>`），
  它只有这两个动作，也不能改变宿主的调度方式。
- **逐次授权桥只决定一次调用**：`allow-once` 只对那一次原生工具调用有效，会话的常规沙箱模式
  仍是 `workspace-write`；它不能创建或扩大任何账号/工作区/会话授权，不能改设置/凭据/开关/
  提供方/模型/隔离，也不能预先批准后续调用。它是本机指挥官的决定，不是自动放行规则、不是
  第二个模型审查、也不依赖人工点击。
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
  - 启动自检只补齐**已安装、入口正好是本安装**且能证明属于本插件的托管 MCP 条目缺失的
    `tool_timeout_sec`，不会在未安装时创建条目，也不会采纳同名非托管条目或用户改写过的条目；
    入口路径指向旧安装时只会报告冲突，需用显式按钮在证明该路径是同一包的真实安装后才会被采纳。
    链接（含 Windows junction）边界一律拒绝，连 MCP 条目的报告也不再穿过链接；备份目录的整条
    祖先链同样会被证明，绝不沿链接把完整 config 写出去。
  - 安装/修复不会打开本机调用开关；开关仍由操作者在第 4 节的位置单独控制。

## 10. 开发

```bash
npm install          # 安装开发依赖（仅本仓库内）
npm test             # node --test --test-concurrency=1 tests/*.test.js
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
| `tests/codex-integration.test.js` | 路径与可执行文件推导（普通 Node / Electron / 随包 Node / 环境变量 / 失败即拒绝）、幂等安装、用户文件保留、MCP 冲突拒绝、写入保真、路由契约、只读 status、入口真实性（真实安装的 manifest `name` + `bin` 映射、POSIX 根、同布局 wrapper 拒绝）、备份祖先链（链接/junction/非目录拒绝、缺失层级创建）、已发布模板迁移（上一版与更早版本、同一版本的 LF 与 CRLF 两种字节，逐字节比对且不归一化行尾） |
| `tests/codex-agent.test.js` | 本版本之前的 `manageCodexAgent` 兼容入口 |
| `tests/codex-ui.test.js` | 设置页流程：`init` 只读、每个动作恰好一次 POST、三种状态分离、构建产物含面板与限制说明 |

## 许可证

MIT，见 [LICENSE](./LICENSE)。
