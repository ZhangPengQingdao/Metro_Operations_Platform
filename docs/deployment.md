# 运行与部署

现有站点的目标地址、发行与系统更新步骤见 [现有站点发布与更新记录](production-deployment-runbook.md)；Ubuntu 一键安装见 [Linux 安装](linux-installation.md)。

使用独立 PostgreSQL 数据库、应用目录和密钥。默认端口：前端 3100、API 3101；开发代理保持同源，写接口还校验 Origin。生产 `PUBLIC_BASE_URL` 与 `CORS_ORIGIN` 必须为真实 HTTPS origin，并配置强 `SESSION_SECRET`、`AI_PROVIDER_ENCRYPTION_KEY` 与安全 Cookie。

`compose.yaml` 仅提供独立开发数据库。先复制 `.env.example` 到 `.env` 配置数据库密码，再执行 `docker compose up -d`；将 server/.env 的 `DATABASE_URL` 指向该数据库。

部署顺序：安装依赖、构建 SDK、API 与前端；备份数据库后显式执行 `npm --prefix server run db:init`；首次部署通过环境变量执行 `admin:create`；启动 API；用反向代理托管 `dist/` 并将 `/api/` 转发 API。`db:init` 只执行平台迁移，迁移与记录在同一事务中提交。管理员初始化不覆盖既有账号。

API 入口 `npm --prefix server start`；`HOST` 默认为 127.0.0.1，容器内如需监听所有接口必须显式配置。健康接口 `/api/health/live` 与 `/api/health/ready`；数据库不可用时 readiness 返回失败。

开发端口冲突时，可在根 `.env` 设置 `VITE_DEV_PORT`，同时修改 server/.env 中 `PUBLIC_BASE_URL` 和 `CORS_ORIGIN` 的端口。不要终止其他项目服务来占用端口。

## 应用

- 配置：`MOP_APP_MANAGEMENT_CONFIG` 指向 `{"version":1,"artifactRoot":"…","uploadRoot":"…"}`（模板 `config/app-management.example.json`）。
- 数据库：安装应用时平台用 API 连接为应用创建 schema（`app_<安装ID>`），API 数据库角色需要该库的 `CREATE` 权限（`GRANT CREATE ON DATABASE <库名> TO <API 角色>`）。
- 文件：安装包解压到 `<artifactRoot>/v2/<appId>/<sha256>/`，按版本不可变保存。
- 进程：每个启用的应用由 API 进程以 Node 子进程运行（同一容器或主机、同一系统用户），环境变量只含 `NODE_ENV`、`TZ`、`PATH`、`MOP_APP_ID`。平台启动时自动拉起已启用的应用；异常退出按 1s→60s 退避重启，5 分钟内连续 5 次后停止，管理员可在应用状态中重新启动。
- 内存：每个应用默认上限 256MB（`app.json` 的 `limits.memoryMiB` 可调），按已启用应用数量预留。

不需要 Docker、应用资源域名、发布者密钥或存储管理数据库连接。

## 从 0.30.x 升级到 1.0.0

1.0.0 删除了旧版签名包应用（v1）的运行方式。升级前备份数据库。`db:init` 中的迁移 `app-legacy-runtime-cleanup` 会：删除 v1 的运行与存储记录表；删除所有不是 `.mopkg` 安装的应用及其负责人、角色、使用授权和安装历史；保留 `.mopkg` 应用和平台数据权限。v1 应用原来的数据 schema（`app_<id>`）不删除，可由数据库管理员确认后清理。旧环境变量 `MOP_APP_RESOURCE_ORIGIN`、`MOP_APP_TRUSTED_ORIGINS_ENABLED`、`MOP_APP_STORAGE_ADMIN_DATABASE_URL` 不再使用，可以删除。

## 管理端独立域名（可选）

设置 `ADMIN_PUBLIC_BASE_URL=https://admin.<域名>`（与 `PUBLIC_BASE_URL` 不同的主机），反向代理把两个域名都指向同一前端与 `/api/`。管理员只能在管理端域名登录，员工只能在员工端域名登录；会话 Cookie 只发往各自主机。前端会把 `/admin`、`/employee` 路由自动跳到所属域名。不设置时两者共用 `PUBLIC_BASE_URL`。

## 本地开发模式

非生产环境可设置 `MOP_DEV_APPS_DIR=<绝对路径>`：平台自动安装该目录中的 `.mopkg`（含同版本重建），配合 `mop-app dev --out <同一目录>` 使用。生产环境（`NODE_ENV=production`）拒绝启用。首次安装后仍需指定负责人并配置角色。
