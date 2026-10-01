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

## 开发者资料维护

开发者中心入口 `/admin/developer` 仅管理员可访问。正文源在 `docs/developer/`，公开操作参考在 SDK `app-contracts`，构建时生成离线文档与 Skill references。`developer/metro-app-development/SKILL.md` 为技能入口。SDK 新增目录客户端从 `@metro/platform-sdk/app-directory` 导入。旧内部能力目录保留供兼容和宿主使用，不作为开发者调用契约。

`npm run build` / `npm run dev` 前置构建 SDK、CLI 与五项下载产物；单独执行可用 `npm run build:developer`（须先构建 SDK/CLI）。产物保存在忽略的 `server/developer-assets`，API 容器复制到同名目录；管理员 API `/api/admin/developer/downloads` 列举元数据，`/:id` 下载允许列表中的文件。不会从用户输入解析文件系统路径。

新增应用公开契约元数据是可选字段，最低平台0.24.0；旧安装包和原 SDK 路径保持兼容。公开元数据不是运行时授权，也不替代 handler 输入和资源校验。修改公开操作时同时更新契约参考、客户端、示例和对应适配器测试。
