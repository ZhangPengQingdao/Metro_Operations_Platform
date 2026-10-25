# 员工工作台与应用性能（0.25.0）

工作台参考 AFC 首页的业务组织方式，采用紧凑指标卡、首排图表、快捷入口、其余图表和右侧关注/记录的布局。指标卡只显示名称、主数值与近 7 日趋势线；热力图按星期对齐，色块内仅显示日期，悬停或聚焦显示数量。顶部不显示欢迎语、重复标题或手动刷新按钮。平台仅通过已安装应用的公开 API 获取数据，不读取应用业务表，也不依赖原 AFC 仓库。

## 个人布局

手机入口位于顶部导航栏右侧，与工作台标题同一行；桌面也仅显示齿轮，弹窗标题和无障碍名称为“首页设置”。员工通过右上角齿轮“首页设置”分别选择并排序顶部卡片（最多 4 张）、图表（最多 16 张）和快捷入口（最多 24 项）。支持恢复默认、取消草稿和隐藏全部；快捷入口固定在首两张图表之后。可选项来自当前有权限的应用，配置不会授予任何权限；暂时失去应用权限时过滤展示，重新获权后可恢复已保存选择。

`GET /api/employee/dashboard-layout` 返回 `{layout,revision}`，未配置为 `{layout:null,revision:0}`。`PUT` 接受 `{layout:{version:1,cards,charts,shortcuts},revision}`，仅使用会话绑定的员工账号，不接受账号/人员参数。数组不得重复；卡片和快捷入口为应用 ID，图表为 `appId:series` 或 `appId:completion`。配置保存在新增的平台表 `platform_employee_dashboard_layouts`，按账号隔离、跨会话/设备同步；升级自动执行增量迁移，不改应用表。过期 revision 返回 409，界面要求重新打开核对；保存结果未知时不自动重试。取消与恢复默认未保存前不写入服务端。

## 应用接入

应用在 `app.json` 中把一个接口标为工作台摘要（最多一个，必须声明权限）：

```json
{"api": [{"id": "dashboard-summary", "permission": "read", "dashboard": true}]}
```

平台把它挂到应用侧栏的第一个页面上。平台不猜测接口，也不自动把其他接口放到首页；未声明时保留应用入口，页面不显示虚构的零值统计。

应用 handler 接受空对象，使用宿主绑定的员工身份，返回 `{ok:true,result:AppDashboardSnapshot}`。错误沿用现有 `{ok:false,error:{code,writeOutcome}}`。公开类型与校验来自 `@metro/platform-sdk/app-dashboard`：

```ts
interface AppDashboardSnapshot {
  version: '1.0';
  generatedAt: string; // ISO 时间
  scopeLabel: string;
  metrics: {id: string; label: string; value: number; unit: string}[];
  completion?: {completed: number; total: number};
  series?: {kind: 'line' | 'heatmap'; label: string; unit: string; points: {date: string; value: number}[]};
  items: {id: string; title: string; description?: string; occurredAt?: string}[];
}
```

最多 4 个非负安全整数指标、5 条近期记录；可选 series 为连续 1–31 个上海自然日的数据，每日值为非负安全整数；文本长度受限，不接受 HTML、任意 URL 或代码。跳转目的地由宿主根据 `routeId` 生成。平台入口 `GET /api/employee/apps/:appId/dashboard` 认证员工会话、核对应用准入和页面可见性，再经现有员工 API 调用链检查业务权限；执行前后复核准入。平台工作台属于当前员工访问该应用的入口。旧版负责人逐接口发布与跨应用调用机制已在 1.0.0 清理，当前没有独立的负责人工作台摘要开关。

页面可见时，员工应用列表每 30 秒刷新，窗口重新获得焦点时也刷新。新安装、启用且员工有权限的应用会自动加入侧栏；声明工作台摘要后，其卡片和图表加入首页设置候选项。已保存的个人布局保留选择，不自动勾选新增内容。未保存布局时默认最多展示 4 张卡片、8 个快捷入口；默认图表优先使用故障趋势、慧策通完成情况、检修趋势和待办完成情况，有这些图表时不自动追加新应用图表。

浏览器最多同时读取两个摘要；单卡失败不影响其他卡，失败与无权限不显示成零。离开首页取消请求，隐藏标签暂停定时刷新，返回后更新。每 60 秒自动刷新；统计只保留在组件内存中。首次摘要完成后再预热最近应用，减少首页与应用启动争用。

## 四个首批应用的口径

- 故障记录：当前授权范围内未作废的全部故障；待处理为总数减已修复。
- 检修管理：当前授权范围内未删除的全部计划；统计单位为计划，非设备或工时。
- 待办事项：当前授权范围内未删除的全部任务；统计单位为任务，非任务子项；预览最新的活动任务。
- 慧策通：当前授权范围内未取消的全部计划条目；统计单位为条目，包含各月数据。

完成率分母不含已删除/取消记录，分母为零时显示“—”。范围由应用现有业务授权决定，当前没有额外的个人/工班范围切换，也不将缺少真实接口的趋势图、工作量或健康分数模拟成业务数据。设备故障趋势展示含今日的近 14 天，按 occurred_at 统计未作废故障，比较近 7 日与前 7 日（不是自然周，今日尚未结束）。检修记录热力图按 created_at 展示含今日的近 28 天未删除计划新增数量，不称为工作量积分。待办和慧策通增加近 14 天 created_at 新建记录趋势，包含后来删除/取消的记录，表示新增事件量而非当前待办存量；卡片迷你趋势沿用对应应用的每日新增/发生数量，不表示待处理数量的历史变化。完成环图直接使用各应用 completion，不混合不同计量单位，也不推导设备健康分。

各应用预览最新一条记录，首页汇合排序；该区不是完整审计日志。

修改仓库源码不会自动改变已安装的应用，需重新构建并上传 `.mopkg`。

## 读取方式

- `platform.app_data.read_batch` 支持 `{kind:'count',table,filters?,anyOf?,range?,search?}`；计数范围由应用按组织权限构造，表和列按本应用 schema 校验，值全部参数化，不允许任意 SQL、groupBy 或跨 schema。
- 同一批次还支持 `{kind:'daily_count',table,column,from,days,filters?,anyOf?}`：column 必须是 timestamptz 列，from 为 YYYY-MM-DD，days 为 1–31，以 Asia/Shanghai 自然日计数，返回 `{days:[{day,count}]}`；无数据日由应用在成功返回后补零，失败不补零。每批最多四项读取。
- 列表支持 `columns`（1–32 个不重复字段），自动保留 `id` 和排序游标列，避免传输大 JSON 字段。
