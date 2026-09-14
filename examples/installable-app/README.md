# 应用安装验收示例

这是独立安装包示例，不是平台预览页。无员工数据、无隐式授权。构建得到真实 manifest 与脚本产物：

```sh
node examples/installable-app/build.mjs 1.0.0
node examples/installable-app/build.mjs 1.1.0
node examples/installable-app/build.mjs 1.0.0 --backend
```

第三条包含独立 Node 健康服务（128MiB 限额、无网络），用于验证确实创建容器；普通版本只有沙箱前端，不创建容器。产物在本目录 `dist/` 下。

使用 L4 CLI 的签名功能和 `encodeInstallPackage` 生成签名 JSON 上传包，平台另行配置发布者公钥及完整 manifest 摘要审批。私钥、宿主路径和审批配置不进入包或仓库。参见 [管理端安装装配](../../docs/applications.md)。

验证路径：安装 1.0.0 → 打开页面并操作按钮 → 停用 → 启用 → 上传 1.1.0 更新包 → 确认停用 → 显式启用 → 页面显示新版本。重复安装请求只查询历史结果，不重放启动。

签名完成后导出管理端上传文件：

```sh
npm --prefix server run app:export-upload -- /absolute/package-dir /absolute/signature.json /absolute/upload.json
```

输出文件包含固定 requestId，遇到未知安装结果保留原文件用于核对，不重新生成请求号后反复上传。命令不会覆盖已有文件。
