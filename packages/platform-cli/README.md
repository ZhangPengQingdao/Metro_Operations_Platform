# @metro/platform-cli

Node.js 22+。独立安装后使用 `mop-app`，不需要平台仓库、数据库、管理员凭据或旧 AFC 源码。

```sh
npm install --save-dev @metro/platform-cli
npx mop-app create my-app my-app sandbox my-publisher
# 在生成项目中安装同版本 SDK、执行 npm test 和 npm run build 后：
npx mop-app validate dist/sandbox
npx mop-app sign dist/sandbox publisher-key /secure/private.pem signature.json
npx mop-app verify dist/sandbox signature.json publisher-key publisher /secure/public.pem
npx mop-app export-upload dist/sandbox signature.json inventory-install.json
```

SDK 提供应用开发契约和运行时客户端；CLI 校验、签名并导出管理员上传的安装包。开发者私钥留在开发环境，管理员只接收上传包并独立核实发布者公钥。当前上传包为有界签名 JSON，并非 ZIP；不要靠修改扩展名转换格式。

导出不自动执行构建、不安装应用、不调用平台、不覆盖已有文件；平台安装时重新校验签名和摘要。`pack <built-dir> <new-dir>` 可复制已声明产物到干净目录。CLI 与 SDK 可以通过平台提供的 npm `.tgz` 安装，尚未发布到公共 npm 时不要假定上述包名可以在线下载。

`create <new-dir> <app-id> <trusted|sandbox|backend> <publisher-id>` 内置模板，生成项目后需安装 SDK 和构建依赖。模板演示 SDK 调用，不表示平台默认支持示例声明的自定义操作或 trusted UI；安装时仍按平台能力和授权拒绝未接通声明。
