# 应用知识库

平台 1.4.0 提供结构化文本知识库。应用在 `app.json` 声明自己的库，通过后端 SDK 维护和检索；平台绑定安装实例、员工身份和组织范围。1.7.0 增加逐条语料向量索引和语义检索；文档上传、解析与切分后续再做。统一聊天入口见 [智能体接入](agents.md)。

## 声明与权限

```json
{
  "platformAccess": ["knowledge.read", "knowledge.write"],
  "knowledgeBases": [{
    "id": "terms",
    "name": "专有名词",
    "retrieval": "exact",
    "readPermission": "fill",
    "writePermission": "corpus",
    "selfRead": true
  }]
}
```

`fill` 和 `corpus` 必须在本应用的 `permissions` 中声明。知识库声明随应用安装生效，相当于创建库；无需单独调用建库接口。每个应用最多声明16个库。删除声明后该库无法再通过 SDK 访问，已存条目不自动删除。

- `search`：要求 `readPermission` 或 `writePermission` 的组织范围授权。
- `list`、`write`：要求 `writePermission` 的组织范围授权。读取完整库与用于生成的检索分开控制。
- `selfRead` 默认关闭。显式启用后，具有读取权限 `self` 范围的员工，可检索自己当前组织及其启用祖先组织的共享知识；不获得维护权限。这适用于成员使用所属部门语料的场景。
- 平台使用现有应用业务角色解析范围；旧版授权模式不支持本接口。服务后台任务没有员工上下文时不能调用。
- 不接受 `appId`、员工 ID 或权限码参数。另一个应用即使声明同名知识库，也无法读取本应用条目。

## 调用

```js
import {createPlatformKnowledgeClient} from '@metro/platform-sdk/app-knowledge';

const knowledge = createPlatformKnowledgeClient(context.platform);
const target = {libraryId: 'terms', organizationId};

const saved = await knowledge.write({
  ...target, action: 'save', id: crypto.randomUUID(), requestId,
  title: 'AFC', content: '自动售检票系统', metadata: {}
}, context.signal);

const page = await knowledge.list(target, context.signal);
const matches = await knowledge.search({...target, query: '完成AFC设备检查'}, context.signal);

await knowledge.write({
  ...target, action: 'delete', id: saved.id,
  expectedVersion: saved.version, requestId: anotherRequestId
}, context.signal);
```

页面经自己的应用 API 发起操作；由业务界面为每次写入意图生成并保存 `requestId`，不要为同一次重试重新生成请求号。SDK 不自动重试。

列表条目返回 `{id,title,content,metadata,version,indexStatus,indexError?}`。检索条目附 `score` 和 `reference:{libraryId,organizationId,id,version}`；外层 `retrieval:{mode,reason?}` 表示实际检索方式。引用是本次检索的条目版本，不由模型生成；条目后续更新时，历史回答仍保留当次版本标识，不提供历史正文快照或页码。

| 字段 / 行为 | 限制 |
| --- | --- |
| title | 1–100字符，首尾不得有空白 |
| content | 最多1000字符，允许空文本以保存尚无解释的名词 |
| metadata | 最多4个字符串字段，每值≤500字符，JSON总大小≤2048字节 |
| query | 1–1500字符 |
| list | 每页20条，以 `nextCursor` 作为下一次的 `afterId` |
| similar 的 limit | 1–20，默认5 |
| exact 检索 | 返回全部命中，最多40条；超限报错，不截掉受保护名词 |

`save` 不带 `expectedVersion` 表示新增；更新与删除带上已读取版本。已删除条目可以重新新增，版本继续递增。`exact` 库按库、组织与标题生成稳定 ID，调用方使用返回的 ID；同名新增产生冲突，更新不允许改名，改名须删除后重新新增。`similar` 库保留调用方生成的 ID。

每次写入在同一事务中记录条目变更与请求结果，按安装实例和 `requestId` 去重，记录操作员工。相同请求重发返回首次结果；同请求号变更内容或员工会被拒绝。未知写入结果先查询核对，不自动重放。

## 检索行为

`exact` 使用标题在查询中的逐字匹配，区分大小写，适合受保护名词。解释放在 `content` 中。

