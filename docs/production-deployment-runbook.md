# 现有站点发布与更新记录

本页记录已实际使用过的发布路径，供后续部署时先核对。目标信息最后核对于 2026-09-24；服务器或域名变更时，以在线只读检查为准，不沿用旧任务 ID。

## 目标

- 平台：`https://afcops.819521.xyz`
- 宿主 SSH：本机受限文件 `runtime/production-deployment-target` 保存当前 SSH 目标（不提交仓库）；使用已配置的 SSH 密钥。连接曾偶发在握手时关闭，可先用只读命令重连确认。
- 宿主更新器：`/run/mop-updater/control.sock`，安装目录 `/opt/metro-platform`
- 2026-09-24 的只读状态：平台 `0.11.1`，上次安装任务已完成，两个应用已恢复。此状态不能代替下次部署前的重新核对。

## 平台发行

1. 从最新 `main` 创建 `codex/` 分支；完成测试、版本与 CHANGELOG，提交并推送 PR，等待全部 CI 通过后合入 `main`。
2. 在 `main` 触发 GitHub Actions 的 **Build signed Linux release**。工作流使用 `production-release` 环境内的 `MOP_RELEASE_SIGNING_KEY`，生成签名资产和草稿 `v<版本>` Release。
3. 核对草稿的目标 commit、版本、签名资产和检查结果，发布正式 Release。已发布资产不可替换；修复要升版重新发行。
4. 更新前只读检查目标及应用工作状态：

   ```sh
   ssh -o BatchMode=yes -o ConnectTimeout=12 "$(cat runtime/production-deployment-target)" \
     'curl -fsS --unix-socket /run/mop-updater/control.sock http://localhost/status'
   curl -fsS https://afcops.819521.xyz/api/health/ready
   ```

5. 在管理端「系统更新」执行检查、下载、确认备份并安装。更新器可自动快照、暂停和恢复应用，但仍须确认没有未完成的写入或迁移。下载或安装返回不明时只查同一任务状态，不创建新任务重试。部署时以当前版本、任务 ID、备份完成标记和健康检查为准。
6. 安装后核对更新器 `currentVersion`、任务 `phase=completed`、应用恢复数量、平台 readiness、登录与应用列表。宿主更新器脚本本身不随 API 镜像更新；协议不兼容时按 [Ubuntu 更新说明](linux-installation.md) 单独处理。

## 晨会交接应用

晨会交接应用是独立签名包，平台 Release 不会自动升级它。

1. 构建 `applications/shifts`，检查 `dist/manifest.json` 版本与 artifact SHA-256。
2. 使用现有 `metro-apps` 发布者的受控私钥和已登记的 key ID，通过 `mop-app sign`、`verify` 和 `export-upload` 生成上传包。私钥和包只保存在受限本地目录，不提交仓库；核对生成的公钥与平台已登记公钥一致。
3. 平台升级完成后，在管理端「应用管理」上传并预览新包，核对版本、权限、迁移、运行模式和摘要；升级继承现有前端模式。审批该精确版本并执行升级，检查应用恢复为 serving。失败或结果未知时先核对安装记录，不自动重放。
4. 用具备 `app.shifts.submit` 的现有测试员工核对晨会、交接班表单加载与按钮状态。只有在测试组织可合法写入时才实际保存测试记录，并在台账中确认；不要在真实工班制造虚假交接记录。

可信模式另需每 App 独立的资源子域、wildcard DNS/TLS 和反向代理保留 Host。没有完成这些基础设施核对时保持标准沙箱，不应仅因代码已发布而开启可信模式。详情见 [应用接入](applications.md)。

## 故障记录应用

故障记录 0.0.1 依赖平台 0.13.0 的签名沙箱下载声明。先完成平台发行与更新，再构建 `applications/faults`，校验清单、产物 SHA-256、兼容版本和独立公钥。仅为 `faults` 登记发布密钥，使用标准沙箱安装并明确批准清单内的平台能力；故障数据保存在新的托管表中，不导入旧系统数据。安装后先核对运行状态与员工可见性，再由应用负责人配置使用范围和业务角色。只在合法测试组织内写入验收记录，且不应虚构真实故障。详见 [首版方案](fault-records-app-plan.md)。
