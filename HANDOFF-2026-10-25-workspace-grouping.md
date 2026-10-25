# dsh-delegate 交接报告：DSH Workspace 分组与会话复用

日期：2026-10-25
仓库：`E:\deepseek workplace\dsh-delegate`
版本：`0.1.8`

## 1. 本轮目标

本轮处理的是 DSH 工作区中任务都堆在“未分区”的问题。目标是让每个实际执行目录对应一个 DSH Workspace，并让同一目录下的任务可以选择新建会话或继续上一次会话，同时不跨目录复用会话。

## 2. 已完成

- 新增 `src/runtime/session-placement.js`：
  - 按实际执行目录调用 `workspaceController.create({ path })`，重复执行时复用同一 Workspace。
  - `conversation.mode = new` 时在该 Workspace 创建新 Session。
  - `conversation.mode = reuse` 时只在相同规范化目录下恢复已记录的 Session。
  - 对缺少原生服务、目录不匹配、Session 不存在、Agent 无法解析等情况 fail-closed，返回明确的 `SESSION_*` 拒绝码。
  - 使用数据目录下的 `sessions.json` 保存最小身份映射：`path`、`workspaceId`、`sessionId`、`updatedAt`；不保存提示词、对话正文、模型输出、token 或凭据。
- `src/runtime/agent-runner.js` 已接入放置流程。已放置的 Agent 由原生 Session 所有，执行器不会错误地再次创建或销毁它。
- `src/jobs/engine.js` 已接入会话模式、执行结果和会话保存记录；无法保存复用身份不会改变本次任务的执行结果。
- 设置、客户端 Execution 面板、任务历史和公开设置投影已支持 `new/reuse`，旧设置缺少字段时安全默认为 `new`。
- 新增说明文档 `docs/conversation-placement.md`，并加入 `package.json` 的发布文件清单。
- 已保留之前完成的 Codex 集成、MCP/端点发现、provider 路由、预检、审查和历史记录改动；本轮没有回滚或覆盖这些已有改动。

## 3. 原生 API 核对

已针对本机 DSH `2.2.19` 运行时声明核对并按实际签名实现：

- `workspaceController.create({ path })`
- `sessionController.create({ workspaceId?, cwd?, sessionId?, agentPreset? })`
- `sessionController.resolveAgent(sessionId)`

特别确认：`ctx.sessions` 是原生持久化服务（例如 `flush`），不能创建或解析 Session；放置逻辑使用的是 `ctx.sessionController`，不是 `ctx.sessions`。

## 4. 验证结果

在当前工作树重新执行：

- `npm test`：`761` 个测试，`761` 通过，`0` 失败，退出码 `0`。
- `npm run check:client`：通过，`lib/client.js` 与客户端源码一致。
- 完整测试已包含 `tests/session-placement.test.js`、配置往返、任务引擎、MCP、Codex 集成、审查、历史、工作树和打包清单检查。

## 5. 当前打包产物

已从当前源码执行 `npm pack`，产物保存在：

`E:\deepseek workplace\dsh-delegate\dsh-delegate-0.1.8.tgz`

核验结果：

- npm 包版本：`0.1.8`
- 文件数：`55`
- 压缩包大小：`388407` 字节
- SHA-256：`EE8C5B0EFD94FA7A9CD558F6268170520AB9E844BF6480823B6BD94F79AD27EA`
- 包内确认包含：
  - `package/src/runtime/session-placement.js`
  - `package/src/runtime/agent-runner.js`
  - `package/src/jobs/engine.js`
  - `package/docs/conversation-placement.md`
- `package/codex/dsh-delegate.toml`（版本标记为 `0.1.8`）

仓库中原有的 `dsh-delegate-0.1.7.tgz` 与 `dsh-delegate-0.1.7-workspace-grouping-2026-10-25.tgz` 均保留供比对；它们是上一版本的构建。`dsh-delegate-0.1.8.tgz` 同样被 `.gitignore` 的 `*.tgz` 忽略。

## 6. 尚未完成与已知限制

### 6.1 桌面端尚未更新

本机安装目录：

`C:\Users\24615\.dsh\profiles\desktop\node_modules\dsh-delegate`

目前仍是版本 `0.1.7` 的旧安装内容，实测不包含：

`src\runtime\session-placement.js`

因此还没有声称“桌面端已经端到端验证 Workspace 分组/复用”。当前完成的是源码、测试和可安装 tarball；下一步应由操作者明确安装该新 tarball，然后重载 DSH，再验证实际任务是否出现在预期 Workspace 中。

### 6.2 需要在桌面端补做的验证

安装新包后，至少验证：

1. `conversation.mode = new`：相同执行目录的两次任务出现在同一 Workspace，但使用两个 Session。
2. `conversation.mode = reuse`：第二次任务恢复同一目录的上一 Session。
3. 切换到不同执行目录：不会复用另一目录的 Session。
4. 删除或失效已记录 Session：返回明确拒绝，不静默跨目录或无提示替换。
5. 关闭插件/重启 DSH 后，`sessions.json` 仍只含身份字段，且恢复行为符合设置。

### 6.3 仍需关注的历史运行问题

此前 DSH Crew 的 Flash 派单曾有上游流中断、超时和审查门控失败记录；本轮本地测试全部通过，但没有把 Crew 的旧失败记录当作本地实现已通过的证据。当前 Crew 记录的有效路由为 `workbuddy / deepseek-v4.1-flash / max`，没有活动 worker，reviewer 在当前会话中关闭。

## 7. 工作树与恢复方式

- 按仓库 `AGENTS.md` 要求，本轮没有 commit、push，也没有修改已安装的 DSH/Crew、凭据或其他仓库。
- 当前工作树仍包含此前及本轮的未提交修改；这些文件已保存在磁盘，不能通过 `git clean` 或回滚命令清理。
- 继续工作时先读取本报告、检查 `git status --short`，并以带日期的新 tarball SHA-256 为当前可安装构建的校验依据。
- 暂停期间不应把旧的 `dsh-delegate-0.1.7.tgz` 当作本轮构建；应使用上面列出的 `dsh-delegate-0.1.8.tgz`。

## 8. 建议的下一步顺序

1. 在 DSH 桌面端安装 `0.1.8` tarball并重载插件。
2. 读取设置确认 `conversation.mode` 的当前值；先用 `new` 做 Workspace 分组验证。
3. 再切换 `reuse` 做同目录续聊验证，并检查不同目录隔离。
4. 记录桌面端实际任务、Workspace、Session 和失败码，必要时再修正实现。
5. 桌面端验证通过后，再决定是否提升到新的版本号并发布到 GitHub。
