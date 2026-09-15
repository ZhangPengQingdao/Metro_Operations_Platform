# 首次服务器安装：0.2.0

本页供安装操作人员使用。平台自动创建 PostgreSQL 数据库和首位管理员；无需自行安装 Node.js、npm 或 PostgreSQL。

## 1. 准备服务器与下载凭据

- 专用 Ubuntu 24.04 / x86_64；至少 10 GiB 可用磁盘，并为数据库、发行镜像和升级备份预留增长空间。
- 一个管理域名，A 记录指向服务器公网 IPv4；若设置 AAAA，也必须正确指向本机。放行 TCP 80/443，保留 SSH 登录通道。
- 服务器能访问 GitHub API、私有 Release、Docker 官方软件源、Docker Hub 和证书签发服务。
- 80/443 没有其他网站占用。本版不接管其他项目的容器和数据库。

在 [GitHub Fine-grained token 创建页](https://github.com/settings/personal-access-tokens/new) 创建服务器专用令牌：

1. Resource owner：`ZhangPengQingdao`。
2. Repository access：**Only select repositories**，只选择 `Metro_Operations_Platform`。
3. Repository permissions：**Contents → Read-only**；Metadata 默认只读即可，不授予写权限。
4. 设置适合维护周期的有效期并记录到期日。复制令牌后直接在服务器安装器的隐藏输入提示中使用。

令牌到期后需要更换服务器上的凭据，在线更新才能继续。不要上传开发机 GitHub 登录凭据或发行私钥。权限依据：[GitHub Release 资产 API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)。

## 2. 上传并校验部署包

将交付的 `mop-install-0.2.0.tar.gz` 上传到服务器用户的主目录。以普通用户或 root 登录服务器，执行：

```sh
tar -xzf mop-install-0.2.0.tar.gz
cd mop-install-0.2.0
sha256sum -c SHA256SUMS
realpath release-public.pem
```

全部文件校验通过后，记下最后一条命令输出的公钥绝对路径。校验清单保护传输完整性；部署包及公钥应来自本次可信交付，不能用未知来源的文件替换。

## 3. 执行安装

```sh
sudo bash deploy/install.sh
```

依次输入：

| 提示 | 输入 |
| --- | --- |
| 安装版本 | `0.2.0` |
| 可信公钥文件 | 上一步 `realpath` 输出的绝对路径 |
| 管理端域名 | 例如 `ops.example.com`，不带 `https://` 或路径 |
| 首位管理员用户名 | 3–64 位，字母/数字开头，可包含 `_ . -` |
| 管理员密码 | 至少 12 字符，UTF-8 最多 72 字节；按提示确认 |
| GitHub 私有仓库只读令牌 | 第 1 节创建的令牌 |

安装器将下载签名镜像、创建独立数据库、执行迁移并申请 HTTPS 证书。密码和令牌输入不回显；等待出现 `Installed: https://你的域名/#/admin`。

## 4. 安装验收

```sh
sudo systemctl is-active mop-updater.service
sudo cat /opt/metro-platform/current.json
# 将域名替换为实际管理域名：
curl --fail --show-error https://ops.example.com/api/health/ready
```

应分别得到 `active`、版本 `0.2.0` 和成功的健康响应。浏览器访问 `https://你的域名/#/admin`，用刚创建的管理员登录，检查基础数据页面及“系统更新”。首次检查更新应显示已是最新版本。

验收完后重启服务器，再确认以上服务与登录正常。备份 `/opt/metro-platform/secrets`，并妥善保管备份，里面包含数据库及加密配置所需密钥。

如果安装停止，先保留 `/opt/metro-platform` 和现有数据库，核对域名、端口、网络及日志。不要删除状态记录重试。使用同一版本、公钥重跑安装器可以继续受支持的首次安装阶段；发生管理员或数据库冲突时停止人工核对。升级中断另按 [安装与恢复说明](linux-installation.md#失败恢复) 处理。

## 5. 后续更新

开发者提交到 GitHub 后，还需通过检查、构建并发布新的签名 Release；单纯推送代码不会让服务器安装未经发行的代码。

管理员网页操作：**系统更新 → 检查更新 → 下载更新 → 确认安装**。安装前自动预检和备份，迁移后健康检查。更新期间页面可能短暂断开，恢复后查看原任务结果。

本版默认关闭生产应用托管；生产应用资源域、真实业务应用和服务器完整恢复演练不包含在这次基础平台安装完成声明中。
