# 存储、文件与附件

## 应用数据

每个应用有自己的数据表（`migrations/` 声明），由平台在安装时创建。接口中用 `ctx.data` 读写（处理函数表写法用 `@metro/platform-sdk/app-gateway` 的 `createAppDataClient(gateway)`）。应用拿不到数据库地址或凭据，不能执行任意 SQL，只能访问本应用的表。

- `get(table, id)` 返回 `{row}`；`list(table, options)` 返回 `{rows, nextCursor}`（筛选、排序、游标、搜索、日期范围、`columns` 字段选择）。
- `readBatch([...])` 一次最多 4 项读取，可含 `{kind: 'count', ...}` 计数和 `{kind: 'daily_count', ...}` 按日计数，见 [员工工作台](../employee-dashboard.md)。
- `transaction(requestId, [...])` 一次最多 16 项写入，同一事务提交；`update`/`delete` 必须带 `expected` 旧值做并发校验。
- 单行结果最多 32KiB，单次读取结果最多 60000 字节，单项写入值最多 16KiB。

写入的 `requestId` 由页面生成（UUID）并传给接口：同一 `requestId` 重试会返回第一次提交的结果，不会重复写入。结果未知时先核对原记录，不要换一个 `requestId` 重发。

## 本地文件

`@metro/platform-sdk/app-files` 的 `readLocalFile`、`readLocalTextFile` 在页面本地读取用户选择的文件，须给 `maxBytes`（最大 50MiB），可限制 `extensions`。原文件不会上传。

```js
import {readLocalTextFile} from '@metro/platform-sdk/app-files';
const text = await readLocalTextFile(file, {maxBytes: 2_000_000, extensions: ['.csv']});
```

## Excel 解析与生成

`@metro/platform-sdk/app-spreadsheets`：`parseExcelFile` 返回首个工作表的 JSON 行，`parseExcelWorkbook` 返回全部工作表；`jsonToExcelBlob` 生成 `.xlsx`，`exportToExcel` 生成并保存。解析不等于导入：检查字段、行数和数据范围，让用户预览确认后再调用写入接口。

页面生成的任何文件用 `saveAs(blob, 文件名)`（`@metro/platform-sdk/app`）交给浏览器保存。平台目前没有公开的 Word/PDF 正文解析、Word/PDF 生成或 OCR；这些格式可以作为附件原件上传、保存和下载。

## 原件附件

页面中用 `useApp().files`：

```js
const {files} = useApp();
// intentId 在用户确认上传时生成并保存，结果未知时按原 intentId 在列表中核对。
const uploaded = await files.upload(file, {entityType: 'record', entityId, intentId});
const page = await files.list({entityType: 'record', entityId});      // {attachments, nextCursor}
await files.save(uploaded.attachmentId);                               // 或 files.download() 取 Blob
```

支持 Word、Excel、PDF、ZIP/RAR/7z/GZIP、图片和视频，单文件不超过 200MiB，单记录最多 500 个。应用须：

1. 在 `platformAccess` 申请 `attachments.create`、`attachments.read`；
2. 提供 `authorize-attachment` 接口（可用 `@metro/platform-sdk/app-files-backend` 的 `createAppAttachmentAuthorizationHandler({authorizeUpload, authorizeRead})`），核对记录存在、员工有权，返回 `{organizationId: 记录所属组织}`。

平台每次上传和读取都重新调用该接口，并检查附件与记录的绑定；不暴露存储直链，不自动解压 ZIP。附件默认无限期保留，没有通用删除接口。

## 留证照片

`createAppImageClient`（页面）与 `createManagedAppImageStore`（接口）提供压缩、分块、关联、校验和读取：应用声明自己的 `photo-begin/part/finish/read` 接口，用 `createAppImageMigrationOperations` 声明私有表，并把 `requireReady`/`link` 与业务写入放入同一事务。原图最多 8MiB，输出 JPEG 最多 220KB，每块 11000 字节，最多 20 块。它不是跨应用的公共图片仓库。


## 后端核验和 ZIP 导出（1.3.0）

应用后端可用 `createPlatformAttachmentClient(gateway).list({entityType,entityId,organizationId,availableOnly:true})` 查询当前记录的有效附件。需 `attachments.read`，由宿主绑定来源应用，返回元数据和 nextCursor，不返回存储路径。应用须先校验员工及记录业务权限。`afterId` 翻页；`availableOnly` 排除已缺失的存储对象，适用于完成前核验。

页面用 `files.saveArchive({fileName,batch,records:[{entityType,entityId,fileName}]})` 打包。单条 batch=false，批量 batch=true 时各记录单独成 ZIP，再组成外层 ZIP。必须在 `authorize-attachment` 显式处理 action=export，或为 SDK 授权工厂提供 authorizeExport；缺失此授权时拒绝，不默认沿用 read。V2 回调可声明具体权限，也可使用由应用内核验的业务入口。

平台按记录和文件逐次复核授权，最多 100 条记录、1000 个文件、ZIP 总长 2 GiB，文件缺失或读取失败不能算成功。ZIP 采用存储模式保持原件字节，不解压用户压缩包。浏览器支持文件系统保存 API 时流式落盘，否则有界 Blob 回退最多 256 MiB。

原件上传经过平台流式存储及 200 MiB 上限，格式基础特征校验不等同正文解析。实际支持扩展名以 SDK 的 APP_ATTACHMENT_EXTENSIONS 为准。图片／视频不转码。
