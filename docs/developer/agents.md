# 统一对话与应用编排

平台 1.5.0 的员工侧栏“新建对话”是统一入口。平台根据当前员工可用的能力目录识别意图，每轮选择一个应用编排；信息不全时返回澄清问题。应用负责自己的业务逻辑、知识检索和数据范围校验。

支持普通函数编排和文字回复。平台 1.6.0 增加[只读工具与 MCP](tools.md)，应用可在编排函数中调用本应用的声明工具。业务写入仍在应用页面确认提交；尚无可视化流程编辑器或模型自主工具循环。

## 声明能力

在 `app.json` 添加 `agents`，接口必须显式绑定同一个业务权限；`page` 指向已声明的无参数页面。平台同时检查该页面权限。每个应用最多 8 项能力，每项 1–4 条示例。

```json
{
  "api": [{"id": "agent-plan", "permission": "fill"}],
  "agents": [{
    "id": "monthly-plan",
    "name": "整理月度计划",
    "description": "整理一条月度计划草稿，缺少信息时追问，不提交计划。",
    "examples": ["帮我整理一条下月计划：完成设备巡检。"],
    "apiId": "agent-plan",
    "permission": "fill",
    "page": "/"
  }]
}
```

名称、描述和示例用于意图路由。描述应明确能力范围，不把暂未实现的操作写进去。示例会成为聊天首页的提示卡片，点击只填入输入框。

## 编排函数

使用已有 `defineServer` 或 `createAppBackend` 注册接口。以下为 `defineServer` 示例：

```js
import {defineServer} from '@metro/platform-sdk/server';
import {readAppAgentInput} from '@metro/platform-sdk/app-agent';

export default defineServer({
    async 'agent-plan'(input, ctx) {
      const task = readAppAgentInput(input);
      // 当前员工来自 ctx.employee；task 不允许携带员工或组织身份。
      // 在这里调用本应用业务函数、平台知识 SDK 等。
      return {ok: true, result: {
        kind: 'clarify',
        text: '这条计划安排在哪个月？'
      }};
    }
});
```

输入为 `message`、`history`、`today`。消息最多 1500 字符；`today` 为平台提供的上海日期。历史最多最近 6 轮、12 条消息、合计 12000 字符，只包含当前任务连续同一应用能力的上下文和平台澄清；切换其他能力会截断历史。历史不是身份或授权依据。

返回沿用应用接口的 `{ok:true,result}` 包装，`result` 只能包含 `kind`（`reply`、`clarify`、`draft`）和 `text`（1–6000 字符）。平台校验返回结构，页面按纯文本呈现；应用链接由清单生成，不接受模型或接口注入地址。

输入在 HTTP、应用 API、模型输出等各自边界校验一次；业务函数继续负责资源归属与权限范围。不要重复校验已确定类型的字段，也不要吞掉平台请求异常。

## 会话与权限

- 会话属于当前员工，管理员登录态不能代替员工登录态。
- 能力目录由当前安装实例、应用准入、业务权限及页面权限产生，执行时仍经过现有员工 API 宿主授权。
- 应用范围变化、安装版本变化或能力不可用时，旧授权上下文下的回复隐藏，不再用于下一轮编排。可能连带隐藏权限扩大前的回复，这是首版有意采用的保守规则。
- 同一对话只允许一个运行中的请求；单用户同一进程也限制一个任务。服务重启将未完成请求标记为中断，不重放业务函数。
- `requestId` 为 UUID，同一次发送重试必须复用原来的 `sessionId`、`requestId`、`message`；不同内容复用请求号会拒绝。每次会话最多 50 轮，历史列表显示最近 50 个会话。
- 路由模型超时 20 秒，整轮上限 60 秒；应用执行继续受自身现有超时约束。取消传播到应用调用，不等同于撤销已经发生的业务写入，因此首批能力仅查询和生成草稿。

## 员工接口

所有接口复用 `/api/employee` 的员工 Cookie、密码状态和同源写入校验。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/chat/capabilities` | 当前员工可用能力与提示示例 |
| GET | `/chats` | 最近会话列表 |
| GET | `/chats/:id` | 会话消息和运行状态 |
| POST | `/chats/messages` | `{sessionId,requestId,message}`，返回 202 后读取会话状态 |
| POST | `/chats/:id/runs/:requestId/cancel` | 停止指定请求 |

模型连接使用管理员已有的 AI 配置，不新增模型配置入口或外部服务。前端不提交目标应用、员工身份或任意工具名。
