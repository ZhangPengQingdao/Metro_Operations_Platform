# 慧策通·计划督办

独立应用，当前版本 0.1.0，交付范围为 [M1 域模型与骨架](../../docs/huicetong-app-plan.md#13-分期与里程碑)。采用员工业务授权、隔离后端、平台托管存储及标准沙箱页面，不依赖旧 AFC 仓库。

## 已实现

- 按授权组织创建唯一的月度周期，维护三级分类字典。
- 编制和修改草稿条目，填写质量标准、时间、拟提报标记及至多 6 位责任人，并指定一位牵头人。
- 通过平台人员目录核验在岗责任人及所属组织；服务端按员工业务权限和组织范围复核读写。
- 平台宿主侧边栏提供“计划条目”和“分类字典”两个功能入口，分别对应 `/` 与 `/categories`；列表用 L2 筛选栏，组织、分类和人员用 L2 层级选择器。
- 周期、分类和条目写入附带审计事件；条目编辑使用版本比较，周期状态与条目写入在同一事务校验。未知写入结果不自动重放。

页面从当前员工所在工班选择责任人；服务端支持同部门跨工班的多责任人。跨工班可视目录需要独立的组织树选择能力，留到后续界面迭代。审核、签发、锁定、执行提报、导出和附件属于后续里程碑，当前不能用于完整月度闭环。

## 授权与构建

安装时为应用服务审批 `platform.app_data.read`、`platform.app_data.write`、`platform.people.read`；为员工授予应用内 `app.huicetong.read`，并按职责追加 `fill`、`review` 或 `manage`。`read` 应覆盖实际需查看的部门，`fill` 的本人范围用于限制本人草稿，`manage` 覆盖计划管理组织。安装、审批及授权按 [应用接入](../../docs/applications.md) 进行。

```sh
npm run build:sdk
npm --prefix applications/huicetong test
npm --prefix applications/huicetong run build
node packages/platform-cli/dist/cli.mjs validate applications/huicetong/dist
```

构建产物在 `dist/`，由 `build.mjs` 生成清单、前后端包和初始迁移。安装前应使用正式发布者私钥签名并在管理端完成审批；本源码不含私钥或生产数据。
