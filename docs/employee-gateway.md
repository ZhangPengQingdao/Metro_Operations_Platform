# 员工身份与目录接口

## 初始化与边界

通过 `npm --prefix server run db:init` 显式安装员工账号/会话及目录权限定义迁移；启动服务不会自动执行。迁移不创建员工账号、不授予角色权限，也不复制管理员身份。

员工账号绑定已有在职人员；所属组织、岗位也必须启用。管理员通过以下接口管理账号，需要平台管理员会话、写请求的同源 Origin 及 `platform.authorization.manage`：

| 方法 | 路径 | 请求体 |
| --- | --- | --- |
| GET | `/api/admin/employee-accounts` | `search?`、`status?`、`page?`、`pageSize?` 查询参数 |
| GET | `/api/admin/apps/:appId/employee-access` | 仅供尚未切换应用角色模式的旧应用读取历史使用授权 |
| PUT | `/api/admin/apps/:appId/employee-access` | 仅供旧应用过渡使用；新应用请配置人员范围和业务角色 |
| POST | `/api/admin/employee-accounts` | `{personId, username, password}` |
| PATCH | `/api/admin/employee-accounts/:id` | `{status?, password?}`，至少一项 |

用户名 3–64 位，字母或数字开头，允许 `_ . -`，统一小写；密码至少 8 字符，且大写字母、小写字母、数字、特殊符号中至少包含三类，不超过 72 UTF-8 字节。密码使用 bcrypt，返回值不包含哈希。创建/修改写入管理员审计；停用、重新启用、重置密码均撤销已有会话。管理员在“账号管理 → 员工账号”中创建、分页搜索账号、重置密码与启停。账号与人员一一关联，不赋予管理员身份。

## 员工会话

已有密码不合规时，下次登录签发仅允许读取本人会话、改密与退出的受限会话，公开账号返回 `passwordChangeRequired: true`；网页强制改密，业务接口拒绝访问。改密后撤销全部会话并重新登录。升级迁移与管理员规则见 [密码规则](password-policy.md)。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/api/employee/auth/login` | `{username,password}`，返回公开账号字段并设置 Cookie |
| GET | `/api/employee/auth/me` | 当前账号 |
| POST | `/api/employee/auth/logout` | 撤销当前会话、清除 Cookie |
| GET | `/api/employee/apps` | 当前员工可用的应用（名称、图标、页面、侧栏） |
| GET | `/api/employee/apps/:appId/v2-session?path=/` | 打开页面：准入键、员工在本应用的权限、页面模块地址 |
| GET | `/api/employee/apps/:appId/v2/:sha256/ui.js`、`ui.css` | 按版本不可变的页面文件 |
| POST | `/api/employee/apps/:appId/api` | 调用本应用接口 `{apiId,method,path,payload}` |
| POST | `/api/employee/apps/:appId/v2-platform` | 页面直接只读查询目录 `{operation,params}` |
| GET/POST | `/api/employee/apps/:appId/attachments` | 附件上传、列表与下载（经应用 `authorize-attachment` 授权） |
| GET | `/api/employee/apps/:appId/dashboard` | 工作台摘要卡片 |

Cookie `mop_employee_session` 有效期 8 小时，HttpOnly、SameSite=Strict，路径 `/api/employee`，HTTPS 下启用 Secure；数据库仅保存随机令牌的 SHA-256 摘要。写请求必须提供配置的同源 Origin。登录按 IP 限制每分钟 5 次；当前限流为单进程，横向部署需另行接入共享限流。

管理员 Cookie 不可用于员工入口；请求体不得携带身份或授权范围。员工入口为 `/#/employee`，管理员入口为 `/#/admin`。

## 应用调用

页面由平台同源加载。应用接口和目录查询请求必须携带 `X-Mop-Employee-Admission`（打开页面时取得）：它绑定员工、安装版本和授权版本，不是认证凭据，不能替代 Cookie 或实时授权。撤权、升级或切换员工后，旧页面的请求被拒绝，需要重新打开。

