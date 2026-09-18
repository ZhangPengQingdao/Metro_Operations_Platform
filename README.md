# 运管开放平台

Metro Operations Platform · 0.6.0

独立的运维应用平台，提供管理员控制台、组织/人员/车站/设备目录、授权审计、模型配置、应用签名安装更新和隔离运行基础。业务功能以独立应用接入。

## 本地开发

需要 Node.js 22.16+、npm、PostgreSQL 16+；独立后端应用另需本地 Docker Engine。

```sh
npm ci
npm run build:sdk
npm --prefix server ci
cp server/.env.example server/.env
# 在 server/.env 中配置新的数据库与密钥
npm --prefix server run db:init
# 设置 MOP_ADMIN_USERNAME / MOP_ADMIN_DISPLAY_NAME / MOP_ADMIN_PASSWORD 后初始化首位管理员
npm --prefix server run admin:create
npm --prefix server run dev
# 另一个终端
npm run dev
```

管理端：http://127.0.0.1:3100/#/admin 。API：127.0.0.1:3101。初始化只创建平台结构，不导入旧系统业务或管理员；服务启动不会自动迁移数据库。

## 检查

```sh
npm run build
npm run typecheck
npm --prefix server run build
npm test
npm run version:check
```

- [开发与目录结构](docs/development.md)
- [应用接入](docs/applications.md)
- [应用托管存储](docs/managed-storage.md)
- [员工身份与目录接口](docs/employee-gateway.md)
- [应用负责人与业务授权](docs/application-business-authorization.md)
- [共享查询列表组件](docs/shared-list-ui.md)
- [运行与部署](docs/deployment.md)
- [Ubuntu 一键安装与在线更新](docs/linux-installation.md)
- [首次服务器安装步骤](docs/server-first-install.md)
- [0.2.0 正式发行记录](docs/release-0.2.0.md)
- [Linux 安装与在线更新实施方案](docs/linux-install-and-update-plan.md)
- [版本规则](docs/versioning.md)
- [当前能力边界](docs/limitations.md)
- [拆分说明](docs/extraction.md)

SDK 位于 `packages/platform-sdk`，独立打包工具位于 `packages/platform-cli`，共享组件位于 `src/components/ui`。源码、数据及启动流程不依赖旧仓库。

员工自助注册、组织选择与管理员审核见 [员工注册](docs/employee-registration.md)。
