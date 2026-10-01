# 身份、角色与数据范围

## 接入平台身份

员工先在平台完成登录和注册。应用不再创建第二套平台账号，不读取平台 Cookie，也没有通用的“注册用户”公开应用 SDK。现有系统的账号与人员对应关系必须先与用户确认，不能按同名自动合并。

后端使用 createAppBackend 的 handler，设置 requireEmployeeContext: true。第三个参数 employee 是宿主绑定的可信身份，包含 personId、organizationUnitId、permissions 和 businessAuthorization。权限来自当前请求，不能永久缓存在全局变量。

## 三种独立声明

平台能力请求：permissions.requested，例如 platform.people.read、platform.app_data.read/write。安装审批与平台授权由管理员完成，声明本身不是授权。

应用业务操作：permissions.defined，例如 app.inventory.read、app.inventory.create。每项给出业务描述，以及真正支持的 scopeKinds。API 的 businessPermission 引用同一操作；需要后端按动作细分权限时可用 businessEntry，但仍必须在 handler 中校验每项操作。

人员与角色：管理员指定应用负责人，负责人在员工端应用管理中配置使用人群、业务角色和成员。应用无需复制一套角色管理页面。岗位、负责人、管理员身份都不会自动变成本应用业务角色。

```json
{
  "permissions": {
    "requested": ["platform.people.read"],
    "defined": [{"code":"app.inventory.read","description":"查看库存","scopeKinds":["self","workgroup","department","organizations","all"]}]
  }
}
```

## 数据范围必须落到资源

self 是本人的业务资源；workgroup 是本工班；department 是本部室及下属工班；organizations 是显式指定组织；all 是本应用该操作全部资源。只声明实际实现并测试过的范围。

```ts
import {allowsAppResource} from '@metro/platform-sdk/app-backend';
if (!allowsAppResource(employee, 'app.inventory.read', {
  organizationUnitId: record.organization_id,
  ownerPersonId: record.created_by
})) {
  return {ok:false,error:{code:'ACCESS_DENIED',writeOutcome:'not_started'}};
}
```

列表先按授权组织与本人条件构造过滤，再分页；多角色范围取并集。写入先检查原记录归属与版本，新记录的组织必须处于允许范围。前端隐藏按钮不能代替后端校验。修改时不能信任客户端传来的组织归属、员工ID或授权列表。

平台服务能力授权和员工业务角色同时生效。一个员工拥有应用业务权限，不代表应用服务身份能读取所有目录；反之平台授予目录能力，也不会授予员工业务数据权限。

## 验收

至少覆盖无角色、本人、同工班、跨组织、多个角色、角色撤销、负责人无业务角色、路由直接访问。未知写入结果先查询原记录；不自动生成新请求ID重发。
