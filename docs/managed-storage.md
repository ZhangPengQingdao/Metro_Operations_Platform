# 应用托管存储

从 0.1.0 起，应用管理可显式装配托管存储的创建、声明式迁移、同结构版本升级、停用及保留。默认配置关闭。已提供服务后端的单行读写 Gateway 与 SDK；员工业务入口和真实业务闭环仍未完成。

## 身份与配置

普通 API 继续使用 `DATABASE_URL`，存储生命周期使用独立的 `MOP_APP_STORAGE_ADMIN_DATABASE_URL`。后者只在平台内部创建专用连接，不传给应用、浏览器或 Docker 后端。迁移另用短期 owner 凭据；原有 NOLOGIN、撤销与会话清理机制继续生效。

现有存储执行器需要超级用户执行角色与凭据检查，因此本次装配显式要求存储管理角色为超级用户；普通 API 角色必须不是超级用户、没有 CREATEROLE、不是该管理角色成员。**独立连接不等于最小权限代理或进程隔离**：管理凭据仍在 API 进程中，超级用户权限覆盖 PostgreSQL 实例。生产使用前还需设计受限管理代理和部署隔离；本地验证采用独立的一次性 PostgreSQL 实例。

在应用管理 JSON 配置中设置 `"managedStorage": true`，在服务器私密环境配置中设置独立连接。配置模板只保留占位值：

```dotenv
MOP_APP_STORAGE_ADMIN_DATABASE_URL=postgresql://metro_storage_admin:CHANGE_ME@127.0.0.1:5433/metro_operations_platform
```

两个 URL 必须显式指定用户名、密码和同一 host/port/database，用户名不同。密码中的特殊字符需 URL 编码。只支持 `postgres:`/`postgresql:`；仅接受可选的 `sslmode` 参数，禁止连接 options、Unix socket 和其他隐式配置。无 TLS 仅允许 `127.0.0.1` 或 `::1`；其他地址必须 `sslmode=verify-full`，采用系统证书信任链。自定义 CA 参数尚未接入。两条连接须使用一致的 TLS 模式。

开关为 false 或未配置时，不读取或连接存储管理凭据，`storage: managed` 仍在安装前拒绝。开关为 true 但配置或前置检查失败时，应用管理初始化失败，不降级为空实现。

## 数据库前置条件

先运行平台 `db:init`，再审核 [只读检查与调整草案](../config/managed-storage-review.sql)。脚本默认仅查询，调整语句为注释，不能当作一键修复脚本。

- PUBLIC 不能持有数据库 CREATE/TEMPORARY、业务 schema CREATE，以及受检查的表、序列、函数、列和大对象权限。
- 九张迁移、租约、恢复与版本证据表必须存在。
- 启动检查验证独立身份、迁移表和数据库 ACL；每次存储操作继续执行原有锁、绑定、ACL 和版本检查。每次新建管理会话重新检查管理身份。
- 服务启动不会创建管理角色、提升 API 权限、撤销数据库 PUBLIC 权限或自动运行平台迁移。

ACL 调整前保留实际授权快照，核对对其他数据库使用者的影响；回退只恢复原先存在的权限。不要删除应用数据、租约或迁移证据来“恢复”。

## 生命周期行为

有效的 managed manifest 仍须声明后端。当前默认装配支持隔离 Node 后端，因此还需显式 Docker 配置、固定镜像审批、健康端点和 Engine 可见的 runtimeRoot；没有后端的包不能绕过 manifest 校验。

1. 安装：校验签名、发布者策略及独立 manifest 审批，再注册应用、创建 schema/角色、执行声明式 JSON 迁移。
2. 迁移产物：从已安装或已签名版本的产物读取器获取；安装 ID、revision、manifest 摘要、产物 ID/路径/摘要/字节数须一致。
3. 启用：只有迁移全部确认、无未知恢复记录、锁与版本仍有效，才允许完成生命周期并开放运行入口。
4. 升级：目前只允许 storage 声明和迁移产物保持不变的代码版本升级；保留数据与迁移历史，成功后保持停用。新增迁移、结构变更升级尚未支持。
5. 停用与卸载：沿用停止入口、排空实际工作、恢复租约的顺序。卸载保留数据并撤销 runtime 权限，不能自动重新激活 retained 存储。
6. 失败：提交结果或结果记录不明确时保留原记录，阻断执行；重复安装不重跑迁移。生命周期恢复只关闭运行状态，不能代替迁移证据核对。已有内部 `reconcile` 只有在原事务证据明确时才能核对；管理端迁移核对入口尚未接入。

