# 首次服务器安装

适用 Ubuntu 24.04 / x86_64。安装器自动准备 Docker、专用 PostgreSQL、数据库账号、迁移、管理员和更新服务；无需安装 Node.js、npm 或手工配置数据库。业务应用不预装，由管理员上传 `.mopkg` 安装。

## 1. 准备

- 至少 10 GiB 可用空间，并为镜像、数据库和备份预留增长空间。
- 可访问 GitHub 私有仓库/Release、Docker 官方源和 Docker Hub。
- 准备只读 GitHub Fine-grained token：仓库只选 `Metro_Operations_Platform`，Contents 为 Read-only，不使用服务器 SSH 密码或 GitHub 登录密码。
- 1Panel 已占用 80/443 可以继续使用；安装选择默认的「1Panel/已有反向代理」。平台只绑定本机端口，默认 18080。
- 准备平台 HTTPS 域名。

## 2. 一条命令拉取并安装（默认方式）

正式 Release 发布后执行：

```sh
(command -v git >/dev/null || (sudo apt-get update && sudo apt-get install -y git)) && git -c credential.helper= clone --depth 1 --branch v0.4.0 https://github.com/ZhangPengQingdao/Metro_Operations_Platform.git mop-install-0.4.0 && sudo bash mop-install-0.4.0/deploy/install.sh
```

Git 提示认证时输入 GitHub 用户名和只读令牌。令牌不放在命令、URL 或历史中。已有同名目录时命令停止；确认目录可信后可继续执行 `sudo bash mop-install-0.4.0/deploy/install.sh`。不要删除数据库或安装状态来重试。

## 3. 安装提示与 1Panel

1. 入口模式选择 **1**，平台本机端口使用 **18080** 或其他未占用端口。
2. 输入平台域名，不含协议和路径。
3. 在 1Panel 配置 HTTPS 反向代理，保留原始 Host：平台域名 → `http://127.0.0.1:18080`。
4. 输入管理员用户名、密码和服务器专用 GitHub 只读令牌。下载、验签、数据库创建、迁移和启动均自动完成。

1Panel 代理需能访问宿主回环地址（例如使用 host 网络的 OpenResty）；桥接容器的 `127.0.0.1` 是容器自己，不能直接照填。不要为绕过代理网络问题把数据库暴露到公网。

安装器保留 80/443 独占模式，适合没有现有反向代理的专用机器；该模式自动申请证书。两种模式都需要平台域名 HTTPS 健康检查通过才完成。

**应用的权限边界：**应用后端以 API 的子进程运行（同一容器、同一非 root 用户），没有容器级隔离，只接收平台转交的员工调用；数据库地址和密钥不传给应用。只安装经管理员审核的内部应用。安装器不接管 1Panel 的数据库、应用或容器。

## 4. 安装与应用验收

等待 `Installed: https://管理域名/#/admin`。检查：

```sh
sudo systemctl is-active mop-updater.service
sudo cat /opt/metro-platform/current.json
curl --fail --show-error https://管理域名/api/health/ready
```

管理员登录后：

1. 建立组织、工班、人员、员工账号。
2. 在“应用管理 → 安装应用”上传 `.mopkg`，查看预览后安装，在“授权”中指定应用负责人。
3. 由应用负责人在员工端配置使用人员、业务角色与数据范围。
4. 使用员工入口验证应用的主要流程和停用后的拒绝。

安装成功不自动授予员工使用或数据权限。

验收后重启服务器，复核数据库、登录、应用状态与更新服务。保管 `/opt/metro-platform/secrets` 的备份，含数据库及加密密钥。失败保留日志、安装状态、应用操作记录和数据库，不自动重放未知操作。

## 5. 后续更新

代码推送后需要发布签名 Release；管理员在「系统更新」检查、下载并确认安装，安装前停用应用。新版安装器使用更新器协议 v2；旧 v0.2.x 更新器拒绝 v2 包，需要受控更新宿主更新器，不能用首次安装器覆盖已运行站点。当前说明面向首次安装，不承诺旧部署自动开通应用托管。
