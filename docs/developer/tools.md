# 只读工具与 MCP

平台 1.6.0 提供应用工具目录和统一调用入口。工具由应用声明和实现，编排函数通过 SDK 调用。平台只暴露当前员工有权使用的本应用工具，实际数据范围仍由工具处理函数校验。

## 声明工具

以下为 `app.json` 片段；保留应用原有数据、目录等能力声明：

```json
{
  "platformAccess": ["tools.read"],
  "permissions": [{"code": "read", "name": "查看记录"}],
  "api": [{"id": "tool-list", "permission": "read"}],
  "tools": [{
    "id": "list-records",
    "name": "查询记录",
    "description": "查询当前员工有权查看的记录，最多 20 条。",
    "apiId": "tool-list",
    "permission": "read",
    "mode": "read",
    "inputSchema": {
      "type": "object",
      "properties": {"status": {"type": "string", "enum": ["active", "completed"], "maxLength": 9}},
      "required": ["status"],
      "additionalProperties": false
    }
  }]
}
```

托管数据读写能力由应用迁移声明产生，不写入 `platformAccess`；管理员仍需按现有规则授予相应服务权限。

每应用最多 16 个工具，每个工具绑定一个独立 API，二者必须显式使用相同业务权限；不能把编排入口同时声明为工具。安装包校验声明，宿主在 API 入口按 `inputSchema` 校验参数一次，直接调用该 API 也不能绕过校验。处理函数不需要再复制结构校验，但必须按可信员工上下文过滤资源。

首版只接受封闭的平面对象，最多 16 个字段：`string`、`integer`、`number`、`boolean`。字符串必须指定 `maxLength`（1–1500），可设 `minLength` 和 `format: "uuid"`；数字必须指定有限的 `minimum`、`maximum`，整数边界须为安全整数。支持最多 32 项的同类型枚举和最多 300 字符的字段说明。暂不支持嵌套、数组、`$ref` 或正则表达式。

## 编排调用

```js
import {createAppToolClient} from '@metro/platform-sdk/app-tools';

// gateway 为宿主提供的 ctx.platform 或 createAppBackend 的平台客户端。
const tools = createAppToolClient(gateway, 'mcp'); // 默认 direct
const catalog = await tools.list(signal);
const result = await tools.call('list-records', {status: 'active'}, signal);
```

`direct` 和 `mcp` 使用同一个工具目录及宿主处理函数。调用只允许 `toolId` 和业务参数，应用和员工身份均从宿主正在执行的员工请求绑定；启动钩子、定时任务或无员工身份的调用会被拒绝。不允许应用传入其他应用 ID 切换工具范围。

工具处理函数沿用 `{ok:true,result}` / `{ok:false,error:{code}}` 返回格式（兼容现有 `writeOutcome` 错误字段）。SDK 返回成功的 `result`，业务失败抛出 `AppToolError`，保留 `code`；不自动重试。

## MCP 与运行约束

使用[官方 TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)的 Client、Server 和 InMemoryTransport，创建短期会话，完成标准初始化与版本协商，支持 `tools/list`、`tools/call`。工具标注 `readOnlyHint`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint: false`。成功和业务失败均有文本内容与 `structuredContent`，业务失败带 `isError: true`。

当前 MCP 是受管应用的协议适配，不提供外部 HTTP/SSE 地址、独立 stdio 进程或第三方 MCP 连接配置。平台接收工具参数后继续调用原应用子进程；同一份应用 handler 服务两种传输。MCP 生命周期、错误和取消由 SDK 处理。

- 需授予应用服务 `platform.tools.read`，同时满足应用准入和工具业务权限。清单声明不自动授权。
- 平台校验当前安装版本，禁用应用或撤销权限后不能继续发起工具调用。工具自己的数据与知识查询仍按既有范围授权。
- 只读工具执行期间，宿主拒绝该调用内的所有平台写操作，即使应用本身有写权限。普通应用业务 API 继续按原权限工作。
- 只读限制针对平台网关，不是操作系统沙箱。受信任的应用代码仍应遵守只读声明，不自行产生外部副作用。
- 沿用网关限流、结果大小和超时，以及应用子进程超时；MCP 每个请求最长 30 秒，外层期限可以更早结束。取消从编排经 MCP、子进程传到嵌套平台读取。
- 审计记录工具名、传输方式、应用和实际员工，不记录工具参数及知识内容。

首批实例：待办事项 `list-todos`（MCP）查询员工授权范围内任务；慧策通 `plan-reference`（direct）检索当前部门名词及计划示例。统一入口仍由平台识别应用意图，应用编排以普通代码决定调用步骤；本阶段不包含模型自主选工具循环或确认写入。
