# 检修管理应用 0.1.2

独立应用，参考旧 AFC Ops Manager 的检修计划与派工流程重新实现。仅通过公开 SDK、Gateway 和托管存储接入平台；不依赖旧仓库，也不迁移旧检修数据。

## 功能

- 按工班、车站、日期、状态和关键词查询计划；每组计划包含多台设备，显示完成进度。
- 新增、编辑计划与逐台派工；主、副作业人从所选工班目录选择，完成设备必须确认主作业人，并记录完成时间。已完成明细不能删除或退回待执行，包含已完成明细的整组计划不能作废。
- 下载 Excel 导入模板，选择 Excel/CSV 文件后在沙箱内解析、预览并批量导入计划；原文件不上传或保存。CSV 须为 UTF-8 编码，单次最多 2 MB、200 组计划。按月份导出授权范围内的已完成与待执行设备，单次最多 5000 台。
- 车站、设备类型和设备编号使用 L2 搜索选择框；目录无对应项时可手工填写，手填内容不视为目录匹配。

## 授权与安装

应用权限为 `app.maintenance.read/create/update/export/delete`，均支持本人、本工班、本部室、指定组织和全平台范围。员工需获应用使用授权及对应业务权限；进入应用需要 `read`。服务身份需获 `platform.app_data.read/write`、`platform.people.read`、`platform.locations.read` 和 `platform.assets.read`。管理员在安装审批时可一并批准这些平台能力；安装完成后应用会启用，应用负责人、员工使用授权和业务角色仍需另行配置。

```sh
npm run build:sdk
npm --prefix applications/maintenance test
npm --prefix applications/maintenance run build
npm --prefix server run app-cli -- validate ../applications/maintenance/dist
```

`dist/` 是本地产物，不提交。应用须签名并经安装审批；构建与清单校验不等于已安装或已完成真实员工验收。
