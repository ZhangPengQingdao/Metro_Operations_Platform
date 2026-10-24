# @metro/platform-cli

Node.js 22+。命令 `mop-app`，独立开发不需要平台仓库、数据库或管理员凭据。

## 用法

```sh
npx mop-app init my-app --name 我的应用   # 生成 app.json、图标、页面、接口、迁移、测试和 Agent Skill
cd my-app && npm install
npm test
npx mop-app check                        # 与平台安装预览相同的规则
npx mop-app build                        # 输出 dist/my-app-<版本>.mopkg，唯一交付物
npx mop-app dev --out ../dev-apps        # 改动后自动构建；本地平台以 MOP_DEV_APPS_DIR=../dev-apps 的绝对路径启动即自动安装
```

`build` 用 esbuild 打包：页面为 ES 模块，React、`@metro/platform-sdk/app`、`@metro/platform-sdk/ui` 由平台共享不打包；`ui.css` 自动限定到 `[data-app="<id>"]`（暂不支持 @keyframes/@font-face/@import），`src/ui.css` 存在但页面未引用、或页面使用未导入的全局 `React` 时构建报错；接口为单文件 Node ESM，构建时加载一次以核对函数名与 `app.json` 的 `api` 一致。说明见 docs/app-model-v2.md 与 docs/developer/packaging.md。

开发者中心提供同版本的 SDK/CLI .tgz 下载；不要假定包已发布到公共 npm。员工提交或管理员安装都使用同一个 `.mopkg`。
