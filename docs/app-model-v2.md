# 应用模型 v2 架构方案

状态：已确认（2026-10-23），按第 8 节分阶段实施。基于 0.25.0 代码审计（2026-10-23）。

实施进度：P1 已在 0.26.0 完成（清单、SDK、`mop-app init/check/build`、`.mopkg` 安装预览）；P2 运行时已在 0.27.0 完成（安装、子进程、同源页面、数据服务），P2 收尾在 0.28.0 完成（管理端独立域名、`mop-app dev`、页面平台目录与附件、旧版后端兼容），见第 8 节。

## 1. 目标与定位

平台定位调整为**内部运管平台**：应用由本单位人员（多数借助 AI）开发，由管理员安装。平台对应用提供身份、权限、人员/车站/设备目录、存储、AI、通知、签字、附件和部署运行；应用装上即作为平台的一部分运行。

v2 的四个目标：

1. **同源加载**：应用页面直接渲染在平台页面中，与平台自带页面无差别，不再出现 iframe 框。
2. **子进程后端**：应用后端由平台以 Node 子进程托管，不再依赖 Docker。
3. **单文件包**：开发工具只产出一个 `.mopkg` 文件，包含名称、图标、清单、前后端和迁移。
4. **存储简化**：保留每应用独立 schema 和声明式迁移，去掉租约、回执、证据、对账和“未知写入阻断”。

非目标：对外开放给第三方、移动端适配（另行规划）、平台自身发行签名与在线更新器（保持现状）。

## 2. 现状与问题

| 环节 | v1 现状 | 问题 |
|---|---|---|
| 前端 | 每应用一个 iframe，独立 HTTPS 资源域、每应用子域、60 秒一次性地址、CSP、postMessage 桥（单条 64KB 上限）；应用各自打包 React 与组件库 | 冷启动慢，弹窗/主题/导航需 `platform.ui.modal`、`platform.ui.theme`、`platform.ui.navigation` 等桥接补偿，视觉割裂；部署需要额外域名与证书 |
| 后端 | 每应用一个 Docker 容器，镜像审批、broker、supervisor、journal，stdio 行协议网关 | 运行链路长，0.25.0 验收已记录“容器协议与冷启动仍有成本” |
| 包 | 发布者私钥签名 + 公钥核实 + 发布者策略；`build.mjs` 手工拼约 20 个字段的清单；`.mop.gz`、`.install.json`、SDK `.tgz`、Skill `.tar.gz` 并存；CLI 6 个位置参数子命令且直接引用 `server/src` | 开发者流程不清晰，AI 生成的应用难以一次打包正确 |
| 存储 | 每应用 schema + owner/runtime 两个角色、独立高权限管理连接、迁移账本、回执、租约、证据、对账；未知写入保留并阻断 | 约 2000 行，运维门槛高；而数据库事务本身已保证原子性 |
| 授权 | 应用负责人逐接口开放、升级后重新确认；跨应用能力调用 | 8 个应用中**没有任何一个**使用跨应用调用（`platform.apps.invoke`） |

可直接删除或大幅缩减的代码（不含测试，测试约 35 个文件相关）：

| 模块 | 行数 |
|---|---|
| `server/src/app-platform/runtime/` 中 docker-*、stdio-*、work-journal、host-lease、hosted-api | ~1640 |
| `server/src/app-platform/storage/` 中租约、账本、回执、证据、对账、portable-data | ~670（其余迁移编译与数据访问保留并简化） |
| `server/src/app-platform/sandbox/`、`mcp-apps/`、`extensions/` | ~880 |
| `src/app-platform/host/sandbox`、`mcp-apps`、`embedded` | ~850 |
| 包签名与发布者策略、导出上传、安装 journal、能力开放 | ~390 |

## 3. 总体架构

```
浏览器（同一个平台 SPA）
 ├─ 平台外壳：顶栏、侧栏、工作台、通知
 └─ 应用页面：import('/api/apps/:id/ui/:hash.js') → React 组件，挂在外壳内容区
        │  useApp().api.call('submit', …)
        ▼
平台 API（Node，单进程）
 ├─ 会话与员工权限校验（每次调用）
 ├─ 应用进程管理器 ──fork/IPC──▶ 应用后端子进程（每应用一个）
 │                               └─ ctx.data / ctx.platform.* 经 IPC 回到平台
 ├─ 应用数据服务：在 app_<安装ID> schema 中执行声明式读写
 └─ 平台能力：人员、车站、设备、AI、通知、签字、附件、Webhook
PostgreSQL
 ├─ 平台表
 └─ app_xxx schema（每应用一个，沿用现有）
```

