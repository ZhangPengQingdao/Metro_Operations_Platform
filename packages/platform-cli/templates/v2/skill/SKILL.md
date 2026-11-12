---
name: metro-app
description: 为运管开放平台新建或改造独立应用，获取同版本 SDK/CLI，声明页面、AI、MCP 和跨应用共用的接口，测试并打包 .mopkg，指导提交更新和授权联调。适用于应用开发，不用于运维平台服务器。
---

# 运管平台应用开发

交付独立应用源码和 `dist/<id>-<version>.mopkg`。平台提供身份、角色、数据范围、存储、目录、AI、通知和应用运行。应用编写业务接口、说明和所需页面，不依赖平台仓库源码。

## 开始工作

先检查已有项目和用户目标。新建应用走下方工具准备；已有项目保留应用 ID、接口 ID、已发布迁移和用户修改，核对 `app.json` 的平台版本范围。权限与实际业务不明确时只追问影响实现的信息，已有授权内继续工作。

平台 1.12.0 起，一份 `api[]` 声明和一个处理函数供不同入口使用。不要为聊天、工具、工作台和跨应用重复编写业务逻辑。接口声明不会自动生成完整业务页面，页面仍按需求使用 SDK 组件实现。

## 工具准备

要求 Node.js 22+、npm。开发者中心下载的完整 Skill 包带 `tools/toolchain.json`、同版本 SDK/CLI `.tgz`、建项目脚本和 `references/`。在其他 Agent 中可安装整个 Skill 目录，或直接让其读取本文件。公共 npm 上没有这些私有包，不要执行裸的 `npm install @metro/platform-sdk`。

对于新建项目，从完整下载包运行：

```sh
node /absolute/path/metro-app-development/scripts/create-app.mjs /absolute/path/fire-check 灭火器巡检
cd /absolute/path/fire-check
npm test
npm run check
npm run build
```

脚本先校验包摘要，在临时目录运行 CLI，向空目录生成项目，将 SDK/CLI 放到项目 `.mop/toolchain/` 并安装。拒绝覆盖非空目录。普通依赖（React、esbuild 等）仍需 npm 网络或缓存；这不是完全离线安装。工具归档不提交，换机器时从同版本 Skill 恢复 `.mop/toolchain/` 后运行 `npm ci`。

已有项目或项目内的 Skill 没有 `tools/` 时，读 [工具安装与连接](references/toolchain.md)，使用完整 Skill 包或从当前实例下载同版本工具。项目内 Skill 自带参考文档，项目依赖正常时直接使用已有工具。不要索取平台数据库密码、管理员 Cookie 或服务密钥。

## 单一接口契约

先读 [统一业务接口](references/shared-api.md)，再修改 `app.json` 和 `src/server.js`。

- `api[].id` 对应处理函数名。声明 `title`、`mode`、`permission`、`documentation`。文档包含 description、input、output、examples、errors，输入根对象须封闭，示例须符合 schema。
- `mode: read` 查询或总结，`draft` 生成待用户核对的草稿，`write` 正式写入。读和草稿入口禁止平台写操作。
- 本应用页面通过 `useApp().api.call(id, input)` 调用。
- `ai: true` 让统一对话和受管工具使用此接口；`tool: true` 只开放受管工具。平台负责身份、参数校验和调用适配。
- `dashboard: true` 复用为工作台摘要，每个应用最多一个，遵循专用输出契约。
- `expose: "apps"` 允许获准应用查询，`expose: true` 还允许个人开发凭证和网页调试。不要为实现跨应用调用另写一套业务接口。
- 使用 `defineServer` 时直接返回业务结果，`documentation.output` 描述该结果。旧函数表的 `{ok:true,result}` 包装仅为兼容。

调用其他应用时，读 [跨应用接入](references/integration.md)。发现接口用开发者中心“应用接口”或 `/api/developer/catalog`，按其实际参数声明 `appAccess: [{appId, apiId}]`，并申请 `apps.read`。后端使用 `ctx.apps.call(appId, apiId, input)`，沿用触发员工在目标应用中的权限与数据范围。接口可在目录查看不表示当前个人密钥可以执行。仅支持员工触发的一层只读跨应用调用，开放处理器不能继续调用其他应用。

## 实现与数据安全

- 平台按接口权限拦截，处理函数对具体记录调用 `ctx.can/ctx.require`；列表先过滤授权范围再分页。身份取 `ctx.employee`，不接受请求体伪造员工或组织范围。`user.has()` 仅控制页面显示。
- 平台能力只申请实际用到的 `platformAccess`，见 [SDK 参考](references/platform-sdk.md)（完整下载包提供）及各专项指南。常用能力与调用示例也在开发者中心“平台 SDK”。
- 页面使用 `@metro/platform-sdk/ui`、主题变量和平台导航。读 [页面与导航](references/ui-navigation.md)，不要重复平台侧栏、页头和登录。
- 业务表保留组织和创建人，迁移只追加，已发布文件不得改删。写入经 `ctx.data.transaction(requestId, operations)`，更新/删除带 `expected` 并发校验。结果不明先核对，同一请求重试保留 requestId，外部副作用不自动重放。
- 密钥放本地环境变量 `MOP_DEV_KEY`，实例地址放 `MOP_URL`；密钥不进入源码、日志、聊天或安装包。正式应用使用宿主身份，不使用个人密钥。新建项目、单元测试和打包无需真实平台凭证。

## 测试、联调与打包

读 [测试与验收](references/testing.md)。每次可交付改动执行：

```sh
npm test
npm run check
npm run build
```

`check` 校验清单和结构，`build` 检查并打包，均不代替业务测试。至少覆盖本次受影响的正常行为、非法参数、无权限、跨组织数据、重复写入与版本冲突。共享接口增加未声明依赖、目标无权限、撤权/停用和只读写入拒绝的联调验证。

有本地平台时，使用 `npx --no-install mop-app dev --out <开发目录>`；平台在非生产环境设置同一 `MOP_DEV_APPS_DIR`。没有平台时完成可执行的离线测试，并明确列出未完成的真实角色、AI 配置和页面操作验收，不能把打包成功报告为线上验收通过。

更新递增应用版本，只追加迁移，核对最低平台版本。读 [打包与更新](references/packaging.md)。负责人提交 `.mopkg` 更新，首次上架可由员工申请，管理员在应用审核中预览批准。安装后配置负责人、使用人员和业务角色。提交/发布遵循用户授权，安装包生成不表示已上线。

交付说明包含源码与包路径、版本、接口开放入口、调用依赖、权限和数据范围、已通过的检查以及尚需现场核验的项目。

## 按需参考

- [开始开发](references/start.md)、[工具安装与连接](references/toolchain.md)、[测试与验收](references/testing.md)
- [统一业务接口](references/shared-api.md)、[身份与权限](references/identity-permissions.md)、[跨应用接入](references/integration.md)
- [存储与文件](references/storage-files.md)、[通知](references/notifications.md)
- [AI 总览](references/ai.md)、[应用对话](references/agents.md)、[受管工具与 MCP](references/tools.md)、[知识库](references/knowledge.md)
