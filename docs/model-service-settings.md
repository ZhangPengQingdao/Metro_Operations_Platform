# 模型协议与语音服务设置

平台 1.9.0。在「个人中心 → 系统设置 → 大模型配置」中，聊天、知识库向量、重排序、语音识别、流式语音识别各有独立标签。表单首项为接口协议，按能力提供已适配的选项；切换协议后重新填写该服务的密钥。标签间切换保留草稿，分别测试与保存；操作期间锁定标签、侧栏和关闭动作。关闭设置或切换左侧分类不保存草稿。

| 标签 | 协议选项 | 当前作用 |
| --- | --- | --- |
| 聊天模型 | OpenAI 兼容 | 智能对话与内容生成，包含兼容该格式的方舟聊天接口 |
| 知识库向量模型 | OpenAI 兼容、火山方舟多模态向量 | 连接测试、知识索引及查询向量均使用所选协议 |
| 重排序模型 | Rerank 兼容 | 配置与示例诊断，尚未改变知识库排序 |
| 语音识别模型 | OpenAI 兼容、豆包录音文件识别 | 配置、文件或 URL 转写诊断；1.10.0 起 OpenAI 兼容文件转写可由授权应用调用 |
| 流式语音识别 | 豆包 WebSocket 流式识别 | 独立配置、按真实速率发送短音频并验证最终结果；尚未接入慧策通麦克风 |

新增协议在各能力适配器内扩展。不能仅因供应商提供 OpenAI 聊天接口，就假设其向量和语音接口也兼容。未知协议会被拒绝。没有填写 protocol 的旧向量和 ASR 配置按 OpenAI 格式读取；无需修改旧配置或迁移业务数据。

## 向量模型

