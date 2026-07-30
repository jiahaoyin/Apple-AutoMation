#!/bin/bash
set -euo pipefail
cd "$(/usr/bin/dirname "$0")"

echo "==> Apple ID 自动化 环境安装"

# shellcheck disable=SC1091
source "$(/usr/bin/dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_install_runtime

readonly SWIFTC_INSTALL_MAX_ATTEMPTS=120
readonly SWIFTC_INSTALL_POLL_SECONDS=5
readonly SWIFT_SOFTWAREUPDATE_LIST_TIMEOUT_SECONDS=120
readonly SWIFT_SOFTWAREUPDATE_INSTALL_TIMEOUT_SECONDS=1800
readonly SWIFT_MODULE_CACHE_DIR="${TMPDIR:-/tmp}/apple-automation-swift-module-cache"
SWIFTC_BIN=""
readonly REQUIRED_SWIFT_HELPERS=(
  "mac-2fa-popup-read"
  "mac-2fa-click-allow"
  "mac-settings-2fa-code"
  "mac-2fa-popup-ocr"
)
readonly OPTIONAL_SWIFT_HELPERS=(
  "mac-settings-ax-fill"
  "mac-settings-sms-verification"
  "mac-settings-sms-ocr"
  "mac-settings-post-sms-finalization"
)
readonly COMPILED_SWIFT_HELPERS=(
  "${REQUIRED_SWIFT_HELPERS[@]}"
  "${OPTIONAL_SWIFT_HELPERS[@]}"
)

swiftc_usable() {
  local swiftc_path
  swiftc_path="$(/usr/bin/xcrun --find swiftc 2>/dev/null)" || return 1
  [[ -n "$swiftc_path" && -x "$swiftc_path" ]] || return 1
  "$swiftc_path" --version >/dev/null 2>&1 || return 1
  /usr/bin/xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 || return 1
  SWIFTC_BIN="$swiftc_path"
}

run_command_with_timeout() {
  local timeout_seconds="$1"
  shift
  "$@" &
  local command_pid="$!"
  local elapsed=0
  while /bin/kill -0 "$command_pid" 2>/dev/null; do
    if (( elapsed >= timeout_seconds )); then
      /bin/kill "$command_pid" 2>/dev/null || true
      wait "$command_pid" 2>/dev/null || true
      return 124
    fi
    /bin/sleep 1
    (( elapsed += 1 ))
  done
  wait "$command_pid"
}

install_command_line_tools_from_softwareupdate() {
  local label list_output
  list_output="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/apple-automation-clt-list.XXXXXX")" || return 1
  if run_command_with_timeout "$SWIFT_SOFTWAREUPDATE_LIST_TIMEOUT_SECONDS" \
    /usr/sbin/softwareupdate --list >"$list_output" 2>/dev/null; then
    label="$(
      /usr/bin/sed -n 's/^.*\* Label: \(Command Line Tools.*\)$/\1/p' "$list_output" |
        /usr/bin/tail -n 1
    )" || true
  else
    label=""
  fi
  /bin/rm -f -- "$list_output"
  if [[ -z "$label" ]]; then
    return 1
  fi
  echo ">>> 检测到 Command Line Tools 更新: ${label}"
  if ! /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
    echo "==> 需要管理员权限补齐 Apple Command Line Tools"
    /usr/bin/sudo -v || return 1
  fi
  run_command_with_timeout "$SWIFT_SOFTWAREUPDATE_INSTALL_TIMEOUT_SECONDS" \
    /usr/bin/sudo -n /usr/sbin/softwareupdate --install "$label" --verbose
}

request_command_line_tools_install() {
  [[ ! -x /usr/bin/xcode-select ]] || /usr/bin/xcode-select --install >/dev/null 2>&1 || true
  install_command_line_tools_from_softwareupdate || true
}

ensure_swiftc() {
  if swiftc_usable; then
    return 0
  fi

  echo "==> 未找到 swiftc，正在请求安装 Apple Xcode Command Line Tools"
  request_command_line_tools_install

  local attempt
  for (( attempt = 1; attempt <= SWIFTC_INSTALL_MAX_ATTEMPTS; attempt++ )); do
    /bin/sleep "$SWIFTC_INSTALL_POLL_SECONDS"
    if swiftc_usable; then
      return 0
    fi
  done

  echo "错误: 未找到 swiftc。请完成 Apple 官方 Xcode Command Line Tools 安装后重新运行 ./install.sh。" >&2
  return 1
}

run_swiftc() {
  /bin/mkdir -p "$SWIFT_MODULE_CACHE_DIR"
  /usr/bin/xcrun swiftc -module-cache-path "$SWIFT_MODULE_CACHE_DIR" "$@"
}

