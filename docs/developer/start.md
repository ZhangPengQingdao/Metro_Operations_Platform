# 开始开发

目标：在独立目录中写一个员工应用，构建成一个 `.mopkg` 文件交给管理员安装。不需要克隆平台源码、平台数据库密码、管理员账号或任何签名密钥。

## 准备工具

要求 Node.js 22+、npm。管理员从开发者中心下载同一平台版本的 SDK、CLI 和应用项目示例（.tgz / .tar.gz），当前不要假设包已发布到公共 npm。

```sh
npm install --global /downloads/metro-platform-cli-<版本>.tgz
mop-app init fire-check --name 灭火器巡检
cd fire-check
npm install /downloads/metro-platform-sdk-<版本>.tgz
npm test
mop-app check
mop-app build          # 输出 dist/fire-check-0.1.0.mopkg
```

项目结构：

| 路径 | 内容 |
|---|---|
| `app.json` | 应用 ID、名称、版本、底色、平台版本范围、权限与数据范围、平台能力、页面、接口 |
| `icon.svg` | 白色线条图标，显示在 `color` 底色上 |
| `src/ui.jsx`、`src/ui.css` | 页面：`export default defineApp({pages: {...}})`；样式自动限定在本应用内 |
| `src/server.js` | 接口：`export default defineServer({...})` |
| `migrations/001-initial.json` | 声明式数据表迁移，只追加 |
| `test/` | 用假 gateway 测接口的权限、数据范围和输入校验 |
| `.claude/skills/metro-app/SKILL.md` | 给编程 Agent 的开发说明 |

## 本地联调

本地有平台时，平台以 `MOP_DEV_APPS_DIR=<目录>` 启动（仅非生产环境），开发者运行 `mop-app dev --out <同一目录>`：每次保存自动构建，平台自动重新安装，刷新页面即可看到改动。首次安装后仍要指定负责人、配置角色。

## 安装与首次使用

1. 管理员在“应用管理 → 安装应用”上传 `.mopkg`，预览名称、图标、版本变化、权限与平台能力、页面、接口和迁移，确认安装。平台自动授予 `app.json` 申请的平台能力并启动应用。
2. 管理员在“授权”中指定应用负责人。
3. 负责人在员工端“应用管理”配置使用人员、业务角色和每个权限的数据范围。员工随后在侧栏看到应用。

员工也可以在员工端“应用管理 → 申请上架”提交 `.mopkg`，由管理员审核后安装；应用负责人可以同样提交已有应用的更新包。

## 开发边界

页面通过 `useApp().api.call()` 调用本应用接口；接口在平台的应用进程中运行，经平台访问目录、数据、签字、通知和 AI。平台负责登录、员工身份、应用准入、页头与侧栏；应用负责业务校验、资源归属和数据范围。不要从请求体读取“当前员工”，不要让 Agent 索取管理员 Cookie、平台数据库地址或服务密钥。

开发者中心“平台 SDK”是当前版本的公开调用参考。

应用知识库的声明、权限与 SDK 使用见[知识库指南](knowledge.md)。

接入平台“新建对话”及声明提示卡片，见[统一对话与应用编排](agents.md)。

平台 1.6.0 支持[只读工具与 MCP](tools.md)：应用声明工具及业务权限，编排通过统一 SDK 调用；平台绑定员工身份并执行权限校验。
