# 应用接入

## 当前可安装类型

管理端默认装配支持 `ui: sandbox/none`、`backend: none/isolated`、`storage: none` 的签名应用。独立后端使用平台审批的固定 Node 镜像，内存/CPU 有界，非 root、文件系统只读、网络隔离，并提供容器内 8080 健康端点。

显式开启 `managedStorage` 并配置独立存储管理连接后，隔离后端应用可声明 `storage: managed`，接通建表、迁移和追加迁移升级等生命周期。数据库前置条件、权限限制与验证范围见 [托管存储](managed-storage.md)。同一开关装配应用服务身份的 `platform.app_data.get/list/write/transaction` 与 SDK 单行读写、游标分页查询、受控原子多行写接口；表结构与授权限制见上述文档。

SDK 导出 manifest、gateway、sandbox、backend 和 test-kit 契约。`examples/installable-app` 可构建最小签名安装样本：

```sh
node examples/installable-app/build.mjs 0.0.1
npm --prefix server run app-cli -- validate ../examples/installable-app/dist/0.0.1
```

应用包需包含 manifest、声明的产物及签名；签名与文件摘要通过后，还需平台的发布者公钥策略和该版本 manifest 的独立审批。平台不接收应用提供的宿主路径、Docker socket、镜像审批或管理员身份。签名文件只含公开签名，发布私钥由开发者保管。

平台启用安装功能需配置 `MOP_APP_MANAGEMENT_CONFIG` 为绝对路径，内容参考 `config/app-management.example.json`。审批摘要由平台对已验证的安装包计算，管理员无需手算。实际路径应指向 `runtime/` 或专用平台数据目录；Docker runtimeRoot 必须也能被选定 Engine 访问。

管理端上传签名 JSON 包；独立 CLI 的 `mop-app export-upload` 将已签名目录导出为上传文件（仓库内部保留 `app:export-upload` 命令）。首次启动将配置中的发布者公钥策略与批准摘要导入数据库，后续以数据库为准；配置文件只负责运行目录、Docker 和存储开关等装配。再次启动不会用旧文件覆盖已撤销的信任。首次导入可使用空 keys 和空批准列表，管理员随后通过网页录入可信 Ed25519 公钥、发布者/密钥 ID、允许的应用 ID 和有效期。

## 管理端安装审批

1. 在“应用管理 → 审核与发布 → 已登记密钥”录入经过独立核实的发布者公钥；安装包不能自行提供可信根，私钥禁止录入。同一发布者/密钥 ID 的公钥材料不可替换或删除，只能撤销；轮换公钥须使用新的密钥 ID。
2. 上传包并选择“校验并预览”。平台核对签名和全部产物摘要，展示应用/版本/发布者、申请及自定义权限、运行方式、存储、新增迁移、权限变化、扩展及外联声明。
3. 选择“批准此版本并安装/更新”。批准精确 manifest 摘要（含产物摘要），再次验证包与审批版本；并发修改、换包、撤销信任、未接通能力或不兼容存储变更均不能绕过。失败不自动重试，应核对状态后重新预览。
4. 安装状态、运行状态和已批准的数据权限分别查看；版本审批不自动赋予员工使用权或数据权限。员工使用范围仍在应用授权中分配。

发布者策略和版本审批保存为不可覆盖的历史版本，并在同一事务写管理员审计。撤销版本审批不卸载、不删除数据；后续安装/启用和员工入口重新检查审批。已运行后端的服务停止仍需显式停用应用，不能将撤销版本审批等同于已停止进程。

管理 API：`GET/PUT /api/admin/publisher-policy`；PUT 接受 `{revision,keys}`。`POST /api/admin/install-preview` 接收安装包；`POST /api/admin/install-approve` 接收 `{revision,digest,package}`；`POST /api/admin/version-approval/revoke` 接收 `{revision,digest}`。所有写操作要求管理员会话及同源 Origin。新增 `app-management-approval-expand` 迁移须显式初始化。

## 生命周期

安装、启用、停用、签名升级、状态检查与恢复经 `/api/admin` 入口执行。更新成功后保持停用，核对授权后明确启用。数据库中的 installed 不代表当前 serving。

创建请求完整收到 Docker 400 并核对容器不存在时，可记录明确拒绝并恢复到停用；超时、断连、核对失败及结果未知继续阻断，不自动重放，也不凭稍后查不到容器就清除历史。

管理员页面装载不会赋予应用员工身份或业务权限。默认 Gateway 提供 `platform.locations.get/list` 与 `platform.assets.get/list`，员工和服务使用独立授权链路，详见 [员工身份与目录接口](employee-gateway.md)。其余业务接口仍需装配，通用应用数据读写仅向服务后端开放。

员工沙箱调用自身后端的 SDK 入口为 `createAppApiClient`（从 `@metro/platform-sdk/app-sandbox` 导入），例如 `createAppApiClient(sandbox).invoke('stock-in', payload)`。API ID 必须在清单声明；宿主按已验证清单固定请求方法和路径，平台验证实时员工身份、应用使用授权与业务权限。后端 handler 通过第三参数读取可信员工上下文，handler 内的 Gateway 请求自动保留原调用绑定。配置 Docker 的隔离后端可接收本应用定义且逐接口声明权限的 API；其余未装配的工具、任务、事件、外联和 trusted UI 仍拒绝。物料的实际 Docker 托管全链路尚待验收。

