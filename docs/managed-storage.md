# 应用托管存储

从 0.1.0 起，应用管理可显式装配托管存储的创建、声明式迁移、同结构版本升级、停用及保留。默认配置关闭。当前开发分支进一步支持分页查询、原子多行写、追加迁移升级及原事务证据核对；物料业务入口已接通，真实 Docker 托管安装升级仍待实机验收。

## 身份与配置

普通 API 继续使用 `DATABASE_URL`，存储生命周期使用独立的 `MOP_APP_STORAGE_ADMIN_DATABASE_URL`。后者只在平台内部创建专用连接，不传给应用、浏览器或 Docker 后端。迁移另用短期 owner 凭据；原有 NOLOGIN、撤销与会话清理机制继续生效。

存储生命周期执行器支持配置专用受限 DDL 管理角色（必须具备 `CREATEROLE` 和数据库 `CREATE` 权限，无需 `SUPERUSER`）；亦向前兼容已有测试环境的超级用户。普通 API 角色必须不是超级用户、没有 CREATEROLE、不是该管理角色成员。**独立连接不等于最小权限代理或进程隔离**：管理凭据仍在 API 进程中，生产使用推荐使用专用的非超级用户 DDL 角色以收敛风险，详见 [只读检查与调整草案](../config/managed-storage-review.sql)。本地验证可采用独立的一次性 PostgreSQL 实例。

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
4. 升级：允许保持存储不变或在原迁移列表末尾追加已签名迁移。历史声明、顺序、文件路径、摘要和字节数必须完全一致，不能删除或重排。先切换停用版本并关联历史迁移证据，再逐项执行新增迁移，成功后仍保持停用。新增字段只支持声明式迁移已有的可空列规则；不能回退到删去已应用迁移的旧包。
5. 停用与卸载：沿用停止入口、排空实际工作、恢复租约的顺序。卸载保留数据并撤销 runtime 权限，不能自动重新激活 retained 存储。
6. 失败：提交结果或结果记录不明确时保留原记录，阻断执行；重复安装不重跑迁移。生命周期恢复只关闭运行状态，不能代替迁移证据核对。已有内部 `reconcile` 只有在原事务证据明确时才能核对；管理员可在“应用状态 → 存储迁移”查看记录并核对原事务；该操作要求应用停用、当前 revision 匹配，仅依据原事务证据判定，不能指定成功结果。

迁移失败后，版本保持停用。结果未知的迁移必须先核对证据；“恢复为停用”不重跑迁移。确认已提交的迁移不重复执行，确认回滚后才可在后续显式启用过程中重新执行。

管理接口：`GET /api/admin/apps/:appId/storage/migrations?afterSequence=0` 按序号分页，最多 100 条；`POST /api/admin/apps/:appId/storage/migrations/reconcile` 接受 `{revision,attemptId}`，要求管理员会话和同源 Origin。记录保留历史尝试与核对证据。

运行中修改开关需重启以装配连接。移除开关或 manifest 审批会阻止后续安装/启用审批，不会主动代替管理员停用已经运行的应用；应先停用再撤配置。

## 应用日常读写

`managedStorage` 开启后，默认 Gateway 同时装配以下操作。应用必须请求并获得 **service 模式、all 范围**授权，使用自己的服务凭据；员工委托入口拒绝这些通用操作。数据归应用整体所有，员工能读写哪些业务记录由应用流程负责。

| 操作 | 权限 | 参数 |
| --- | --- | --- |
| `platform.app_data.get` | `platform.app_data.read` | `{table,id}` |
| `platform.app_data.list` | `platform.app_data.read` | `{table,afterId?,pageSize?,filters?,search?}` |
| `platform.app_data.read_batch` | `platform.app_data.read` | `{operations:[{table,id} 或 {table,pageSize,...查询条件},...]}` |
| `platform.app_data.transaction` | `platform.app_data.write` | `{requestId,operations}` |
| `platform.app_data.write` | `platform.app_data.write` | `{table,id,requestId,action,values?}` |

`action` 为 insert、update 或 delete；delete 不带 values，其余必须提供非空字段对象，且不能修改 id。返回 `{row:对象或null}`；更新/删除不存在的记录返回 null。请求最多 16 KiB、单行结果最多 32 KiB。另有受控多行事务接口；不开放任意 SQL 或跨应用 schema 入口。

`list` 返回 `{rows,nextCursor}`，按 UUID 主键升序进行游标分页；将 nextCursor 作为下页 afterId，null 表示本次查询已到末页。pageSize 默认 20、最大 50。filters 最多 8 个 `{column,value}` 等值条件，仅支持 uuid/text/boolean/integer 列，null 匹配空值；search 为 `{column,text}`，仅支持单个 text 列的大小写不敏感字面子串查询，`%`、`_` 不作为通配符。所有条件先过滤再分页；列须来自已核对表结构，参数不能选择 SQL、schema 或排序表达式。单行仍限制 32 KiB，含一条前瞻记录的行数据总量最多 60,000 字节，超限明确拒绝，调用者可降低 pageSize；不返回全表总数。分页之间并发写入不构成同一快照。

`read_batch` 将 1–4 个 get/list 读操作放入同一只读事务与短期存储租约，按输入顺序返回 `{results:[{row} 或 {rows,nextCursor},...]}`。每项仍执行相同的表结构、过滤和授权检查；整个响应共用 60,000 字节数据上限，不接收写入。单独查询能成功但组合超限时，应用应退回单项读取。

