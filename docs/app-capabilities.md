# 应用能力注册与调用

应用能力以**签名安装清单中的业务 API**为候选来源。应用原有 `permissions.defined` 仍是员工角色授权的权限定义；API 通过 `businessPermission` 引用同一个权限码，再声明 `expose` 成为可开放候选。应用负责人在员工端“应用管理 → 开放接口”逐项决定是否发布，默认全部关闭。能力 ID 为 `<应用 ID>.<API ID>`，无需维护第二份业务权限目录。清单升级或应用负责人更换后旧开放设置失效，须由当前负责人重新确认；应用停用、负责人离职或关闭接口也会立即禁止新调用。

首版仅支持平台内部应用中由**当前员工操作触发**的同步调用。调用方须有隔离后端，且在该员工的业务 API 处理期间使用其服务 Gateway。平台不接受调用方传入员工 ID 来冒用身份；独立定时任务、无人登录的服务调用和外部系统调用均不在此范围。应用能力没有统一改用 MCP：应用间调用走现有 Gateway，后续 AI 会话或 MCP 工具可在同一能力与授权链之上增加适配器。

## 提供方声明

以下为清单片段；完整清单仍须满足原有字段、签名与运行时规则：

```json
{
  "id": "faults",
  "permissions": {
    "defined": [{"code": "app.faults.create", "description": "创建故障"}]
  },
  "api": [{
    "id": "create",
    "method": "POST",
    "path": "/create",
    "handler": "create",
    "permission": "app.faults.create",
    "businessPermission": "app.faults.create",
    "expose": {"contractVersion": "1.0", "mode": "write"}
  }]
}
```

`expose` 只声明候选接口的契约版本和读写属性；目录说明直接读取现有权限定义的 `description`，无需重复维护，也不改变已有 API 的业务实现。提供方 handler 继续校验必填字段、业务状态、员工组织与数据范围；平台每次调用都会重新核对负责人当前的开放状态、该员工在**提供方**的应用准入与 `businessPermission`。清单不能把 `businessEntry` API 直接开放，候选 API 的 `permission` 和 `businessPermission` 必须指向同一个本应用定义的权限。普通员工是否能进入应用由应用负责人的人员范围和角色权限决定，不额外分配“允许使用”开关；业务读取权限仍控制实际数据查询。

本仓库八个应用版本已把 43 个通过逐接口权限审计的业务 API 声明为候选，包括故障、检修、隐患、慧策通、晨会、在线签字、待办和物料。会话、人员目录、配置、草稿、上传分块、本人签署、定时触发，以及一个入口需同时支持多种权限的接口未列为候选。候选清单只有在新版应用包签名、审批、升级后才会出现在已安装应用中；负责人还需逐项开放。开发者中心从当前安装记录和实时开放状态生成，显示全部已安装应用、候选接口及其“已开放/未开放”状态，已开放接口附 SDK 调用入口；页面可手动刷新，聚焦及页面停留期间也会更新。

## 调用方声明与代码

调用方在签名清单中声明 `platform.apps.invoke`、要调用的目标业务权限，以及提供方的兼容版本范围：

```json
{
  "permissions": {"requested": ["platform.apps.invoke", "app.faults.create"]},
  "compatibility": {"applications": [{"id": "faults", "version": {"minInclusive": "1.0.0", "maxExclusive": "2.0.0"}}]}
}
```

管理员安装预览会显示目标权限及本应用开放的能力。批准签名版本后，`platform.apps.invoke` 作为平台服务能力按现有流程授权；目标业务权限不会因此授予任何员工。调用方后端在员工触发的 handler 内通过公开 SDK 调用：

```ts
import {createAppCapabilityClient} from '@metro/platform-sdk/app-gateway';

const capabilities = createAppCapabilityClient(gateway);
await capabilities.call('faults', 'create', confirmedPayload);
```

其中 `gateway` 是当前应用后端已绑定的 Gateway 客户端。后端应先核验自己的触发动作权限；对写入能力，界面应先让员工补齐信息并确认，再提交调用。示例“晨会交接 → 创建故障”仅用于合成应用测试，本版没有给晨会或故障应用增加入口。

平台在执行前后核对调用方与提供方仍启用、版本依赖仍满足、目标 API 仍由负责人发布、平台服务授权仍有效，以及员工在目标应用的业务授权。目标 API 沿用原有业务数据范围校验。关闭接口会返回 `APP_CAPABILITY_NOT_PUBLISHED`；员工角色或数据范围不足时返回 `TARGET_APP_ACCESS_DENIED`，调用方应把原因显示给员工，在弹窗中提示其联系目标应用负责人核对角色与范围。审计记录来源应用、目标应用和 API ID，不记录业务参数。Gateway 和目标后端均有超时、并发与负载上限；失败的写入结果可能是 `writeOutcome: 'unknown'`，调用方不得自动重试，应由业务记录查询或人工核对。

部署前运行数据库迁移 `app-gateway-capability-invoke-permission` 和 `app-capability-publication-expand`，分别注册 `platform.apps.invoke` 权限及负责人开放状态表。迁移不向既有应用自动授权，也不默认开放接口。提供方及调用方都须分别完成签名、版本审批、安装、启用和业务授权配置；提供方负责人再逐项开放。
