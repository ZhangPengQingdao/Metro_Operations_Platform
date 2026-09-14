# 运行与部署

使用独立 PostgreSQL 数据库、应用目录和密钥。默认端口：前端 3100、API 3101；开发代理保持同源，写接口还校验 Origin。生产 `PUBLIC_BASE_URL` 与 `CORS_ORIGIN` 必须为真实管理端 HTTPS origin，并配置强 SESSION_SECRET、AI_PROVIDER_ENCRYPTION_KEY 与安全 Cookie。

`compose.yaml` 仅提供独立开发数据库。先复制 `.env.example` 到 `.env` 配置数据库密码，再执行 `docker compose up -d`；将 server/.env 的 DATABASE_URL 指向该数据库。不要复用原项目生产数据库。

部署顺序：安装依赖、构建 SDK、API 与前端；备份数据库后显式执行 `npm --prefix server run db:init`；首次部署通过环境变量执行 `admin:create`；启动 API；用反向代理托管 `dist/` 并将 `/api/` 转发 API。`db:init` 仅执行平台迁移，迁移事务与记录一起提交，不启动应用或导入旧数据。管理员初始化不覆盖既有账号。

API 入口 `npm --prefix server start`；`HOST` 默认为 127.0.0.1，容器内如需监听所有接口必须显式配置。健康接口 `/api/health/live` 与 `/api/health/ready`；数据库不可用时 readiness 返回失败。

可选应用 Docker 接入只接受显式 Unix socket、digest 镜像、完整审批快照，不从 DOCKER_HOST 继承配置，不自动拉取镜像。选择不支持的宿主配置时明确失败。

当前应用沙箱页面仅验收回环 HTTP。生产 HTTPS 的独立、无平台 Cookie 资源域尚待接入；因此本版不是生产应用托管完成版。不要将本地 srcdoc 模式强行放开到生产同源。

开发端口冲突时，可在根 `.env` 设置 `VITE_DEV_PORT`，同时修改 server/.env 中 PUBLIC_BASE_URL 和 CORS_ORIGIN 的端口。不要终止其他项目服务来占用端口。
