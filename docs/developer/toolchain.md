# 工具安装与平台连接

开发者中心“Skill 与工具”提供完整 Skill 包。只需下载这一包，就能把开发流程、参考文档和同版本 SDK/CLI 一起交给 Agent。Node.js 22+、npm 仍需在开发机器安装，普通 npm 依赖需要网络或缓存。

## 新建应用

解压 `metro-skill-<版本>.tar.gz`，安装其中的 `metro-app-development` 目录到 Agent 支持的 Skill 目录，或直接让 Agent 阅读 `SKILL.md`。目录包含工具归档、摘要清单和建项目脚本。

```sh
node /absolute/path/metro-app-development/scripts/create-app.mjs /absolute/path/fire-check 灭火器巡检
cd /absolute/path/fire-check
npm test
npm run check
npm run build
```

脚本只接受不存在或空的目标目录；使用同包内的 SDK/CLI，避免误从公共 npm 获取私有包。项目里的 `.mop/toolchain/` 存放这两个归档，Git 默认忽略该目录。协作者使用同版本 Skill 恢复归档后再 `npm ci`。

## 已有应用

先核对工具版本与目标平台，不要用旧工具覆盖较新契约。把两个归档复制到项目 `.mop/toolchain/`，同时修改 package.json 后再安装，避免 npm 在安装其中一个包时去公共仓库解析另一个包。

```sh
mkdir -p .mop/toolchain
# 将同版本 metro-platform-sdk-<版本>.tgz 和 metro-platform-cli-<版本>.tgz 复制到此目录
npm pkg set 'dependencies.@metro/platform-sdk=file:.mop/toolchain/metro-platform-sdk-<版本>.tgz'
npm pkg set 'devDependencies.@metro/platform-cli=file:.mop/toolchain/metro-platform-cli-<版本>.tgz'
npm install
npm test
npm run check
npm run build
```

将 `<版本>` 替换为下载清单中的版本。CLI 命令是 `mop-app`，npm scripts 使用 `mop-app check` 和 `mop-app build`。项目内 Skill 带参考文档；SDK/CLI 归档来自完整下载包。

## Agent 连接当前实例

本地开发、测试与打包无需密钥。需要查询真实公共数据、查看当前已安装接口或在线下载工具时，员工在“我的凭证”创建开发密钥，在本机安全设置 `MOP_URL`（平台根地址）与 `MOP_DEV_KEY`。不要把密钥发到聊天或写进源码。

```sh
# 以下环境变量需事先在本机设置；MOP_URL 示例为 https://your-platform.example
curl --fail --show-error -H "Authorization: Bearer $MOP_DEV_KEY" "$MOP_URL/api/developer/downloads"
curl --fail --show-error -H "Authorization: Bearer $MOP_DEV_KEY" "$MOP_URL/api/developer/downloads/sdk" -o sdk.tgz
curl --fail --show-error -H "Authorization: Bearer $MOP_DEV_KEY" "$MOP_URL/api/developer/downloads/cli" -o cli.tgz
curl --fail --show-error -H "Authorization: Bearer $MOP_DEV_KEY" "$MOP_URL/api/developer/catalog"
```

下载前读取清单，核对版本；下载后核对 `bytes` 和 `sha256`，再安装本地归档。不要跟随未知重定向转发密钥。工具下载不需要业务角色，接口目录仍需凭证的 apps 范围和目标业务权限。旧的仅目录凭证可下载工具但不能查看业务接口。

`/catalog` 返回可接入的跨应用接口说明和 `consumers`（page、dashboard、ai、tool、apps、developer），不返回业务记录。`/interfaces` 保持只列可由个人密钥执行的接口。执行使用 `/call`；仅向应用开放的接口仍须在正式应用中使用 `ctx.apps.call`，开发密钥不能绕过这一限制。

员工网页会话走 `/api/employee/developer/…`，管理员下载走 `/api/admin/developer/downloads`。这些会话接口不接受开发密钥，Agent 应使用上面的 Bearer 专用地址。正式应用使用平台身份，无需把开发密钥安装到服务器。
