# 员工身份与目录接口

## 初始化与边界

通过 `npm --prefix server run db:init` 显式安装新增的员工账号/会话及目录权限定义迁移。连同应用 runtime 存储迁移，当前共 35 项平台迁移；启动服务不会自动执行。迁移不创建员工账号、不授予角色权限，也不复制管理员身份。

员工账号绑定已有在职人员；所属组织、岗位也必须启用。管理员通过以下接口管理账号，需要平台管理员会话、写请求的同源 Origin 及 `platform.authorization.manage`：

| 方法 | 路径 | 请求体 |
| --- | --- | --- |
| GET | `/api/admin/employee-accounts` | `search?`、`status?`、`page?`、`pageSize?` 查询参数 |
| GET | `/api/admin/apps/:appId/employee-access` | 员工使用授权及版本 |
| PUT | `/api/admin/apps/:appId/employee-access` | `{personId,enabled,revision}`，首次授权 revision 为 null |
| POST | `/api/admin/employee-accounts` | `{personId, username, password}` |
| PATCH | `/api/admin/employee-accounts/:id` | `{status?, password?}`，至少一项 |

用户名 3–64 位，字母或数字开头，允许 `_ . -`，统一小写；密码至少 12 字符、不超过 72 UTF-8 字节。密码使用 bcrypt，返回值不包含哈希。创建/修改写入管理员审计；停用、重新启用、重置密码均撤销已有会话。管理员在“账号管理 → 员工账号”中创建、分页搜索账号、重置密码与启停。账号与人员一一关联，不赋予管理员身份。

## 员工会话

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/api/employee/auth/login` | `{username,password}`，返回公开账号字段并设置 Cookie |
| GET | `/api/employee/auth/me` | 当前账号 |
| POST | `/api/employee/auth/logout` | 撤销当前会话、清除 Cookie |
| GET | `/api/employee/apps` | 当前可用的沙箱应用列表 |
| GET | `/api/employee/apps/:appId/ui?path=/` | 已授权页面资源与宿主持有的实例绑定 |
| POST | `/api/employee/apps/:appId/gateway` | 当前员工代表指定应用调用 Gateway |
| POST | `/api/employee/apps/:appId/api` | 调用已装配的隔离应用 API；须声明本应用定义的权限 |

Cookie `mop_employee_session` 有效期 8 小时，HttpOnly、SameSite=Strict，路径 `/api/employee`，HTTPS 下启用 Secure；数据库仅保存随机令牌的 SHA-256 摘要。写请求必须提供配置的同源 Origin。登录按 IP 限制每分钟 5 次；当前限流为单进程，横向部署需另行接入共享限流。

管理员 Cookie 不可用于员工入口；请求体不得携带身份或授权范围。员工入口为 `/#/employee`，包含登录、我的应用及沙箱页面。管理员入口仍为 `/#/admin`。平台 Cookie、会话令牌和实例绑定不传入沙箱；SDK 消息由平台宿主转发到 Gateway。

## 默认 Gateway 操作

请求示例（`id` 换成真实目录 UUID）：

```json
{"version":"1.0","operation":"platform.locations.get","params":{"id":"51000000-0000-4000-8000-000000000004"}}
```

| 操作 | 权限 | 返回字段 |
| --- | --- | --- |
| `platform.locations.get` | `platform.locations.read` | id、code、name、locationType、status、organizationUnitId |
| `platform.locations.list` | `platform.locations.read` | organizationUnitId、rows、nextCursor；rows 为位置白名单字段 |
| `platform.assets.get` | `platform.assets.read` | id、displayName、assetCode、locationId、typeId、lifecycleState、organizationUnitId |

按 ID 查询只接受 `{id}`。不存在或无权访问的对象均拒绝；不提供目录批量导出。位置按真实位置/组织授权，设备按真实设备/位置/类型及位置所属组织授权。执行前、执行后和返回快照均做范围检查，防止数据变化导致越权返回。

位置列表接受 `{organizationUnitId?, afterId?, pageSize?, search?, status?}`。页大小默认 20、最多 50；search 为名称和编码的字面子串（最多 100 字符），status 仅 active/inactive。数据库按 UUID 升序有界读取，用返回的 nextCursor 续页；不返回总数。未指定组织时必须具有完整目录授权；指定组织时对该组织做授权并限制 SQL 查询范围，返回每行再次检查真实范围。组织参数是待验证资源，不是授权声明。范围不足时连空页也拒绝；逐对象授权仍用 get 查询。游标不要求记录仍存在，删除游标记录不会回到第一页。

管理员还需在应用授权页面分配“员工使用范围”；安装或授予目录权限不会自动允许所有员工打开应用。授权使用比较并更新版本，防止管理员覆盖其他人的变更；审计记录应用安装 ID 和员工 ID。

应用必须声明权限且经管理员批准。员工还需具有相应角色权限；两者取交集。服务调用沿隔离后端的 Gateway 传输入口，要求独立服务凭据与服务授权，不能借用员工角色。默认组织树和责任范围解析器尚未装配，这些范围保持拒绝；可使用已实现的 all、organization 和 explicit 范围。