print_swift_compile_log() {
  local compile_log="$1"
  if [[ ! -s "$compile_log" ]]; then
    return 0
  fi
  echo "---- swiftc 输出开始 ----" >&2
  /usr/bin/sed -n '1,80p' "$compile_log" >&2 || true
  echo "---- swiftc 输出结束 ----" >&2
}

swift_compile_error_is_environmental() {
  local compile_log="$1"
  /usr/bin/grep -Eiq \
    "invalid active developer path|unable to find utility|unable to find sdk|SDK .* cannot be located|no such module '(AppKit|ApplicationServices|Vision|CoreGraphics|ScreenCaptureKit)'|unable to load standard library|xcrun: error|license" \
    "$compile_log"
}

repair_swift_toolchain_after_compile_failure() {
  local compile_log="$1"
  if ! swift_compile_error_is_environmental "$compile_log"; then
    return 1
  fi
  echo ">>> Swift 编译环境不完整，尝试补齐 Apple Command Line Tools 后重试"
  request_command_line_tools_install
  local attempt
  for (( attempt = 1; attempt <= SWIFTC_INSTALL_MAX_ATTEMPTS; attempt++ )); do
    /bin/sleep "$SWIFTC_INSTALL_POLL_SECONDS"
    if swiftc_usable; then
      return 0
    fi
  done
  return 1
}

validate_required_swift_sources() {
  local helper
  for helper in "${REQUIRED_SWIFT_HELPERS[@]}"; do
    if [[ -f "scripts/swift/${helper}.swift" ]]; then
      continue
    fi
    echo "错误: 缺少必需 Swift helper 源文件: scripts/swift/${helper}.swift" >&2
    return 1
  done
}

swift_product_is_executable() {
  [[ -f "$1" && -x "$1" ]]
}

cleanup_swift_helper_temp_dir() {
  local temp_dir="$1"
  local helper
  for helper in "${COMPILED_SWIFT_HELPERS[@]}"; do
    /bin/rm -f -- "$temp_dir/${helper}"
    /bin/rm -f -- "$temp_dir/${helper}.compile.log"
  done
  /bin/rmdir "$temp_dir" 2>/dev/null || true
}

disable_optional_swift_helper() {
  local helper="$1"
  case "$helper" in
    mac-settings-post-sms-finalization)
      /bin/rm -f -- "scripts/bin/${helper}"
      ;;
  esac
}

compile_swift_helper() {
  local temp_dir="$1"
  local helper="$2"
  shift 2
  local failure_label="错误"
  if [[ "${1:-}" == "--optional" ]]; then
    failure_label="警告"
    shift
  fi
  local output_path="$temp_dir/${helper}"
  local compile_log="$temp_dir/${helper}.compile.log"

  if ! run_swiftc -O -o "$output_path" "scripts/swift/${helper}.swift" "$@" >"$compile_log" 2>&1; then
    if [[ "$failure_label" == "错误" ]] &&
      repair_swift_toolchain_after_compile_failure "$compile_log" &&
      run_swiftc -O -o "$output_path" "scripts/swift/${helper}.swift" "$@" >"$compile_log" 2>&1; then
      :
    else
      print_swift_compile_log "$compile_log"
      echo "${failure_label}: Swift helper 编译失败: ${helper}。请确认 Apple Xcode Command Line Tools 已完成安装，然后重新运行 ./install.sh。" >&2
      echo "诊断命令: /usr/bin/xcrun swiftc -module-cache-path \"$SWIFT_MODULE_CACHE_DIR\" -O -o /tmp/${helper} scripts/swift/${helper}.swift $*" >&2
      /bin/rm -f -- "$compile_log"
      return 1
    fi
  fi
  /bin/rm -f -- "$compile_log"
  if ! swift_product_is_executable "$output_path"; then
    echo "${failure_label}: Swift helper 编译产物无效: ${helper}" >&2
    return 1
  fi
}