保留不变：管理员与员工两套身份、应用角色与数据范围（本人/工班/部门/组织/全部）、工作台摘要、平台目录与能力网关的业务语义、平台发行与更新器。

## 4. 前端：同源加载

### 4.1 应用前端写法

应用前端是一个 ES 模块，默认导出 `defineApp(...)`：

```jsx
import {defineApp, useApp} from '@metro/platform-sdk/app';
import {Button, QueryList, Dialog} from '@metro/platform-sdk/ui';

function Tasks() {
  const {api, user, navigate, toast} = useApp();
  // api.call('list', {...}) → 本应用后端 handler
  return <QueryList /* ... */ />;
}

export default defineApp({
  pages: {'/': Tasks, '/devices': Devices, '/records/:id': RecordDetail},
  dashboard: Summary,          // 可选：工作台卡片组件
});
```

`useApp()` 提供：`appId`、`api.call(apiId, input)`、`user`（当前员工、组织、本应用已授予的权限 `has()`）、`route`（路径与参数）、`navigate(path)`、`toast`、`confirm`、`platform` / `directory`（人员、组织、线路车站、设备的只读查询，按应用授权与员工范围执行）、`files`（按业务记录上传、列出、下载原件附件，由应用的 `authorize-attachment` 接口授权）。弹窗、主题、导航由共享组件与外壳直接处理，不再需要 `platform.ui.*` 桥接操作。

### 4.2 加载与共享依赖

