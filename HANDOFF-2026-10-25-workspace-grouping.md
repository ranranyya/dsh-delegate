# dsh-delegate 交接报告：DSH Workspace 分组与会话复用

更新日期：2026-10-26（基于 2026-10-25 交接记录）
仓库：`E:\deepseek workplace\dsh-delegate`
版本：`0.1.10`

## 1. 本轮目标

本轮处理的是 DSH 工作区中任务都堆在“未分区”的问题。目标是让每个实际执行目录对应一个 DSH Workspace；普通新任务创建独立会话，同一任务的修改、纠正或重试可以显式续接原任务会话，同时不跨目录复用会话。

## 2. 已完成

- 新增 `src/runtime/session-placement.js`：
  - 按实际执行目录调用 `workspaceController.create({ path })`，重复执行时复用同一 Workspace。
  - 不带 `continueFromTaskId` 时在该 Workspace 创建新 Session。
  - 只有显式带 `continueFromTaskId` 的跟进任务才恢复指定任务的 Session；不会按目录自动复用。
  - 对缺少原生服务、目录不匹配、Session 不存在、Agent 无法解析等情况 fail-closed，返回明确的 `SESSION_*` 拒绝码。
  - 使用数据目录下的 `sessions.json` 按任务保存最小身份映射：任务 id、源目录、执行目录、Workspace、Session、隔离和工作树身份；不保存提示词、对话正文、模型输出、token 或凭据。
- `src/runtime/agent-runner.js` 已接入放置流程。已放置的 Agent 由原生 Session 所有，执行器不会错误地再次创建或销毁它。
- `src/jobs/engine.js` 已接入任务线程续接、执行结果和会话保存记录；无法保存续接身份不会改变本次任务的执行结果。
- 目录级 `new/reuse` 设置已移除；旧设置只读兼容，实际策略由 `continueFromTaskId` 决定。
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

- `npm test`：`798` 个测试，`798` 通过，`0` 失败，退出码 `0`。
- `npm run check:client`：通过，`lib/client.js` 与客户端源码一致。
- `git diff --check`：通过。
- 完整测试已包含 `tests/session-placement.test.js`、配置往返、任务引擎、MCP、Codex 集成、审查、历史、工作树和打包清单检查。

## 5. 当前打包产物

已从当前源码执行 `npm pack`，产物保存在：

`E:\deepseek workplace\dsh-delegate\dsh-delegate-0.1.10.tgz`

核验结果：

- npm 包版本：`0.1.10`
- 文件数：`55`
- 压缩包大小：`406209` 字节
- SHA-256：`B468CD40C08C17040912F1F75ED5CE0D1DE2E4CE39D3DEA5DD33F9C311B259AB`
- 包内确认包含：
  - `package/src/runtime/session-placement.js`
  - `package/src/runtime/agent-runner.js`
  - `package/src/jobs/engine.js`
  - `package/docs/conversation-placement.md`
- `package/codex/dsh-delegate.toml`（版本标记为 `0.1.10`）

仓库中原有的旧版 tarball 均保留供比对；它们是上一版本的构建。`dsh-delegate-0.1.10.tgz` 同样被 `.gitignore` 的 `*.tgz` 忽略。

## 6. 尚未完成与已知限制

### 6.1 桌面端尚未更新

本机安装目录：

`C:\Users\24615\.dsh\profiles\desktop\node_modules\dsh-delegate`

该目录是否已替换为 `0.1.10` 尚未由本轮确认；本轮没有直接修改正式 Desktop profile。

因此还没有声称“桌面端已经端到端验证 Workspace 分组/复用”。当前完成的是源码、测试和可安装 tarball；下一步应安装该新 tarball，然后重载 DSH，再验证实际任务是否出现在预期 Workspace 中。

### 6.2 需要在桌面端补做的验证

安装新包后，至少验证：

1. 不带 `continueFromTaskId`：相同执行目录的两次任务出现在同一 Workspace，但使用两个 Session。
2. 带上第一项任务的 `continueFromTaskId`：第二次任务恢复同一任务的 Session。
3. 切换到不同执行目录：不会复用另一目录的 Session。
4. 删除或失效已记录 Session：返回明确拒绝，不静默跨目录或无提示替换。
5. 关闭插件/重启 DSH 后，`sessions.json` 仍只含身份字段，且显式跟进仍按任务链恢复。

### 6.3 仍需关注的历史运行问题

此前 DSH Crew 的 Flash 派单曾有上游流中断、超时和审查门控失败记录；本轮本地测试全部通过，但没有把 Crew 的旧失败记录当作本地实现已通过的证据。当前 Crew 记录的有效路由为 `workbuddy / deepseek-v4.1-flash / max`，没有活动 worker，reviewer 在当前会话中关闭。

## 7. 工作树与恢复方式

- 按仓库 `AGENTS.md` 要求，本轮没有 commit、push，也没有修改已安装的 DSH/Crew、凭据或其他仓库。
- 当前工作树仍包含此前及本轮的未提交修改；这些文件已保存在磁盘，不能通过 `git clean` 或回滚命令清理。
- 继续工作时先读取本报告、检查 `git status --short`，并以带日期的新 tarball SHA-256 为当前可安装构建的校验依据。
- 暂停期间不应把旧版 tarball 当作本轮构建；应使用上面列出的 `dsh-delegate-0.1.10.tgz`。

## 8. 建议的下一步顺序

1. 在 DSH 桌面端安装 `0.1.10` tarball并重载插件。
2. 先提交两个不带 `continueFromTaskId` 的任务，验证同 Workspace、不同 Session。
3. 再用第一项任务 id 提交跟进任务，验证同 Session 和同一工作树，并检查不同目录隔离。
4. 记录桌面端实际任务、Workspace、Session 和失败码，必要时再修正实现。
5. 桌面端验证通过后，再决定是否提升到新的版本号并发布到 GitHub。
