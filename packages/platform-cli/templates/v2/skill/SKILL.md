---
name: metro-app
description: 开发运管平台应用（应用模型 v2）：编写 app.json、React 页面、Node 接口和数据迁移，用 mop check / mop build 产出单个 .mopkg 安装文件。新建应用或修改本项目时使用。
---

# 运管平台应用开发（v2）

平台提供登录、员工身份、角色与数据范围、人员/车站/设备目录、数据存储和部署运行。应用只写业务：页面、接口、数据表。交付物是 `dist/` 里唯一的 `.mopkg` 文件。

## 工作流程

1. 确认业务目标、应用 ID（小写英文加连字符）、名称、要区分的权限（如查看/提交/管理）和每个权限允许的数据范围。
2. 先改 `app.json`，再写 `migrations/`、`src/server.js`、`src/ui.jsx`。
3. 每次改动后运行 `npm test`、`npm run check`；本地有平台时用 `npx mop-app dev --out <目录>` 联调（平台以同一目录设置 `MOP_DEV_APPS_DIR`）；完成后 `npm run build`。
4. 汇报：`.mopkg` 路径、权限清单（含数据范围）、需要管理员确认的平台能力、已通过和未执行的检查。

不要引用平台仓库源码，不要自建登录、用户表或权限表，不要在代码中写死人员或组织 ID。

## app.json

| 字段 | 说明 |
|---|---|
| `id` `name` `version` `description` | 必填。`version` 每次交付递增 |
| `color` | 图标底色 `#RRGGBB`；`icon.svg` 用白色线条 |
| `platform` | 平台版本范围，如 `>=0.26.0` |
| `permissions` | `{code, name, scopes}`；`code` 用短代码（`read`），`scopes` 取自 `self` `workgroup` `department` `organizations` `all` |
| `platformAccess` | 需要的平台能力：`people.read` `locations.read` `assets.read` `ai.complete` `attachments.create` `attachments.read` `notifications.create` `notifications.manage` `signatures.create` `signatures.read` `signatures.sign` `webhook.send`。只申请用到的 |
| `pages` | `{path, title, permission, nav}`；`path` 可带参数 `/records/:id`；`nav: true` 进入侧栏，按数组顺序排列 |
| `api` | `{id, permission, dashboard}`；`id` 与 `server.js` 中的函数名一致；`dashboard: true` 表示工作台摘要（最多一个） |
| `limits` | 可选 `{memoryMiB, timeoutSeconds}` |

## 页面 src/ui.jsx

```jsx
import {defineApp, useApp} from '@metro/platform-sdk/app';
import {Button, Table, Dialog, Field, Input, QueryList} from '@metro/platform-sdk/ui';
function Page({params}) {
  const {api, user, route, navigate, toast, confirm, directory, files} = useApp();
  // await api.call('list', {...})；user.has('create') 判断按钮是否显示
}
export default defineApp({pages: {'/': Page, '/records/:id': Detail}, dashboard: Summary});
```

- 页面渲染在平台内容区，标题与侧栏由平台根据 `pages` 生成，页面里不要再放大标题或侧栏。
- 使用 `@metro/platform-sdk/ui` 组件；颜色、字号用平台 CSS 变量（如 `var(--afc-color-muted)`）。`ui.css` 构建时自动限定在本应用内。
- 前端的 `user.has()` 只控制显示；真正的权限在接口里检查。
- 只读目录查询可在页面直接调用：`directory.members({organizationUnitId: user.organizationUnitId})`（工班成员）、`directory.organizationContext(id)`、`directory.responsibleStations({...})`、`directory.locations()`、`directory.assets()`；需在 `platformAccess` 申请 `people.read` / `locations.read` / `assets.read`。写操作一律经本应用接口。
- 附件：`files.upload(file, {entityType, entityId})`、`files.list({entityType, entityId})`、`files.save(attachmentId)`。需要申请 `attachments.create`、`attachments.read`，并提供接口 `authorize-attachment`：输入 `{action:'upload'|'read', entityType, entityId}`，校验记录存在且员工有权后返回 `{organizationId: 记录所属组织}`。支持 Word、Excel、PDF、ZIP 和图片，单个不超过 50MB。

## 接口 src/server.js

```js
import {defineServer} from '@metro/platform-sdk/server';
export default defineServer({
  async list(input, ctx) { return ctx.data.list('records', {pageSize: 50}); },
  async create(input, ctx) {
    ctx.require('create', {organizationUnitId: ctx.employee.organizationUnitId, ownerPersonId: ctx.employee.personId});
    await ctx.data.transaction(input.requestId, [{action: 'insert', table: 'records', id: ctx.uuid(), values: {/* ... */}}]);
  },
}, {start(ctx) { /* 可选：定时任务 */ }});
```

- 平台已按 `api[].permission` 拦截调用；涉及具体记录时再用 `ctx.can/ctx.require(权限, {organizationUnitId, ownerPersonId})` 按数据范围判断，列表要过滤掉无权查看的记录。
- `ctx.data`：`get(table,id)`、`list(table,{filters,order,pageSize,after,search,range})`、`readBatch([...])`、`transaction(requestId, [insert|update|delete])`。`update/delete` 需带 `expected` 旧值做并发校验。
- 写操作由前端生成 `requestId`（UUID）传入；同一 `requestId` 重试不会重复写入。
- `ctx.platform.invoke('platform.people.members', {...})` 等调用平台能力，须先在 `platformAccess` 申请。
- 输入一律校验类型与长度；出错时 `throw new Error('INVALID_INPUT')` 之类的代码。

## 数据迁移 migrations/

- 文件名 `001-initial.json`、`002-add-photo.json`……从 001 连续编号；**已发布的文件不能修改或删除**，只能追加。
- 格式：`{"migrationVersion":"1.0","operations":[...]}`，操作仅支持 `createTable`（列类型 `text` `boolean` `integer` `bigint` `uuid` `date` `timestamptz` `jsonb`）、`addColumn`（只能可空）、`createIndex`。
- 每张业务表建议包含 `id`、`organization_id`、`created_by`、`created_at`，以便按数据范围过滤。

## 测试

`test/` 中用 `createAppServerContext({appId, gateway, employee, signal})` 加假 gateway 测接口：至少覆盖正常写入、无权限拒绝、跨组织拒绝、非法输入。

## 交付

`npm run build` 生成 `dist/<id>-<version>.mopkg`。该文件包含 app.json、图标、页面、接口和迁移，管理员上传后可预览并安装。平台 0.27.0 起支持安装运行，0.28.0 起支持 `directory`、`files` 与 `mop-app dev`。安装后由管理员指定应用负责人，负责人配置角色和使用人员，员工才能看到应用。
