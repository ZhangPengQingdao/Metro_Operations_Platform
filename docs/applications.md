# 应用接入

待办事项独立应用的任务、人员与车站分配、周期模板及授权说明见 [待办应用说明](../applications/todos/README.md)。故障记录独立应用的首版功能、权限、旧功能对照与安装前验收点见 [故障记录应用方案](fault-records-app-plan.md)。检修管理独立应用的计划组、逐台派工、导入导出及旧功能边界见 [检修管理应用方案](maintenance-app-plan.md)。

## 当前可安装类型

管理端默认装配支持 `ui: sandbox/none`、`backend: none/isolated`、`storage: none` 的签名应用。独立后端使用平台审批的固定 Node 镜像，内存/CPU 有界，非 root、文件系统只读、网络隔离，并提供容器内 8080 健康端点。

显式开启 `managedStorage` 并配置独立存储管理连接后，隔离后端应用可声明 `storage: managed`，接通建表、迁移和追加迁移升级等生命周期。数据库前置条件、权限限制与验证范围见 [托管存储](managed-storage.md)。同一开关装配应用服务身份的 `platform.app_data.get/list/read_batch/write/transaction` 与 SDK 单行读写、同事务批量读取、游标分页查询、受控原子多行写接口；表结构与授权限制见上述文档。

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
3. 首次安装时选择“前端运行模式”：默认标准沙箱；仅管理员确认正式内部应用后选择可信应用。更新页面显示并继承现有模式，模式不是 manifest 的一部分，同一签名包可在不同环境以不同模式安装。再选择“批准此版本并安装/更新”。批准精确 manifest 摘要（含产物摘要），再次验证包与审批版本；并发修改、换包、撤销信任、未接通能力或不兼容存储变更均不能绕过。失败不自动重试，应核对状态后重新预览。
4. 安装状态、运行状态和已批准的数据权限分别查看；版本审批不自动赋予员工使用权或数据权限。员工使用范围仍在应用授权中分配。

发布者策略和版本审批保存为不可覆盖的历史版本，并在同一事务写管理员审计。撤销版本审批不卸载、不删除数据；后续安装/启用和员工入口重新检查审批。已运行后端的服务停止仍需显式停用应用，不能将撤销版本审批等同于已停止进程。

管理 API：`GET/PUT /api/admin/publisher-policy`；PUT 接受 `{revision,keys}`。`POST /api/admin/install-preview` 接收安装包；`POST /api/admin/install-approve` 接收 `{revision,digest,package}`；`POST /api/admin/install` 接收 `{package,frontendRunMode}`，其中 `frontendRunMode` 只能为 `standard` 或 `trusted`，未提供时默认为标准；`PUT /api/admin/apps/:appId/frontend-mode` 接收 `{revision,mode}` 并要求管理员权限与当前 revision。`POST /api/admin/version-approval/revoke` 接收 `{revision,digest}`。所有写操作要求管理员会话及同源 Origin。新增 `app-management-approval-expand` 迁移须显式初始化。

## 生命周期

安装、启用、停用、签名升级、状态检查与恢复经 `/api/admin` 入口执行。更新成功后保持停用，核对授权后明确启用。数据库中的 installed 不代表当前 serving。

创建请求完整收到 Docker 400 并核对容器不存在时，可记录明确拒绝并恢复到停用；超时、断连、核对失败及结果未知继续阻断，不自动重放，也不凭稍后查不到容器就清除历史。

管理员页面装载不会赋予应用员工身份或业务权限。默认 Gateway 提供 `platform.locations.get/list` 与 `platform.assets.get/list`，员工和服务使用独立授权链路，详见 [员工身份与目录接口](employee-gateway.md)。其余业务接口仍需装配，通用应用数据读写仅向服务后端开放。

