# 开发约定

- `src/app-platform/admin`：管理员界面。
- `src/app-platform/host`：应用页面宿主（同源渲染 `.mopkg` 页面）与应用图标。
- `src/components/ui`、`src/hooks`、`src/utils`：共享组件与工具。
- `src/platform`：前端平台上下文与引用组件。
- `server/src/core`：配置、身份、数据库、事件、任务、集成等基础能力。
- `server/src/platform`：人员、组织、位置、设备、授权、审计等平台契约。
- `server/src/app-platform`：应用注册表、`.mopkg` 安装与运行（`v2/`）、员工准入、业务授权与平台网关。
- `server/src/setup`：独立平台初始化。按依赖排序执行迁移，事务内写入 `platform_schema_migrations`，重复运行不重放已完成项。
- `packages/platform-sdk`：公开应用契约，包名 `@metro/platform-sdk`。
- `packages/platform-cli`：应用开发工具 `mop-app`（init/check/build/dev）与项目模板。
- `applications`：仓库内的业务应用（`.mopkg` 项目）；产物不提交。

新业务不得直接导入平台内部数据库或管理端身份。通用能力通过 SDK 和经授权的适配接口调用。管理员身份与普通员工身份分离，应用不会继承管理员会话。

运行 `npm test` 会先构建 SDK 与 CLI，然后运行平台测试；各应用在自己的目录运行 `npm test` 与 `npm run build`。

配置、私钥、应用包、数据库和日志保存在忽略的本地目录。禁止提交 `.env`、`runtime/`、`dist/` 和上传数据。

## 开发者资料维护

开发者中心入口 `/admin/developer` 仅管理员可访问。正文源在 `docs/developer/`，公开操作参考在 SDK `app-contracts`，构建时生成离线文档与 Skill references。技能入口与 `mop-app init` 写入项目的相同，源在 `packages/platform-cli/templates/v2/skill/SKILL.md`。SDK 新增目录客户端从 `@metro/platform-sdk/app-directory` 导入。旧内部能力目录保留供兼容和宿主使用，不作为开发者调用契约。

`npm run build` / `npm run dev` 前置构建 SDK、CLI 与五项下载产物（SDK、CLI、离线文档、Skill、`mop-app init` 生成的项目示例）；单独执行可用 `npm run build:developer`（须先构建 SDK/CLI）。产物保存在忽略的 `server/developer-assets`，API 容器复制到同名目录；管理员 API `/api/admin/developer/downloads` 列举元数据，`/:id` 下载允许列表中的文件。不会从用户输入解析文件系统路径。

公开操作参考不是运行时授权，也不替代接口输入和资源校验。修改公开操作时同时更新契约参考、客户端、示例和对应适配器测试。
