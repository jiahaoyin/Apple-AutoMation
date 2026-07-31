import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep, waitUntil } from "./prompt.js";
import {
  withAccessibilityRetry,
  ensureAutomation,
  checkAutomationGranted,
  openAutomationSettings,
  isAutomationDeniedError,
  getAccessibilityHostApp,
} from "./accessibility.js";
import { ensureMacOS15, getMacOSVersion, openAppleAccountSettings } from "./macos.js";
import {
  compileAxFillHelper,
  fillViaSwiftAx,
  isAxFillAvailable,
} from "./mac-settings-ax-fill.js";
import { saveMacSettingsSmsProviderConfig } from "./credentials.js";
import { completeSupervisedMacSettingsSmsVerification } from "./mac-settings-sms-verification.js";
import { isMacSettingsSmsHelperAvailable } from "./mac-settings-sms-ax.js";
import { createSmsProviderCodePoller, resolveMacSettingsSmsProviderConfig } from "./mac-settings-sms-provider.js";
import {
  completeMacSettingsPostSmsFinalization,
  isMacSettingsPostSmsFinalizationEnabled,
} from "./mac-settings-post-sms-finalization.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_SCPT = path.resolve(__dirname, "../mac-settings-apple-login.applescript");
const DUMP_SCPT = path.resolve(__dirname, "../mac-settings-ui-dump.applescript");
const SIGNED_IN_SCPT = path.resolve(__dirname, "../mac-settings-signed-in.applescript");
const AUTOMATION_CHECK_SCPT = path.resolve(
  __dirname,
  "../automation-check.applescript"
);
const SMS_RUNTIME_SECRET_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
  "APPLE_AUTOMATION_MANUAL_SMS_CODE",
];
const MAC_LOGIN_STATUS_ROUTES = new Set(["swift_ax", "applescript"]);
const MAC_LOGIN_STATUS_PHASES = new Set([
  "preflight",
  "dump",
  "email",
  "continue",
  "password",
  "state",
  "fallback_recovery",
]);
const MAC_LOGIN_STATUS_OUTCOMES = new Set(["started", "succeeded", "failed", "fallback"]);
const MAC_LOGIN_STATUS_REASONS = new Set([
  "ok",
  "target_unavailable_before_write",
  "target_focus_unavailable",
  "target_changed_before_write",
  "ax_value_unconfirmed",
  "keyboard_fallback_unsafe",
  "keyboard_target_changed",
  "keyboard_unconfirmed",
  "login_state_unknown",
  "login_window_not_found",
  "exact_username_field_not_found",
  "exact_password_field_not_found",
  "enabled_login_button_not_found",
  "enabled_login_button_not_found_after_password",
  "missing_email_value",
  "missing_password_value",
  "settings_process_not_found",
  "helper_invalid_output",
  "helper_exit",
  "helper_unavailable",
  "compile_failed",
  "preflight_unavailable",
  "fallback_recovery_failed",
  "applescript_failed",
  "applescript_invalid_output",
]);
const MAC_LOGIN_STATES = new Set(["email", "password", "unknown"]);
const MAC_LOGIN_INPUT_ROUTES = new Set(["ax_value", "keyboard", "existing_value", "unknown"]);
const MAC_LOGIN_PREWRITE_FAILURE_REASONS = new Set([
  "target_unavailable_before_write",
  "target_focus_unavailable",
  "target_changed_before_write",
  "login_state_unknown",
  "login_window_not_found",
  "exact_username_field_not_found",
  "exact_password_field_not_found",
  "settings_process_not_found",
]);
const MAX_MAC_LOGIN_TEXT_FIELDS = 32;

function macLoginToken(value, allowed, fallback = "unknown") {
  return allowed.has(value) ? value : fallback;
}

function normalizeMacLoginReason(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return MAC_LOGIN_STATUS_REASONS.has(normalized) ? normalized : fallback;
}

function sanitizeMacLoginStatus(status = {}) {
  return {
    route: macLoginToken(status.route, MAC_LOGIN_STATUS_ROUTES),
    phase: macLoginToken(status.phase, MAC_LOGIN_STATUS_PHASES),
    outcome: macLoginToken(status.outcome, MAC_LOGIN_STATUS_OUTCOMES, "failed"),
    reason: normalizeMacLoginReason(status.reason),
    loginState: macLoginToken(status.loginState, MAC_LOGIN_STATES),
    inputRoute: macLoginToken(status.inputRoute, MAC_LOGIN_INPUT_ROUTES),
    textFieldCount:
      Number.isInteger(status.textFieldCount) &&
      status.textFieldCount >= 0 &&
      status.textFieldCount <= MAX_MAC_LOGIN_TEXT_FIELDS
        ? status.textFieldCount
        : null,
  };
}

