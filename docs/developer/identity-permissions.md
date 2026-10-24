# 身份、角色与数据范围

## 接入平台身份

员工在平台登录和注册。应用不创建第二套账号，不读取平台 Cookie。现有系统的账号与人员对应关系必须先与用户确认，不能按同名自动合并。

接口函数的第二个参数 `ctx` 带有平台绑定的可信身份：`ctx.employee`（`personId`、`organizationUnitId`、权限与业务授权）。身份来自当前请求，不要缓存到全局变量，也不要从请求体读取“当前员工”。

## 三种独立声明（app.json）

- 平台能力 `platformAccess`：如 `people.read`、`locations.read`、`attachments.create`。安装时由平台授予，只申请用到的。
- 业务权限 `permissions`：`{code, name, scopes}`，如 `{code: 'read', name: '查看', scopes: ['self', 'workgroup', 'all']}`。只声明真正实现并测试过的数据范围。
- 页面与接口：`pages[].permission` 控制谁能打开页面，`api[].permission` 控制谁能调用接口；不写 `permission` 的接口对所有有本应用角色的员工开放，函数内仍要逐项校验。

人员与角色：管理员指定应用负责人，负责人在员工端“应用管理”配置使用人员、业务角色和每个权限的数据范围。应用不需要自己做角色管理页面；岗位、负责人、管理员身份都不会自动成为本应用的业务角色。

## 数据范围必须落到资源

`self` 是本人的业务资源；`workgroup` 是本工班；`department` 是本部室及下属工班；`organizations` 是指定组织；`all` 是本应用该操作的全部资源。

```js
export default defineServer({
  async detail(input, ctx) {
    const {row} = await ctx.data.get('records', input.id);
    if (!row) throw new Error('NOT_FOUND');
    ctx.require('read', {organizationUnitId: row.organization_id, ownerPersonId: row.created_by});
    return row;
  },
});
```

`ctx.can(权限, 资源)` 返回布尔值，`ctx.require` 不满足时抛出 `ACCESS_DENIED`。处理函数表写法（`createAppBackend`）可用 `@metro/platform-sdk/app-backend` 的 `allowsAppResource(employee, 'app.<id>.read', 资源)` 做同样的判断。

列表先按授权组织与本人条件构造过滤再分页；多个角色的范围取并集。写入先检查原记录的归属与版本，新记录的组织必须在允许范围内。页面上的 `useApp().user.has()` 只决定按钮是否显示，不能代替接口校验。

平台能力和员工业务角色同时生效：员工有业务权限不代表应用能读取所有目录；平台授予目录能力也不会授予员工业务数据权限。

## 验收

至少覆盖：无角色、本人、同工班、跨组织、多个角色、角色撤销、负责人无业务角色、直接打开无权限页面。写入结果未知时先查询原记录，不要生成新的 requestId 重发。
