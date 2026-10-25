# 晨会交接

交接班台账、晨会记录与本人签署。

## 1.0.0：应用模型 v2

本版改为 v2 项目，作为新应用安装（不保留旧版测试数据）：`app.json`、`icon.svg`、`src/`（页面 `ui.jsx`、样式 `ui.css`、接口 `server.js` 及业务模块）、`migrations/`。页面用 `defineApp` 直接渲染在平台内，标题与侧栏由平台按 `pages` 生成；后端在平台子进程中运行。页面：`/` 交接班、`/handover-records` 交接班记录、`/meeting` 晨会、`/meeting-records` 晨会记录、`/settings` 设置。

```sh
npm test            # 业务规则测试
npm run check       # 校验 app.json、迁移与页面/接口一致性
npm run build       # 输出 dist/shifts-1.0.2.mopkg
```

要求平台 0.30.0 及以上。管理员上传 `.mopkg` 安装后指定应用负责人，负责人配置角色与使用人员。以下为各版业务说明，涉及签名包、沙箱和 `build.mjs` 的构建与安装步骤已不再适用。
