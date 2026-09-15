# Ubuntu 安装与平台在线更新（0.2.1）

## 首版范围

目标：专用 Ubuntu 24.04 LTS / x86_64，至少 10 GiB 可用磁盘，能够访问 Docker 官方软件源、Docker Hub、GitHub API 和私有 Release 工件。管理域名应已解析到服务器，80/443 可用并允许证书签发。数据库只在 Docker 私有网络中开放，不映射服务器端口。

部署包含 PostgreSQL 17、普通权限 API、Caddy HTTPS 前端及宿主 systemd 更新器。安装器自动安装缺少的 Docker 官方软件源依赖，发现其他容器运行时冲突时停止，不卸载或覆盖其他服务。

**此部署默认不启用应用托管**：生产资源域、应用 Docker 宿主及高权限存储代理仍需单独验收。平台基础数据、管理员、模型配置、员工后端及平台更新可使用；不提供生产应用宿主的完成承诺。

## 发行准备（仓库维护者）

1. 在安全环境生成 Ed25519 发行密钥，私钥只进入 GitHub Actions 的 `MOP_RELEASE_SIGNING_KEY` Secret，公钥通过可信渠道交付给服务器管理员。不得提交私钥。首次安装器本身须来自可信、核对过 commit 的仓库副本。
2. 配置 GitHub Environment `production-release` 的发布审批策略；为该环境或仓库提供上述 Secret。未配置签名密钥时流水线直接失败。
3. 合并代码、统一版本与 CHANGELOG 后，在 **main** 执行 `Build signed Linux release` 工作流。它先等待平台检查和 Linux 镜像验收，通过后构建三个固定镜像并生成 `release.json`、Ed25519 签名和 `images.tar`，再创建草稿 `v版本号` Release。
4. 审核草稿的版本、更新说明和测试结果后发布。已发布的版本资产不得替换；有修复必须升版。建议启用 GitHub immutable releases。

镜像基础版本固定在 `deploy/images.json` 和 Dockerfile 的 digest 中。网页普通升级要求 PostgreSQL 镜像 ID 与现版一致；升级数据库镜像必须执行单独审核流程。清单包含源 commit、架构、最低更新器协议及最低可升级版本。目前只接受由该安装器部署的 0.2.0 及以后版本，不能直接接管旧开发目录。

## 一键安装

首次部署人员可按 [首次服务器安装步骤](server-first-install.md) 准备域名、只读令牌和部署包。

