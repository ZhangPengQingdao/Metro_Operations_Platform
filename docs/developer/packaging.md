# 打包、安装与升级

## 应用模型 v2：单文件 .mopkg（0.26.0 起）

新应用使用 `mop-app` 生成项目并构建为一个 `.mopkg` 文件，不再需要签名、manifest 拼装或 `.mop.gz`：

```sh
npx mop-app init fire-check --name 灭火器巡检
cd fire-check && npm install
npm test
npx mop-app check
npx mop-app build        # 输出 dist/fire-check-0.1.0.mopkg
```

`.mopkg` 是普通 zip，只允许以下文件：`app.json`（必需）、`icon.svg` 或 `icon.png`（必需，二选一）、`ui.js`/`ui.css`（有页面时）、`server.js`（有接口或迁移时）、`migrations/001-名称.json` 起连续编号、`README.md`、`CHANGELOG.md`。包不超过 50MB，`ui.js` 不超过 5MB，`server.js` 不超过 20MB。字段说明见 [应用模型 v2](../app-model-v2.md) 第 7 节，项目内 `.claude/skills/metro-app/SKILL.md` 给编程 Agent 使用。

管理员在“应用管理 → 安装应用”上传 `.mopkg` 可预览名称、图标、版本变化、权限与平台能力、页面、接口、迁移和问题清单。0.26.0 只提供预览，安装运行在 0.27.0 接通；以下 v1 签名包流程在此之前继续用于现有应用。

## v1 签名包（现有应用，1.0.0 移除）

### 三类文件

SDK / CLI 的 .tgz 是 npm 工具包。应用的 .mop.gz 是管理员上传的安装包。Agent Skill 的 .tar.gz 是解压后供编程 Agent 使用的技能目录。三者不能混用。

应用源码包含业务代码、app.json 或构建配置、图标声明、测试、构建脚本及可选迁移。构建目录必须有 manifest.json 和其中声明的全部产物：前端 bundle、隔离后端 bundle、可选声明式迁移与资源。每项产物记录 id、kind、相对路径、sha256 和 bytes。

不放 node_modules、平台源码、.env、数据库、私钥、运行日志或本地容器数据。后端依赖打包进产物；Node 内置模块按运行环境使用。

### 校验与签名

```sh
mop-app validate dist
mop-app sign dist my-key /secure/private.pem signature.json
mop-app verify dist signature.json my-key my-publisher /secure/public.pem
mop-app export-upload dist signature.json my-app-1.0.0.mop.gz
```

也可用项目外层 node_modules/.bin/mop-app 执行。私钥在开发者安全环境保存；签名参数 publisherId 与清单声明一致，keyId 与管理员核实的公钥记录一致。签名证明来源和完整性，不授予权限。

压缩包内为完整安装清单、签名、产物；仍兼容旧 .install.json。压缩输入和解压后内容均有92MB上限，还受逐项产物限制。CLI 不覆盖已有输出；修改产物后重新计算摘要、校验和签名。

### 管理员与负责人

管理员核实发布者公钥、审核版本及申请能力、安装、配置平台服务授权、指定负责人并启用。负责人决定使用人员、业务角色、范围，以及哪些候选 API 对其他应用开放。安装成功不代表所有角色已获授权。

### 版本兼容

compatibility.platform 使用 minInclusive/maxExclusive 明确范围；依赖其他应用时在 compatibility.applications 声明其版本范围。新增公开文档元数据的应用包最低平台版本应为0.24.0；旧包不需要增加该字段，新平台继续接受旧包。

业务破坏性变更应升级应用版本并通知调用方。托管迁移按末尾追加，保持历史ID、顺序和产物摘要不变；目前支持建表、增加可空列和索引，不支持任意SQL。不要通过删除迁移或修改旧迁移回退。

升级涉及后端、接口或权限契约变动时，已有开放状态可能失效，需负责人重新开放。纯文档文字更新不自动授权；输入/输出结构变更会使该接口重新确认开放。
