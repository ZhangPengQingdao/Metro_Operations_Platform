# 开发约定

- `src/app-platform/admin`：管理员界面。
- `src/app-platform/host`：应用页面宿主与沙箱。
- `src/components/ui`、`src/hooks`、`src/utils`：共享组件与工具。
- `src/platform`：前端平台上下文与引用组件。
- `server/src/core`：配置、身份、数据库、事件、任务、集成等基础能力。
- `server/src/platform`：人员、组织、位置、设备、授权、审计等平台契约。
- `server/src/app-platform`：应用声明、签名包、安装、宿主、存储与网关基础。
- `server/src/setup`：独立平台初始化。按依赖排序执行迁移，事务内写入 `platform_schema_migrations`，重复运行不重放已完成项。
- `packages/platform-sdk`：公开应用契约，包名 `@metro/platform-sdk`。
- `examples`：可构建的应用 SDK、后端 SDK 和安装示例；产物不提交。

新业务不得直接导入平台内部数据库或管理端身份。通用能力通过 SDK 和经授权的适配接口调用。管理员身份与普通员工身份分离，应用不会继承管理员会话。

运行 `npm test` 会先构建 SDK 和测试示例，然后运行平台测试。依赖显式 Docker/PostgreSQL 测试环境的项目默认跳过；这不等于生产验收。为 Docker 测试显式设置 `AFC_DOCKER_TEST_SOCKET`、`AFC_DOCKER_TEST_IMAGE`（digest）及 `AFC_DOCKER_TEST_ROOT`（Engine 可见目录），不得连接生产 Docker。

配置、私钥、应用包、数据库和日志保存在忽略的本地目录。禁止提交 `.env`、`runtime/`、`dist/` 和上传数据。
