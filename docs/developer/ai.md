# AI 平台能力

普通 AI 能力从共享接口生成，可选自定义编排。 见[统一业务接口](shared-api.md)。

应用通过平台 SDK 使用 AI，供应商密钥由平台后端持有。开发凭证只支持公共目录和开放业务查询，不提供任意模型代理，也不返回模型密钥。

## 已接通的应用能力

- 文本生成：申请 ai.complete，使用 createPlatformAiClient(gateway).complete({system,prompt})。返回 content；当前不是通用结构化输出或模型自主工具循环接口。模型未配置返回 AI_NOT_CONFIGURED。
- 应用知识库：声明 knowledgeBases，申请 knowledge.read / knowledge.write。支持授权组织内的文本条目管理、精确检索、文本或向量相似检索。索引不可用时的行为见知识库指南。
- 统一对话：在业务接口上声明 `ai: true`，平台根据说明准备参数并执行。复杂编排仍可声明 agents。业务提交仍在应用页面完成。
- 只读工具 / MCP：通过接口的 ai / tool 标记发布工具，调用本应用工具需申请 tools.read，createAppToolClient 查询和调用本应用工具；这是平台受管通道，不是任意外部 MCP 服务器接入。
- 录音转写：申请 asr.transcribe，在页面使用 useApp().files.transcribe(file, format)。还须声明带业务权限的 authorize-transcription 接口，返回 {ok:true,result:{allowed:true}}。平台核对应用和员工准入，并使用已配置的兼容文件转写服务。具体返回和格式以 SDK 类型为准。

## 配置不等于开放接口

管理端可以配置聊天、向量、重排序、录音和流式语音服务。重排序与流式语音的配置/诊断不代表已经提供通用业务 SDK；OCR、视觉理解、TTS 和可视化编排也不在本版本公开能力中。

开发时先核对平台 SDK 的实际入口、所需权限和限制。尚未配置的实例会明确报错，不自动切换到开发者自己的供应商密钥。无需把模型参数、供应商地址和管理配置下载给应用。
