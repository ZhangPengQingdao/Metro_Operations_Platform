# 故障记录应用 0.0.4

独立应用代码，只通过公开 `@metro/platform-sdk` 和 Gateway 访问平台能力。业务设计、原系统功能对照与待接能力见 [故障记录应用方案](../../docs/fault-records-app-plan.md)。不迁移旧数据。

## 本版功能

- 使用平台 L2 搜索和筛选，按组织、发生日期、故障/设备/车站关键词、状态和待完善状态查询，支持发生时间正倒序；查看详情。状态与排序位于筛选面板，导出和小单粘贴位于功能菜单。
- 新增、编辑、修复/重开、作废。记录归属由可信员工身份及应用业务授权决定，作废留痕。
- 粘贴故障小单本地识别，带入可修改表单；不宣称 AI 或设备点表匹配。
- 按日期范围在沙箱内生成并下载 `.xlsx`，单次最多 5000 条，超限明确要求分段导出；下载需清单声明 `ui.downloads: true`。
- 处理人使用 SDK 共享 L2 单个搜索下拉框，必须从所选工班的在职人员目录选择。车站、设备类型和设备编号均使用单个搜索下拉框；目录为空或未授权时仍可手工输入，手工输入不宣称已匹配设备。设备编号候选仅在选择目录车站后展示，并按车站及类型查询。
- 接报人同样支持单框搜索并选择本工班人员，也可手工填写外部来报姓名；接报、到达、修复时间及导出日期使用共享 L2 日期/时间控件。保存按钮直接调用业务 API，适配无 `allow-forms` 的标准沙箱；保存前要求必填字段和时间的日期与时分均完整。

## 构建与检查

先在仓库根目录安装依赖并构建 SDK，再运行：

```sh
npm run build:sdk
npm --prefix applications/faults test
npm --prefix applications/faults run build
npm --prefix server run app-cli -- validate ../applications/faults/dist
```

`dist/` 是本地构建产物，不提交。后续由独立 CLI 签名和导出安装包，再由管理端审批、授权和启用；构建成功本身不代表已安装。

## 授权

应用定义 `app.faults.read/create/update/export/delete`，支持本人、本工班、本部室、指定组织和全平台范围。建议普通成员授予本工班的 read/create/update/export，工班负责人再授予本工班 delete。应用负责人管理角色分配，但不自动获得业务数据权限。

应用服务需获 `platform.app_data.read/write`、`platform.people.read`、`platform.locations.read`、`platform.assets.read`；员工还需获应用使用授权及对应业务权限。平台管理员身份不代替员工业务身份。未知写入结果不自动重试，界面保留请求编号并阻止后续写入。
