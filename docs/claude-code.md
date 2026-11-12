# Claude Code 手动接入

DSH TaskDispatch 提供标准 stdio MCP 服务，Claude Code 可作为指挥端连接它。这里提供配置方法，不代表已经完成真实 Claude Code 客户端验收；目前也没有一键安装 Claude Code 智能体的按钮。

## 连接

在 Claude Code 支持的 MCP 配置中登记一个 stdio 服务，`command` 指向本机 **Node.js 24 或更高版本的可执行文件**，`args` 只填写本插件实际安装目录里的 `bin/dsh-delegate-mcp.js` 的绝对路径。不要填写 `DeepSeek Harness.exe`，也不要把示例占位符直接复制为实际路径。

```json
{
  "mcpServers": {
    "dsh-taskdispatch": {
      "command": "<Node.js 可执行文件绝对路径>",
      "args": ["<本插件安装目录>/bin/dsh-delegate-mcp.js"],
      "env": {
        "DSH_DELEGATE_DISCOVERY_FILE": "<DSH_HOME>/data/dsh-delegate/runtime-endpoint.json"
      }
    }
  }
}
```

配置文件的位置和作用域按你的 Claude Code 版本选择，参见 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)。端点文件由运行中的插件维护，端口变化时重新发现；无需把 DSH API 密钥写到 Claude Code。

## 指挥规则

先在 DSH 插件页选好 API、执行模型和思考强度，并开启本机调用开关。向指挥端说明：

> 仅在我明确委派的任务中调用 DSH。你负责规划、权限判断和最终审查，DSH 负责实现。先预检授权的源仓库，提交后等待同一 taskId；普通执行期间不要反复读取结果。审批时核对准确操作与指纹，按授权决定单次允许或拒绝。交付后集中审查，有修正则通过 continueFromTaskId 续接原任务，不重复派工或自行接管实现。模型与思考强度以 DSH 插件设置为准。

先调用 `delegate_status` 验证连接，再以不修改文件的简短任务试运行。客户端可能提前结束等待，应继续等待原任务；不承诺某个客户端版本的 `@` 选择或完全零唤醒。