`transaction` 将 1–16 个 insert/update/delete 合并为一个数据库事务，返回 `{results:[{row},...]}`。每项提供 table、id、action 和适用的 values；update/delete 必须提供非空 expected 字段对象，数据库在写入时比较旧值，不匹配则返回 `STORAGE_CONFLICT` 并回滚整批操作。insert 不接受 expected。整批请求共用一个 requestId，最多 16 KiB；同一表结构检查、授权复核、安装锁、租约和未知结果阻断适用于全部操作。库存值和版本比较后更新，再新增流水，可保证同一事务成功或全部回滚。库存不得为负、员工所属工班及冲销规则仍必须由物料应用的可信后端校验，通用存储接口不代替业务授权。

表须由已安装签名迁移建立，具备单列 UUID 主键 `id`，最多 64 列；当前支持 uuid、text、boolean、integer、jsonb。不支持继承、分区、视图、触发器、规则、RLS、生成列或 identity 列。不符合条件的既有表保持拒绝，不自动改表。

```ts
import {createAppDataClient} from '@metro/platform-sdk/app-gateway';

// gateway 来自后端 SDK 的受控服务传输。
const data = createAppDataClient(gateway);
// rowId 与 writeRequestId 由业务创建并保存；一次写入意图对应一个 requestId。
await data.insert('entries', rowId, writeRequestId, {value: {note: '检查完成'}});
const result = await data.get('entries', rowId);
const page = await data.list('entries', {pageSize: 20});
// table/columns 已由应用声明式迁移创建；业务后端先校验数量与数据范围。
await data.transaction(transactionId, [
  {action: 'update', table: 'inventory', id: materialId,
   expected: {version: 1, quantity: 10}, values: {version: 2, quantity: 7}},
  {action: 'insert', table: 'entries', id: entryId, values: {value: {delta: -3}}},
]);
```

每次调用持有应用存储锁，检查安装版本、启用状态、授权、迁移账本和数据库 ACL。平台先持久化租约，再为 runtime 角色设置短期凭据；实际 DML 使用独立 runtime 会话。runtime 没有 owner、建表、平台表或其他应用数据权限。凭据不离开平台受控执行器，结束后撤销登录并核对会话已关闭。生命周期恢复可清理旧 runtime 租约，不能借此认定写入回滚。

写入先记录唯一 `(installationId,requestId)`，再执行事务；确认提交后标记 completed，确认回滚后标记 rolled_back。任何已有请求 ID 均拒绝再次执行，不返回伪造的成功结果。提交断连、完成记录落库失败等情况保留 dispatched，阻断该应用后续读写及启用就绪检查。SDK 不自动重试，也不能更换请求 ID 来绕过未知结果。

日常写入开始后、执行数据变更前，平台持久化原事务编号、集群 system_identifier、数据库 OID/名称及请求摘要。管理员在“应用状态 → 数据写入”核对结果：应用须停用、runtime 会话已清理、revision 匹配、数据库身份及摘要一致，且原事务状态明确为 committed 或 aborted。核对结果和管理员身份另行留痕，不重新执行写入、不删除请求记录，原 requestId 仍不可重放。

接口为 `GET /api/admin/apps/:appId/storage/writes?after=<requestId>` 和 `POST /api/admin/apps/:appId/storage/writes/reconcile`，后者只接受 `{revision,requestId}`；不能提供期望结果。缺少事务凭据的历史记录、数据库身份变化、事务证据过期或仍运行均继续阻断。数据库恢复/克隆后的记录不得当作原集群证据自动核对。清理租约或查看当前库存不能替代原事务证据。

新增 `app-runtime-write-evidence-expand` 迁移须显式执行；旧记录不补造证据。受限存储管理服务及生产部署验收尚未完成。

## 验证范围

本轮已在临时 PostgreSQL 17 集群执行真实 SCRAM 测试，验证 list 及原子多行写、旧值冲突的整批回滚、调用中撤权、并发库存更新不重复扣减；测试集群自动关闭清理。

普通测试覆盖开关、未接通能力拒绝、URL/TLS、独立身份、前置条件、连接清理和产物绑定。已有存储测试继续验证 ACL、迁移与恢复边界。

新增真实 PostgreSQL 测试只接受显式提供的回环测试库 `mop_storage_test`，在其中创建随机命名的临时数据库和 API 角色，完成后清理。提供的管理身份须有创建数据库与角色的权限，且应属于一次性测试实例：

```sh
# 私密环境中配置 MOP_STORAGE_TEST_ADMIN_URL；不要把连接凭据写入命令历史。
NODE_ENV=test node --import tsx --test test/app-management-storage-postgres.test.ts
```

命令在 `server/` 执行，使用 Node 22。测试验证签名安装、重复请求、同结构及追加迁移签名升级、数据保留、卸载撤权，以及迁移提交后结果记录失败的证据恢复。还覆盖真实 SCRAM runtime 登录、单行 CRUD、双应用/平台表隔离、撤权回滚、停用拒绝、遗留 runtime 租约清理和日常写入提交或回滚后记录失败的阻断与原事务证据核对；无证据的历史记录保持阻断。该测试采用受控的外部运行时替身，不代表真实 Docker 或生产 HTTPS 验收。
