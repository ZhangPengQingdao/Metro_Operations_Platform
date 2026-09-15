# 应用接入

## 当前可安装类型

管理端默认装配支持 `ui: sandbox/none`、`backend: none/isolated`、`storage: none` 的签名应用。独立后端使用平台审批的固定 Node 镜像，内存/CPU 有界，非 root、文件系统只读、网络隔离，并提供容器内 8080 健康端点。

显式开启 `managedStorage` 并配置独立存储管理连接后，隔离后端应用可声明 `storage: managed`，接通建表、迁移和同结构升级等生命周期。数据库前置条件、权限限制与验证范围见 [托管存储](managed-storage.md)。同一开关装配应用服务身份的 `platform.app_data.get/write` 与 SDK 单行读写接口；表结构与授权限制见上述文档。

SDK 导出 manifest、gateway、sandbox、backend 和 test-kit 契约。`examples/installable-app` 可构建最小签名安装样本：

```sh
node examples/installable-app/build.mjs 0.0.1
npm --prefix server run app-cli -- validate ../examples/installable-app/dist/0.0.1
```

应用包需包含 manifest、声明的产物及签名；签名与文件摘要通过后，还需平台的发布者公钥策略和该版本 manifest 的独立审批。平台不接收应用提供的宿主路径、Docker socket、镜像审批或管理员身份。签名文件只含公开签名，发布私钥由开发者保管。

平台启用安装功能需配置 `MOP_APP_MANAGEMENT_CONFIG` 为绝对路径，内容参考 `config/app-management.example.json`。审批摘要使用 `manifestApprovalDigest`，不要用不同 JSON 键序直接计算摘要。实际路径应指向 `runtime/` 或专用平台数据目录；Docker runtimeRoot 必须也能被选定 Engine 访问。

管理端上传签名 JSON 包；开发 CLI 的 `app:export-upload` 将已签名目录导出为上传文件。配置发布者策略时参考 `server/src/app-platform/developer/publisher-policy.ts` 的严格结构。

## 生命周期

安装、启用、停用、签名升级、状态检查与恢复经 `/api/admin` 入口执行。更新成功后保持停用，核对授权后明确启用。数据库中的 installed 不代表当前 serving。

创建请求完整收到 Docker 400 并核对容器不存在时，可记录明确拒绝并恢复到停用；超时、断连、核对失败及结果未知继续阻断，不自动重放，也不凭稍后查不到容器就清除历史。

管理员页面装载不会赋予应用员工身份或业务权限。默认 Gateway 提供 `platform.locations.get` 与 `platform.assets.get`，员工和服务使用独立授权链路，详见 [员工身份与目录接口](employee-gateway.md)。其余业务接口仍需装配，通用应用数据读写仅向服务后端开放。

CLI 的直接 install 子命令需要另行配置受控管理凭据入口，默认管理端不挂载该入口；本版通过管理端上传导出的签名 JSON 包安装。