调用本应用接口时，平台检查员工会话、应用准入、接口声明的权限（或业务角色），再把可信员工上下文（`personId`、`organizationUnitId`、本应用权限快照与业务授权）随调用传给应用进程；业务 payload 中的同名字段不会覆盖它。应用进程在处理期间发起的平台调用以应用的服务身份执行，并绑定该员工，人员与组织范围照常生效。

页面可直接调用的只读目录操作：`platform.people.members`、`platform.people.organization_context`、`platform.locations.get`、`platform.locations.list`、`platform.locations.responsible_stations`、`platform.assets.get`、`platform.assets.list`；须在 `app.json` 的 `platformAccess` 申请相应能力。写操作一律经本应用接口。

## 目录与 AI 操作

| 操作 | 权限 | 返回字段 |
| --- | --- | --- |
| `platform.locations.get` | `platform.locations.read` | id、code、name、locationType、status、organizationUnitId |
| `platform.locations.list` | `platform.locations.read` | organizationUnitId、rows、nextCursor；rows 为位置白名单字段 |
| `platform.assets.get` | `platform.assets.read` | id、displayName、assetCode、locationId、typeId、lifecycleState、organizationUnitId |
| `platform.assets.list` | `platform.assets.read` | organizationUnitId、rows、nextCursor；rows 增加 typeName 类型名称，支持按类型名称精确筛选，名称搜索也匹配类型名称；仍按设备和位置授权范围裁剪 |
| `platform.ai.complete` | `platform.ai.complete` | content；调用平台配置的模型返回有界文本，不返回密钥或模型配置 |

按 ID 查询只接受 `{id}`。不存在或无权访问的对象均拒绝；不提供目录批量导出。位置按真实位置/组织授权，设备按真实设备/位置/类型及位置所属组织授权。执行前、执行后和返回快照均做范围检查，防止数据变化导致越权返回。

模型补全只接受 `{system,prompt}`，分别最多 3,000 和 12,000 字符，返回 `content` 最多 12,000 字符；请求受 Gateway 授权、限流、审计和 30 秒超时约束。它不替应用校验业务字段，应用应校验模型返回并在写入前由员工确认。安装识隐等应用时，服务身份须单独获得该能力授权。

位置列表接受 `{organizationUnitId?, afterId?, pageSize?, search?, status?}`。设备列表接受 `{organizationUnitId?, afterId?, pageSize?, search?, lifecycleState?, locationId?, typeId?, typeName?}`，`typeName` 为精确名称过滤。页大小默认 20、最多 50；search 为名称、编码和设备类型名称的字面子串（最多 100 字符），status 仅 active/inactive，lifecycleState 为 planned/active/suspended/retired。数据库按 UUID 升序有界读取，用返回的 nextCursor 续页；不返回总数。未指定组织时必须具有完整目录授权；指定组织时对该组织做授权并限制 SQL 查询范围，返回每行再次检查真实范围。组织参数是待验证资源，不是授权声明。范围不足时连空页也拒绝；逐对象授权仍用 get 查询。游标不要求记录仍存在，删除游标记录不会回到第一页。

应用由负责人在员工端“应用管理 → 人员管理、角色配置”维护可使用人员和业务操作范围；具备生效业务角色即可进入。安装应用或授予目录能力不会自动允许所有员工打开应用。

## 统一入口与员工工作区（0.5.0）

`POST /api/auth/login` 按账号所属身份路由；管理员与员工会话 Cookie 仍各自隔离。同名跨身份账号拒绝登录，不以优先级选择更高权限身份。旧登录链接转向统一入口。

员工 `GET /api/employee/profile` 读取本人资料，`GET /api/employee/notifications` 仅返回本人收件通知。工作区复用共享侧边栏、消息和个人资料。
`PATCH /api/employee/profile` 只接受本人的 `phone` 和 `wecomUserId`，拒绝身份、岗位与组织字段；沿用默认租户的企业微信外部身份记录，修改 UserID 后清除核验状态。`PATCH /api/employee/auth/password` 接受 `currentPassword` 和至少 8 字符且包含上述四类字符中至少三类的新密码 `newPassword`，验证当前密码后撤销该员工的全部会话。两个写接口均校验 Origin 和有效员工会话，事务内再次核对本人身份并记录审计。
