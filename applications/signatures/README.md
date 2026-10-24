# 在线签字应用

独立应用 `signatures` 使用公开 SDK、托管应用数据、平台人员目录、公共签字与系统通知。旧 AFC 系统仅作为业务模板参考；本应用没有旧仓库的源码或运行时依赖。

## 1.0.0：应用模型 v2

本版改为 v2 项目，作为新应用安装（不保留旧版测试数据）：`app.json`、`icon.svg`、`src/`（页面 `ui.jsx`、样式 `ui.css`、接口 `server.js` 及业务模块）、`migrations/`。页面用 `defineApp` 直接渲染在平台内，标题与侧栏由平台按 `pages` 生成；后端在平台子进程中运行。页面：`/` 签字列表、`/templates` 签字模板、`/sign/:taskId` 本人签字。

```sh
npm test            # 业务规则测试
npm run check       # 校验 app.json、迁移与页面/接口一致性
npm run build       # 输出 dist/signatures-1.0.0.mopkg
```

要求平台 0.30.0 及以上。管理员上传 `.mopkg` 安装后指定应用负责人，负责人配置角色与使用人员。以下为各版业务说明，涉及签名包、沙箱和 `build.mjs` 的构建与安装步骤已不再适用。

## 页面与流程

- 侧边栏依次为“签字列表”和“签字模板”。列表使用共享 L2 搜索、筛选、列表与分页组件。
- 内置线下培训签到表、技术比武成绩单、安全会议及活动台账、员工调整排班申请表四种模板。人员从当前工班目录搜索选择；创建时再次核验所有签字人。
- 创建记录后直接展示任务详情和二维码，并关联公共签字任务，为每位签字人创建本人系统通知。员工侧通知铃铛显示待签提醒数量，通知和二维码都指向该任务详情；扫码者须登录平台，业务权限和本人身份由宿主核验，二维码本身不授予签字权。
- 详情展示模板内容、二维码、进度、逐人签字状态及时间。已签人员的笔迹按需从公共签字证据读取；本人签名由公共能力保存，完成后撤销本人的待签通知。

## 权限与能力

业务权限为 `app.signatures.read`（列表查看范围）、`app.signatures.create`（组织范围）及 `app.signatures.sign`（本人）。仅有 sign 授权的员工可通过通知或二维码的独立 `/sign` 入口查看本人任务并签字；read 授权用于常规列表菜单。应用服务需单独获批 `platform.app_data.read/write`、`platform.people.read`、`platform.signatures.create/read/sign`、`platform.notifications.create/manage`。这些授权由管理员配置；安装本身不会自动授予。

签字证据不保存在应用数据表中。签字关联或通知写入结果未确认时，页面保留提示，不自动重放外部写入。任务二维码是登录后的深链接，不是公开匿名签到入口。

## 本地验证

```sh
npm --prefix applications/signatures test
npm --prefix applications/signatures run build
node server/dist/app-platform/developer/cli.js validate applications/signatures/dist
```

构建产物位于忽略提交的 `dist/`。安装发布仍需按平台流程签名、预览、审批、授权并启用。