员工沙箱调用自身后端的 SDK 入口为 `createAppApiClient`（从 `@metro/platform-sdk/app-sandbox` 导入），例如 `createAppApiClient(sandbox).invoke('stock-in', payload)`。API ID 必须在清单声明；宿主按已验证清单固定请求方法和路径，每次请求核验员工登录态。员工应用准入与业务授权在单进程内最多复用 30 秒；本进程通过员工账号、应用使用授权、应用业务授权、审批和应用生命周期操作后立即失效，其他进程或直接改库的变化可能延迟最多 30 秒生效。后端 handler 通过第三参数读取可信员工上下文，handler 内的 Gateway 请求自动保留原调用绑定。配置 Docker 的隔离后端可接收本应用定义且逐接口声明权限的 API；其余未装配的工具、任务、事件和外联仍拒绝。物料的实际 Docker 托管全链路尚待验收。

CLI 的直接 install 子命令需要另行配置受控管理凭据入口，默认管理端不挂载该入口；本版通过管理端上传导出的签名 JSON 包安装。

## 前端运行模式与资源域名

标准沙箱保持 `sandbox="allow-scripts"`、opaque Origin、单次 `/document/<token>` 文档和内联已校验的 `ui.js`。可信应用由平台安装记录中的 `frontendRunMode` 决定，使用 `sandbox="allow-scripts allow-same-origin"`。旧安装记录没有此字段时一律按标准沙箱处理；应用 manifest 无法声明或提升运行模式。旧契约中的 `ui.mode: trusted` 仍不属于可安装 UI 类型，签名包应声明 `ui.mode: sandbox`，是否可信只由管理员选择。应用管理的“设置”可修改模式，修改会提升安装 revision、记入历史并使员工 admission key 失效；工作台下一次状态刷新会卸载旧 retained/prewarm iframe，按新模式重新创建。服务端业务、员工、Gateway、存储、审批和审计检查不因可信模式放宽。

两种运行模式都没有 `allow-forms`。应用应由普通按钮的点击事件调用 SDK/Bridge 保存，不要依赖原生 `<form onSubmit>` 或 `type="submit"`：浏览器会在触发 `submit` 事件前阻止沙箱表单提交。涉及保存的应用应在 `sandbox="allow-scripts"` 的真实 iframe 中验证按钮事件和 Bridge 请求。

生产可信模式要求 `MOP_APP_RESOURCE_ORIGIN=https://apps.example.net`，且反向代理将 `apps.example.net` 和 `*.apps.example.net` 都转发到资源服务端口，原样保留 Host，不转发 Cookie/Authorization，不在资源域设置平台 Cookie。平台域名不得等于资源域或位于其子域下；每个 App 的稳定 Origin 为 `https://<appId>.apps.example.net`，不同 App 不共用 Origin。为 `*.apps.example.net` 配置 DNS 记录与 wildcard TLS 证书，再设 `MOP_APP_TRUSTED_ORIGINS_ENABLED=true` 开放可信模式。外部反向代理安装模式会写入该开关；内置 Caddy 的直接 HTTPS 模式没有自动获取 wildcard 证书的 DNS challenge 配置，只提供标准沙箱，不应开启该开关。切换代理或证书前先验证基础域和至少两个不同 App 子域能到达同一个资源服务，且 Host 保持原值。

可信应用的 `/document/<token>` 仍是单次、`no-store`，消费时重新校验 admission；HTML 只含主题/bootstrap 和指向 `/assets/<appId>/<sha256>/ui.js` 的脚本标签。资源服务只接受与 Host 的 App ID 一致、当前已安装且启用、审批有效的 frontend artifact，读取时核对字节数与 SHA-256；未知 hash、其他 App Host、路径或已停用版本返回 404。成功响应为 `public, max-age=31536000, immutable`。bundle 是签名安装包的静态代码，不注入员工身份、会话、权限或 bearer secret。CSP 仍禁止网络连接、worker、表单与嵌入，并只允许 nonce 脚本和同源 bundle；Bridge 精确校验该 App Origin，业务调用仍经平台 admission。