- 外壳在加载第一个应用页面前登记共享模块表 `globalThis.__MOP_SHARED__`：`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、`@metro/platform-sdk/app`、`@metro/platform-sdk/ui`（外壳自己的组件库，导出清单见 `src/components/ui/app-exports.ts`，SDK 的 `ui.js` 由同一清单构建）。
- `mop-app build` 把对这些模块的 import 编译成对共享表的读取（CommonJS 包装，任意具名导入都可用），`ui.js` 只含业务代码；示例应用页面约 2KB。实施中改用此方式代替 import map：无需生成垫片文件，外壳只需 `import(moduleUrl)`。
- 页面文件地址带内容哈希（`/api/employee/apps/:id/v2/:sha256/ui.js`），按员工准入下发，私有长期缓存；升级即换地址。
- 应用 CSS（可选 `ui.css`）由 CLI 自动加 `[data-app="<id>"]` 前缀，外壳在应用容器上设置该属性，避免样式互相污染。颜色、字号、圆角等一律引用平台 CSS 变量。

### 4.3 外壳行为

- 路由 `/employee/app/:appId/*`：外壳根据清单 `pages` 匹配页面、校验页面权限，页面标题、面包屑和侧栏导航由外壳根据清单生成。
- 每个应用包在 `ErrorBoundary` + `Suspense` 中：应用报错只影响内容区，显示“应用出错，重新加载”，错误上报平台日志。
- 页面切换不再需要保留 iframe；模块缓存后再次进入是普通的 React 路由切换。是否保留页面状态（keep-alive）先不做，按实测决定。

### 4.4 安全取舍

应用前端与员工会话同源，意味着应用代码能以当前员工身份调用平台接口。接受该取舍的前提：

- 应用只能由管理员安装，安装记录包哈希与操作人；
- 服务端对每次调用按**员工权限**校验，应用不能获得超出当前员工的能力；
- 应用代码**不在管理端加载**。v1 的管理端应用页面（`AdminApplicationOutlet`，`requiresEmployee` 为假的页面）迁到员工端，由应用的管理权限（如 `manage`）控制。

管理端独立域名已在 0.28.0 提供：配置 `ADMIN_PUBLIC_BASE_URL` 后两类会话的 Cookie 分属不同主机，员工端页面无法借用管理员会话。

## 5. 后端：子进程托管

### 5.1 应用后端写法

```js
import {defineServer} from '@metro/platform-sdk/server';

export default defineServer({
  async list(input, ctx) {
    return ctx.data.list('inspections', {filters: [{column: 'station_id', value: input.stationId}], pageSize: 50});
  },
  async submit(input, ctx) {
    ctx.require('inspect', {organizationUnitId: input.organizationId});   // 数据范围校验
    await ctx.data.transaction(input.requestId, [{action: 'insert', table: 'inspections', id: ctx.uuid(), values: {/* ... */}}]);
    return {ok: true};
  },
}, {
  start(ctx) { /* 可选：定时任务，如周期待办 */ },
});
```

`ctx` 提供：`employee`（与 v1 `AppBackendEmployeeContext` 相同字段）、`can/require`（复用 `allowsAppResource` 语义）、`data`（与 v1 `createAppDataClient` 相同方法）、`platform.invoke(operation, params)`（调用 `platform.people.members` 等平台能力，受 `platformAccess` 限制）、`log`、`uuid`。

**兼容**：v1 写法 `createAppBackend({input: process.stdin, output: process.stdout, handlers})` 继续可用。新版 SDK 检测到 IPC 通道（`process.send` 存在）时改走 IPC、忽略 stdin/stdout；现有 8 个应用的 `entry.mjs`、`handlers.mjs`、`service.mjs` 无需改动，用新 SDK 重新构建即可。

### 5.2 进程管理器

| 项 | 规则 |
|---|---|
| 启动 | 平台启动及应用启用时 `child_process.fork(server.js)`；工作目录为 `runtime/apps/<id>/<version>/` |
| 环境 | 只传 `NODE_ENV`、`TZ`、`MOP_APP_ID`；不传数据库地址、会话密钥等任何平台凭据 |
| 资源 | `--max-old-space-size`（默认 256MB，清单可调）；单次调用超时默认 30 秒 |
| 通信 | Node 内置 IPC（JSON 消息），请求 `{id, kind:'call', api, input, employee}`，应用回调平台 `{id, kind:'platform', op, params}` |
| 健康 | 进程存活 + 每 30 秒 IPC ping；不再要求应用自开 HTTP 健康端口（v1 的 8080 端口代码保留也无害） |
| 崩溃 | 自动重启，退避 1s→2s→4s… 最长 60s；5 分钟内连续崩溃 5 次标记为“异常”，管理端可见并告警 |
| 停止/升级 | 停止接收新调用 → 等待进行中调用（最长 10 秒）→ SIGTERM → 5 秒后 SIGKILL |
| 日志 | stdout/stderr 按行加 `[app:<id>]` 前缀写入平台日志，管理端应用状态页可看最近日志 |

可选加固（待确认）：启用 Node 权限模型（`--permission --allow-fs-read=<应用目录>`）限制应用读写文件和起子进程。平台要求的 Node 22 中该特性仍需 `--experimental-permission`，建议先不开，平台 Node 升级到稳定版本后再评估。

10 个应用常驻约 10×40–80MB 内存，在当前服务器上可接受；如后续应用增多，再引入“首次调用时启动、空闲 15 分钟停止”。

### 5.3 调用链

```
POST /api/apps/:appId/call/:apiId   （员工 cookie）
 → 校验：会话有效、员工有本应用使用授权、有该 API 的权限，解析业务授权（角色 + 数据范围）
 → IPC 调用子进程 handler（附 employee 上下文）
 → handler 内 ctx.data.* / ctx.platform.* 经 IPC 回平台，平台以同一员工上下文校验后执行
 → 返回 JSON
