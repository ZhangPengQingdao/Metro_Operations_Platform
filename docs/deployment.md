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
