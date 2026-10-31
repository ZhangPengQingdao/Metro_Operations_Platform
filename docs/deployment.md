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

## 平台知识服务（1.4.0）

沿用现有数据库与应用运行时。发布平台后按既有升级流程执行 `npm --prefix server run db:init`，新增 `platform-knowledge-expand`，再安装需要此能力的应用包。慧策通2.1.0最低要求平台1.4.0。此轮直接切换建立在“尚无有效旧语料”的确认上；迁移不搬运或删除旧语料，不适用于已有有效语料的环境直接切换。接口见[知识库指南](developer/knowledge.md)。

## 1.5.0 统一对话

先执行现有 `npm --prefix server run db:init`，新增 `platform-chat-expand` 的会话和运行表，再启动后端。未完成请求在启动时标记为中断，不自动执行。使用现有管理员 AI 连接配置进行意图识别，不新增服务、密钥分发或数据库扩展。

部署平台后安装慧策通 2.2.0、待办事项 1.1.0 的新包，员工取得对应业务权限及目标页面权限后会看到提示卡片。应用知识库内容无需迁移。服务器和浏览器以已有员工认证访问统一入口。

此阶段只支持单个后端实例，与现有本地应用子进程模型一致；运行任务不跨进程共享。

## 1.6.0 只读工具与 MCP

沿用 Node 22 部署环境，后端依赖增加固定版本的官方 MCP client/server SDK。执行既有 `db:init` 升级流程会新增 `platform-tools-read-permission`，仅添加权限定义，不修改业务数据或员工授权。平台更新完成后再安装慧策通 2.3.0、待办事项 1.2.0，并在现有应用服务授权中授予其 `platform.tools.read`。

协议会话在平台进程内通过内存传输创建，工具实际运行在原应用子进程中；无需新增监听端口、MCP 密钥或反向代理规则。不支持配置外部 MCP 服务。应用仍须具备原有数据、知识、组织目录等权限。工具执行中拒绝平台写操作；正常应用页面的业务写入不受影响。具体契约见[工具指南](developer/tools.md)。

### 1.7.0 逐条语料索引

按原有升级流程运行 `db:init`，应用新增 `platform-knowledge-vectors-expand` 迁移，再更新慧策通 2.4.0。向量存储复用 PostgreSQL，无新服务。管理员在「个人中心 → 系统设置 → 大模型配置 → 知识库向量模型」中单独填写 embeddings 连接并测试，模型原生输出维度必须与配置一致；密钥加密存储；1.7.1 支持下述本机及内网连接配置。未启用配置时继续文本检索。首次启用或切换模型会后台重建，失败条目由维护人员手动重建；不迁移旧应用语料。

### 本机和内网向量模型（1.7.1）

重排序与 ASR（1.8.0）的配置协议和独立内网白名单见 [模型服务设置](model-service-settings.md)。管理端在线更新会在备份后自动执行新增 `platform-model-configuration-expand` 迁移，无需手动运行数据库命令；仅源码开发或手工部署需自行执行 `db:init`。该迁移仅新增配置保存幂等记录，不改变业务检索或应用语音流程。

向量模型可部署在平台服务器本机，也可使用独立内网服务。运维在 API 进程的环境文件中配置允许访问的完整请求地址，然后重启 API：

```dotenv
MOP_EMBEDDING_ALLOWED_ENDPOINTS=http://127.0.0.1:3212/v1/embeddings,http://embedding.internal:8000/v1/embeddings
```

最多16个地址，逗号分隔，HTTP/HTTPS均可；不能包含凭据、查询参数或片段。不使用通配符，也不因为批准了一个地址而允许同机其他端口或路径。管理端可填服务基础地址（会补齐 `/embeddings`），白名单须填最终完整地址。白名单外继续使用公网 HTTPS 检查，所有模型请求禁止跟随重定向。

在「个人中心 → 系统设置 → 大模型配置 → 知识库向量模型」配置相同地址、模型 ID、原生维度及模型服务的 API Key，先测试再保存启用。平台和本机模型应处于同一网络命名空间；内网地址需从平台 API 所在服务器可达。私有 HTTPS 使用受信任证书或通过 `NODE_EXTRA_CA_CERTS` 添加组织 CA，不关闭 TLS 证书校验。

试跑模型：`BAAI/bge-small-zh-v1.5`，512维，短文本最长512 tokens。运行环境与模型文件属于独立模型服务，不打进 `.mopkg`；应用继续只调用平台知识库 SDK。当前本机试跑服务拒绝超长输入，不静默截断；长条目需后续分段或选择上下文更长的模型。最低相似度按业务样例设置，本次试跑0.55，仅是小样本起点。

实际本地模型与检索试跑记录见 [本地向量模型验收](acceptance-local-embedding.md)。
