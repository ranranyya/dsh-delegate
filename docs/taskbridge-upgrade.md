# 从 DSH Delegate／TaskDispatch 升级到 DSH TaskBridge

**1.3.1 起统一使用 DSH TaskBridge，包名为 `dsh-taskbridge`，GitHub 仓库为 `ranranyya/dsh-taskbridge`。** 1.3.0 的旧包名 `dsh-taskdispatch` 只在 GitHub 发布；npm 因其与已有包名过于相似而拒绝注册。此前的 `dsh-delegate` 同样不要与 npm 上他人的包混淆。

## 升级步骤

1. 等待当前任务结束，关闭旧插件的本机调用开关，备份希望保留的配置。
2. 在 DSH 插件管理中停用并卸载本项目旧 `dsh-delegate` 或 `dsh-taskdispatch` 包。**保留 `<DSH_HOME>/data/dsh-delegate` 数据目录**；DSH 若提供删除数据选项，不要勾选。新旧包不能同时启用。
3. 在“添加插件”中输入 **`dsh-taskbridge@1.3.1`**。中国大陆镜像未同步时改选 npm 官方源。也可安装本项目 Release 的 `dsh-taskbridge-1.3.1.tgz`，或添加本项目固定 Git 提交的自定义索引。不要手动修改 Desktop 保留的 profile。
4. 打开 **DSH TaskBridge** 配置页，核对 API、模型、思考强度和总开关。数据目录与旧版相同；安装前关闭旧开关，避免恢复之前保存的开启状态。
5. 在 Codex 集成中点击“安装 / 更新 Codex 集成”或“仅修复 MCP 配置”，迁移到新安装目录，再让 Codex 重新加载。启动自检不会擅自接管其他安装目录。
6. 若添加过旧索引，改用 `https://ranranyya.github.io/dsh-taskbridge/index.json`。

## 保持兼容的技术标识

- 数据与端点：`<DSH_HOME>/data/dsh-delegate`、`runtime-endpoint.json`。
- 环境变量：`DSH_DELEGATE_*`。
- MCP 工具：`delegate_status`、`delegate_preflight`、`delegate_submit`、`delegate_wait`、`delegate_result`、`delegate_cancel`、`delegate_permission_decide`。
- Codex 文件和条目：`agents/dsh-delegate.toml`、`mcp_servers.dsh-delegate`。
- MCP/控制程序：`bin/dsh-delegate-mcp.js`、`bin/dsh-delegate-control.js`。

这些名称保留兼容，不会让安装指向其他 npm 项目。采纳旧入口仍需证明真实文件、正确 bin 映射及本项目新旧仓库来源；无法证明身份的入口、自定义包装器和用户编辑过的智能体文件会被保留并报告冲突。

## 版本差异

1.2.0 完成静默等待中断语义、独立控制通道和既有 Codex 集成升级修复。1.3.0 增加中英文介绍、图标、更名兼容和自定义插件索引。1.3.1 统一为 TaskBridge 并增加 npm 安装渠道；不改变核心执行、等待、审批或审查流程。

更名是包身份迁移，不能称为对旧包的普通原地更新。隔离配置目录中的迁移测试不等于已经在真实 Desktop 完成卸载、安装和重启验收。
