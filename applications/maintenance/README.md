# 检修管理应用

本版增加工作台摘要接口，最低平台版本为 0.25.0；统计口径和安装顺序见 [工作台接入说明](../../docs/employee-dashboard.md)。

独立应用，参考旧 AFC Ops Manager 的检修计划与派工流程重新实现。仅通过公开 SDK、Gateway 和托管存储接入平台；不依赖旧仓库，也不迁移旧检修数据。

检修记录热力图统计近 28 天按上海自然日新建的未删除计划，单位为计划项，并非工作量积分或设备台数。

## 1.0.0：应用模型 v2

本版改为 v2 项目，作为新应用安装（不保留旧版测试数据）：`app.json`、`icon.svg`、`src/`（页面 `ui.jsx`、样式 `ui.css`、接口 `server.js` 及业务模块）、`migrations/`。页面用 `defineApp` 直接渲染在平台内，标题与侧栏由平台按 `pages` 生成；后端在平台子进程中运行。页面：`/` 检修管理。

```sh
npm test            # 业务规则测试
npm run check       # 校验 app.json、迁移与页面/接口一致性
npm run build       # 输出 dist/maintenance-1.0.0.mopkg
```

要求平台 0.30.0 及以上。管理员上传 `.mopkg` 安装后指定应用负责人，负责人配置角色与使用人员。以下为各版业务说明，涉及签名包、沙箱和 `build.mjs` 的构建与安装步骤已不再适用。

## 功能

- 按工班、车站、日期、状态和关键词查询计划；每组计划包含多台设备，显示完成进度。
- 新增、编辑计划与逐台派工；主、副作业人从所选工班目录选择，完成设备必须确认主作业人，并记录完成时间。已完成明细不能删除或退回待执行，包含已完成明细的整组计划不能作废。
- 下载 Excel 导入模板，选择 Excel/CSV 文件后在沙箱内解析、预览并批量导入计划；原文件不上传或保存。CSV 须为 UTF-8 编码，单次最多 2 MB、200 组计划。按月份导出授权范围内的已完成与待执行设备，单次最多 5000 台。
- 车站、设备类型和设备编号使用 L2 搜索选择框；目录无对应项时可手工填写，手填内容不视为目录匹配。

## 授权与安装

应用权限为 `app.maintenance.read/create/update/export/delete`，均支持本人、本工班、本部室、指定组织和全平台范围。应用负责人配置人员范围和业务角色；查看计划需 `read`，具体数据按该权限范围裁剪。服务身份需获 `platform.app_data.read/write`、`platform.people.read`、`platform.locations.read` 和 `platform.assets.read`。管理员在安装审批时可一并批准这些平台能力；安装完成后应用会启用，负责人和业务角色仍需另行配置。新版包把列表、详情、创建、修改、作废和导出声明为可开放候选，负责人在“开放接口”中逐项发布，默认关闭。

```sh
npm run build:sdk
npm --prefix applications/maintenance test
npm --prefix applications/maintenance run build
```

`dist/` 是本地产物，不提交。应用须签名并经安装审批；构建与清单校验不等于已安装或已完成真实员工验收。
