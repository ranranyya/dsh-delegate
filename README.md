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
| DSH | `0.2.0-rc.2` / `0.2.1-rc.2` | `peerDependencies` 精确声明这两个版本的范围（`0.2.0-rc.2 \|\| 0.2.1-rc.2`）；DSH 启动时会用 `semver` 加 `includePrerelease` 校验 `@deepseek-ai/dsh-*` 的 peer 范围，不匹配的插件行会被拒绝加载（`skippedBundles` / denied row）。`0.2.0-rc.2` 是开发与自动测试所用版本；`0.2.1-rc.2` 在**隔离 profile** 中完成验收（未写入正式 profile）。其他 DSH 版本**未经验证**，请不要假定可用。 |
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
   #    → dsh-delegate-0.1.5.tgz
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
dsh plugin --profile web add ./dsh-delegate-0.1.5.tgz && dsh plugin --profile web why dsh-delegate

# 启动（首次启动会自动把插件 bundle 追加到 dsh.profile.bundles）
dsh --profile web
```

> **不要用这条路径装进 Desktop。** Desktop 的 profile 是保留的，npm/CLI 对它的操作会被
> 拒绝；Desktop 的安装、升级和卸载都在应用内的 Plugins manager 完成。上面的命令只适用于
> 你自己用 CLI 启动的 web profile。

### 说明与注意

- **不要装进你正在用的正式 profile 做试验。** 建议先用一次性 profile：
  `dsh plugin --profile dsh-delegate-try add ./dsh-delegate-0.1.5.tgz`，再把
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
移除，不再有那一页。页面分区：

1. **本机调用授权**——单一开关。关闭后拒绝新提交并请求停止运行中的任务。
2. **API 管理**——从 DSH 已注册的接口中选择；模型和推理强度由 DSH 当前目录同步。
3. **执行设置**——provider / 模型 / 推理强度 / 超时 / 最大并发 / 工作区隔离。
4. **附加审查**——独立 provider / 模型 / 强度；默认关闭，与授权无关。
5. **任务记录**——状态、实际 provider/model/effort、变更文件、diff、验证证据。

界面只负责切换本机调用能力和配置；任务由 MCP 宿主提交。

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

包内可执行文件 `bin/dsh-delegate-mcp.js`（bin 名 `dsh-delegate-mcp`）实现了四个工具：
`delegate_status` / `delegate_submit` / `delegate_result` / `delegate_cancel`。
它**不提供**授权、配置写入或凭据读写工具。

在需要调用委派工具的 MCP 宿主中添加 stdio server（以下为通用配置示意）：

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
- 工具为 `delegate_status`、`delegate_submit`、`delegate_result` 和 `delegate_cancel`。
- 开关关闭时，`delegate_submit` 返回 `DELEGATION_DISABLED`；状态、结果和取消工具仍可使用。

### 6.1 Codex 子智能体（可选）

插件本身只安装在 DSH。需要从 Codex 明确调用时，可另外安装一个 Codex 自定义子智能体；它只负责检查总开关、把限定任务交给 Delegate，再把结果交回 Codex 审查。调用时不传 provider、模型或思考强度覆盖，因此使用 DSH 插件中选定的 worker 配置，以及匹配项目的有效覆盖设置：

```bash
node bin/dsh-delegate-codex-agent.js install
node bin/dsh-delegate-codex-agent.js status
node bin/dsh-delegate-codex-agent.js remove
```

命令在仓库副本或解包后的插件目录中运行。默认只写入 `~/.codex/agents/dsh-delegate.toml`；设置了 `CODEX_HOME` 时使用该目录。安装不修改 `config.toml`、不注册 MCP，也不会替用户开启 DSH 总开关。Codex 主会话需要先能看到 `delegate_status` 等 DSH Delegate MCP 工具；子智能体继承主会话的 MCP 连接。不同内容的同名 agent 会阻止安装；卸载只删除仍与内置模板完全一致的文件。配置更新后按 Codex 的自定义 agent 流程重新载入配置。

Codex 官方文档说明了[自定义子智能体](https://learn.chatgpt.com/docs/agent-configuration/subagents)和[MCP 连接](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。这些文档支持 agent 配置与 MCP 继承，但没有承诺在输入框键入 `@dsh-delegate` 就会选择它；是否可通过 `@` 直接调用取决于当前 Codex 界面能力。

## 7. 凭据隔离

- provider、地址和密钥由 DSH 自己管理；插件通过 DSH 原生 provider 调用现有配置。
- 插件配置和任务结果不复制或返回 DSH 的密钥。导出配置只含非敏感选择与执行设置。

## 8. 升级 / 导出 / 卸载 / 回滚

```bash
# Desktop：在 Plugins manager 里对已安装的 dsh-delegate 执行更新 / 卸载
# （先 npm pack 出新 .tgz，再用 add-plugin 添加新版本）。
# 不要在 Desktop 的正式 profile 下执行下面的 CLI 命令。

# CLI web profile 的升级：换成本地新包或（将来）新版本
dsh plugin --profile web add ./dsh-delegate-0.1.5.tgz

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

## 9. 限制（请如实理解）

- **没有发布渠道**：无 GitHub 仓库、无 npm 版本、无签名产物、无自动更新。
- **DSH 版本锁定**：只验证了 `0.2.0-rc.2` 与 `0.2.1-rc.2` 两个版本；其中 `0.2.1-rc.2`
  的验收在**隔离 profile** 中完成。其他版本会被 peer 门禁拒绝，或行为未知。
- **本机开关不是进程身份认证**：开关开启时，能连接本机 DSH 端口的同机进程可以提交任务。
  不要在不可信的本机环境中开启；它不能防御同账号的恶意进程。
- **工作树隔离需要 git**：默认 `worktree` 隔离要求源目录是已提交的 git 仓库；
  否则显式拒绝。`shared` 模式不是隔离，界面会如实标注。
- **审查不是批准**：附加审查只产出发现，不代表宿主验收；任务完成状态是
  "等待宿主审查"，不是"已通过"。

## 10. 开发

```bash
npm install          # 安装开发依赖（仅本仓库内）
npm test             # node --test，578 项
npm run check:client # scripts/build-client.mjs --check，校验 lib/client.js 与源码一致
npm run build:client # 由 src/client/index.jsx 重建 lib/client.js
npm run pack:dry     # npm pack --dry-run
```

`lib/client.js` 是构建产物，必须与源码一致；`--check` 会重建到临时目录并对比。
客户端 bundle 只允许请求平台模块表里的 `react` / `react/jsx-runtime`，因此
`package.json` 不需要 `dsh.client.external`。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
