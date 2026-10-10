# 员工工作台与应用性能（0.25.0）

工作台参考 AFC 首页的业务组织方式，采用紧凑指标卡、首排图表、快捷入口、其余图表和右侧关注/记录的布局。指标卡只显示名称、主数值与近 7 日趋势线；热力图按星期对齐，色块内仅显示日期，悬停或聚焦显示数量。顶部不显示欢迎语、重复标题或手动刷新按钮。平台仅通过已安装应用的公开 API 获取数据，不读取应用业务表，也不依赖原 AFC 仓库。

## 个人布局

手机入口位于顶部导航栏右侧，与工作台标题同一行；桌面也仅显示齿轮，弹窗标题和无障碍名称为“首页设置”。员工通过右上角齿轮“首页设置”分别选择并排序顶部卡片（最多 4 张）、图表（最多 16 张）和快捷入口（最多 24 项）。支持恢复默认、取消草稿和隐藏全部；快捷入口固定在首两张图表之后。可选项来自当前有权限的应用，配置不会授予任何权限；暂时失去应用权限时过滤展示，重新获权后可恢复已保存选择。

`GET /api/employee/dashboard-layout` 返回 `{layout,revision}`，未配置为 `{layout:null,revision:0}`。`PUT` 接受 `{layout:{version:1,cards,charts,shortcuts},revision}`，仅使用会话绑定的员工账号，不接受账号/人员参数。数组不得重复；卡片和快捷入口为应用 ID，图表为 `appId:series` 或 `appId:completion`。配置保存在新增的平台表 `platform_employee_dashboard_layouts`，按账号隔离、跨会话/设备同步；升级自动执行增量迁移，不改应用表。过期 revision 返回 409，界面要求重新打开核对；保存结果未知时不自动重试。取消与恢复默认未保存前不写入服务端。

## 应用接入

应用在签名 manifest 中声明：

```json
{
  "dashboard": { "apiId": "dashboard-summary", "routeId": "records" }
}
```

`apiId` 必须引用 `expose.mode=read` 的 GET/POST API；该 API 同时需要应用自己的 `businessPermission` 和相同的 `permission`。`routeId` 必须引用 sandbox 应用已声明的页面。平台不猜测接口，也不自动把其他接口放到首页。旧应用未声明时保留应用入口，页面不显示虚构的零值统计。

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

最多 4 个非负安全整数指标、5 条近期记录；可选 series 为连续 1–31 个上海自然日的数据，每日值为非负安全整数；文本长度受限，不接受 HTML、任意 URL 或代码。跳转目的地由宿主根据 `routeId` 生成。平台入口 `GET /api/employee/apps/:appId/dashboard` 认证员工会话、核对应用准入和页面可见性，再经现有员工 API 调用链检查业务权限；执行前后复核准入。跨应用调用的负责人发布开关仍只适用于跨应用调用，平台工作台属于当前员工访问该应用的入口。

浏览器最多同时读取两个摘要；单卡失败不影响其他卡，失败与无权限不显示成零。离开首页取消请求，隐藏标签暂停定时刷新，返回后更新。每 60 秒自动刷新；统计只保留在组件内存中。首次摘要完成后再预热最近应用，减少首页与应用启动争用。

## 四个首批应用的口径

- 故障记录：当前授权范围内未作废的全部故障；待处理为总数减已修复。
- 检修管理：当前授权范围内未删除的全部计划；统计单位为计划，非设备或工时。
- 待办事项：当前授权范围内未删除的全部任务；统计单位为任务，非任务子项；预览最新的活动任务。
- 慧策通：当前授权范围内未取消的全部计划条目；统计单位为条目，包含各月数据。

完成率分母不含已删除/取消记录，分母为零时显示“—”。范围由应用现有业务授权决定，当前没有额外的个人/工班范围切换，也不将缺少真实接口的趋势图、工作量或健康分数模拟成业务数据。设备故障趋势展示含今日的近 14 天，按 occurred_at 统计未作废故障，比较近 7 日与前 7 日（不是自然周，今日尚未结束）。检修记录热力图按 created_at 展示含今日的近 28 天未删除计划新增数量，不称为工作量积分。待办和慧策通增加近 14 天 created_at 新建记录趋势，包含后来删除/取消的记录，表示新增事件量而非当前待办存量；卡片迷你趋势沿用对应应用的每日新增/发生数量，不表示待处理数量的历史变化。完成环图直接使用各应用 completion，不混合不同计量单位，也不推导设备健康分。

各应用预览最新一条记录，首页汇合排序；该区不是完整审计日志。

平台和四个应用需分别更新：先发布平台 0.25.0，再重新构建、签名并更新应用包；新应用的最低平台版本是 0.25.0。修改仓库源码不会自动改变已安装的应用。

## 性能改动

1. 管理员与员工工作区按路由加载，登录与员工访问无需下载完整管理端。
2. 不声明 `clientRouting` 的应用，在保留的同一路径重新显示时也复用 iframe；路径或安装/授权版本变化仍重新准入。
3. 可见应用准入轮询由 5 秒改为 30 秒，聚焦和标签恢复时检查；后台标签不轮询。所有业务请求仍走服务端权限校验。无业务请求的界面撤权展示可能等待一次轮询；服务端原有 30 秒准入缓存边界没有放宽。
4. `platform.app_data.read_batch` 支持 `{kind:'count',table,filters?,anyOf?,range?,search?}`。与普通读取一样，仅服务身份可用，计数范围由应用组织权限构造，表和列按绑定 schema 验证，值全部参数化；不允许任意 SQL、groupBy 或跨 schema。
5. 同一批次还支持 `{kind:'daily_count',table,column,from,days,filters?,anyOf?}`。column 必须是声明的 timestamptz 列，from 为 YYYY-MM-DD，days 为 1–31；以 Asia/Shanghai 自然日计数，返回 `{days:[{day,count}]}`，无数据日由应用在成功返回后补零，失败不补零。仍最多四项读取，故障/检修摘要的趋势占用第四项。
6. 列表支持 `columns`（1–32 个不重复字段）；自动保留 `id` 和排序游标列。故障/检修的计数、精简预览和每日趋势合并为一次批次、一次受限连接租约及一个 SQL 语句。待办/慧策通因排除删除/取消记录已用满四项，趋势再使用一个顺序单项批次；两批次不承诺同一数据库快照。所有批次继续限定现有组织范围，避免逐页传输大 JSON 子项。

保留双应用上限、独立资源域、sandbox 和服务端权限检查。受限数据库连接租约、冷启动资源获取、跨进程协议仍有成本；本轮没有宣称已达到原生集成速度。后续应按真实部署的 `observeTiming` 数据区分连接、SQL、准入和容器开销，再评估连接复用等涉及隔离模型的优化。
