# 在线签字应用

独立应用 `signatures` 使用公开 SDK、托管应用数据、平台人员目录、公共签字与系统通知。旧 AFC 系统仅作为业务模板参考；本应用没有旧仓库的源码或运行时依赖。

## 页面与流程

- 侧边栏依次为“签字列表”和“签字模板”。列表使用共享 L2 搜索、筛选、列表与分页组件。
- 内置线下培训签到表、技术比武成绩单、安全会议及活动台账、员工调整排班申请表四种模板。人员从当前工班目录搜索选择；创建时再次核验所有签字人。
- 创建记录后关联公共签字任务，并为每位签字人创建本人系统通知。通知和任务二维码都指向该任务详情；扫码者须登录平台，业务权限和本人身份由宿主核验，二维码本身不授予签字权。
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