默认按 [一条命令拉取并安装](server-first-install.md#2-一条命令拉取并安装默认方式) 操作。Git 拉取正式标签后直接调用仓库内安装器，无需人工上传 Release。

已有可信仓库副本时，也可运行：

```sh
sudo bash deploy/install.sh
```

版本和公钥默认从可信仓库或发行安装器包中读取；按提示输入域名、首位管理员用户名/密码和 GitHub 只读令牌。可用 `--version`、`--public-key` 显式指定；旧安装包缺少这些元数据时仍交互询问。令牌仅需该私有仓库的 Contents: Read 权限，本方案使用 Release 资产，不需要 GHCR 登录。

安装器依次验证系统和端口、下载验签、检查镜像摘要、创建独立数据库/API 角色、执行迁移、创建首位管理员、启动 API/HTTPS 前端和更新服务。不会在服务器安装 npm 开发依赖或编译源码。

重复执行同一已完成版本会保留配置和数据并直接返回；部分首次安装可使用原版本、公钥和已保存配置继续，检测到管理员冲突或非本安装器数据库时停止。不要把安装器当升级脚本，也不要删除 installation.json 或数据库目录来重试。

密钥仅交互输入，保存在受限文件；完成后移除初始化管理员密码。请妥善备份 `/opt/metro-platform/secrets`，否则无法恢复已有加密模型配置。

## 管理端更新

进入 **系统更新**：检查更新 → 查看 Release 说明 → 下载更新 → 确认备份并安装。只有已签名、架构和版本兼容的正式 Release 会被安装；网页不接收任意 URL、路径、SQL 或命令。

当前独立管理员均具有 `platform.system.update` 权限，仍不与员工角色混用；员工不能进入该入口。请求先写管理员审计，再提交更新器；更新器另保留持久任务和阶段审计。下载和安装分别需要管理员操作，没有自动安装计时器。

安装升级前须停用业务应用并排空工作；未确认的应用存储写入、运行工作、迁移或租约会阻断。升级期间网页可能断连，恢复服务后重新读取任务；不要因超时重复提交。更新器在宿主运行，不随 API 容器退出。

## 文件与权限

- `/opt/metro-platform/releases/<版本>/`：验签清单、镜像归档与平台生成的 Compose 配置。
- `/opt/metro-platform/database/`：数据库持久数据。
- `/opt/metro-platform/secrets/`：数据库密码、API 配置、GitHub 只读令牌。
- `/opt/metro-platform/backups/<任务ID>/`：数据库 custom dump、角色/ACL SQL、配置密钥归档及完成标记。目录仅 root 可读；需要异地加密备份与恢复演练。
- `/opt/metro-platform/task.json`、`requests/`、`audit.jsonl`：当前任务、每个请求的终态/阶段、原始审计；不自动删改历史来恢复。
- `/run/mop-updater/control.sock`：root 与受控 API 附加组可访问的本机 socket；API 无 Docker socket、sudo 或 root 权限。

更新器是有权管理该平台容器的宿主服务，必须保护其脚本、配置、公钥和 socket。Compose secrets 为文件挂载权限保护，不是宿主磁盘加密。

## 失败恢复

只读查看不需要停止更新器：

```sh
sudo python3 /opt/metro-platform/updater/updater.py status
sudo journalctl -u mop-updater.service
```

更新器进程中断时，将原任务标记为 recovery_required，不自动重新执行。需要恢复时先停止更新器，核对精确任务 ID、失败阶段、版本与备份。以下命令是显式恢复决策，不可作为循环重试脚本：

```sh
sudo systemctl stop mop-updater
# 仅在数据库迁移尚未开始时，恢复旧平台服务：
sudo python3 /opt/metro-platform/updater/updater.py recover --task-id TASK_UUID --mode restart-current
# 已有完整备份且迁移/切换中断时，继续同一签名目标版本：
sudo python3 /opt/metro-platform/updater/updater.py recover --task-id TASK_UUID --mode resume-target
sudo systemctl start mop-updater
```

resume-target 使用平台迁移账本与原子数据库迁移，只执行尚未提交的迁移，并再次核对未完成应用工作。无法验证时继续阻断；不会恢复数据库备份或回退已迁移结构。恢复失败会保留原任务及恢复记录。数据库手工还原、主版本升级、磁盘损坏和跨服务器灾难恢复必须按另行审核的恢复流程执行。

主机更新器协议暂固定为 v1；本版网页不自动更新宿主 Python 更新器。未来需要协议升级的包会因 minUpdater 不匹配而拒绝，需要人工更新受信安装器后再继续。

## 验证与限制

本地测试覆盖签名、下载重定向、版本范围、任务恢复、失败状态、管理员授权和审计。Linux CI 构建实际最终镜像，以独立 PostgreSQL 验证两次迁移、首次管理员、重复创建拒绝、非 root API 登录及前端镜像启动。CI 不等于目标服务器的 systemd、真实 DNS、TLS、实际磁盘和恢复演练验收。

发布密钥 Secret、正式 Release 和真实目标服务器不是源码可自动产生的外部验收结果；完成对应配置和发布前，安装器不会伪造可下载版本。

参考：[Docker Ubuntu 官方安装](https://docs.docker.com/engine/install/ubuntu/)、[GitHub Release 完整性](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)。