function emitMacLoginStatus(onStatus, status) {
  const safeStatus = sanitizeMacLoginStatus(status);
  if (typeof onStatus === "function") {
    try {
      onStatus(safeStatus);
    } catch {
      /* Audit delivery cannot alter credential submission. */
    }
  }
  return safeStatus;
}

function createMacLoginError(status) {
  const error = new Error("MAC_SETTINGS_LOGIN_FAILED");
  error.code = "MAC_SETTINGS_LOGIN_FAILED";
  error.macSettingsStatus = sanitizeMacLoginStatus(status);
  return error;
}

export function appleScriptPhaseFromStep(step) {
  if (!Number.isInteger(step) || step < 1) return "state";
  if (step <= 3) return "state";
  if (step <= 6) return "email";
  if (step <= 8) return "continue";
  return "password";
}

export function sanitizedMacSettingsChildEnv(env = process.env) {
  const childEnv = { ...env };
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) delete childEnv[key];
  return childEnv;
}

function clearMacSettingsSmsRuntimeSecrets(env = process.env) {
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) delete env[key];
}

/** 自动化预检：激活系统设置并尝试读取 UI 属性 */
export async function preflightMacSettingsAutomation() {
  const host = getAccessibilityHostApp();
  const check = await checkAutomationGranted();
  if (check.granted) {
    console.log(`[Mac 设置] ✓ 自动化预检通过（${host.name} → 系统设置）`);
    return { ok: true, host: host.name };
  }

  console.warn(`[Mac 设置] 自动化预检未通过: ${check.reason ?? check.code ?? "unknown"}`);
  console.warn(
    `[Mac 设置] 请在 系统设置 → 隐私与安全性 → 自动化 中展开「${host.name}」并勾选「系统设置」`
  );
  openAutomationSettings();

  await ensureAutomation({ quiet: false, timeoutMs: 120_000 });
  return { ok: true, host: host.name };
}

/** 预检：登录窗口是否可见（解析 dump 脚本输出） */
async function preflightLoginWindowVisible(options = {}) {
  const route = options.route ?? "swift_ax";
  const phase = options.phase ?? "preflight";
  emitMacLoginStatus(options.onStatus, { route, phase, outcome: "started", reason: "ok" });
  try {
    const { stdout } = await execFileAsync("osascript", [DUMP_SCPT], {
      timeout: 25_000,
      env: sanitizedMacSettingsChildEnv(),
    });
    const text = stdout.trim();
    if (/login window found/.test(text) && /deep=[1-9]/.test(text)) {
      console.log("[Mac 设置] ✓ 预检：登录窗口已就绪");
      emitMacLoginStatus(options.onStatus, { route, phase, outcome: "succeeded", reason: "ok" });
      return true;
    }
    console.warn("[Mac 设置] 预检：登录窗口或输入框未就绪");
    emitMacLoginStatus(options.onStatus, {
      route,
      phase,
      outcome: "failed",
      reason: "preflight_unavailable",
    });
    return false;
  } catch {
    console.warn("[Mac 设置] 预检 AX probe 失败");
    emitMacLoginStatus(options.onStatus, {
      route,
      phase,
      outcome: "failed",
      reason: "preflight_unavailable",
    });
    return false;
  }
}

/** AppleScript 回退（索引式 BFS，不缓存元素引用） */
async function fillViaAppleScript(creds, options = {}) {
  console.log("[Mac 设置] AppleScript 回退填表…");
  emitMacLoginStatus(options.onStatus, {
    route: "applescript",
    phase: "state",
    outcome: "started",
    reason: "ok",
  });
  let stdout = "";
  let stderr = "";
  let executionFailed = false;
  let lastStep = 0;
  try {
    ({ stdout, stderr } = await execFileAsync("osascript", [LOGIN_SCPT], {
      timeout: 180_000,
      env: {
        ...sanitizedMacSettingsChildEnv(),
        APPLE_SCRIPT_APPLE_ID: creds.appleId,
        APPLE_SCRIPT_PASSWORD: creds.password,
        APPLE_SCRIPT_PANE_OPENED: "1",
      },
    }));
  } catch (error) {
    executionFailed = true;
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    stderr = typeof error?.stderr === "string" ? error.stderr : "";
  }

  if (stderr?.trim()) {
    for (const line of stderr.trim().split("\n")) {
      const match = /^\[step\s+(\d+)\]/.exec(line.trim());
      if (match) {
        lastStep = Math.max(lastStep, Number.parseInt(match[1], 10) || 0);
        console.log("[Mac 设置] AppleScript step " + match[1] + " complete");
      }
    }
  }
  const ok = !executionFailed && stdout?.trim() === "ok";
  const status = emitMacLoginStatus(options.onStatus, {
    route: "applescript",
    phase: ok ? "password" : appleScriptPhaseFromStep(lastStep),
    outcome: ok ? "succeeded" : "failed",
    reason: ok ? "ok" : executionFailed ? "applescript_failed" : "applescript_invalid_output",
  });
  if (!ok) throw createMacLoginError(status);
  return status;
}