OpenAI 请求为 `model/input:string/encoding_format:float`，读取 `data[0].embedding`。火山方舟请求为 `model/input:[{type:"text",text}]/encoding_format:float`，读取 `data.embedding`，参考 [方舟向量化说明](https://docs.volcengine.com/docs/ark/vectorization?lang=zh)。虽然该接口支持多模态，本次知识库仍只传结构化文本，没有新增图片或视频索引。

选择方舟协议会预填 `https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal`、`doubao-embedding-vision-251215` 和 2048 维，可按实际开通模型修改。请求地址按协议补齐路径，不会在 `/embeddings/multimodal` 后再追加 `/embeddings`。维度必须与实际输出一致；两种协议都校验有限数值和非零范数，再存储单位向量。

协议、地址、模型或维度变化会更新索引版本并自动重建。只修改相似度门槛、超时或密钥不重建。更换协议或地址时必须重新填写 Key，防止错误复用凭据；旧配置首次补写 `protocol=openai` 不改变索引版本。

## 重排序

填写完整请求地址、API Key、模型 ID 和超时。点击“测试连接”仅发送内置问题与两条示例文本，请求为 `model/query/documents/top_n`，测试 `top_n=2`。响应须包含 `results:[{index,relevance_score}]`；两个索引须为不重复的 0、1，分数为有限数值。页面按服务顺序展示示例和分数；连接成功不等于检索质量验收。协议参照 [Cohere Rerank](https://docs.cohere.com/reference/rerank)，不标记为 OpenAI。

## 录音文件语音识别

### OpenAI 兼容

填写完整 `/audio/transcriptions` 地址、Key、模型 ID、超时；可额外填写两位小写语言代码（如 `zh`），留空不发送语言提示。测试支持不超过 **2 MiB** 的 WAV、MP3、M4A、WebM、OGG 文件。平台发送 multipart `file/model/response_format=json` 与可选 language，读取 `{text:string}`。参考 [OpenAI 音频转写接口](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。扩展名允许不代表供应商接受其内部编码。

### 豆包录音文件识别

默认地址 `https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit`，模型固定 `bigmodel`。资源下拉可选 `volc.seedasr.auc`（2.0）或 `volc.bigasr.auc`（1.0）；需要豆包语音控制台中能访问该资源的 API Key，方舟 Key 不能直接代替。

该协议的测试来源是**公网 HTTPS 音频 URL**，支持 WAV、MP3、OGG；当前诊断不接受 URL 内嵌凭据、查询参数或片段。平台不为了测试而公开本地录音；音频由豆包从所填 URL 获取，平台不下载它。录音 URL 只随本次测试发送，不保存在配置里。

服务使用 JSON、`X-Api-Key`、`X-Api-Resource-Id`、新 UUID 请求编号与 `X-Api-Sequence:-1`。平台只提交一次任务，随后最多自动查询三次。仍未完成或查询失败时保留任务编号，可以点击“查询转写结果”，不会重新提交音频。关闭设置会清除本次临时任务状态；诊断应使用短样例，长期任务管理属于后续业务接入。外部提交结果未知时不自动重试。

提交地址末尾须为 `/submit`，查询路径为同源 `/query`。两条完整 URL 都要通过各自的地址检查；内网部署只批准 submit 不会同时放行 query。参考 [提交任务](https://docs.volcengine.com/docs/doubao-voice/task-submission-http-1?lang=zh)与[查询结果](https://docs.volcengine.com/docs/doubao-voice/result-query-http-1?lang=zh)。

## 流式语音识别

默认使用 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`（双向流式优化接口），选择豆包语音 WebSocket 协议、填写 Key 和对应流式资源。提供 ASR 2.0 / 1.0 的按时长、按并发四种资源 ID，默认 `volc.seedasr.sauc.duration`。它们与录音识别的 `.auc` 资源分开授权，录音转写成功不能证明流式资源可用。

本次支持公网 WSS，沿用公网地址和 DNS 检查；拒绝 WS、内网、嵌入凭据、查询参数、片段与重定向，没有引入流式内网白名单。密钥仅由平台后端加入 WebSocket 握手 Header，不发送给浏览器或应用。

测试音频为不超过 **2 MiB、30 秒、16 kHz、单声道、16 位 PCM** 的 WAV。平台校验 WAV 块与编码，剥离容器后每 200 ms 发送一段 PCM，使用豆包二进制协议和 gzip；超时需比音频时长至少多 3 秒，默认 45 秒。页面展示完成后的转写文字与识别结果次数。中间结果按完整假设替换，不逐段拼接造成重复；收到有效最终帧才成功，提前断开会报错。

帧大小、解压大小、累计响应与文本长度均有限制。断开客户端连接、取消、服务关闭或超时会终止上游 WebSocket；不自动重连或重发音频。鉴权拒绝与其他握手失败分别报错。参考 [豆包流式 ASR 协议](https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1?lang=zh)。

慧策通 2.5.0 已接入录音文件转写和会议多事项提取，使用平台 1.10.0 的 `files.transcribe`。浏览器实时识别仍由 `SpeechRecognition` 提供；平台流式会话仍未开放。后续还需完成麦克风采集/重采样、用户与组织授权、会话生命周期、断线片段恢复、稳定文本合并、附件策略及人工编辑确认，再进入现有督办提取流程。

## 管理端接口与数据边界

以下均位于 `/api/admin`，要求独立管理员会话；所有 POST 均检查同源 Origin，响应 `Cache-Control: no-store`。

| 方法与路径 | 输入 / 返回 |
| --- | --- |
| `GET /embedding` | 向量配置，始终返回 protocol；旧配置默认 openai |
| `POST /embedding/save`、`POST /embedding/test` | 向量配置、protocol、可选 apiKey；测试返回 dimensions，不保存草稿 |
| `GET /rerank`、`GET /asr`、`GET /streaming-asr` | 公开配置 endpoint/model/timeoutMs/hasApiKey/configured；语音含 protocol 和对应 resourceId |
| `POST /{kind}/save` | 配置与 UUID requestId；不接受音频或任务输入，返回公开配置 |
| `POST /rerank/test` | 配置，返回 latencyMs/results |
| `POST /asr/test` | OpenAI 加 `audio:{format,data}`（规范 Base64）；豆包加 `urlAudio:{url,format}`，两者不能混传 |
| `POST /asr/query` | 豆包配置与 UUID taskId；返回 taskId/pending，完成时另有 text |
| `POST /streaming-asr/test` | 流式配置与 `audio:{format:"wav",data}`；返回 latencyMs/text/partialCount |

测试和查询不保存配置。保存语音/重排序配置时在同一事务内写配置、管理员审计和幂等结果。三个配置键分别为 `rerank_runtime_global`、`asr_runtime_global`、`streaming-asr_runtime_global`，互不覆盖；相同 requestId、管理员和参数只返回首次结果，参数或服务类型变更返回 409。留空密钥仅在协议与地址不变时保留，密钥沿用 `AI_PROVIDER_ENCRYPTION_KEY` 加密，不回传明文或密文；审计不存录音、URL 或转写正文。

文件仅在浏览器与 API 内存中暂存，保存不会上传测试音频。普通诊断响应最多 64 KiB，转写文本最多 12000 字符；流式另限制累计响应 2 MiB。每个 API 进程最多同时接纳两个重排序/语音测试或查询，超出返回 429。取消不能保证供应商未计费；供应商留存规则由对应服务决定。

这些接口是管理员诊断，业务应用不能携管理员会话复用。公开业务音频能力需要受控附件或流式契约，不能把长音频塞入现有公开 JSON 网关。

## 部署与兼容

1.9.0 复用现有 JSON 配置与幂等记录表，没有新增数据迁移。旧配置默认原协议，管理员可在系统更新中按正常签名版本流程升级。不要更换现有加密主密钥。

OpenAI、方舟向量、Rerank 和录音 ASR 沿用完整 URL 的精确内网白名单（API 进程环境，最多 16 项，逗号分隔）：

```dotenv
MOP_EMBEDDING_ALLOWED_ENDPOINTS=http://embedding.internal:8000/v1/embeddings
MOP_RERANK_ALLOWED_ENDPOINTS=http://rerank.internal:8000/v1/rerank
MOP_ASR_ALLOWED_ENDPOINTS=http://asr.internal:8000/submit,http://asr.internal:8000/query
```

各类地址权限独立；允许 HTTP(S) 时仍禁止重定向和 URL 内嵌数据。流式 WSS 不使用这些白名单。配置模板见 `server/.env.example`。首次部署幂等表的说明仍见 1.8.0 版本记录，在线更新器会自动处理历史迁移。
