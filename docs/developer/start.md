# 开始开发

目标：在独立目录中，用公开 SDK 构建一个员工应用，交给管理员安装。应用无需克隆平台源码、持有平台数据库密码或管理员账号。

## 准备工具

要求 Node.js 22+、npm。管理员从开发者中心下载同一平台版本的 SDK、CLI 和标准应用示例。当前不要假设包已发布到公共 npm；使用下载的 .tgz 文件。

```sh
mkdir my-workspace
cd my-workspace
npm init -y
npm install --save-dev /downloads/metro-platform-cli-<版本>.tgz
npx mop-app create my-app my-app standard my-publisher
cd my-app
npm install /downloads/metro-platform-sdk-<版本>.tgz
npm test
npm run build
../node_modules/.bin/mop-app validate dist
```

standard 模板包含 React 沙箱界面、Node 隔离后端、公开目录 SDK、共享 QueryList、业务权限、宿主路由和健康检查。列表演示读取当前员工工班人员，无写入、无托管数据迁移。构建输出为 dist/manifest.json、ui.js 和 entry.cjs。也可解压标准应用示例，修改 app.json 中 id、name、publisherId 后构建。

旧 sandbox/trusted/backend 模板保留作协议示例；它们包含 sample.* 演示权限，不能直接作为生产业务脚手架。管理员选择的“可信应用”是 sandbox 应用的部署运行模式，与旧 ui.mode=trusted 声明不同。

## 安装与首次使用

开发者用自己的发布者 Ed25519 私钥签名并导出 .mop.gz；详见“打包与升级”。管理员核实公钥、审核签名版本、安装并授予 platform.people.read 服务能力，指定应用负责人，然后启用应用。负责人配置人员范围、角色并给员工分配 app.<应用ID>.read 权限。应用负责人身份本身不授予业务权限。

隔离后端需要平台管理员配置并批准运行镜像及运行环境。权限被拒绝、运行环境未配置和业务数据为空是不同状态。构建成功不能证明目标实例可以安装或所有员工可以使用。

## 开发边界

应用界面通过 SDK Bridge 调用本应用后端；后端经平台 Gateway 访问公共能力。宿主负责员工登录、注册、应用准入、导航、主题；应用负责业务校验、资源归属和数据范围。不要从请求体读取“当前员工ID”，不要让 Agent 索取管理员 Cookie、平台数据库地址或服务密钥。

开发者中心“平台 SDK”是当前版本的公开操作参考；“应用开放接口”是当前实例已安装且由负责人开放的目录。下载的目录只是时间点快照，运行时仍重新授权。
