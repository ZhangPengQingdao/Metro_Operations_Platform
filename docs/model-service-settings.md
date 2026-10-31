# 重排序与 ASR 模型配置

平台 1.8.0。在「个人中心 → 系统设置 → 大模型配置」中，聊天、知识库向量、重排序、语音识别各有独立标签。切换标签保留草稿，分别测试与保存；测试或保存时锁定切换。关闭设置或切换左侧分类不保存草稿。

本次提供真实的配置持久化与诊断请求。保存重排序配置不会改变知识库检索结果；保存 ASR 配置不会替换慧策通当前浏览器语音识别。业务调用、公开 SDK、启用开关与质量评估属于后续接入阶段。

## 配置和测试

两类服务分别填写完整请求地址、API Key、模型 ID、请求超时（5000–120000 毫秒）。首次配置或更换地址需填写密钥；地址不变时留空保留原密钥。没有通用的模型发现接口，模型 ID 应按服务商提供的标识填写。ASR 可额外填写两位小写语言代码，如 `zh`；留空不发送语言提示。

服务地址按填写值请求，不自动补齐路径。示例：

- 重排序：`https://api.example.com/v1/rerank`，或供应商实际的 `/v2/rerank`。
- ASR：`https://api.example.com/v1/audio/transcriptions`。

### 重排序

