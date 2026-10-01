# 提供与调用应用开放接口

只有签名清单 api[].expose 声明的接口才是候选；负责人逐项开放后才能被其他应用调用。开发者中心默认显示已开放接口，也可查看未开放候选。旧包没有参数契约时明确标注“未提供契约”，不能猜测其 payload。

## 提供方

API 的 permission 与 businessPermission 必须引用同一个本应用 permissions.defined 权限，不能直接开放 businessEntry。handler 继续校验业务输入、员工权限和数据范围。

```json
{
  "id":"get-record",
  "method":"POST",
  "path":"/get-record",
  "handler":"get-record",
  "permission":"app.inventory.read",
  "businessPermission":"app.inventory.read",
  "expose": {
    "title":"查询记录",
    "contractVersion":"1.0",
    "mode":"read",
    "documentation": {
      "description":"查询当前员工有权读取的记录标题。",
      "input":{"type":"object","properties":{"id":{"type":"string","description":"记录 UUID"}},"required":["id"],"additionalProperties":false},
      "output":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false},
      "examples":[{"title":"查询记录","params":{"id":"00000000-0000-4000-8000-000000000001"},"result":{"title":"示例记录"}}],
      "errors":[{"code":"ACCESS_DENIED","description":"记录不存在或当前员工无权查看"}]
    }
  }
}
```

documentation 是有界 JSON Schema 子集：type、description、properties、required、additionalProperties、items、enum。不允许远程 $ref、正则执行、任意扩展字段；最大16KiB、结构深度8、结构节点128、示例1～4个。示例必须符合所声明结构。复杂规则写进 description 并由业务 handler 校验；它不是完整 OpenAPI，也不会自动生成新的 HTTP 接口。

SDK 的 isAppApiDocumentation 可在构建前校验；CLI 和安装端也校验。documentation 是签名的一部分；input/output 变化影响开放契约指纹，需重新开放；说明、例子和错误文案不改变授权。

## 调用方

```json
{
  "permissions":{"requested":["platform.apps.invoke","app.inventory.read"]},
  "compatibility":{"applications":[{"id":"inventory","version":{"minInclusive":"1.0.0","maxExclusive":"2.0.0"}}]}
}
```

```ts
import {createAppCapabilityClient} from '@metro/platform-sdk/app-gateway';
const client = createAppCapabilityClient(gateway);
const result = await client.call('inventory', 'get-record', {id:recordId});
```

gateway 来自当前员工触发的隔离后端 handler。不能传员工ID模拟他人，不能从浏览器直接访问另一个应用的后端地址，也不适用于外部系统或无人登录任务。

平台检查调用方服务授权、双方启用与版本、提供方开放状态、当前员工在目标应用的准入、业务角色和范围。已开放不等于当前调用者已获授权。写入必须先确认输入；writeOutcome=unknown 时禁止自动重放。
