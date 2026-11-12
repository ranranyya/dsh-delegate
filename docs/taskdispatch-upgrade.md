# 从 DSH Delegate 升级到 DSH TaskDispatch

1.3.0 的展示名为 **DSH TaskDispatch**，包名为 **dsh-taskdispatch**。旧包 `dsh-delegate` 与 npm 上他人的同名占位包不是同一个项目。当前发布信息以本仓库和正式 Release 为准。

## 升级步骤

1. 等待当前任务结束，关闭旧插件的本机调用开关，并备份希望保留的配置。
2. 在 DSH 插件管理中停用并卸载本项目的旧 `dsh-delegate` 包。**保留 `<DSH_HOME>/data/dsh-delegate` 数据目录**；本项目没有提供删除该目录的迁移脚本。DSH 自身若提供“删除数据”选项，不要勾选。不要同时启用两个包。
3. 从本项目 Release 安装 `dsh-taskdispatch-1.3.0.tgz`，或使用文档列出的固定 Git 提交索引安装。不要对 Desktop 保留的 profile 手动执行 npm/pnpm。
4. 打开新插件配置页。设置、历史、运行端点路径仍使用原数据目录；检查 API、模型与思考强度后，按需要开启本机调用开关。旧数据若保存了开启状态，插件会恢复该值，安装前应先完成第 1 步。
5. 在 Codex 集成中显式点击“安装 / 更新 Codex 集成”或“仅修复 MCP 配置”，把旧包入口迁移到新安装目录，再让 Codex 重新加载。启动自检不会擅自接管其他安装目录。

## 保持兼容的技术标识

- 数据与端点：`<DSH_HOME>/data/dsh-delegate`、`runtime-endpoint.json`。
- 环境变量：`DSH_DELEGATE_*`。
- MCP 工具：`delegate_status`、`delegate_preflight`、`delegate_submit`、`delegate_wait`、`delegate_result`、`delegate_cancel`、`delegate_permission_decide`。
- Codex 文件和条目：`agents/dsh-delegate.toml`、`mcp_servers.dsh-delegate`。
- MCP/控制程序：`bin/dsh-delegate-mcp.js`、`bin/dsh-delegate-control.js`。

保留这些名称是为了兼容，不会让安装源改指向别人的 npm 包。显式采纳旧入口需要真实的包目录、文件和正确 bin 映射，以及本项目新旧 GitHub 仓库来源；无法证明身份的旧入口、自定义包装器和用户编辑过的智能体文件都会被保留并报告冲突。

更名属于包身份迁移，不能描述为对旧包的普通原地更新。迁移检查在隔离的临时配置目录进行；不能据此声称真实 Desktop 卸载、安装、重启已全部验收。
