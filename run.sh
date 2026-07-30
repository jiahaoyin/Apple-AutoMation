#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Never pass a shell-provided SMS pair through bootstrap or preflight children.
# credentials.js later reads the saved .env pair as data and immediately hands it
# to the SMS runtime snapshot, keeping child environments clear of those values.
if [[ -n "${APPLE_AUTOMATION_SMS_PHONE:-}" || -n "${APPLE_AUTOMATION_SMS_API_URL:-}" ]]; then
  export APPLE_AUTOMATION_SMS_ENABLED=1
fi
unset APPLE_AUTOMATION_SMS_PHONE APPLE_AUTOMATION_SMS_API_URL APPLE_AUTOMATION_MANUAL_SMS_CODE

launcher_trim_value() {
  printf '%s' "$1" | /usr/bin/sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

launcher_normalize_flag() {
  launcher_trim_value "$1" | /usr/bin/tr '[:upper:]' '[:lower:]'
}

launcher_terminal_debug_enabled() {
  local terminal_debug supervised_gui
  terminal_debug="$(launcher_normalize_flag "${APPLE_AUTOMATION_TERMINAL_DEBUG:-}")"
  case "$terminal_debug" in
    1|true|yes|on) return 0 ;;
  esac
  supervised_gui="$(launcher_trim_value "${APPLE_AUTOMATION_SUPERVISED_GUI:-}")"
  [[ "$supervised_gui" == "1" ]]
}

launcher_pre_audit_failure() {
  printf '[×] 启动失败（阶段：launcher_entered，退出码：1）\n' >&2 || true
  printf '[日志] 启动审计尚未创建\n' >&2 || true
  exit 1
}

launcher_report_root="${APPLE_AUTOMATION_REPORT_ROOT:-data/reports}"
case "$launcher_report_root" in
  ""|*$'\n'*|*$'\r'*) launcher_pre_audit_failure ;;
esac

umask 077
if ! /bin/mkdir -p "$launcher_report_root" >/dev/null 2>&1; then
  launcher_pre_audit_failure
fi
if ! launcher_report_root="$(cd "$launcher_report_root" >/dev/null 2>&1 && /bin/pwd -P)"; then
  launcher_pre_audit_failure
fi
export APPLE_AUTOMATION_REPORT_ROOT="$launcher_report_root"

if ! launcher_audit_dir="$(/usr/bin/mktemp -d "$launcher_report_root/.launcher-audit.XXXXXX" 2>/dev/null)"; then
  launcher_pre_audit_failure
fi
launcher_audit_path="$launcher_audit_dir/launcher-audit.jsonl"
if ! { : > "$launcher_audit_path" && /bin/chmod 600 "$launcher_audit_path"; } 2>/dev/null; then
  launcher_pre_audit_failure
fi
export APPLE_AUTOMATION_LAUNCHER_AUDIT_PATH="$launcher_audit_path"
launcher_run_id="$(/usr/bin/uuidgen 2>/dev/null | /usr/bin/tr '[:upper:]' '[:lower:]' || true)"
if [[ ! "$launcher_run_id" =~ ^[a-z0-9][a-z0-9-]{0,95}$ ]]; then
  launcher_run_id="run-$$-$(/bin/date -u '+%s' 2>/dev/null || printf '0')"
fi
export APPLE_AUTOMATION_RUN_ID="$launcher_run_id"
launcher_audit_sequence=0
if launcher_terminal_debug_enabled; then
  printf '%s\n' "$launcher_audit_path"
fi

launcher_stage_token_valid() {
  case "$1" in
    launcher_entered|launcher_bootstrap_started|launcher_bootstrap_ready|launcher_env_setup_started|launcher_env_setup_skipped|launcher_env_setup_ready|launcher_preflight_started|launcher_preflight_skipped|launcher_preflight_ready|flow_main_started|credentials_ready|apple_flow_exec|apple_flow_completed|failure) return 0 ;;
  esac
  return 1
}

