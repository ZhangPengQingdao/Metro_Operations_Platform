# 运行与部署

现有站点的目标地址、签名发行、系统更新与晨会交接独立应用升级步骤见 [现有站点发布与更新记录](production-deployment-runbook.md)。

使用独立 PostgreSQL 数据库、应用目录和密钥。默认端口：前端 3100、API 3101；开发代理保持同源，写接口还校验 Origin。生产 `PUBLIC_BASE_URL` 与 `CORS_ORIGIN` 必须为真实管理端 HTTPS origin，并配置强 SESSION_SECRET、AI_PROVIDER_ENCRYPTION_KEY 与安全 Cookie。

`compose.yaml` 仅提供独立开发数据库。先复制 `.env.example` 到 `.env` 配置数据库密码，再执行 `docker compose up -d`；将 server/.env 的 DATABASE_URL 指向该数据库。不要复用原项目生产数据库。

部署顺序：安装依赖、构建 SDK、API 与前端；备份数据库后显式执行 `npm --prefix server run db:init`；首次部署通过环境变量执行 `admin:create`；启动 API；用反向代理托管 `dist/` 并将 `/api/` 转发 API。`db:init` 仅执行平台迁移，迁移事务与记录一起提交，不启动应用或导入旧数据。管理员初始化不覆盖既有账号。

API 入口 `npm --prefix server start`；`HOST` 默认为 127.0.0.1，容器内如需监听所有接口必须显式配置。健康接口 `/api/health/live` 与 `/api/health/ready`；数据库不可用时 readiness 返回失败。

可选应用 Docker 接入只接受显式 Unix socket、digest 镜像、完整审批快照，不从 DOCKER_HOST 继承配置，不自动拉取镜像。选择不支持的宿主配置时明确失败。

可选托管存储通过 `managedStorage` 和独立的 `MOP_APP_STORAGE_ADMIN_DATABASE_URL` 装配。当前执行器要求高权限存储管理身份；API 数据库身份保持普通权限。启动前核对数据库 ACL 与迁移表，启动不会自动修改权限。配置、局限与只读审核脚本见 [托管存储](managed-storage.md)。

0.4.0 支持独立 HTTPS 应用资源域及单独监听器，见 [首次安装](server-first-install.md)。资源服务不挂载平台 API，不设置 Cookie，一次性资源地址在 60 秒内有效，加载前复核授权。srcdoc 仍仅允许回环 HTTP。高权限存储代理隔离及目标机恢复演练尚未完成，不是生产托管完成声明。

开发端口冲突时，可在根 `.env` 设置 `VITE_DEV_PORT`，同时修改 server/.env 中 PUBLIC_BASE_URL 和 CORS_ORIGIN 的端口。不要终止其他项目服务来占用端口。

员工账号与目录 Gateway 新增两项结构迁移；升级到 0.1.0 时按上述数据库初始化流程显式执行后再启用接口。不会自动创建员工账号或授权。接口及验收边界见 [员工身份与目录接口](employee-gateway.md)。

应用 runtime 存储另新增一项迁移（租约、写入记录及权限定义），当前总计 32 项。开启 managedStorage 前须完成迁移；当前未知日常写入会保留记录并阻断，已有原事务证据核对恢复入口，详见托管存储文档。

## 应用模型 v2（0.27.0 起）

单文件 `.mopkg` 应用由平台直接托管，不需要 Docker、资源域或发布者密钥：

- 前提：已配置 `MOP_APP_MANAGEMENT_CONFIG`，并执行 `db:init`（新增 `platform_app_v2_migrations`、`platform_app_v2_requests` 两张表）。
- 数据库：安装时平台用 API 连接为应用创建 schema（`app_<安装ID>`），因此 API 数据库角色需要该库的 `CREATE` 权限（`GRANT CREATE ON DATABASE <库名> TO <API 角色>`）。不需要 `MOP_APP_STORAGE_ADMIN_DATABASE_URL`。现有 v1 应用的 schema 不受影响。
- 文件：安装包解压到 `<artifactRoot>/v2/<appId>/<sha256>/`，按版本不可变保存。
- 进程：每个启用的应用由 API 进程以 Node 子进程运行（同一容器或主机、同一系统用户），环境变量只含 `NODE_ENV`、`TZ`、`PATH`、`MOP_APP_ID`，不含数据库地址或密钥。平台启动时自动拉起已启用的应用；异常退出按 1s→60s 退避重启，5 分钟内连续 5 次后停止重启，管理员可在应用状态中重新启动。
- 内存：每个应用默认上限 256MB（`app.json` 的 `limits.memoryMiB` 可调），按已启用应用数量预留。

## 旧应用转换为 v2（0.29.0 起）

现有签名包应用（v1）可原地转换，数据与授权保留：先备份数据库；在应用管理中停用该应用；上传其 `.mopkg`（预览显示“从旧版签名包转换”）并安装。若提示需要数据库管理员处理，用存储管理账号执行提示中的 `REASSIGN OWNED BY "app_<安装ID>_owner" TO "<平台数据库账号>";`，再上传同一个包。转换失败时注册表与数据不变，应用保持停用，可按提示处理后重试；转换后不能再以旧版签名包更新。

## 管理端独立域名（可选，0.28.0 起）

设置 `ADMIN_PUBLIC_BASE_URL=https://admin.<域名>`（与 `PUBLIC_BASE_URL` 不同的主机），反向代理把两个域名都指向同一前端与 `/api/`。管理员只能在管理端域名登录，员工只能在员工端域名登录；会话 Cookie 只发往各自主机。前端会把 `/admin`、`/employee` 路由自动跳到所属域名。不设置时两者共用 `PUBLIC_BASE_URL`。

## 本地开发模式

非生产环境可设置 `MOP_DEV_APPS_DIR=<绝对路径>`：平台自动安装该目录中的 `.mopkg`（含同版本重建），配合 `mop-app dev --out <同一目录>` 使用。生产环境（`NODE_ENV=production`）拒绝启用。首次安装后仍需指定负责人并配置角色。