compile_swift_helpers() {
  echo "==> 编译 Swift 原生 helper"
  mkdir -p scripts/bin
  local temp_dir
  temp_dir="$(/usr/bin/mktemp -d "scripts/bin/.swift-helpers.XXXXXX")" || {
    echo "错误: 无法创建 Swift helper 临时目录" >&2
    return 1
  }

  local required_helper
  for required_helper in "${REQUIRED_SWIFT_HELPERS[@]}"; do
    case "$required_helper" in
      mac-2fa-popup-read|mac-2fa-click-allow|mac-settings-2fa-code)
        if ! compile_swift_helper "$temp_dir" "$required_helper" \
            -framework ApplicationServices -framework AppKit; then
          cleanup_swift_helper_temp_dir "$temp_dir"
          return 1
        fi
        ;;
      mac-2fa-popup-ocr)
        if ! compile_swift_helper "$temp_dir" "$required_helper" \
            -framework ApplicationServices -framework AppKit -framework Vision -framework CoreGraphics \
            -framework ScreenCaptureKit; then
          cleanup_swift_helper_temp_dir "$temp_dir"
          return 1
        fi
        ;;
      *)
        echo "错误: 未知必需 Swift helper: ${required_helper}" >&2
        cleanup_swift_helper_temp_dir "$temp_dir"
        return 1
        ;;
    esac
  done

  local optional_helper
  local optional_compiled=()
  for optional_helper in "${OPTIONAL_SWIFT_HELPERS[@]}"; do
    case "$optional_helper" in
      mac-settings-ax-fill|mac-settings-sms-verification)
        if [[ -f "scripts/swift/${optional_helper}.swift" ]] &&
          compile_swift_helper "$temp_dir" "$optional_helper" \
            --optional \
            -framework ApplicationServices -framework AppKit; then
          optional_compiled+=("$optional_helper")
        else
          echo "警告: 可选 Swift helper 编译失败: ${optional_helper}。跳过 Mac 系统设置登录辅助；./run.sh --skip-mac 浏览器流程仍可继续。" >&2
          /bin/rm -f -- "$temp_dir/${optional_helper}"
        fi
        ;;
      mac-settings-post-sms-finalization)
        if [[ -f "scripts/swift/${optional_helper}.swift" ]] &&
          compile_swift_helper "$temp_dir" "$optional_helper" \
            --optional \
            -framework ApplicationServices -framework AppKit -framework Vision -framework CoreGraphics \
            -framework ScreenCaptureKit; then
          optional_compiled+=("$optional_helper")
        else
          echo "警告: 可选 Swift helper 编译失败: ${optional_helper}。iPhone 解锁视觉定位将保留人工处理。" >&2
          /bin/rm -f -- "$temp_dir/${optional_helper}"
          disable_optional_swift_helper "$optional_helper"
        fi
        ;;
      mac-settings-sms-ocr)
        if [[ -f "scripts/swift/${optional_helper}.swift" ]] &&
          compile_swift_helper "$temp_dir" "$optional_helper" \
            --optional \
            -framework ApplicationServices -framework AppKit -framework Vision -framework CoreGraphics \
            -framework ScreenCaptureKit; then
          optional_compiled+=("$optional_helper")
        else
          echo "警告: 可选 Swift helper 编译失败: ${optional_helper}。SMS 验证码 OCR 回退不可用。" >&2
          /bin/rm -f -- "$temp_dir/${optional_helper}"
        fi
        ;;
    esac
  done

  local helper
  for helper in "${REQUIRED_SWIFT_HELPERS[@]}"; do
    if ! /bin/mv -f -- "$temp_dir/${helper}" "scripts/bin/${helper}"; then
      echo "错误: 无法替换 Swift helper: ${helper}" >&2
      cleanup_swift_helper_temp_dir "$temp_dir"
      return 1
    fi
    echo "✓ ${helper} 已编译"
  done
  for helper in "${optional_compiled[@]}"; do
    if ! /bin/mv -f -- "$temp_dir/${helper}" "scripts/bin/${helper}"; then
      echo "警告: 可选 Swift helper 无法替换: ${helper}。保留旧 helper，安装继续。" >&2
      /bin/rm -f -- "$temp_dir/${helper}"
      disable_optional_swift_helper "$helper"
      continue
    fi
    echo "✓ ${helper} 已编译"
  done

  if ! /bin/rmdir "$temp_dir"; then
    echo "错误: 无法清理 Swift helper 临时目录" >&2
    return 1
  fi
}

validate_required_swift_artifacts() {
  local helper
  for helper in "${REQUIRED_SWIFT_HELPERS[@]}"; do
    if [[ -f "scripts/bin/${helper}" && -x "scripts/bin/${helper}" ]]; then
      continue
    fi
    echo "错误: 必需 Swift helper 编译产物无效: scripts/bin/${helper}" >&2
    return 1
  done
}

ensure_swiftc
validate_required_swift_sources
compile_swift_helpers
validate_required_swift_artifacts

node scripts/setup-environment.mjs --install-ruyipage "$@"
echo "==> 确认 2FA 自动取码权限"
node scripts/preflight-2fa-permissions.mjs --all
