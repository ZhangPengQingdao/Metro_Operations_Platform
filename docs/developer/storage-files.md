# 存储、文件与附件

## 托管数据

createAppDataClient 位于 @metro/platform-sdk/app-gateway。需要隔离后端、storage.mode=managed、声明式迁移，以及 service/all 模式的 platform.app_data.read/write 授权。管理员还需为当前实例启用托管存储。SDK 不返回数据库凭据，不执行任意SQL，只能访问本应用表。

get 返回 {row}，list 返回 {rows,nextCursor}；readBatch 返回 {results}。单项写入返回 {row}，transaction 返回 {results}。readBatch 最多4项；transaction 最多16项；单行结果最多32KiB，总读取结果最多60000字节。单项 values 最多16KiB。ID和写入 requestId 使用 UUID；列表筛选与游标类型见 SDK 的 AppDataListOptions。

并发修改使用 transaction 的 expected 条件进行乐观校验。多个角色授权组织与本人资源先组成 anyOf 过滤，再分页。未知提交结果先核对原记录；存储不是业务权限的替代品。

## 本地文件

@metro/platform-sdk/app-files 提供 readSandboxFile、readSandboxTextFile、downloadSandboxFile。读取须给 maxBytes，可限制 extensions；最大50MiB。Excel 可使用下面的公开解析工具，CSV 的分隔符和字段规则由应用处理；预览、校验后只提交用户确认的业务数据。原文件默认不上传。

```js
import {readSandboxTextFile} from '@metro/platform-sdk/app-files';
const text = await readSandboxTextFile(file,{maxBytes:2000000,extensions:['.csv']});
```

## Excel 解析、生成与下载

@metro/platform-sdk/app-spreadsheets 复用平台的表格工具，随 SDK 打包，无需导入平台源码。parseExcelFile 返回首个工作表的 JSON 行；parseExcelWorkbook 返回全部工作表的网格、字段和 JSON 行。解析不等于导入：应用仍需检查字段、行数、数据范围，并让用户预览确认后调用业务写入 API。工具在本地执行，不保存原件，也不执行宏或公式计算。

```js
import {readSandboxFile, downloadSandboxFile} from '@metro/platform-sdk/app-files';
import {parseExcelFile, parseExcelWorkbook, jsonToExcelBlob, exportToExcel} from '@metro/platform-sdk/app-spreadsheets';

// 限制输入体积后解析；业务还应约束行列数量，避免阻塞浏览器。
const bytes = await readSandboxFile(file, {maxBytes: 5 * 1024 * 1024, extensions: ['.xlsx', '.xls']});
const rows = await parseExcelFile(new Blob([bytes]));
const workbook = await parseExcelWorkbook(new Blob([bytes]), file.name);
// 在 UI 中展示 rows 或 workbook，校验字段和数据范围，经确认后写入。

const blob = jsonToExcelBlob({data: [{title: '示例记录'}], sheetName: '记录', columns: [{key: 'title', header: '标题', width: 24}]});
downloadSandboxFile('records.xlsx', blob, blob.type);
// 或直接生成并下载：
exportToExcel({data: rows, filename: 'records.xlsx'});
```

下载需在签名清单声明 ui.downloads:true，内容≤50MiB。jsonToExcelBlob 只生成 Blob；可把 Blob 组成 File，再使用原件附件客户端存入有权限的业务记录。上传存放不会自动解析。平台目前没有公开的通用 Word/PDF 正文解析、Word/PDF 文件生成或 OCR SDK；这些格式作为附件原件上传、保存与下载已支持。界面组件中的导出按钮回调不代表相应生成服务已经开放。

## 原件附件

createSandboxAttachmentClient(sandbox) 提供 upload(file,{entityType,entityId,intentId})、list({entityType,entityId})、read(attachmentId) 和 download(attachmentId)。支持 Word、Excel、PDF、ZIP，单文件≤50MiB，单记录≤500个；list 返回 nextCursor，下一页将该值作为 afterId 传入。下载须声明 ui.downloads:true。

```js
import {createSandboxAttachmentClient} from '@metro/platform-sdk/app-files';
const attachments = createSandboxAttachmentClient(sandbox);
// intentId 在用户确认上传时生成并保存，结果未知时按原 intentId 核对列表。
const uploaded = await attachments.upload(file, {entityType: 'record', entityId, intentId});
const page = await attachments.list({entityType: 'record', entityId});
const {blob, fileName} = await attachments.read(uploaded.attachmentId);
await attachments.download(uploaded.attachmentId);
```

应用后端声明固定 authorize-attachment API，permission 与 businessPermission 指向应用定义的业务权限。用 @metro/platform-sdk/app-files-backend 的 createAppAttachmentAuthorizationHandler({authorizeUpload,authorizeRead}) 核对记录、组织与员工业务权限。请求并获得 platform.attachments.create/read 服务授权。

文件通过宿主二进制通道，不经64KiB JSON Bridge；不暴露存储直链，不自动解压 ZIP。intentId 在首次上传前保存；结果未知时列表核对原记录，不能自动重传。附件目前私有，默认无限期保留，没有通用删除SDK。

## 留证照片

createSandboxImageClient 与 createManagedAppImageStore 提供压缩、分块、关联、校验和读取；应用声明自己的 begin/part/finish/read API，后端提供 authorizeWrite、resolveRead 回调。通过 createAppImageMigrationOperations 声明私有表，将 requireReady/link 与业务写入放入同一事务。原图最多8MiB，输出JPEG最多220KB，每块11000字节，最多20块。它不是跨应用公共图片仓库。
