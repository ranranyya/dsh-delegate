# 从 DSH Delegate／TaskDispatch 升级到 DSH TaskBridge

**1.3.1 起统一使用 DSH TaskBridge，包名为 `dsh-taskbridge`，GitHub 仓库为 `ranranyya/dsh-taskbridge`。** 1.3.0 的旧包名 `dsh-taskdispatch` 只在 GitHub 发布；npm 因其与已有包名过于相似而拒绝注册。此前的 `dsh-delegate` 同样不要与 npm 上他人的包混淆。

## 升级步骤

1. 等待当前任务结束，关闭旧插件的本机调用开关。
2. 在 DSH 插件管理中停用并卸载本项目旧 `dsh-delegate` 或 `dsh-taskdispatch` 包。**保留 `<DSH_HOME>/data/dsh-delegate` 数据目录**；DSH 若提供删除数据选项，不要勾选。新旧包不能同时启用。
3. 在“添加插件”中输入 **`dsh-taskbridge@1.4.0`**。中国大陆镜像未同步时改选 npm 官方源。也可安装本项目 Release 的 `dsh-taskbridge-1.4.0.tgz`，或添加本项目固定 Git 提交的自定义索引。不要手动修改 Desktop 保留的 profile。
4. 打开 **DSH TaskBridge** 配置页，核对 API、模型、思考强度和总开关。数据目录与旧版相同；安装前关闭旧开关，避免恢复之前保存的开启状态。
5. 在 Codex 集成中点击“安装 / 更新 TaskBridge 智能体”，更新智能体及 MCP，然后重新加载 Codex。未修改的旧 `dsh-delegate.toml` 会迁移为 `dsh-taskbridge.toml`；修改过的文件保留。只需修复 MCP 时可使用“仅修复 MCP 配置”。启动自检不会接管其他安装目录。
6. 若添加过旧索引，改用 `https://ranranyya.github.io/dsh-taskbridge/index.json`。

## 保持兼容的技术标识

- 数据与端点：`<DSH_HOME>/data/dsh-delegate`、`runtime-endpoint.json`。
- 环境变量：`DSH_DELEGATE_*`。
- MCP 工具：`delegate_status`、`delegate_preflight`、`delegate_submit`、`delegate_wait`、`delegate_result`、`delegate_cancel`、`delegate_permission_decide`。
- Codex MCP 条目：`mcp_servers.dsh-delegate`。智能体文件从 1.3.2 起改为 `agents/dsh-taskbridge.toml`，对外名称为 `dsh-taskbridge`。
- MCP/控制程序：`bin/dsh-delegate-mcp.js`、`bin/dsh-delegate-control.js`。

保留的内部名称不会让安装指向其他 npm 项目。仍存在的旧包入口须证明真实文件、bin 映射及本项目仓库来源。1.3.2 的显式安装/修复也接受本插件目录旁已卸载的 `node_modules/dsh-delegate` 或 `dsh-taskdispatch` 标准入口，前提是原 MCP 配置带托管标记且结构符合插件规则。其他路径、自定义包装器和用户编辑过的智能体文件保留；启动自检不会接管搬家路径。

## 版本差异

1.2.0 完成静默等待中断语义、独立控制通道和既有 Codex 集成升级修复。1.3.0 增加中英文介绍、图标、更名兼容和自定义插件索引。1.3.1 统一为 TaskBridge 并增加 npm 安装渠道。1.3.2 将 Codex 智能体同步更名、新工作区按任务内容命名，并修复旧包卸载后的 MCP 路径迁移；不改变模型选择、等待、审批或审查流程。从 TaskBridge 1.3.1 升到 1.3.2 是同包小版本更新。

更名是包身份迁移，不能称为对旧包的普通原地更新。隔离配置目录中的迁移测试不等于已经在真实 Desktop 完成卸载、安装和重启验收。
