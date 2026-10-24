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

支持 Word、Excel、PDF、ZIP 和图片，单文件不超过 50MiB，单记录最多 500 个。应用须：

1. 在 `platformAccess` 申请 `attachments.create`、`attachments.read`；
2. 提供 `authorize-attachment` 接口（可用 `@metro/platform-sdk/app-files-backend` 的 `createAppAttachmentAuthorizationHandler({authorizeUpload, authorizeRead})`），核对记录存在、员工有权，返回 `{organizationId: 记录所属组织}`。

平台每次上传和读取都重新调用该接口，并检查附件与记录的绑定；不暴露存储直链，不自动解压 ZIP。附件默认无限期保留，没有通用删除接口。

## 留证照片

`createAppImageClient`（页面）与 `createManagedAppImageStore`（接口）提供压缩、分块、关联、校验和读取：应用声明自己的 `photo-begin/part/finish/read` 接口，用 `createAppImageMigrationOperations` 声明私有表，并把 `requireReady`/`link` 与业务写入放入同一事务。原图最多 8MiB，输出 JPEG 最多 220KB，每块 11000 字节，最多 20 块。它不是跨应用的公共图片仓库。
