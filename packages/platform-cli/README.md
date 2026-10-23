# @metro/platform-cli

Node.js 22+。命令 `mop-app`，独立开发不需要平台仓库、数据库或管理员凭据。

## 应用模型 v2（推荐）

```sh
npx mop-app init my-app --name 我的应用   # 生成 app.json、图标、页面、接口、迁移、测试和 Agent Skill
cd my-app && npm install
npm test
npx mop-app check                        # 与平台安装预览相同的规则
npx mop-app build                        # 输出 dist/my-app-<版本>.mopkg，唯一交付物
```

`build` 用 esbuild 打包：页面为 ES 模块，React、`@metro/platform-sdk/app`、`@metro/platform-sdk/ui` 由平台共享不打包；`ui.css` 自动限定到 `[data-app="<id>"]`（暂不支持 @keyframes/@font-face/@import）；接口为单文件 Node ESM，构建时加载一次以核对函数名与 `app.json` 的 `api` 一致。说明见 docs/app-model-v2.md 与 docs/developer/packaging.md。

## v1 签名包（现有应用，1.0.0 移除）
Node.js 22+。独立开发不需要平台仓库、数据库或管理员凭据。使用开发者中心下载的同版本 SDK/CLI .tgz；不要假定包已发布到公共 npm。

```sh
npm install --save-dev /downloads/metro-platform-cli-<版本>.tgz
npx mop-app create my-app my-app standard my-publisher
cd my-app
npm install /downloads/metro-platform-sdk-<版本>.tgz
npm test
npm run build
../node_modules/.bin/mop-app validate dist
../node_modules/.bin/mop-app sign dist publisher-key /secure/private.pem signature.json
../node_modules/.bin/mop-app verify dist signature.json publisher-key my-publisher /secure/public.pem
../node_modules/.bin/mop-app export-upload dist signature.json my-app.mop.gz
```

standard 模板使用真实目录能力、React 共享组件、标准沙箱与隔离 Node 后端。旧 sandbox/trusted/backend 模板保留作协议演示，其中 sample.* 不是平台默认开放操作。

应用 .mop.gz 为 gzip 压缩签名 JSON，包含清单、签名、产物；仍兼容 .install.json，不是 ZIP。SDK/CLI .tgz 是工具包，不能上传为应用。开发者私钥留在安全环境，管理员核实发布者公钥并独立审核能力、启用与业务授权。

export-upload 不执行构建、不安装应用、不覆盖输出；平台重新验证签名与摘要。pack <built-dir> <new-dir> 仅复制已声明产物。

完整流程见 docs/developer/start.md、packaging.md 及开发者中心。编程 Agent 可使用随版本下载的 metro-app-development 技能；已有项目必须先评估接入方案。