员工工作台保留最近 App 自动预热与最多两个 retained iframe。列表里其余可信应用只通过 `rel=prefetch` 预取当前 hash 的 bundle，不创建 iframe，不运行 React/bootstrap，也不读取业务数据；标准沙箱仍按需冷启动。升级改变 hash 后浏览器自然请求新 URL。浏览器可忽略资源提示；当平台和资源域不属于同一 site 时，Chromium 的 HTTP 缓存分区也可能使顶层页面的预取无法供 App iframe 复用，需用真实目标域名检查网络缓存命中。本阶段不共享 React、ReactDOM 或 SDK 前端运行时依赖。

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

React 应用可以从 `@metro/platform-sdk/ui` 引入 Button、Input、Field、FilterBar、Table、Dialog、TagDropdownPicker 等组件；从 `@metro/platform-sdk/ui-styles` 引入 `platformUiCss`，使用宿主提供的脚本 nonce 安装样式。`TagDropdownPicker` 的 `inline` 模式在表单内直接展开目标标签。组件构建自平台同一 L2 源文件，发布包只含构建产物。React / React DOM 是可选 peer 依赖；无 UI 的后端应用无需引入。

普通单选使用 `DropdownSelect`，选中项以黑底和勾选标记显示。需要在同一输入框中搜索或选择时使用 `SearchSelect`；选项可提供 `detail`，与名称同排展示。目录查询、选中值和是否允许手工输入由应用管理。

标准应用沙箱使用 `sandbox="allow-scripts"`，没有 `allow-forms`。保存操作应使用普通按钮的点击事件调用 Bridge；不要依赖原生 `<form onSubmit>` 或 `type="submit"`。涉及写入的应用需在真实标准沙箱中检查按钮是否发出请求。

沙箱应用如需由用户手动导出文件，可在签名清单的 `ui` 声明 `downloads: true`（平台 0.13.0 起支持）。安装预览展示该能力，宿主只对已批准声明的页面增加 `allow-downloads`；未声明的应用仍禁止下载。应用自行检查导出业务权限与数据范围。

常见组合优先使用 `QueryList`（查询工具栏、表格、分页）、`SidebarDialog`（分区导航弹窗）、`OrganizationPicker` 或 `OrganizationPeoplePicker`（组织及人员选择）。使用示例见 [共享查询列表](shared-list-ui.md) 和 [L2 弹窗与组织选择](shared-dialog-directory-ui.md)。

沙箱应用打开 L2 弹窗时，调用 `sandbox.invoke("platform.ui.modal", {open:true})`，关闭时传 `false`。宿主只接受当前沙箱通道的布尔状态，用于模糊侧边栏和页头并暂停其交互；应用内背景由共享 Dialog 的透明模糊遮罩处理。通道失效或应用卸载时自动恢复。此接口不传递身份、不授予业务权限，也不解除沙箱隔离。

FilterBar 的 `layout="spread"` 提供左侧常驻搜索、右侧操作按钮及表格前间距；默认布局保持不变。

表格可设置 `pinActions` 将最后一列固定在右侧，配合 `TableActionButton` 显示图标与文字。物料应用按实际功能使用默认可展开搜索和新建操作，不添加未实现的筛选或批量操作。

`platform.ui.theme` 接受空对象，返回宿主当前解析后的 `light` / `dark`，仅传递外观状态。本地沙箱首次 HTML 在原 CSP nonce 样式中注入主题，避免切页浅色闪烁。生产独立资源域仍需相应首屏主题验收。

## 应用图标与压缩安装包（0.10.0）

应用清单可提供 `icon: { "paths": ["M5 4h14v16H5z"] }`。宿主以固定 `0 0 24 24` 视口、中性主题描边绘制 SVG；最多 16 条路径，每条不超过 2048 字符。图标属于签名清单的一部分，不允许 HTML、脚本、外部图片地址或事件属性。未提供图标的旧应用继续使用默认图标。晨会交接构建从 `applications/shifts/icon.json` 将图标写入清单。

