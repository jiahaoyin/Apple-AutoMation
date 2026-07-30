import {
  normalizeMacSettingsPostSmsBinding,
  runMacSettingsPostSmsHelper,
} from "./mac-settings-post-sms-finalization-ax.js";
import { sleep } from "./prompt.js";

const VALID_STAGES = new Set(["waiting", "terms", "mac_password", "iphone_unlock", "location"]);
const ACTION_BY_STAGE = new Map([
  ["terms", "terms"],
  ["mac_password", "mac-password"],
  ["iphone_unlock", "unlock-code"],
  ["location", "location"],
]);

function remainingMs(deadline, now) {
  return Math.max(0, deadline - now());
}

function boundedPositive(value, fallback) {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : fallback;
}

export function isMacSettingsPostSmsFinalizationEnabled(env = process.env) {
  return env.APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED !== "0";
}

export function normalizeMacSettingsPostSmsState(value) {
  if (!value || value.ok !== true || !VALID_STAGES.has(value.stage)) {
    return { ok: false, stage: "invalid", digits: null, binding: null };
  }
  if (value.stage === "waiting") {
    return { ok: true, stage: "waiting", digits: null, binding: null };
  }
  if (["terms", "mac_password", "location"].includes(value.stage)) {
    const binding = normalizeMacSettingsPostSmsBinding(value.binding);
    return binding
      ? { ok: true, stage: value.stage, digits: null, binding }
      : { ok: false, stage: "invalid", digits: null, binding: null };
  }
  const binding = normalizeMacSettingsPostSmsBinding(value.binding);
  return (value.digits === 4 || value.digits === 6) && binding
    ? { ok: true, stage: "iphone_unlock", digits: value.digits, binding }
    : { ok: false, stage: "invalid", digits: null, binding: null };
}

/**
 * Complete one trusted post-SMS modal per invocation. The next login poll can
 * pick up a subsequent modal, so a successful action never disables polling.
 * Device and Mac password fixtures are intentionally supplied as zeroes by
 * the supervised test flow, and are sent to Swift only over stdin.
 */
export async function completeMacSettingsPostSmsFinalization(options = {}) {
  const platform = options.platform ?? process.platform;
  const supervised = options.supervised ?? process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
  const isTTY = options.isTTY ?? Boolean(
    process.stdin?.isTTY === true && (process.stdout?.isTTY === true || supervised === true)
  );
  if (platform !== "darwin" || supervised !== true || isTTY !== true) {
    return { status: "manual_required" };
  }

  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const nativeRunner = options.nativeRunner ?? runMacSettingsPostSmsHelper;
  const scanTimeoutMs = boundedPositive(options.scanTimeoutMs, 45_000);
  const actionTimeoutMs = boundedPositive(options.actionTimeoutMs, 60_000);
  const pollIntervalMs = Math.max(100, boundedPositive(options.pollIntervalMs, 750));
  const deadline = now() + scanTimeoutMs;

  while (remainingMs(deadline, now) > 0) {
    let rawState;
    try {
      rawState = await nativeRunner("state", {
        timeoutMs: Math.min(remainingMs(deadline, now), 15_000),
      });
    } catch {
      return { status: "manual_required" };
    }
    const state = normalizeMacSettingsPostSmsState(rawState);
    if (!state.ok) return { status: "manual_required" };
    if (state.stage !== "waiting") {
      const phase = ACTION_BY_STAGE.get(state.stage);
      if (!phase || !state.binding) return { status: "manual_required" };
      const actionOptions = {
        binding: state.binding,
        timeoutMs: actionTimeoutMs,
      };
      if (state.stage === "mac_password") actionOptions.password = "000000";
      if (state.stage === "iphone_unlock") {
        actionOptions.passcode = "0".repeat(state.digits);
      }
      let submitted;
      try {
        submitted = await nativeRunner(phase, actionOptions);
      } catch {
        submitted = null;
      }
      const expectedStage = {
        terms: "terms_submitted",
        mac_password: "mac_password_submitted",
        iphone_unlock: "iphone_unlock_submitted",
        location: "location_submitted",
      }[state.stage];
      if (submitted?.ok === true && submitted.stage === expectedStage) {
        console.log(`[Mac 设置] 已处理后置弹窗: ${state.stage}`);
        return { status: "submitted" };
      }
      console.warn(`[Mac 设置] 后置弹窗处理失败: ${state.stage}，保留页面供人工核对。`);
      return { status: "manual_required" };
    }
    await pause(Math.min(pollIntervalMs, remainingMs(deadline, now)));
  }

  return { status: "not_required" };
}
