# 0.2.0 发行记录

2026-09-15 已发布 [正式 v0.2.0](https://github.com/ZhangPengQingdao/Metro_Operations_Platform/releases/tag/v0.2.0)，不是草稿或预发行版。GitHub 返回 `immutable: true`，标签指向 `374d58655086d9158041f9c733b1f82052ab9ef7`。

## 已完成配置与核验

- GitHub `production-release` 环境仅允许 `main`；该环境已配置专用 Ed25519 签名 Secret。
- [发行流水线](https://github.com/ZhangPengQingdao/Metro_Operations_Platform/actions/runs/34970607835) 全部通过，包括平台检查、Linux 镜像验收和正式工件构建。
- 实际下载镜像归档，核对签名、长度和 SHA-256；原始安装器逐文件与标签源码一致。
- 部署包只含安装器、公钥、说明和校验信息，另附 Ed25519 签名，不含发行私钥或任何服务器凭据。
- 已用更新器的 GitHub 客户端核验正式版本发现、认证下载和清单验签。此验证使用维护者现有凭据，不代替服务器新建只读令牌的安装验收。

## 可信交付校验值

| 文件 | SHA-256 |
| --- | --- |
| `release-public.pem` | `135e6f53862414e8c59b3639554d31a79f7094fb8be8a40827b5f36a40a4f1d4` |
| `mop-install-0.2.0.tar.gz` | `ff065b63793c18811cf8451ec662848b4e9d6e0bf5fc600202c6d71cb79dc703` |
| `images.tar` | `5f299f431d29fba18ec600c4a8ba2c66b7f8ed36243ae447fe4ee1b77c484db7` |

镜像归档为 859,943,936 字节；部署包为 17,708 字节。首次安装应从本次可信交付固定公钥，不能自动信任新下载的替换公钥。

发行私钥的本机备份位于受限且被 Git 忽略的 `runtime/release-signing/`。维护者应另行妥善备份，不能上传到服务器部署目录；后续发行继续使用同一信任密钥，换钥须单独交付和核对。

## 安装与后续更新

部署人员按 [首次服务器安装步骤](server-first-install.md) 操作。域名、服务器只读令牌以及目标机 DNS/TLS/systemd/重启和恢复验收由部署阶段完成，发行成功不等于目标机已经安装成功。

后续交付按版本规则升版，合并 main 后运行签名发行工作流，检查草稿再发布正式 Release。服务器管理端才能发现该版本；单纯推送 main 不会自动升级服务器。不得替换 `v0.2.0` 资产或重写标签。