launcher_audit_record() {
  local stage="$1"
  local exit_code="$2"
  local failed_stage="${3:-}"
  local timestamp

  launcher_stage_token_valid "$stage" || return 1
  [[ "$exit_code" =~ ^[0-9]+$ ]] || return 1
  if [[ "$stage" == "failure" ]]; then
    launcher_stage_token_valid "$failed_stage" || return 1
    [[ "$failed_stage" != "failure" ]] || return 1
  fi
  timestamp="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || return 1
  [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  launcher_audit_sequence=$((launcher_audit_sequence + 1))
  if [[ "$stage" == "failure" ]]; then
    printf '{"version":1,"runId":"%s","sequence":%d,"timestamp":"%s","stage":"%s","exitCode":%d,"failedStage":"%s"}\n' "$launcher_run_id" "$launcher_audit_sequence" "$timestamp" "$stage" "$exit_code" "$failed_stage" >> "$launcher_audit_path" 2>/dev/null
  else
    printf '{"version":1,"runId":"%s","sequence":%d,"timestamp":"%s","stage":"%s","exitCode":%d}\n' "$launcher_run_id" "$launcher_audit_sequence" "$timestamp" "$stage" "$exit_code" >> "$launcher_audit_path" 2>/dev/null
  fi
}

launcher_current_stage="launcher_entered"

launcher_stage() {
  launcher_current_stage="$1"
  launcher_audit_record "$1" 0
  if launcher_terminal_debug_enabled; then
    printf '[apple-automation] stage:%s\n' "$1"
  fi
}

launcher_exit() {
  local exit_code=$?
  local failed_stage="${launcher_current_stage:-launcher_entered}"
  trap - EXIT
  if (( exit_code != 0 )); then
    if ! launcher_stage_token_valid "$failed_stage" || [[ "$failed_stage" == "failure" ]]; then
      failed_stage="launcher_entered"
    fi
    launcher_audit_record failure "$exit_code" "$failed_stage" || true
    if launcher_terminal_debug_enabled; then
      printf '[apple-automation] stage:failure\n' || true
    fi
    if [[ "$failed_stage" != "apple_flow_exec" ]]; then
      printf '[×] 启动失败（阶段：%s，退出码：%d）\n' "$failed_stage" "$exit_code" >&2 || true
      printf '[日志] %s\n' "$launcher_audit_path" >&2 || true
    fi
  fi
  exit "$exit_code"
}

trap launcher_exit EXIT

launcher_stage launcher_entered
launcher_stage launcher_bootstrap_started

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime
launcher_stage launcher_bootstrap_ready

skip_browser=0
skip_mac=0
for arg in "$@"; do
  if [[ "${arg}" == "--skip-browser" ]]; then
    skip_browser=1
  fi
  if [[ "${arg}" == "--skip-mac" ]]; then
    skip_mac=1
  fi
done

if [[ "${SKIP_ENV_SETUP:-}" != "1" ]]; then
  launcher_stage launcher_env_setup_started
  setup_args=(--quiet)
  if [[ "${skip_browser}" == "1" ]]; then
    setup_args+=(--skip-firefox --skip-ruyipage)
  fi
  if [[ "${skip_mac}" == "1" ]]; then
    setup_args+=(--skip-automation)
  fi
  node scripts/setup-environment.mjs "${setup_args[@]}"
  launcher_stage launcher_env_setup_ready
else
  launcher_stage launcher_env_setup_skipped
fi

if [[ "${skip_browser}" != "1" ]]; then
  launcher_stage launcher_preflight_started
  node scripts/preflight-2fa-permissions.mjs --quiet --all
  launcher_stage launcher_preflight_ready
else
  launcher_stage launcher_preflight_skipped
fi

# credentials.js loads .env as data and preserves already-exported runtime overrides.

launcher_stage apple_flow_exec
node scripts/apple-id-full-flow.mjs --skip-setup "$@"
launcher_stage apple_flow_completed