export function mayUseAppleScriptFallback(status) {
  if (status?.route !== "swift_ax" || status?.inputRoute !== "unknown") {
    return false;
  }
  if (status?.phase === "dump" || status?.phase === "state") {
    return true;
  }
  if (status?.phase !== "email" && status?.phase !== "password") {
    return false;
  }
  return MAC_LOGIN_PREWRITE_FAILURE_REASONS.has(status?.reason);
}

export async function isMacSettingsSignedIn() {
  try {
    const { stdout } = await execFileAsync("osascript", [SIGNED_IN_SCPT], {
      timeout: 15_000,
      env: sanitizedMacSettingsChildEnv(),
    });
    return stdout.trim().toLowerCase() === "yes";
  } catch {
    return false;
  }
}

export function isMacSettingsSmsRuntimeEnabled(env = process.env) {
  if (env.APPLE_AUTOMATION_SMS_RECONFIGURE === "1") return true;
  if (env.APPLE_AUTOMATION_SMS_ENABLED === "0") return false;
  // Default on: SMS automation is enabled unless explicitly disabled.
  // Existing stored phone/URL or terminal prompt will provide credentials.
  return true;
}

/**
 * 打开系统设置 Apple ID 并填入账号密码（手机验证码人工完成）
 * @param {{ appleId: string, password: string }} creds
 */
export async function fillMacSettingsAppleLogin(creds, options = {}) {
  console.log("\n[Mac 设置] 打开 Apple ID 并填入账号密码…");

  await preflightMacSettingsAutomation();
  const built = compileAxFillHelper({ quiet: true });
  if (!built.ok) {
    emitMacLoginStatus(options.onStatus, {
      route: "swift_ax",
      phase: "preflight",
      outcome: "failed",
      reason: "compile_failed",
    });
  }

  await withAccessibilityRetry(
    async () => {
      console.log("[Mac 设置] 打开 Apple Account 深链…");
      openAppleAccountSettings({ env: sanitizedMacSettingsChildEnv() });
      await sleep(3500);

      try {
        await execFileAsync("osascript", [AUTOMATION_CHECK_SCPT], {
          timeout: 20_000,
          env: sanitizedMacSettingsChildEnv(),
        });
      } catch (err) {
        const msg = String(err?.stderr ?? err?.message ?? err);
        if (isAutomationDeniedError({ message: msg })) {
          openAutomationSettings();
          throw new Error(
            "缺少自动化权限：请在 系统设置 → 隐私与安全性 → 自动化 中允许当前终端 App 控制「系统设置」，然后重试。"
          );
        }
      }

      await preflightLoginWindowVisible({ onStatus: options.onStatus });

      // 主路径：Swift AX API
      if (isAxFillAvailable()) {
        try {
          await fillViaSwiftAx(creds, { onStatus: options.onStatus });
          return;
        } catch (swiftErr) {
          const swiftStatus = sanitizeMacLoginStatus(swiftErr?.macSettingsStatus);
          if (!mayUseAppleScriptFallback(swiftStatus)) {
            throw createMacLoginError(swiftStatus);
          }
          emitMacLoginStatus(options.onStatus, {
            ...swiftStatus,
            outcome: "fallback",
          });
          console.warn("[Mac 设置] Swift AX 主路径失败，回退 AppleScript…");
          await fillViaAppleScript(creds, { onStatus: options.onStatus });
          return;
        }
      } else {
        console.warn("[Mac 设置] Swift AX helper 不可用，使用 AppleScript 回退");
        emitMacLoginStatus(options.onStatus, {
          route: "swift_ax",
          phase: "preflight",
          outcome: "fallback",
          reason: "helper_unavailable",
        });
      }

      // The fallback resolves the same exact identifiers and can begin from a
      // fresh email page or an already advanced password page.
      await fillViaAppleScript(creds, { onStatus: options.onStatus });
    },
    { label: "Mac 系统设置填表", maxAttempts: 2 }
  );

  console.log("[Mac 设置] 填表结果: ok");
}

/**
 * 等待 Mac 设置中 Apple ID 完全登录（手机验证码人工 + 自动轮询 Sign Out / 邮箱）
 */
