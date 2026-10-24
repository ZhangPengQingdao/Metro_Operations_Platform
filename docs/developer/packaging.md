# 打包、安装与升级

## 单文件 .mopkg

```sh
mop-app check            # 校验 app.json、图标、迁移、页面与接口入口
mop-app build            # 输出 dist/<id>-<版本>.mopkg
```

`.mopkg` 是普通 zip，只允许以下文件：`app.json`（必需）、`icon.svg` 或 `icon.png`（必需，二选一）、`ui.js`/`ui.css`（有页面时）、`server.js`（有接口或迁移时）、`migrations/001-名称.json` 起连续编号、`README.md`、`CHANGELOG.md`。包不超过 50MB，`ui.js` 不超过 5MB，`server.js` 不超过 20MB。字段说明见 [应用模型 v2](../app-model-v2.md) 第 7 节。

构建时：页面打包为 ES 模块，React、`@metro/platform-sdk/app` 与 `@metro/platform-sdk/ui` 由平台共享、不打进包；`src/ui.css` 必须在 `ui.jsx` 中 `import './ui.css'`，否则构建报错；页面不能使用未导入的全局 `React`。接口打包为单文件 Node ESM，构建时加载一次以核对函数名与 `app.json` 的 `api` 一致。

不要把 `node_modules`、平台源码、`.env`、数据库或日志放进项目交付物；依赖由构建打包。

## 安装、升级与修复

管理员在“应用管理”上传 `.mopkg`：

- 新应用：安装并启动，授予申请的平台能力；随后指定负责人。
- 更高版本：先停止旧版本，执行新增迁移，切换版本，重新授予平台能力并启动（原来启用的应用保持启用）。
- 同版本：只在应用已停用时作为“修复”接受；版本更低时拒绝。

平台版本不满足 `app.json` 的 `platform` 范围时拒绝安装。每次安装都可重复：失败后修正问题，重新上传同一个包即可。

## 版本与迁移

- 每次交付递增 `version`。
- 迁移只能在末尾追加（`002-…`、`003-…`），已发布的文件不能修改、重排或删除；支持建表、增加可空列和建索引，不支持任意 SQL。
- 新迁移须对正在运行的旧版本安全（只追加可空列），平台先迁移、再切换版本。
- 权限码改名或删除会使负责人已配置的角色失效，尽量只追加。