```

## 6. 存储简化

### 6.1 保留

- 每应用一个 schema：沿用现有命名 `app_<安装ID去连字符>`，**现有数据原地保留，无需搬迁**。
- 声明式 JSON 迁移（`createTable`、`addColumn`、`createIndex`），按文件名顺序追加执行；对 AI 生成的应用更安全，不开放任意 SQL。
- 数据访问 API 不变：`get / list / readBatch / count / daily_count / insert / update / delete / transaction`，含 `expected` 旧值校验（乐观锁）。

### 6.2 去掉

- 每应用 owner/runtime 两个数据库角色、独立的 `MOP_APP_STORAGE_ADMIN_DATABASE_URL`、连接租约与咨询锁检查。平台 API 的数据库角色直接拥有/读写各应用 schema；应用进程本身没有数据库凭据，只能经平台数据服务访问自己的 schema，隔离由平台代码保证。
- 迁移账本、回执、生命周期证据、运行时证据、对账，以及“未知写入保留并阻断”。

### 6.3 新的一致性规则

- 一次 `transaction` 在一个数据库事务内执行，要么全部成功要么全部回滚，不存在“写了一半”的状态。
- `requestId` 作幂等键：平台在同一事务内写入 `platform_app_v2_requests(installation_id, request_id, result)`（主键约束）。客户端或应用超时后**可以用同一 requestId 安全重试**：重复请求不再写入，直接返回首次提交的结果（即使重试时重新生成了行 ID）。键保留 7 天。
- 迁移记录简化为一张表 `platform_app_v2_migrations(installation_id, migration_id, sha256, applied_at)`；已执行的迁移摘要不可变，升级只能在末尾追加。
- 外部写（Webhook、企业微信等）仍然不自动重放，失败如实返回给应用。

`AGENTS.md` 的对应规则已在 0.27.0 改为：平台内数据库写入以事务和幂等键保证一致；外部系统写入失败不自动重放。

## 7. 单文件包 `.mopkg`

### 7.1 文件结构

`.mopkg` 是普通 zip：

```
extinguisher-inspection-1.0.0.mopkg
├─ app.json            必需：清单
├─ icon.svg            必需：图标（svg ≤64KB，或 icon.png 256×256）
├─ ui.js               有页面时必需：ES 模块
├─ ui.css              可选
├─ server.js           有接口时必需：已打包的 Node 模块
├─ migrations/
│   ├─ 001-initial.json
│   └─ 002-add-photo.json
├─ README.md           可选：说明，安装预览中展示
└─ CHANGELOG.md        可选：升级预览中展示
```

限制：包 ≤50MB、`ui.js` ≤5MB、`server.js` ≤20MB；拒绝绝对路径、`..`、符号链接与未列出的目录。平台记录整个包的 sha256 用于审计与回滚，不再要求发布者签名。

### 7.2 清单 `app.json`

```json
{
  "id": "extinguisher-inspection",
  "name": "灭火器巡检",
  "version": "1.0.0",
  "description": "按车站巡检灭火器，记录压力、有效期和照片",
  "color": "#E5484D",
  "platform": ">=0.26.0",
  "permissions": [
    {"code": "read",    "name": "查看巡检记录", "scopes": ["self", "workgroup", "department", "all"]},
    {"code": "inspect", "name": "提交巡检",     "scopes": ["self", "workgroup"]},
    {"code": "manage",  "name": "管理灭火器台账", "scopes": ["department", "all"]}
  ],
  "platformAccess": ["people.read", "locations.read", "attachments.create", "attachments.read"],
  "pages": [
    {"path": "/",            "title": "巡检任务",   "permission": "read",   "nav": true},
    {"path": "/devices",     "title": "灭火器台账", "permission": "manage", "nav": true},
    {"path": "/records/:id", "title": "巡检详情",   "permission": "read"}
  ],
  "api": [
    {"id": "list",    "permission": "read"},
    {"id": "submit",  "permission": "inspect"},
    {"id": "summary", "permission": "read", "dashboard": true}
  ],
  "limits": {"memoryMiB": 256}
}
```

相对 v1 的变化：

| v1 字段 | v2 处理 |
|---|---|
| `manifestVersion`、`publisherId`、`artifacts`（含 sha256/bytes） | 删除，由包内文件约定代替 |
| `ui.mode`、`backend.mode/runtime/entryArtifactId`、`storage.mode` | 删除，按 `ui.js`、`server.js`、`migrations/` 是否存在推断 |
| `routes` + `navigation` | 合并为 `pages`；`nav: true` 进入侧栏，顺序即数组顺序；支持 `:id` 参数 |
| `api[].method/path/handler/businessPermission/businessEntry/expose` | 简化为 `id + permission`；全部 POST，handler 名即 id；`dashboard: true` 代替 `expose` + `dashboard` |
| `permissions.defined/requested` | `permissions`（本应用权限，短代码，平台自动加 `app.<id>.` 前缀）与 `platformAccess`（平台能力） |
| `compatibility.platform` 区间 | `platform` 字符串，如 `">=0.26.0"` |
| `events`、`jobs`、`tools`、`resources`、`network`、`health` | 删除；定时任务写在 `server.js` 的 `start()` 中 |
| `icon.paths`（内联 SVG 路径） | `icon.svg` 文件 + `color` 主题色，用于彩色应用图标 |

清单校验 schema 放入 SDK（`@metro/platform-sdk/manifest`），平台与 CLI 共用，CLI 不再引用 `server/src`。

### 7.3 开发工具

沿用现有 npm 包 `@metro/platform-cli`（命令 `mop-app`，内含项目模板和 Agent Skill；SDK 作为项目依赖安装）：

| 命令 | 作用 |
|---|---|
| `mop-app init <目录> [--id] [--name]` | 生成项目：`app.json`、`icon.svg`、`src/ui.jsx`、`src/server.js`、`migrations/001-initial.json`、测试样例，并写入 Agent Skill（`.claude/skills/metro-app/`、`AGENTS.md`） |
| `mop-app dev [--out <目录>]` | 监听源码、增量构建到 `.mop/dev/`；本地平台开启开发模式（`MOP_DEV_APPS_DIR`）后自动加载该目录，前端改动刷新即生效，后端改动自动重启子进程 |
| `mop-app check` | 校验清单、权限引用、图标、迁移编号与结构、源码入口；与平台安装预览使用同一套规则 |
| `mop-app build` | 构建页面（React 与组件库不打包）与接口，核对接口函数与 `api` 一致，CSS 自动加应用前缀，输出 `dist/<id>-<version>.mopkg`，这是唯一交付物 |

开发者中心“工具与下载”简化为：下载 CLI 与 SDK + 查看文档；v1 的 create/validate/pack/sign/verify/export-upload 命令保留到 1.0.0。

### 7.4 安装与升级

管理端“安装应用”：上传 `.mopkg` → 平台解析并展示预览（图标、名称、版本、说明、权限与平台能力增减、页面、接口、迁移、问题清单）→ 安装或更新。

- 顺序：校验 → 文件写入 `<artifactRoot>/v2/<appId>/<sha256>/` → 迁移（单个事务，仅追加，对正在运行的旧版本无影响）→ 注册表切换版本 → 服务身份与平台能力授权 → 启动进程并启用。每一步可重复，失败后重新上传同一个包即可继续。
- 降级拒绝；同版本只在应用已停用时作为“修复”接受。现有 v1 应用暂不能用 `.mopkg` 更新（P3 迁移提供）。
- 平台能力按 `platformAccess` 在安装时授予；本应用权限沿用现有**应用负责人 + 业务角色与数据范围**：管理员在“设置”中指定负责人，负责人在员工端“应用管理”配置角色和使用人员。未配置前应用对员工不可见。
- 进程启动失败时生命周期记为失败、应用保持停用，状态页可查看最近日志。

## 8. 实施阶段

采用**双运行时过渡**：v2 与 v1 并存，应用逐个迁移，全部迁完后再删 v1 代码。每个阶段可独立发版。

| 阶段 | 内容 | 交付与验收 |
|---|---|---|
| P1 包与清单（0.26.0，已完成） | SDK 增加 `manifest`、`mopkg`、`app`（defineApp/useApp）、`server`（defineServer）；CLI 的 init/check/build；管理端 `.mopkg` 安装预览（`POST /api/admin/app-packages/preview`，只读） | 用模板做一个“灭火器巡检”示例，`mop-app build` 产出单文件，管理端能解析并展示安装预览；实际运行在 P2 接通，此阶段不改变现有应用 |
| P2 运行时（0.27.0，已完成） | 进程管理器 + IPC；同源页面加载、共享模块表、错误边界；数据服务直连 schema；`platform_app_v2_requests`、`platform_app_v2_migrations`；`.mopkg` 安装/升级/修复 | 本地真实 PostgreSQL + 浏览器验收：安装、负责人配置角色、员工打开页面、写入、带参数页面跳转、升级（新迁移）、撤权后按钮隐藏且接口拒绝。接口往返 p50 7ms / p95 9ms，在线升级 122ms（本机测量，非生产数据） |
| P2 收尾（0.28.0，已完成） | 管理端独立域名；`mop-app dev` 与平台开发模式；`useApp().platform/directory/files`；v1 `createAppBackend` 经 IPC 运行（P3 前提） | 浏览器验收：分站登录与跳转、员工端调用管理接口被拒、页面查询成员、附件上传下载、开发模式改动自动生效；真实待办后端在子进程中注册 12 个接口 |
| P3 应用迁移（0.27.x–0.28.x） | 按下表逐个迁移现有应用 | 每个应用：本地测试通过 → 备份 → 生产升级 → 核对数据与权限 |
| P4 清理（0.29.0 或 1.0.0） | 删除 Docker 运行时、iframe 沙箱、资源域、包签名、存储租约与证据、能力开放等 v1 代码与测试；更新 docs、Skill、`AGENTS.md` | 全量测试、类型检查、构建通过；部署文档去掉资源域与 Docker 要求 |

## 9. 现有应用迁移路径

### 9.1 数据迁移（一次性，P3 开始时执行）

1. 平台迁移脚本把各应用 schema 的所有权/读写权限授予平台 API 角色（需用一次现有存储管理连接）。
2. 从 v1 迁移账本读取每个应用已执行的迁移 ID 和摘要，写入 `app_migrations`；之后 v1 账本只读保留一个版本周期再删除。
3. 应用表和业务数据不移动、不改结构。
4. 执行前完整备份数据库，脚本可重复执行（已授权、已登记的跳过）。

### 9.2 每个应用的改造

| 改造项 | 工作量 |
|---|---|
| `build.mjs` 里拼清单 → 写 `app.json`；`migration-*.json` 移到 `migrations/` | 小；保持迁移内容与顺序不变，平台按摘要核对 |
| 后端 `entry.mjs` | 无需改动，用新 SDK 重建 |
| 前端入口：去掉 `document.currentScript`、`createRoot`、注入 CSS 字符串、`createAppSandboxClient`，改为 `export default defineApp(...)` | 小 |
| 前端中 `platform.ui.modal/theme/navigation/context` 调用 | 删除或改用 `useApp()`；共享组件本身已一致 |
| 文件、图片、附件：`createSandboxAttachmentClient`、`createSandboxImageClient` → `useApp().files` | 中，仅慧策通、隐患涉及 |
| 管理端应用页面（若有）迁到员工端并以 `manage` 权限控制 | 视应用而定 |

### 9.3 迁移顺序

| 顺序 | 应用 | 版本 | 规模（行） | 依赖平台能力 | 难度 |
|---|---|---|---|---|---|
| 1 | 物料管理 materials | 0.2.9 | 566 | 数据（3 次迁移）、人员 | 低，作为试点，已有完整升级验收经验 |
| 2 | 故障记录 faults | 0.1.0 | 336 | 数据、设备、车站、人员 | 低 |
| 3 | 检修管理 maintenance | 0.2.0 | 414 | 数据、设备、车站、人员 | 低 |
| 4 | 待办事项 todos | 0.2.0 | 700 | 数据、车站、人员；后端周期任务 | 中（验证 `start()` 定时任务） |
| 5 | 隐患提报 hazards | 0.2.2 | 515 | 数据、AI、图片 | 中（文件通道） |
| 6 | 在线签字 signatures | 0.1.2 | 293 | 数据、签字、通知；有 `platform.ui.context` | 中（签字面板与跨应用跳转） |
| 7 | 慧策通 huicetong | 0.4.0 | 1130 | 数据（3 次迁移）、AI、附件、图片 | 中高 |
| 8 | 晨会交接 shifts | 0.0.16 | 3071 | 数据、签字、通知、Webhook | 高（规模最大，外部 Webhook） |

仓库外的应用（生产中的“创新管理平台”等，当前生产共 10 个应用）需要取得源码后按同一路径评估；未迁移前继续由 v1 运行时承载。

### 9.4 回滚

- P2 发版后 v1 运行时仍在，任一应用迁移后出问题，可重新安装其 v1 包回到 Docker + iframe 运行方式；数据 schema 未变，可直接回退。
- 迁移过程中若应用新增了迁移，回滚前需确认旧版本能忽略新增的可空列（声明式迁移只允许追加可空列，通常可以）。

## 10. 已确认事项（2026-10-23）

1. 管理端改为独立子域名或端口，与员工端分开 cookie 作用域（随 P2 实施）。
2. 暂不启用 Node 权限模型。
3. 迁移只允许声明式 JSON；`renameColumn`、带默认值的非空列等按实际需要再补。
4. 版本节奏：P1–P3 走 0.26–0.28 的次版本，P4 清理完成时升 1.0.0。
5. `AGENTS.md` 中“外部写结果保持未知”规则按第 6.3 节改写，随 P2 存储改造一起落地。
6. 应用后端先常驻。
