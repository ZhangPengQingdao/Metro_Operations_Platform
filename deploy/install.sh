#!/usr/bin/env bash
set -euo pipefail
# Run from a trusted checkout/installer kit. The release key must be obtained out of band.
[[ ${EUID} -eq 0 ]] || { echo '请使用 sudo 执行安装器。' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && "$(uname -m)" == x86_64 ]] || { echo '首版仅支持 Ubuntu 24.04 / x86_64。' >&2; exit 1; }
if ! command -v docker >/dev/null; then
  # Dedicated new host only; never uninstall an existing Docker/containerd installation.
  installed_packages=$(dpkg-query -W -f='${binary:Package} ${Status}\n')
  if grep -Eq '^(docker\.io|containerd|runc)(:[^ ]+)? install ok installed$' <<< "$installed_packages"; then
    echo '发现已有容器运行时，请先人工核对兼容性。' >&2; exit 1
  fi
  apt-get update
  apt-get install -y ca-certificates curl python3 openssl
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/mop-docker.asc
  chmod a+r /etc/apt/keyrings/mop-docker.asc
  cat > /etc/apt/sources.list.d/mop-docker.sources <<'SOURCES'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/mop-docker.asc
SOURCES
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
command -v python3 >/dev/null && command -v openssl >/dev/null && docker compose version >/dev/null || { echo 'Python/OpenSSL/Compose 依赖不完整，请检查安装日志。' >&2; exit 1; }
read -r -p '安装版本（例如 0.2.0）：' release_version
read -r -p '可信发行公钥文件的绝对路径：' public_key
exec python3 "$(dirname "$0")/updater.py" install --version "$release_version" --public-key "$public_key"