员工 Gateway 请求必须携带平台宿主从页面资源响应取得的 `X-Mop-Employee-Admission`；它是员工、安装和授权版本的绑定值，不是认证凭据，不能替代 Cookie 或实时授权。沙箱不能选择该值。每次校验都与当前状态比较，旧页面在撤权后重新授权、升级或切换员工后必须重新打开。

员工调用在执行及返回检查时重新验证会话并固定身份。应用须由当前宿主持有有效租约且正在服务；停用、失去租约或持久工作记录失败会阻断调用。发布者或版本审批记录读取后，入口再次核对身份、使用授权与安装版本；失效或无法确认则拒绝。应用列表和页面状态每 5 秒刷新，重新聚焦也检查页面；接口后续访问即时校验，已经下载的页面内容无法追溯撤回。

操作使用普通 API 数据库连接，不借用存储管理连接或生命周期事务会话。

## 验证范围

PGlite 集成测试覆盖账号登录、真实目录读取、角色/应用授权交集、跨位置拒绝、管理员 Cookie 拒绝、注销/停用/密码重置/离职以及服务授权。定向测试还覆盖审批读取期间撤权、重新授权、升级、安装替换、宿主停用、身份切换及旧页面绑定拒绝。定向测试覆盖返回快照变化、调用途中身份撤销或替换；宿主测试覆盖停用和失去租约后的员工入口拒绝。

这些测试未替代生产 PostgreSQL、真实隔离后端、员工浏览器入口或生产资源域验收。

## 隔离后端员工上下文（底层通道已实现）

Hosted API 在调用前重新解析平台人员上下文，将最小字段通过独立 `employee` 信封传入后端：`version`、`personId`、`organizationUnitId`、`requestId`、`traceId`、`permissions`（本应用定义且经宿主实时授权的权限快照）。不传会话 Cookie、登录标识、服务凭据或角色列表。字段来源为受信任平台上下文，业务 payload 中同名字段不会覆盖它。

接入该信封的后端必须用本次更新后的 SDK 重新构建；旧 SDK 的严格协议解析不接受新增 employee 字段。SDK 的 handler 可声明 `requireEmployeeContext: true`，并通过 `execute(payload, signal, employee)` 的第三参数读取不可变上下文。缺失、格式错误或夹带额外身份字段的信封在业务处理前拒绝；未要求身份的旧处理器仍可处理无身份的底层协议帧。该信封仅可信于平台控制的标准输入通道，不能从公网 HTTP 请求体构造。

Hosted API 固定调用人的员工及组织 ID，并在执行后重新核对；停用、撤权或人员/组织更换后不返回结果。已派发操作遇到这些失败时仍报告未知结果，不能自动重试，也不表示业务写入被撤销。

员工 HTTP API 请求仅接受 `{apiId,method,path,payload}`，同样要求员工 Cookie、同源 Origin 和 `X-Mop-Employee-Admission`。宿主保留重新验证会话及页面授权的回调，调用前后以及嵌套的后端 Gateway 授权时重新执行；URL 和 payload 不能指定员工或覆盖这些回调。HTTP 路由已接通到宿主，管理端已装配保守的 API 权限检查：没有可信业务资源解析器时，仅员工及应用均具备不受范围限制的授权才可通过，组织/本人/显式对象范围不会被当作完整权限放行。具体业务范围仍待适配，默认安装继续拒绝自定义 API 声明。

沙箱宿主根据平台返回的已验证清单 API 列表构造 `application.api.<id>` 消息方法，固定其 API ID、HTTP 方法和相对路径；沙箱参数只成为业务 payload。SDK 使用 `createAppApiClient(sandboxClient).invoke(apiId, payload)`，无需知道 HTTP 路径、Cookie 或页面绑定。调用失败不自动重试。此桥已用真实消息代理与公开 SDK 做协议测试，尚未进行浏览器或真实物料验收。

SDK 自动将 handler 内的异步 Gateway 调用绑定至原始 API 帧 ID；宿主只接受当前有效的调用，不接受不存在、已结束、超时或断开的绑定。带 API 声明的宿主要求所有后端 Gateway 请求具有绑定，缺失绑定不能退回自主服务调用。不能启动未等待的后台任务延续员工授权。

后端仍以自身服务授权访问托管存储，额外受原员工调用的授权回调约束。Gateway 将回调保留到操作上下文，存储在提交前调用授权方法时再次复核；原员工调用撤权不会因为服务授权仍有效而被绕过。临时 PostgreSQL 测试已验证 SQL 执行后撤权会回滚、保留原数据并记为 rolled_back。若 COMMIT 已送出而确认丢失，仍按既有原事务证据规则处理，不能宣称回滚或自动重放。

完整真实应用验收仍需具体业务权限/数据范围适配、受限存储管理及物料应用。上述底层接线不能作为默认应用安装或生产验收完成的依据。


0.3.0 宿主在调用、嵌套 Gateway 和提交前复核 permissions 快照，额外管理权限被撤销时即使基础 read 仍有效，也会拒绝原调用。应用不能通过 payload 设置权限。成员目录 `platform.people.members` 仅供已授权 Gateway 调用，接受 organizationUnitId 和可选 personId/search，返回最多 50 个有效工班成员的 ID、姓名、工号与组织 ID，不包含联系方式。查询前校验组织范围，返回时复核实际成员范围；通过服务身份调用仍须单独服务授权。
