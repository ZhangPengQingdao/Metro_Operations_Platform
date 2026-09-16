# 首次服务器安装：0.4.0

适用 Ubuntu 24.04 / x86_64。安装器自动准备 Docker、专用 PostgreSQL、数据库账号、迁移、管理员和更新服务；无需安装 Node.js、npm 或手工配置数据库。物料应用不预装，由管理员自己上传签名 `.install.json`。

## 1. 准备

- 至少 10 GiB 可用空间，并为镜像、数据库和备份预留增长空间。
- 可访问 GitHub 私有仓库/Release、Docker 官方源和 Docker Hub。
- 准备只读 GitHub Fine-grained token：仓库只选 `Metro_Operations_Platform`，Contents 为 Read-only，不使用服务器 SSH 密码或 GitHub 登录密码。
- 1Panel 已占用 80/443 可以继续使用；安装选择默认的「1Panel/已有反向代理」。平台只绑定本机端口，默认 18080；资源服务默认 18081。
- 准备管理端 HTTPS 域名，以及不同主机名的应用资源 HTTPS 域名。资源域名仅用于应用页面，不能承载平台登录或其他带敏感 Cookie 的站点；推荐独立注册域。不要配置父域共享平台 Cookie。

## 2. 一条命令拉取并安装（默认方式）

正式 Release 发布后执行：

```sh
(command -v git >/dev/null || (sudo apt-get update && sudo apt-get install -y git)) && git -c credential.helper= clone --depth 1 --branch v0.4.0 https://github.com/ZhangPengQingdao/Metro_Operations_Platform.git mop-install-0.4.0 && sudo bash mop-install-0.4.0/deploy/install.sh
```

Git 提示认证时输入 GitHub 用户名和只读令牌。令牌不放在命令、URL 或历史中。已有同名目录时命令停止；确认目录可信后可继续执行 `sudo bash mop-install-0.4.0/deploy/install.sh`。不要删除数据库或安装状态来重试。

## 3. 安装提示与 1Panel

1. 入口模式选择 **1**，平台本机端口使用 **18080** 或其他未占用端口。
2. 要试装物料应用，在「启用应用试装环境」输入 **y**；资源端口默认 **18081**。
3. 输入管理域名和应用资源域名，不含协议和路径。
4. 在 1Panel 配置两条 HTTPS 反向代理，保留原始 Host：
   - 管理域名 → `http://127.0.0.1:18080`
   - 资源域名 → `http://127.0.0.1:18081`
5. 输入管理员用户名、密码和服务器专用 GitHub 只读令牌。下载、验签、数据库创建、迁移和启动均自动完成。

1Panel 代理需能访问宿主回环地址（例如使用 host 网络的 OpenResty）；桥接容器的 `127.0.0.1` 是容器自己，不能直接照填。不要为绕过代理网络问题把数据库或 Docker socket 暴露到公网。

安装器保留 80/443 独占模式，适合没有现有反向代理的专用机器；该模式自动申请证书。两种模式都需要管理域名 HTTPS 健康检查通过才完成。资源域名配置后也应检查：`https://资源域名/api/health/ready` 必须返回 404，不能代理平台 API。

**应用试装的权限边界：**当前 API 持有专用数据库实例的高权限存储连接和宿主 Docker socket；应用容器本身无网络、非 root、只读运行。该交付用于受控试装，不是生产最小权限托管方案。安装器不接管 1Panel 的数据库、应用或容器，不预装物料应用。

## 4. 安装与应用验收

等待 `Installed: https://管理域名/#/admin`。检查：

```sh
sudo systemctl is-active mop-updater.service
sudo cat /opt/metro-platform/current.json
curl --fail --show-error https://管理域名/api/health/ready
```

管理员登录后：

1. 建立组织、工班、人员、员工账号。
2. 在应用管理录入经核实的发布者公钥。
3. 上传物料应用 `.install.json`，查看权限、存储和版本信息，审批安装。
4. 分配员工使用范围、角色权限、委托授权与服务授权；准备服务凭据并启用。
5. 使用员工入口验证入库、出库、查询、本人冲销、物资管理员设置和停用拒绝。

安装成功不自动授予使用或数据权限。工班长和物资管理员可管理本工班物料，成员只能纠错本人出库。测试包与发布者公钥由开发者单独交付，私钥不上传到平台。

验收后重启服务器，复核数据库、登录、应用状态与更新服务。保管 `/opt/metro-platform/secrets` 的备份，含数据库及加密密钥。失败保留日志、安装状态、应用操作记录和数据库，不自动重放未知操作。

## 5. 后续更新

代码推送后需要发布签名 Release；管理员在「系统更新」检查、下载并确认安装，安装前停用应用。新版安装器使用更新器协议 v2；旧 v0.2.x 更新器拒绝 v2 包，需要受控更新宿主更新器，不能用首次安装器覆盖已运行站点。当前说明面向首次安装，不承诺旧部署自动开通应用托管。
