# __APP_NAME__

运管平台应用（应用模型 v2）。

```sh
npm install
npm test
npm run check
npm run build      # 输出 dist/__APP_ID__-<版本>.mopkg
```

把 `dist/` 中的 `.mopkg` 文件交给平台管理员，在管理端“应用管理 → 安装应用”上传。

## 目录

- `app.json`：应用名称、版本、权限、页面、接口。
- `icon.svg`：应用图标（白色线条，平台按 `color` 填充底色）。
- `src/ui.jsx`：页面，`export default defineApp(...)`。
- `src/server.js`：接口，`export default defineServer(...)`，函数名与 `app.json` 的 `api[].id` 一致。
- `migrations/`：数据表，`001-xxx.json` 起按序追加，已发布的迁移不要修改。
