#!/bin/bash
# 引导 Python 与 Node 运行时（仅用官方发行物，不用 Homebrew）
set -euo pipefail

BOOTSTRAP_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$BOOTSTRAP_DIR/.." && pwd)"
LOCAL_NODE_DIR="$PACKAGE_ROOT/.runtime/node"
LOCAL_NODE_VERSION="${LOCAL_NODE_VERSION:-22.14.0}"
readonly LOCAL_PYTHON_VERSION="3.12.10"
PYTHON_BOOTSTRAP_SERIES="${LOCAL_PYTHON_VERSION%.*}"
PYTHON_DOWNLOAD_DIR="$PACKAGE_ROOT/.runtime/downloads"
OFFLINE_DIR="$PACKAGE_ROOT/.runtime/offline"
readonly PYTHON_BOOTSTRAP_PKG_URL="https://www.python.org/ftp/python/${LOCAL_PYTHON_VERSION}/python-${LOCAL_PYTHON_VERSION}-macos11.pkg"
readonly PYTHON_BOOTSTRAP_SHA256="8373e58da4ea146b3eb1c1f9834f19a319440b6b679b06050b1f9ee3237aa8e4"
PYTHON_FRAMEWORK_BIN="/Library/Frameworks/Python.framework/Versions/${PYTHON_BOOTSTRAP_SERIES}/bin"
SUDO_KEEPALIVE_PID=""
ROOT_PYTHON_STAGE_DIR=""
ROOT_PYTHON_PKG=""