`mop-app export-upload <built-dir> <signature-file> <output.mop.gz>` 导出 gzip 压缩安装包。压缩内容仍是完整安装清单、签名及全部产物，管理端可直接上传；`.json` 导出与上传仍兼容。压缩文件和解压后内容均限制为 92MB，后端继续验证产物大小、摘要、发布者签名和已批准权限。不会解压客户端指定的文件系统路径。

此版本仍需要已信任的发布者公钥。公钥不是秘密，但从公开包内容生成私钥不能证明发布者身份；私钥始终由发布者保存。首次信任的合并确认流程尚未交付。应用运行时服务身份密钥由平台安全生成，无需应用使用者手动配置。

## 晨会交接加载诊断

工班角色需具备 `app.shifts.config` 的本工班范围；没有配置记录时应显示默认模块。应用内的托管数据调用串行执行，避免独占存储租约争用。配置继承一次读取当前组织到部门及全局的候选记录，按优先级选取；表单初始化用一个只读批量请求读取模板、个人草稿和上一班记录，组合结果超限时退回逐项读取。晨会交接对已授权员工的启动结果短时缓存，按员工、工班、表单类型和业务授权版本区分；写入配置、草稿或记录后立即失效，未知写入结果也失效。不跨请求缓存员工权限。

从晨会交接 0.0.12 起，删除台账需要单独授予 `app.shifts.delete`，且员工仍须有记录读取权限。可按本人、工班、部门、指定组织或全部范围授权；未授权时列表保留禁用的删除操作。删除需确认并通过记录 revision 比较，随后仅写入 `deleted_at`、`deleted_by` 等字段，原记录继续保留以供审计；普通列表、详情和上一班读取均排除已删除记录。已有签名或签名状态暂时无法核对的晨会记录拒绝删除。新版本包含新增 nullable 删除字段的托管存储迁移，安装审批和业务角色授权需分别完成。

读取失败与写入结果未知分开显示。模板、草稿和上一班记录有任一项读取失败时禁止提交，并提供重试入口。已有模块输入在重试时保留。超时或中断的写入仍需核对，不自动重放，未结束运行记录也不因超时自动清除。

清单中设置 `ui.clientRouting: true` 的沙箱应用可处理同一应用内的页面切换。宿主先按目标路径重新检查员工身份、安装版本与应用准入；准入版本未变时，向现有沙箱通道发送目标路径，应用通过 `sandbox.onRouteChange(listener)` 更新页面并回执。切换中原页面隐藏，回执后显示新页面；未回执时显示可重新打开的错误。安装版本、授权或账号变化仍创建新沙箱。未声明该选项的应用继续按路径加载独立页面。员工工作台最多保留同一账号最近使用的两款沙箱，重新显示前仍检查准入；访问列表移除应用、退出登录或切换账号时销毁对应沙箱。工作台显示且应用列表就绪 0.3 秒后预热上次使用的应用；没有历史记录时只预热列表第一款，避免给全部应用建立沙箱。员工应用容器的 `data-mop-admission-ms`、`data-mop-frame-ms`、`data-mop-route-ms` 和 `data-mop-reused` 可用于测量准入、iframe 加载、路由回执及复用状态，不包含应用首批业务数据读取时间。晨会交接与物料管理已启用应用内路由，前者按目标页读取或命中已授权的短时表单缓存，后者切页时重置搜索、分页和弹窗并抑制旧读取结果。

员工沙箱 frontend JS 的内容寻址缓存实验与 Chrome opaque iframe 实测结果见 [沙箱缓存实验记录](sandbox-cache-experiment.md)；当前保留原有内联 document 与 retained/prewarm 机制。