export async function waitForMacSettingsLoginComplete(options = {}) {
  const isSignedIn = options.isSignedIn ?? isMacSettingsSignedIn;
  const pause = options.sleep ?? sleep;
  const postSmsFinalization = options.postSmsFinalization;
  const postSmsIntervalMs = options.postSmsIntervalMs ?? 1_500;
  let postSmsDisabled = false;
  let nextPostSmsAt = 0;
  await waitUntil(
    "[Mac 设置] 请在系统设置中完成手机验证码（人工），脚本将等待直至检测到已登录…",
    async () => {
      if (
        typeof postSmsFinalization === "function" &&
        !postSmsDisabled &&
        Date.now() >= nextPostSmsAt
      ) {
        let result;
        try {
          result = await postSmsFinalization();
        } catch {
          result = { status: "manual_required" };
        }
        if (result?.status === "submitted") {
          // One invocation handles one stable modal. Keep polling so a later
          // terms/password/location sheet is processed by the same chain.
          postSmsDisabled = false;
          // Do not let the signed-in probe short-circuit the next modal. The
          // native helper is the only source that can prove no post-SMS sheet
          // remains; scan again immediately after a successful submission.
          nextPostSmsAt = 0;
          return false;
        } else if (result?.status === "complete") {
          postSmsDisabled = true;
        } else if (result?.status === "manual_required") {
          postSmsDisabled = true;
          console.warn("[Mac 设置] 后置弹窗未能稳定识别，保留页面供人工完成。");
        }
        if (result?.status !== "submitted") {
          nextPostSmsAt = Date.now() + Math.max(250, postSmsIntervalMs);
        }
      }
      if (await isSignedIn()) return true;
      return false;
    },
    {
      timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
      intervalMs: options.intervalMs ?? 2500,
      allowManualContinuation: false,
    }
  );

  await pause(options.settleMs ?? 1500);
  const ok = await isSignedIn();
  if (!ok) {
    throw new Error("MAC_SETTINGS_LOGIN_NOT_CONFIRMED");
  }
  console.log("[Mac 设置] ✓ 已检测到 Apple ID 登录完成");
  return { signedIn: true };
}

/**
 * @param {{ appleId: string, password: string }} creds
 * @param {{ smsEnv?: Record<string, string | undefined>, onStatus?: (status: object) => void }} [options]
 */
export async function runMacSettingsLoginPhase(creds, options = {}) {
  const version = ensureMacOS15({
    strict: false,
    env: sanitizedMacSettingsChildEnv(),
  });
  console.log(
    `[Mac 设置] macOS ${version.productVersion}（目标 macOS 15 Sequoia）`
  );

  const already = await isMacSettingsSignedIn();
  if (already) {
    console.log("[Mac 设置] 检测到已登录 Apple ID，跳过填表");
    return { skipped: true, signedIn: true };
  }

  const smsEnv = { ...process.env, ...(options.smsEnv ?? {}) };
  const smsConfig = isMacSettingsSmsRuntimeEnabled(smsEnv)
    ? await resolveMacSettingsSmsProviderConfig({ env: smsEnv })
    : null;
  if (smsConfig?.source === "terminal") {
    try {
      saveMacSettingsSmsProviderConfig(smsConfig);
      console.log("[短信] 短信服务配置已保存至 .env");
    } catch {
      throw new Error("MAC_SETTINGS_SMS_CONFIG_SAVE_FAILED");
    }
  }
  if (smsConfig) clearMacSettingsSmsRuntimeSecrets();

  await fillMacSettingsAppleLogin(creds, { onStatus: options.onStatus });
  if (smsConfig) {
    if (!isMacSettingsSmsHelperAvailable()) {
      console.warn(
        "[短信] 原生短信助手不可用，请在系统设置中手动完成短信验证"
      );
    } else {
      console.log("[短信] 等待短信验证界面出现…");
      await completeSupervisedMacSettingsSmsVerification({
        phoneNumber: smsConfig.phoneNumber,
        codeProvider: createSmsProviderCodePoller(smsConfig),
        supervised: true,
      });
      console.log(
        "[短信] 验证码已提交，Apple 将自动继续；请在系统设置中完成剩余步骤"
      );
    }
  } else {
    console.log("\n[Mac 设置] 账号密码已提交，如有短信验证请手动完成");
  }
  const postSmsEnabled = isMacSettingsPostSmsFinalizationEnabled(smsEnv);
  await waitForMacSettingsLoginComplete({
    postSmsFinalization: postSmsEnabled
      ? () =>
          completeMacSettingsPostSmsFinalization({
            supervised: true,
            scanTimeoutMs: 30_000,
            pollIntervalMs: 150,
          })
      : undefined,
  });
  return { skipped: false, signedIn: true };
}