python_version_supported() {
  local command_path="$1"
  local version major minor
  version="$("$command_path" --version 2>&1)" || return 1
  if [[ "$version" =~ Python[[:space:]]+([0-9]+)\.([0-9]+) ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    (( major > 3 || (major == 3 && minor >= 10) ))
    return
  fi
  return 1
}

python_path_is_admin_trusted() {
  local candidate="$1"
  local resolved current metadata owner mode mode_value
  resolved="$(/usr/bin/realpath "$candidate" 2>/dev/null)" || return 1
  [[ -f "$resolved" && -x "$resolved" ]] || return 1

  current="$resolved"
  while true; do
    metadata="$(/usr/bin/stat -f '%u %Lp' "$current" 2>/dev/null)" || return 1
    owner="${metadata%% *}"
    mode="${metadata##* }"
    if [[ "$owner" != "0" || ! "$mode" =~ ^[0-7]{3,4}$ ]]; then
      return 1
    fi
    mode_value=$((8#$mode))
    if (( (mode_value & 0022) != 0 )); then
      return 1
    fi
    [[ "$current" == "/" ]] && break
    current="$(/usr/bin/dirname "$current")"
  done

  printf '%s\n' "$resolved"
}

resolve_supported_python() {
  local candidate command_path trusted_path
  local candidates=()
  if [[ -n "${PYTHON_BOOTSTRAP_EXECUTABLE:-}" ]]; then
    candidates+=("$PYTHON_BOOTSTRAP_EXECUTABLE")
  fi
  candidates+=(
    "python3"
    "python"
    "/usr/local/bin/python3"
    "$PYTHON_FRAMEWORK_BIN/python3"
  )

  for candidate in "${candidates[@]}"; do
    command_path="$candidate"
    if [[ "$candidate" != */* ]]; then
      command_path="$(command -v "$candidate" 2>/dev/null || true)"
    fi
    if [[ "$candidate" == "$PYTHON_FRAMEWORK_BIN/python3" && -x "$command_path" ]] &&
      python_version_supported "$command_path"; then
      printf '%s\n' "$command_path"
      return 0
    fi
    if [[ -n "$command_path" ]] &&
      trusted_path="$(python_path_is_admin_trusted "$command_path")" &&
      python_version_supported "$trusted_path"; then
      printf '%s\n' "$trusted_path"
      return 0
    fi
  done
  return 1
}

cleanup_root_python_stage() {
  if [[ -n "$ROOT_PYTHON_PKG" ]]; then
    /usr/bin/sudo -n /bin/rm -f "$ROOT_PYTHON_PKG" 2>/dev/null || true
    ROOT_PYTHON_PKG=""
  fi
  if [[ -n "$ROOT_PYTHON_STAGE_DIR" ]]; then
    /usr/bin/sudo -n /bin/rmdir "$ROOT_PYTHON_STAGE_DIR" 2>/dev/null || true
    ROOT_PYTHON_STAGE_DIR=""
  fi
}

release_admin_authorization() {
  cleanup_root_python_stage
  if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then
    kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    wait "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    SUDO_KEEPALIVE_PID=""
  fi
  /usr/bin/sudo -k 2>/dev/null || true
}

finish_admin_authorization() {
  release_admin_authorization
  trap - EXIT INT TERM
}

acquire_admin_authorization() {
  echo "==> 需要管理员权限安装受信任的 Python 运行环境"
  echo "    密码仅由系统 sudo 读取，项目不会保存或记录密码"
  if ! /usr/bin/sudo -v; then
    echo "错误: 未获得管理员授权，安装已停止"
    exit 1
  fi
  (
    while /usr/bin/sudo -n /usr/bin/true 2>/dev/null; do
      /bin/sleep 30
    done
  ) &
  SUDO_KEEPALIVE_PID="$!"
  trap release_admin_authorization EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

verify_python_pkg_hash() {
  local pkg="$1"
  local hash_output actual_hash
  hash_output="$(/usr/bin/shasum -a 256 "$pkg")" || return 1
  actual_hash="${hash_output%% *}"
  if [[ "$actual_hash" != "$PYTHON_BOOTSTRAP_SHA256" ]]; then
    echo "错误: Python 安装包 SHA-256 不匹配"
    echo "    期望: $PYTHON_BOOTSTRAP_SHA256"
    echo "    实际: $actual_hash"
    return 1
  fi
}

resolve_trusted_python_signer() {
  local signature="$1"
  local line
  while :; do
    if [[ "$signature" == *$'\n'* ]]; then
      line="${signature%%$'\n'*}"
      signature="${signature#*$'\n'}"
    else
      line="$signature"
      signature=""
    fi
    if [[ "$line" =~ ^[[:space:]]*1\.[[:space:]]+Developer[[:space:]]ID[[:space:]]Installer:[[:space:]]Python[[:space:]]Software[[:space:]]Foundation[[:space:]]\(([A-Z0-9]{10})\)[[:space:]]*$ ]]; then
      printf 'Developer ID Installer: Python Software Foundation (%s)\n' "${BASH_REMATCH[1]}"
      return 0
    fi
    [[ -n "$signature" ]] || break
  done
  return 1
}

stage_python_pkg_for_install() {
  local pkg="$1"
  local hash_output root_hash
  ROOT_PYTHON_STAGE_DIR="$(
    /usr/bin/sudo -n /usr/bin/mktemp -d /var/tmp/apple-automation-python.XXXXXX
  )" || return 1
  ROOT_PYTHON_PKG="$ROOT_PYTHON_STAGE_DIR/python-${LOCAL_PYTHON_VERSION}-macos11.pkg"
  /usr/bin/sudo -n /usr/bin/install \
    -o root -g wheel -m 0600 \
    "$pkg" "$ROOT_PYTHON_PKG"

  hash_output="$(
    /usr/bin/sudo -n /usr/bin/shasum -a 256 "$ROOT_PYTHON_PKG"
  )" || return 1
  root_hash="${hash_output%% *}"
  if [[ "$root_hash" != "$PYTHON_BOOTSTRAP_SHA256" ]]; then
    echo "错误: root 暂存 Python 安装包 SHA-256 不匹配"
    return 1
  fi
}

verify_staged_python_signature() {
  local signature signer
  signature="$(
    /usr/bin/sudo -n /usr/sbin/pkgutil --check-signature "$ROOT_PYTHON_PKG" 2>&1
  )" || {
    echo "$signature"
    echo "错误: Python 安装包签名验证失败"
    return 1
  }
  if ! signer="$(resolve_trusted_python_signer "$signature")"; then
    echo "$signature"
    echo "错误: Python 安装包签名身份不匹配"
    return 1
  fi
  echo "✓ Python 安装包签名: $signer"
}

install_python_official_pkg() {
  local pkg partial offline_pkg
  /bin/mkdir -p "$PYTHON_DOWNLOAD_DIR"
  pkg="$PYTHON_DOWNLOAD_DIR/python-${LOCAL_PYTHON_VERSION}-macos11.pkg"
  partial="${pkg}.part"
  offline_pkg="$OFFLINE_DIR/python-${LOCAL_PYTHON_VERSION}-macos11.pkg"

  if [[ ! -f "$pkg" ]]; then
    if [[ -f "$offline_pkg" ]]; then
      echo ">>> 使用本地离线安装包: $offline_pkg"
      /bin/cp "$offline_pkg" "$pkg"
    else
      echo ">>> 从 python.org 下载官方 Python ${LOCAL_PYTHON_VERSION} universal2 安装包"
      if ! /usr/bin/curl \
        --fail --location --retry 3 --proto '=https' --proto-redir '=https' --tlsv1.2 \
        --output "$partial" "$PYTHON_BOOTSTRAP_PKG_URL"; then
        /bin/rm -f "$partial"
        echo "错误: Python 安装包下载失败: $PYTHON_BOOTSTRAP_PKG_URL"
        return 1
      fi
      /bin/mv "$partial" "$pkg"
    fi
  fi

  verify_python_pkg_hash "$pkg"
  stage_python_pkg_for_install "$pkg"
  verify_staged_python_signature
  echo ">>> 安装已验证摘要与签名的 Python ${LOCAL_PYTHON_VERSION}"
  /usr/bin/sudo -n /usr/sbin/installer -pkg "$ROOT_PYTHON_PKG" -target /
  cleanup_root_python_stage
}

ensure_python() {
  local python_path
  if python_path="$(resolve_supported_python)"; then
    export PATH="$(/usr/bin/dirname "$python_path"):$PATH"
    export PYTHON_BOOTSTRAP_EXECUTABLE="$python_path"
    echo "✓ Python $("$python_path" --version 2>&1) ($python_path)"
    return 0
  fi

  echo ">>> 未检测到符合要求的 Python 3.10+，开始自动安装"
  install_python_official_pkg

  if ! python_path="$(resolve_supported_python)"; then
    echo "错误: Python 安装完成后仍未检测到 Python 3.10+"
    echo "已检查 python3、python、/usr/local/bin/python3 与 $PYTHON_FRAMEWORK_BIN/python3"
    return 1
  fi

  export PATH="$(/usr/bin/dirname "$python_path"):$PATH"
  export PYTHON_BOOTSTRAP_EXECUTABLE="$python_path"
  echo "✓ Python $("$python_path" --version 2>&1) ($python_path)"
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -p "parseInt(process.versions.node.split('.')[0], 10)"
}

ensure_local_node_path() {
  if [[ -x "$LOCAL_NODE_DIR/bin/node" ]]; then
    export PATH="$LOCAL_NODE_DIR/bin:$PATH"
  fi
}

install_node_official_binary() {
  local arch dest tarball url offline_tarball
  arch="$(uname -m)"
  case "$arch" in
    arm64) arch="arm64" ;;
    x86_64) arch="x64" ;;
    *) echo "错误: 不支持的 CPU 架构: $arch"; return 1 ;;
  esac

  dest="$LOCAL_NODE_DIR"
  tarball="node-v${LOCAL_NODE_VERSION}-darwin-${arch}.tar.gz"
  url="https://nodejs.org/dist/v${LOCAL_NODE_VERSION}/${tarball}"
  offline_tarball="$OFFLINE_DIR/${tarball}"

  echo ">>> 安装 Node"
  echo "    版本: v${LOCAL_NODE_VERSION}"
  echo "    安装到: $dest"

  mkdir -p "$dest"
  if [[ -f "$offline_tarball" ]]; then
    echo ">>> 使用本地离线安装包: $offline_tarball"
    tar -xzf "$offline_tarball" -C "$dest" --strip-components=1
  else
    echo ">>> 从 nodejs.org 下载官方 Node 二进制"
    curl -fsSL "$url" | tar -xz -C "$dest" --strip-components=1
  fi
  export PATH="$dest/bin:$PATH"

  local major
  major="$(node_major_version)"
  if [[ "$major" -lt 18 ]]; then
    echo "错误: 官方 Node 安装后版本仍不满足 18+"
    return 1
  fi
  echo "✓ Node $(node -v)（官方二进制）"
}

ensure_node() {
  ensure_local_node_path

  local major
  major="$(node_major_version)"
  if [[ "$major" -ge 18 ]]; then
    echo "✓ Node $(node -v)"
    return 0
  fi

  if [[ "$major" -gt 0 ]]; then
    echo ">>> Node 版本过低 ($(node -v))，需要 18+"
    echo "    请从 https://nodejs.org 安装新版本，或运行 ./install.sh 自动下载官方包"
    exit 1
  fi

  echo ">>> 未检测到 Node.js，开始从 nodejs.org 安装…"
  install_node_official_binary

  major="$(node_major_version)"
  if [[ "$major" -lt 18 ]]; then
    echo "错误: 需要 Node 18+，当前: $(node -v 2>/dev/null || echo none)"
    exit 1
  fi
}

bootstrap_macos_runtime() {
  if [[ "$(/usr/bin/uname)" != "Darwin" ]]; then
    echo "错误: 仅支持 macOS"
    exit 1
  fi
  ensure_node
}

bootstrap_macos_install_runtime() {
  if [[ "$(/usr/bin/uname)" != "Darwin" ]]; then
    echo "错误: 仅支持 macOS"
    exit 1
  fi
  acquire_admin_authorization
  ensure_python
  finish_admin_authorization
  ensure_node
}
