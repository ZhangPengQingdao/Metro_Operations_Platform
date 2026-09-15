#!/usr/bin/env bash
set -euo pipefail
# Run from a trusted checkout/installer kit. The release key must be obtained out of band.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
release_version=''
public_key=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|--public-key)
      [[ $# -ge 2 && -n "$2" ]] || { echo '参数缺少值。' >&2; exit 1; }
      if [[ "$1" == --version ]]; then release_version=$2; else public_key=$2; fi
      shift 2 ;;
    *) echo '用法：install.sh [--version 版本] [--public-key 公钥路径]' >&2; exit 1 ;;
  esac
done
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
if [[ -z "$release_version" && -f "$script_dir/../package.json" ]]; then
  release_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$script_dir/../package.json")
fi
if [[ -z "$public_key" && -f "$script_dir/release-public.pub" ]]; then
  public_key="$script_dir/release-public.pub"
fi
[[ -n "$release_version" ]] || read -r -p '安装版本：' release_version
[[ -n "$public_key" ]] || read -r -p '可信发行公钥文件的绝对路径：' public_key
echo "安装运管开放平台 $release_version"
exec python3 "$script_dir/updater.py" install --version "$release_version" --public-key "$public_key"