CLI 的直接 install 子命令需要另行配置受控管理凭据入口，默认管理端不挂载该入口；本版通过管理端上传导出的签名 JSON 包安装。

## 独立开发工具

开发者使用公开的 `@metro/platform-sdk` 和 `@metro/platform-cli`。SDK 提供应用客户端与契约，CLI 负责创建项目、校验、签名和导出，不要求克隆平台或安装平台后端。

发行工作流会附带 `metro-platform-sdk-<版本>.tgz` 和 `metro-platform-cli-<版本>.tgz`；这两个是 npm 工具分发包，不是管理员上传的应用包。当前工作分支尚未发布这些 Release 资产，也未发布到公共 npm。取得同一正式版本的两个文件后：

```sh
mkdir my-app-workspace
cd my-app-workspace
npm init -y
npm install --save-dev /downloads/metro-platform-cli-<版本>.tgz
npx mop-app create my-app my-app sandbox my-publisher
cd my-app
npm install /downloads/metro-platform-sdk-<版本>.tgz
npm test
npm run build
npx mop-app validate dist/sandbox
npx mop-app sign dist/sandbox publisher-key /secure/private.pem signature.json
npx mop-app verify dist/sandbox signature.json publisher-key my-publisher /secure/public.pem
npx mop-app export-upload dist/sandbox signature.json my-app-install.json
```

`<版本>` 和路径需替换为实际文件。CLI 创建新目录，不覆盖已有项目；签名和导出也拒绝覆盖。私钥仅留开发端，不放进应用或工具分发包。管理员接收最后的 `my-app-install.json`，通过网页验签预览、批准和安装。

脚手架是 SDK 调用示例，`sandbox` 示例的 greeting 操作仍需应用作者替换为已支持的平台操作；`trusted` UI 仍拒绝，backend 示例必须满足隔离运行配置与本应用定义权限约束，不能把生成/构建成功当成默认可安装或真实业务验收。物料应用另行完成业务规则与接入验收。


## 物料试装与员工权限（0.3.0）

上传格式为签名 `.install.json`。应用自定义权限由管理员在「应用授权 → 员工角色与应用权限」选择已安装清单中的权限注册并授予角色，不能向清单外的系统权限扩权。员工角色变更保留管理员审计及旧分配记录；变更影响该员工所有应用。安装、使用授权、角色权限、应用委托授权和服务授权分别配置，不自动授予。

物料：工班长角色授予 read/outbound/manage，检修工角色授予 read/outbound；三个完整权限码为 `app.materials.read`、`app.materials.outbound`、`app.materials.manage`。应用委托授权分别授予这三个权限。当前自定义 API 不支持通用资源范围推断，使用完整操作授权；物料代码强制可信员工组织隔离，出库纠错还强制本人。

服务身份单独授予 `platform.app_data.read`、`platform.app_data.write`、`platform.people.read`（范围全部，应用只访问自己的数据及所需工班成员）。批准服务授权时由平台自动准备缺失身份，凭据不返回浏览器。停用后重新启用时，若内存凭据丢失，平台在独占运行锁及未完成调用检查后自动换发凭据，保留身份与原授权，不补回已撤销权限。委任物资管理员在物料应用内部「设置」完成，仅工班长可用；不改变平台员工角色。

## 公开 L2 界面组件（0.5.0）

React 应用可以从 `@metro/platform-sdk/ui` 引入 Button、Input、Field、FilterBar、Table、Dialog 等组件；从 `@metro/platform-sdk/ui-styles` 引入 `platformUiCss`，使用宿主提供的脚本 nonce 安装样式。组件构建自平台同一 L2 源文件，发布包只含构建产物。React / React DOM 是可选 peer 依赖；无 UI 的后端应用无需引入。

沙箱应用打开 L2 弹窗时，调用 `sandbox.invoke("platform.ui.modal", {open:true})`，关闭时传 `false`。宿主只接受当前沙箱通道的布尔状态，用于模糊侧边栏和页头并暂停其交互；应用内背景由共享 Dialog 的透明模糊遮罩处理。通道失效或应用卸载时自动恢复。此接口不传递身份、不授予业务权限，也不解除沙箱隔离。

FilterBar 的 `layout="spread"` 提供左侧常驻搜索、右侧操作按钮及表格前间距；默认布局保持不变。

表格可设置 `pinActions` 将最后一列固定在右侧，配合 `TableActionButton` 显示图标与文字。物料应用按实际功能使用默认可展开搜索和新建操作，不添加未实现的筛选或批量操作。

`platform.ui.theme` 接受空对象，返回宿主当前解析后的 `light` / `dark`，仅传递外观状态。本地沙箱首次 HTML 在原 CSP nonce 样式中注入主题，避免切页浅色闪烁。生产独立资源域仍需相应首屏主题验收。
