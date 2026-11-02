# 公共目录、开发凭证与跨应用查询

平台 1.11.0 在员工侧栏提供开发者中心；管理员继续使用原入口。员工可下载同版本 SDK、CLI、示例和开发 Skill，查看公共数据、管理个人凭证，并按权限调试应用开放接口。

## 公共目录

启用的线路、车站、线路车站关系、组织与工班、工班管辖车站、岗位和设备系统/类别/类型向有效员工开放只读查询。返回固定字段，不返回人员、手机号、账号绑定、具体设备或业务数据。不自动开放管理员数据字典。公共目录可见不授予业务权限，现有 people.read / locations.read / assets.read 的范围不改变。

分页使用 pageSize（1–100，默认 50）、afterId（上页 nextCursor），search 搜索白名单字段。结果按 ID 稳定排序；树和站序展示请使用 parentId / sortOrder。nextCursor 为 null 表示结束。工班管辖按车站分页，每条返回该车站的 workgroups 数组。默认只查启用项；历史停用项仍由业务应用的既有记录和受控接口处理。

应用申请 directory.read 后，在员工触发的后端调用：

```js
const page = await ctx.directory.list('stations', {pageSize: 50});
// 处理函数表写法使用 gateway.invoke('platform.directory.list', {resource:'stations', pageSize:50})
```

resource 支持 lines、stations、line-stations、organizations、workgroup-stations、positions、asset-systems、asset-categories、asset-types。所有 ID 都是实际实例数据，开发环境和其他实例之间不可混用。

## 个人开发凭证

员工在“我的凭证”创建只读 API Key，选择 7/30/90 天、公共目录及可选的应用接口查询权限。每人最多 5 个未撤销且未过期的凭证；完整密钥仅创建成功时显示一次，服务器只保存摘要。若响应丢失，刷新列表核对，撤销该凭证后再创建；不会重放完整密钥。

把密钥存放在本地环境变量 MOP_DEV_KEY，不放在前端、Git、聊天示例或 .mopkg 中。密钥绑定员工账号，每次请求检查账号、人员、组织、岗位、强制改密状态和密码指纹。撤销、过期或密码修改后不能使用；账号和人员停用期间也不能使用。每个 Key 每分钟最多 60 次请求。

```sh
curl -H "Authorization: Bearer $MOP_DEV_KEY" \
  "$MOP_URL/api/developer/directory?resource=stations"

curl -H "Authorization: Bearer $MOP_DEV_KEY" \
  "$MOP_URL/api/developer/interfaces"

curl -H "Authorization: Bearer $MOP_DEV_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"appId":"faults","apiId":"public-query","input":{}}' \
  "$MOP_URL/api/developer/call"
```

外部入口只接受 Authorization Bearer；员工和管理接口不接受该凭证。支持本地 CLI、服务端脚本和 Agent，不开放跨站浏览器 CORS。开发调用记录保存操作、目标和时间，不保存密钥或请求正文。页面展示最近 50 条请求记录（表示调用尝试，不表示业务成功）。

员工浏览器使用 /api/employee/developer 下对应接口，沿用会话和 Origin 校验。keys 的创建使用 requestId，revoke 为幂等停用；GET history 返回本人的最近记录。

## 开放应用接口

只支持显式声明的只读接口；必须绑定业务权限，并提供完整输入输出、示例和错误说明。输入根对象要求 additionalProperties:false。未声明 expose 的内部接口不出现在开放目录。

```json
{
  "api": [{
    "id": "public-query",
    "permission": "read",
    "expose": {
      "mode": "read",
      "title": "查询摘要",
      "documentation": {
        "description": "查询当前员工授权范围内的摘要",
        "input": {"type":"object","properties":{},"additionalProperties":false},
        "output": {"type":"object","properties":{"count":{"type":"integer"}},"required":["count"],"additionalProperties":false},
        "examples": [{"title":"读取摘要","params":{},"result":{"count":0}}],
        "errors": [{"code":"ACCESS_DENIED","description":"无查询权限"}]
      }
    }
  }]
}
```

handler 仍返回 {ok:true,result} 或 {ok:false,error}；documentation.output 描述 result。公开调用返回的 HTTP 正文为 {result}；SDK ctx.apps.call 直接返回业务 result。平台检查契约与权限，应用必须先按员工数据范围过滤再分页。声明不会自动修复应用自身的资源授权。

## 正式跨应用调用

调用方申请 apps.read 并逐项声明依赖：

```json
{
  "platformAccess": ["apps.read"],
  "appAccess": [{"appId":"faults","apiId":"public-query"}]
}
```

```js
const result = await ctx.apps.call('faults', 'public-query', {stationId});
// 处理函数表写法：
const result2 = await gateway.invoke('platform.apps.call', {
  appId:'faults', apiId:'public-query', input:{stationId}
}, signal);
```

安装预览展示开放接口及调用依赖，管理员安装即确认这些声明；无额外审批流程。调用方需有平台能力授权和对应依赖，员工还需有目标应用权限。目标后端获得目标应用的员工权限上下文；不能传 personId、employee 或组织范围来代替真实身份。应用停用、升级和角色变化会在调用及返回阶段重新核对。

本版本只支持员工触发的一层跨应用查询：开放查询处理器不可继续调用其他应用，禁止循环调用，执行期间平台写操作被拒绝。宿主不提供任意第三方后端副作用的事务保证，开放处理器必须保持纯查询。无后台服务身份、跨应用写入或分布式事务，失败不自动重试。

故障记录 1.1.0 开放 public-query；检修管理 1.1.0 的计划详情可读取本站最近 20 条故障摘要。需要分别安装这两个应用更新，并为员工分配相应业务角色；平台升级不会自动更新业务应用。

## 升级与验收

新增 developer-access-expand 迁移，创建凭证、调用记录表和两项平台能力定义，不生成默认密钥。正常在线更新流程执行迁移；源码手动部署先执行 npm --prefix server run db:init。平台版本与应用最低版本均为 1.11.0。

验收无目标角色、本人/工班/跨工班、撤权、Key 过期撤销、账号停用、密码变更、未声明依赖、应用停用与只读接口尝试写入。确认开发凭证无法访问管理接口，日志和离线文档不含凭证或实例业务数据。
