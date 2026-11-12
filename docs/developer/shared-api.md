# 一个接口供多个入口使用

从平台 1.12.0 起，在 `app.json` 的 `api` 中声明业务接口，在 `src/server.js` 中实现同名函数。页面通过 `api.call(id, input)` 调用。每个入口沿用相同的业务权限、输入和输出，处理函数根据宿主绑定的员工检查具体记录的数据范围。

下面的声明让页面、统一对话、受管 MCP 和获准的应用都能使用 `list`。省略 `ai`、`tool` 和 `expose` 时，接口供本应用页面使用。

```json
{
  "id": "list",
  "title": "查询巡检记录",
  "permission": "read",
  "mode": "read",
  "ai": true,
  "expose": "apps",
  "documentation": {
    "description": "查看本人有权读取的最近20条巡检记录，可按关键词搜索。",
    "input": {"type":"object","properties":{"search":{"type":"string","maxLength":100}},"additionalProperties":false},
    "output": {"type":"object","properties":{"titles":{"type":"array","items":{"type":"string"}}},"required":["titles"],"additionalProperties":false},
    "examples": [{"title":"查询最近的巡检记录","params":{},"result":{"titles":[]}}],
    "errors": [{"code":"ACCESS_DENIED","description":"无权读取记录"}]
  }
}
```

| 字段 | 效果 |
| --- | --- |
| `mode` | `read` 用于查询或总结，`draft` 用于生成待核对的草稿。两者在宿主内都禁止平台写操作。`write` 用于在应用中确认的正式提交。 |
| `ai: true` | 从标题、说明、示例和参数生成聊天能力及本应用工具。平台选择获准接口，缺信息时追问，校验参数后每轮最多执行一次，再将结果转成文字答复。可用 `ai: {page, examples}` 指定页面和聊天示例。 |
| `tool: true` | 仅发布本应用的受管工具。使用 `createAppToolClient` 的编排调用方需申请 `tools.read`。普通聊天入口由平台调用。 |
| `expose: "apps"` | 向已安装且获准的应用提供查询。调用方申请 `apps.read`，在 `appAccess` 逐项声明依赖。 |
| `expose: true` | 同时允许员工开发者中心和本人只读开发凭证调用。安装时可审阅开放范围。 |
| `dashboard: true` | 将接口结果作为工作台卡片，输入为 `{}`，输出须符合 `AppDashboardSnapshot`。每个应用最多一项。平台内置摘要的输入输出说明，设置 `mode: "read"` 和 `ai: true` 即可同时接入聊天。 |
| `permission` | 一般接口绑定一个业务权限。共享既有的多用途页面接口时，可以改用 `sharedPermissions` 列出可通过共享入口访问的业务权限。命中其中之一仅获准进入接口，处理函数仍按实际参数和资源校验具体权限。 |

`documentation.output` 描述业务结果。新模板使用 `defineServer` 直接返回结果，页面可以直接读取 `result.titles`。旧函数表也可以继续返回 `{ok:true,result}` 或 `{ok:false,error:{code}}`。业务对象顶层的布尔型 `ok` 保留给这一包装。参数描述应写明单位、默认值和分页口径。平台支持封闭对象、数组、枚举、长度、数值范围和 UUID 格式，`mop-app check` 会检查示例是否符合声明。

跨应用沿用当前员工在目标应用中的角色、数据范围和单层只读调用限制。额外开放某个入口需要更新应用包。应用负责人提交更新、管理员审核后生效。自定义多轮流程可保留 `agents` 编排。已有 `tools`、`agents` 和对象形式的 `expose` 继续被平台识别，迁移时逐个替换，保留已发布的接口 ID 和业务参数。

先升级平台，再安装或提交各应用的新包。平台升级不会替换已安装的业务应用或重新分配员工角色。