运行中修改开关需重启以装配连接。移除开关或 manifest 审批会阻止后续安装/启用审批，不会主动代替管理员停用已经运行的应用；应先停用再撤配置。

## 应用日常读写

`managedStorage` 开启后，默认 Gateway 同时装配以下操作。应用必须请求并获得 **service 模式、all 范围**授权，使用自己的服务凭据；员工委托入口拒绝这些通用操作。数据归应用整体所有，员工能读写哪些业务记录由应用流程负责。

| 操作 | 权限 | 参数 |
| --- | --- | --- |
| `platform.app_data.get` | `platform.app_data.read` | `{table,id}` |
| `platform.app_data.write` | `platform.app_data.write` | `{table,id,requestId,action,values?}` |

`action` 为 insert、update 或 delete；delete 不带 values，其余必须提供非空字段对象，且不能修改 id。返回 `{row:对象或null}`；更新/删除不存在的记录返回 null。请求最多 16 KiB、单行结果最多 32 KiB。没有批量查询、跨行事务、任意 SQL、跨应用 schema 或条件表达式入口。

表须由已安装签名迁移建立，具备单列 UUID 主键 `id`，最多 64 列；当前支持 uuid、text、boolean、integer、jsonb。不支持继承、分区、视图、触发器、规则、RLS、生成列或 identity 列。不符合条件的既有表保持拒绝，不自动改表。

```ts
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';

// gateway 来自后端 SDK 的受控服务传输。
const data = createAppDataClient(gateway);
// rowId 与 writeRequestId 由业务创建并保存；一次写入意图对应一个 requestId。
await data.insert('entries', rowId, writeRequestId, {value: {note: '检查完成'}});
const result = await data.get('entries', rowId);
```

每次调用持有应用存储锁，检查安装版本、启用状态、授权、迁移账本和数据库 ACL。平台先持久化租约，再为 runtime 角色设置短期凭据；实际 DML 使用独立 runtime 会话。runtime 没有 owner、建表、平台表或其他应用数据权限。凭据不离开平台受控执行器，结束后撤销登录并核对会话已关闭。生命周期恢复可清理旧 runtime 租约，不能借此认定写入回滚。

写入先记录唯一 `(installationId,requestId)`，再执行事务；确认提交后标记 completed，确认回滚后标记 rolled_back。任何已有请求 ID 均拒绝再次执行，不返回伪造的成功结果。提交断连、完成记录落库失败等情况保留 dispatched，阻断该应用后续读写及启用就绪检查。SDK 不自动重试，也不能更换请求 ID 来绕过未知结果。

**未知日常写入的证据核对入口尚未实现**。清理租约或查看当前数据不构成原事务结果证明，不能删除/改写 dispatched 记录来恢复。当前存储接口是最小接线，尚不具备生产故障恢复闭环。

## 验证范围

普通测试覆盖开关、未接通能力拒绝、URL/TLS、独立身份、前置条件、连接清理和产物绑定。已有存储测试继续验证 ACL、迁移与恢复边界。

新增真实 PostgreSQL 测试只接受显式提供的回环测试库 `mop_storage_test`，在其中创建随机命名的临时数据库和 API 角色，完成后清理。提供的管理身份须有创建数据库与角色的权限，且应属于一次性测试实例：

```sh
# 私密环境中配置 MOP_STORAGE_TEST_ADMIN_URL；不要把连接凭据写入命令历史。
NODE_ENV=test node --import tsx --test test/app-management-storage-postgres.test.ts
```

命令在 `server/` 执行，使用 Node 22。测试验证签名安装、重复请求、同结构签名升级、数据保留、卸载撤权，以及迁移提交后结果记录失败的证据恢复。还覆盖真实 SCRAM runtime 登录、单行 CRUD、双应用/平台表隔离、撤权回滚、停用拒绝、遗留 runtime 租约清理和日常写入提交后记录失败的阻断。该测试采用受控的外部运行时替身，不代表真实 Docker 或生产 HTTPS 验收。
