# 通用站内通知

所有应用可通过公开 SDK 请求站内通知能力。平台绑定来源应用、存储通知、校验接收人、展示未读状态；应用决定业务触发时机和允许接收通知的人。

## 声明和调用

请求 platform.notifications.create；需要撤销时再请求 platform.notifications.manage，由管理员授予服务能力。调用来自当前员工触发的隔离后端 handler，handler 先校验员工业务操作权限及接收对象范围。

```ts
import {createPlatformNotificationsClient} from '@metro/platform-sdk/app-gateway';
const notifications = createPlatformNotificationsClient(gateway);
const result = await notifications.publish({
  id: notificationIntentId,
  entityType:'maintenance-record',
  entityId:record.id,
  personIds:confirmedRecipientIds,
  title:'检修记录已提交',
  body:'请进入应用查看。',
  routeId:'records'
});
// 保存 result.id 供核对或撤销；撤销不硬删除通知。
await notifications.cancel(result.id);
```

id 和 entityId 为UUID；personIds 必须去重，1～50个在职人员ID，组织须启用。entityType 为小写字母开头的字母/数字/下划线/短横线标识，最长64。title 最长160字符，body 最长1000。内容应只含接收人允许看到的信息。

routeId 可省略；提供时必须是本应用 app.json pages 中不带参数的页面。平台构造 /employee/app/<appId>/<path>，拒绝自定义URL和跨应用链接。通知本身不授予应用准入、路由权限或业务数据权限；接收人打开时仍检查。当前跳转定位页面，不提供任意查询参数或具体记录定位协议。

## 兼容与限制

publish 是通用站内通知；旧 create(params) 保留固定签字提醒的契约和跳转，用于已安装应用兼容。新应用优先使用 publish。cancel 支持本应用的两类通知，拒绝跨应用撤销。

本期只发送 in_app，不提供组织群发、外部渠道选择或无人值守任务。企业微信／钉钉机器人仍由独立 webhook 能力处理。

平台按源应用及通知ID核对幂等内容，但客户端不自动重试。网络或提交结果未知时，保存原 intentId 并核对通知/业务记录；不能用新ID重复发布。当前没有通用应用通知查询SDK，无法核对时交管理员检查。应用须设计自己的通知意图记录与人工恢复入口，不能宣称“恰好一次送达”。


## 应用无人值守提醒（V2）

有定时业务的应用可以通过 defineServer 的 start/stop 钩子管理扫描；平台启动启用应用时运行，停用或退出时停止。提醒通过应用服务身份调用已有 Webhook 网关，不需要员工浏览器保持打开；停机期间不承诺发送。

应用须持久化领取和投递状态，核对到期记录与设置，避免重复扫描／重启造成重复消息。外部发送超时或结果未知保留待核对状态，不自动重发。Webhook 不写入安装包、普通接口或日志。
