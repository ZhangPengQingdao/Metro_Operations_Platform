# 员工身份与目录接口

## 初始化与边界

通过 `npm --prefix server run db:init` 显式安装新增的员工账号/会话及目录权限定义迁移。连同应用 runtime 存储迁移，当前共 32 项平台迁移；启动服务不会自动执行。迁移不创建员工账号、不授予角色权限，也不复制管理员身份。

员工账号绑定已有在职人员；所属组织、岗位也必须启用。管理员通过以下接口管理账号，需要平台管理员会话、同源 Origin 及 `platform.authorization.manage`：

| 方法 | 路径 | 请求体 |
| --- | --- | --- |
| POST | `/api/admin/employee-accounts` | `{personId, username, password}` |
| PATCH | `/api/admin/employee-accounts/:id` | `{status?, password?}`，至少一项 |

用户名 3–64 位，字母或数字开头，允许 `_ . -`，统一小写；密码至少 12 字符、不超过 72 UTF-8 字节。密码使用 bcrypt，返回值不包含哈希。创建/修改写入管理员审计；停用、重新启用、重置密码均撤销已有会话。暂未提供账号列表及管理页面。

## 员工会话

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/api/employee/auth/login` | `{username,password}`，返回公开账号字段并设置 Cookie |
| GET | `/api/employee/auth/me` | 当前账号 |
| POST | `/api/employee/auth/logout` | 撤销当前会话、清除 Cookie |
| POST | `/api/employee/apps/:appId/gateway` | 当前员工代表指定应用调用 Gateway |

Cookie `mop_employee_session` 有效期 8 小时，HttpOnly、SameSite=Strict，路径 `/api/employee`，HTTPS 下启用 Secure；数据库仅保存随机令牌的 SHA-256 摘要。写请求必须提供配置的同源 Origin。登录按 IP 限制每分钟 5 次；当前限流为单进程，横向部署需另行接入共享限流。

管理员 Cookie 不可用于员工入口；请求体不得携带身份或授权范围。员工登录页面、应用列表和沙箱 Bridge 尚未接通，本接口不代表完整员工使用体验。

## 默认 Gateway 操作

请求示例（`id` 换成真实目录 UUID）：

```json
{"version":"1.0","operation":"platform.locations.get","params":{"id":"51000000-0000-4000-8000-000000000004"}}
```

| 操作 | 权限 | 返回字段 |
| --- | --- | --- |
| `platform.locations.get` | `platform.locations.read` | id、code、name、locationType、status、organizationUnitId |
| `platform.assets.get` | `platform.assets.read` | id、displayName、assetCode、locationId、typeId、lifecycleState、organizationUnitId |

参数只接受 `{id}`。不存在或无权访问的对象均拒绝；不提供目录批量导出。位置按真实位置/组织授权，设备按真实设备/位置/类型及位置所属组织授权。执行前、执行后和返回快照均做范围检查，防止数据变化导致越权返回。

应用必须声明权限且经管理员批准。员工还需具有相应角色权限；两者取交集。服务调用沿隔离后端的 Gateway 传输入口，要求独立服务凭据与服务授权，不能借用员工角色。默认组织树和责任范围解析器尚未装配，这些范围保持拒绝；可使用已实现的 all、organization 和 explicit 范围。

员工调用在执行及返回检查时重新验证会话并固定身份。应用须由当前宿主持有有效租约且正在服务；停用、失去租约或持久工作记录失败会阻断调用。操作使用普通 API 数据库连接，不借用存储管理连接或生命周期事务会话。

## 验证范围

PGlite 集成测试覆盖账号登录、真实目录读取、角色/应用授权交集、跨位置拒绝、管理员 Cookie 拒绝、注销/停用/密码重置/离职以及服务授权。定向测试覆盖返回快照变化、调用途中身份撤销或替换；宿主测试覆盖停用和失去租约后的员工入口拒绝。

这些测试未替代生产 PostgreSQL、真实隔离后端、员工浏览器入口或生产资源域验收。