未启用向量模型，或当前库仍有未完成/失败索引时，`similar` 使用基础字符重合检索：查询去重后保留字母和数字，忽略大小写；按正文命中数排序。至少命中2个字符且覆盖查询有效字符的20%；查询仅1个有效字符时需命中该字符。无有效命中返回空列表。该分数只用于基础排序，不是语义置信度。标准示例正文放在 `content`，质量标准可放在 `metadata.qualityStandard`。

启用向量模型且当前组织库全部索引就绪后，`similar` 用查询向量做精确余弦相似度排序，返回分数达到管理员配置 `minScore` 的前 `limit` 条。分数不是答案可信度；默认 0.3 保留已有配置行为，可在管理端调整（0–1），无需重建索引。本地 BGE-small-zh-v1.5 试跑暂用 0.55，需要结合真实语料继续验收。向量输入包括标题、正文和 metadata，专有名词库始终逐字匹配，不生成向量。

`retrieval.mode` 为 `exact`、`text` 或 `semantic`；文本降级原因 `reason` 为 `unconfigured`、`indexing` 或 `failed`。配置启用但查询向量调用失败时返回 `KNOWLEDGE_EMBEDDING_UNAVAILABLE`，不静默换成文本结果。

平台先按应用和组织权限限制数据，再检索。返回的知识文本应作为模型参考数据，应用继续负责自身输出格式和业务规则。

## 索引与连接

管理端「个人中心 → 系统设置 → 大模型配置 → 知识库向量模型」单独填写 OpenAI 兼容的 embeddings 地址、API Key、模型 ID、模型原生输出维度（1–4096）。可先测试再启用保存，密钥加密存储且不回传明文。接口发送 `model/input/encoding_format:float`，不请求缩减维度。更换地址必须重新填写密钥；支持服务器本机及内网 HTTP/HTTPS 模型：运维在启动环境 `MOP_EMBEDDING_ALLOWED_ENDPOINTS` 指定完整请求地址白名单，管理员填写匹配地址即可。未列入白名单的地址仍须通过公网 HTTPS 检查，所有连接均禁止重定向。白名单不会放开聊天模型连接策略。详见 [部署说明](../deployment.md)。

索引状态：`not_required`（精确库）、`unconfigured`、`pending`、`processing`、`ready`、`failed`。保存和修改仅落库，后台每两秒最多处理一条，外部请求不占用数据库事务。失败保存错误码，等待用户修复配置后手动重建；不自动反复重试。进程中断的任务在两分钟租约到期后可重新领取。停机和平台维护会取消并等待当前索引任务。

```js
await knowledge.write({
  ...target, action: 'reindex', id: entry.id,
  expectedVersion: entry.version, requestId: crypto.randomUUID()
}, context.signal);
```

`reindex` 只用于 `similar` 库，沿用维护权限和请求幂等，不增加业务正文版本。修改、删除和重建会清空旧向量并取消旧任务令牌；迟到结果不能覆盖新状态。更换模型、地址或维度生成新索引版本，旧向量不参加新模型检索并自动排队重建。仅更换密钥或超时时间不重建已就绪向量；失败条目可手动重建。

当前将归一化向量存入 PostgreSQL `double precision[]`，按已授权库精确计算相似度，适合当前小规模逐条语料。没有新增向量数据库、ANN 索引或额外服务；计算量随库内条数和维度线性增长，大语料规模需另行评估。

## 错误与部署

- `ACCESS_DENIED`：应用、员工、知识库声明或组织范围未授权。
- `INVALID_PARAMS`：参数不符合接口契约。
- `KNOWLEDGE_CONFLICT`：条目版本变化、重复标题、无效删除或试图给精确匹配条目改名。
- `KNOWLEDGE_EMBEDDING_UNAVAILABLE`：查询向量服务不可用，HTTP 502，可直接填写或检查向量配置。
- `KNOWLEDGE_LIMIT`：精确匹配命中超过40条。
- `REQUEST_ID_REUSED`：同请求号被用于不同写入。

升级平台并执行已有 `db:init` 流程，应用 `platform-knowledge-expand` 迁移，再安装声明知识库的新应用包。迁移仅新增平台知识条目、写入请求表及权限定义，不搬运或删除应用旧语料。应用仍使用原有数据库和运行时，无新增部署服务。

1.7.0 额外执行 `platform-knowledge-vectors-expand` 增量迁移，只增加索引列。已有文本条目保留；启用向量配置后逐条建立索引。升级平台后安装慧策通 2.4.0（要求平台≥1.7.0）。无需迁移应用旧语料，也无需先上传文档。