点击“测试连接”发送一条内置问题与两条示例文本；不会读取或发送实际知识库内容。请求采用 JSON：`model/query/documents/top_n`，其中测试 `top_n=2`。响应须包含 `results:[{index,relevance_score}]`；两个候选索引须为不重复的 0、1，分数须为有限数值。页面显示服务返回顺序、对应示例和分数；连接成功不代表真实检索质量通过验收。该协议参照 [Cohere Rerank 接口](https://docs.cohere.com/reference/rerank)，只要求这里列出的字段，不假设供应商其他扩展参数兼容，也不把重排序标记为 OpenAI 接口。

### 语音识别

选择不超过 **2 MiB** 的 WAV、MP3、M4A、WebM 或 OGG 短音频，点击“测试转写”。仅测试按钮会把所选音频发给配置的服务；保存配置不上传文件。请使用适合发送到该服务的测试素材。

平台以 multipart/form-data 发送 `file/model/response_format=json`，配置语言时额外发送 `language`。响应要求 `{text:string}`，页面显示原始转写文字；空文本会提示未识别到文字，不冒充质量验收通过。参考 [OpenAI 音频转写接口](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。不支持供应商私有 WebSocket、异步任务、实时流式协议和说话人分离参数。扩展名在支持列表内不代表音频编码一定被具体服务接受。

测试请求的音频仅在浏览器与平台内存中暂存，不写入平台文件或数据库。供应商留存规则由所配置服务决定。测试响应最多 64 KiB，转写文本最多 12000 字符；超限、无效结构、拒绝连接、取消和超时均明确报错，不自动重试。

## 管理端接口

以下路径均位于 `/api/admin`，只允许管理员会话，所有写入和测试要求同源 Origin；响应为 `Cache-Control: no-store`。这些是管理诊断接口，业务应用不能拿管理员会话使用。

| 方法与路径 | 输入 / 返回 |
| --- | --- |
| `GET /rerank`、`GET /asr` | 返回 endpoint、model、timeoutMs、hasApiKey、configured；ASR 另含 language。未配置时返回空值与默认超时 |
| `POST /rerank/save`、`POST /asr/save` | 上述配置字段（不含 hasApiKey/configured），可选 apiKey，必填 UUID requestId；返回公开配置 |
| `POST /rerank/test` | 配置字段与可选 apiKey，使用内置样例；返回 latencyMs 与 results |
| `POST /asr/test` | 配置字段、可选 apiKey，加 `audio:{format,data}`；data 为规范 Base64；返回 latencyMs 与 text |

管理端小文件测试使用受限 JSON 上传，然后平台转成供应商要求的 multipart。此路径不属于公开应用网关；后续业务音频应使用经授权的附件引用和任务契约，不复用诊断接口做大文件传输。每个 API 进程最多同时接纳 2 个重排序/ASR 诊断请求，超出返回 429。平台断开测试连接时取消上游请求；取消不能保证供应商未计费。

保存时在同一事务中写入配置、管理员审计和幂等结果。重排序与 ASR 分别使用 `rerank_runtime_global`、`asr_runtime_global` 配置键。密钥沿用 `AI_PROVIDER_ENCRYPTION_KEY` 加密，不回传明文或加密载荷；审计不存密钥、音频或转写正文。相同 requestId、管理员和参数重发只返回首次结果；变更参数、管理员或服务类型返回 409。旧请求重发不会覆盖更新的配置。结果未知时先重新读取核对，前端不自动重放；同一草稿手动重试保留请求编号。

## 部署

正式签名版本发布后，按正常管理端流程「系统更新 → 检查更新 → 下载更新 → 确认备份并安装」升级即可。宿主更新器会自动备份、运行新版本的 `dist/setup/database.js`、切换 API/前端并检查健康；无需管理员另外登录服务器执行数据库命令。新增迁移 `platform-model-configuration-expand` 只创建 `model_configuration_requests` 幂等记录表；已有配置与业务语料不迁移，已完成迁移不会重复执行。

仅源码开发或绕过在线更新器的手工部署，才需要部署人员自行执行 `npm --prefix server run db:init`。模型配置需已有的有效 `AI_PROVIDER_ENCRYPTION_KEY`；不要为了接入新模型更换现有主密钥。

公网服务使用 HTTPS 并通过现有外部模型地址校验。若服务在本机或内网，由运维在 **API 进程环境** 分别添加完整请求 URL：

```dotenv
MOP_RERANK_ALLOWED_ENDPOINTS=http://rerank.internal:8000/v1/rerank
MOP_ASR_ALLOWED_ENDPOINTS=http://asr.internal:8000/v1/audio/transcriptions
```

每项最多 16 个、逗号分隔，仅允许 HTTP/HTTPS，不含凭据、查询参数或片段。精确匹配协议、主机、端口和路径；不开放同机其他路径。地址规范化后匹配，所有请求禁止重定向。两类列表互不授权，也不扩大聊天或向量服务的权限。修改启动环境后重启 API；私有 HTTPS 使用受信任证书，不关闭证书检查。配置模板见 `server/.env.example`。

诊断测试会产生供应商调用和可能的费用。当前不包含真实模型质量评测、供应商部署、音频长期保存、配额结算或公开 SDK 能力。

## 验收记录（2026-10-31）

- 完整平台回归 527/527 通过。随后补齐非法 URL 处理和环境白名单验证，最终相关测试 22/22 通过（新增模型配置、向量服务、核心配置和管理端），未重复执行无关完整测试。
- 前端类型检查、SDK/CLI/开发者资源/前端构建、API 构建以及版本一致性检查通过。
- 使用 PGlite 验证配置加密、两类配置隔离、留空密钥保留、更换地址需密钥、审计失败回滚、请求编号冲突、旧请求不能覆盖新配置、迁移可重复执行；测试内容和明文密钥不进入配置或幂等结果。
- 使用本地 HTTP 测试服务验证真实管理端鉴权、Origin 拒绝、重排序请求、ASR multipart 文件转发、诊断不保存草稿、并发限额释放和超大请求 413；供应商响应测试覆盖错误结构、重复/越界候选、过大响应、空转写、取消和超时。
- 生产前端构建配合受控 API 响应验证四个标签、读取失败重试、草稿保留、文件类型校验、重排序结果、ASR 转写显示、保存不上传音频、空密钥不发送、保存响应丢失后手动重试复用 requestId、测试失败恢复、忙碌状态锁定、Home/End 切换。浏览器页面脚本错误为 0。
- 检查 1440px 桌面与 390px、320px 窄屏，明暗主题正常；标签可横向滚动，表单纵向滚动后可到达保存按钮，对话框无横向溢出。截图和脚本保存在本地忽略目录 `output/playwright/model-services-*`，最终浏览器结果为 `model-services-final-result.txt`。
- 自查了管理员边界、密钥与测试数据处理、事务和幂等、连接限制、取消、表单状态和文档一致性。尚未调用真实供应商、修改运行环境、执行业务数据库迁移、提交、推送或部署。管理端在线更新会自动执行迁移；用户验收可从两个新标签分别保存配置并测试开始。
