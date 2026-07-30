import { promptForHiddenVerificationCode } from "./manual-verification-prompt.js";
import { runMacSettingsSmsHelper } from "./mac-settings-sms-ax.js";
import { runSmsOcrHelper, isSmsOcrHelperAvailable } from "./mac-settings-sms-ocr.js";
import { sleep } from "./prompt.js";

const VALID_STAGES = new Set(["phone_selection", "code_entry", "waiting"]);
const SIX_DIGIT_CODE_RE = /^[0-9]{6}$/;
const TWO_DIGIT_SUFFIX_RE = /^[0-9]{2}$/;

// Per-invocation native helper timeout – short enough that a stuck helper
// won't block the poll loop for minutes, long enough for real AX work.
const NATIVE_CALL_TIMEOUT_MS = 15_000;
const PHONE_SELECTION_TOTAL_MS = 60_000;
const MAX_WAIT_WITHOUT_PROGRESS_MS = 90_000;
const WAIT_PROGRESS_INTERVAL_MS = 15_000;

function failure(code) { const error = new Error(code); error.code = code; return error; }
function readRemainingMs(deadline, now) { return Math.max(0, deadline - now()); }
function boundedPositiveInteger(value, fallback, errorCode) { const candidate = value ?? fallback; if (!Number.isFinite(candidate) || candidate <= 0) throw failure(errorCode); const normalized = Math.trunc(candidate); if (normalized <= 0) throw failure(errorCode); return normalized; }

export function trustedPhoneSuffix(phoneNumber) {
  const raw = String(phoneNumber ?? "").trim();
  if (!/^\+?[0-9()\s.-]+$/.test(raw)) throw failure("MAC_SETTINGS_SMS_PHONE_INVALID");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) throw failure("MAC_SETTINGS_SMS_PHONE_INVALID");
  return digits.slice(-2);
}

export function normalizeManualSmsCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  return SIX_DIGIT_CODE_RE.test(code) ? code : null;
}

export function normalizeMacSettingsSmsState(value) {
  if (!value || typeof value !== "object" || value.ok !== true) return { ok: false, stage: "invalid" };
  const stage = value.stage;
  return { ok: true, stage: VALID_STAGES.has(stage) ? stage : "invalid" };
}

async function readCodeWithinDeadline(provider, { signal, timeoutMs }) {
  let removeAbortListener = () => {};
  const aborted = new Promise((resolve) => {
    const onAbort = () => resolve(null);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider({ signal, timeoutMs })).catch(() => null),
      aborted,
    ]);
  } finally { removeAbortListener(); }
}

async function defaultNativeRunner(phase, options) {
  return runMacSettingsSmsHelper(phase, options);
}

/**
 * Complete macOS System Settings SMS verification with full terminal feedback,
 * per-stage timeouts, and manual fallback at every decision point.
 *
 * Stages:
 *   1. phone_selection — pick the trusted number, click Continue
 *   2. code_entry      — obtain the 6-digit code (provider or manual) and fill
 *   3. waiting         — System Settings is still loading; poll with feedback
 */
export async function completeSupervisedMacSettingsSmsVerification(options = {}) {
  const suffix = trustedPhoneSuffix(options.phoneNumber);
  const platform = options.platform ?? process.platform;
  const isTTY = options.isTTY ?? Boolean(process.stdin?.isTTY === true);
  if (platform !== "darwin") throw failure("MAC_SETTINGS_SMS_UNSUPPORTED_PLATFORM");

  const codeProvider = options.codeProvider ?? null;
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, codeProvider ? 420_000 : 120_000, "MAC_SETTINGS_SMS_TIMEOUT_INVALID");
  const providerTimeoutMs = boundedPositiveInteger(options.providerTimeoutMs, 120_000, "MAC_SETTINGS_SMS_PROVIDER_TIMEOUT_INVALID");
  const manualTimeoutMs = boundedPositiveInteger(options.manualTimeoutMs, 300_000, "MAC_SETTINGS_SMS_MANUAL_TIMEOUT_INVALID");
  const pollIntervalMs = Math.max(50, boundedPositiveInteger(options.pollIntervalMs, 500, "MAC_SETTINGS_SMS_POLL_INTERVAL_INVALID"));
  const nativeCallTimeoutMs = Math.min(NATIVE_CALL_TIMEOUT_MS, pollIntervalMs > 0 ? pollIntervalMs * 3 : NATIVE_CALL_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const nativeRunner = options.nativeRunner ?? defaultNativeRunner;
  const manualCodeProvider = options.manualCodeProvider ?? promptForHiddenVerificationCode;

  const deadline = now() + timeoutMs;
  let selectionSubmitted = false;
  let lastStage = "initial";
  let pollCount = 0;
  let waitingStartedAt = 0;
  let lastWaitProgressAt = 0;
  let axWaitingCount = 0;
  let ocrAvailable = isSmsOcrHelperAvailable();

  // ── helpers ──────────────────────────────────────────────────────────

  const invokeNative = async (phase, values = {}) => {
    const remainingMs = readRemainingMs(deadline, now);
    if (remainingMs <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT");
    const callTimeout = Math.min(nativeCallTimeoutMs, remainingMs);
    const result = await nativeRunner(phase, { ...values, timeoutMs: callTimeout });
    if (readRemainingMs(deadline, now) <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT");
    return result;
  };

  const acquireCode = async (provider, maxMs) => {
    const availableMs = Math.min(maxMs, readRemainingMs(deadline, now));
    if (availableMs <= 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), availableMs);
    try {
      const value = await readCodeWithinDeadline(provider, { signal: controller.signal, timeoutMs: availableMs });
      return controller.signal.aborted ? null : normalizeManualSmsCode(value);
    } finally { clearTimeout(timer); }
  };

  const reportStage = (stage, detail = "") => {
    if (stage !== lastStage || pollCount === 0) {
      const messages = {
        phone_selection: `[短信验证] 正在检测受信任号码 … 尾号 **${suffix}`,
        code_entry: "[短信验证] 等待验证码 …",
        waiting: "[短信验证] 系统设置短信界面正在加载 …",
        manual_phone: `[短信验证] 号码选择未自动完成`,
        manual_code: "[短信验证] 未自动获取到验证码",
      };
      const msg = messages[stage] || `[短信验证] 阶段: ${stage}`;
      if (detail) console.log(`${msg} ${detail}`);
      else console.log(msg);
      lastStage = stage;
      pollCount = 0;
    }
    pollCount += 1;
  };

  // ── main poll loop ───────────────────────────────────────────────────

  while (readRemainingMs(deadline, now) > 0) {
    const state = normalizeMacSettingsSmsState(await invokeNative("sms-state", { suffix }));

    if (!state.ok || state.stage === "invalid") {
      console.warn("[短信验证] 无法读取短信验证界面，系统设置窗口是否可见？");
      await pause(Math.min(pollIntervalMs, readRemainingMs(deadline, now)));
      continue;
    }

    // Reset the "stuck in waiting" tracker whenever we see a concrete stage.
    if (state.stage !== "waiting") {
      waitingStartedAt = 0;
      axWaitingCount = 0;
      reportStage(state.stage);
    }

    // When AX keeps returning "waiting", try OCR as a fallback every ~8 polls
    if (state.stage === "waiting" && ocrAvailable) {
      axWaitingCount += 1;
      if (axWaitingCount >= 8) {
        axWaitingCount = 0;
        console.log("[短信验证] 尝试 OCR 辅助检测界面状态 …");
        try {
          const ocrState = await runSmsOcrHelper("ocr-state", {
            suffix,
            timeoutMs: nativeCallTimeoutMs,
          });
          if (ocrState?.ok && ocrState.stage === "code_entry") {
            console.log("[短信验证] OCR 检测到验证码输入界面 (尾号 " + (ocrState.suffix || "?") + ")");
            // Treat OCR code_entry as authoritative — jump to code entry flow
            state = { ok: true, stage: "code_entry" };
            waitingStartedAt = 0;
          } else if (ocrState?.ok && ocrState.stage === "phone_selection") {
            console.log("[短信验证] OCR 检测到号码选择界面");
            // Fall through to phone_selection handling below
            state = { ok: true, stage: "phone_selection" };
            waitingStartedAt = 0;
          } else {
            console.log("[短信验证] OCR 未能确定界面状态: " + (ocrState?.message || "unknown"));
          }
        } catch {
          console.log("[短信验证] OCR 调用失败，继续使用 AX 检测");
        }
      }
    }

    // ── phone selection ────────────────────────────────────────────────
    if (state.stage === "phone_selection" && !selectionSubmitted) {
      reportStage("phone_selection");
      const phoneDeadline = now() + PHONE_SELECTION_TOTAL_MS;

      while (!selectionSubmitted && now() < phoneDeadline && readRemainingMs(deadline, now) > 0) {
        try {
          const selection = await invokeNative("sms-select", { suffix });
          if (selection?.ok === true) {
            console.log(`[短信验证] ✓ 已匹配受信任号码尾号 ${suffix}，点击继续…`);
            const continued = await invokeNative("sms-continue", { suffix });
            if (continued?.ok === true) {
              console.log("[短信验证] ✓ 已点击继续，等待验证码输入界面…");
              selectionSubmitted = true;
              break;
            }
          }
        } catch {
          // Native helper timed out – retry after a short pause.
        }
        await pause(Math.min(1_000, readRemainingMs(deadline, now)));
      }

      if (!selectionSubmitted) {
        // Manual fallback: ask the user to select the number and click Continue.
        console.warn(`\n[短信验证] ⚠  号码自动选择未完成`);
        console.warn(`[短信验证]    请在系统设置中手动选择尾号为 **${suffix} 的号码`);
        console.warn("[短信验证]    并点击「继续」，完成后按回车…\n");

        // Wait for user confirmation or remaining time.
        const manualDeadline = Math.min(deadline, now() + manualTimeoutMs);
        try {
          await promptForHiddenVerificationCode({
            prompt: `[短信验证] 选择尾号 **${suffix} 并点击继续后，按回车确认`,
            timeoutMs: readRemainingMs(manualDeadline, now),
            allowEmpty: true,
          });
          console.log("[短信验证] 已确认手动选号，继续流程…");
          selectionSubmitted = true;
        } catch {
          console.warn("[短信验证] 手动选号等待超时，将重试…");
        }
        continue;
      }
    }

    // ── code entry ──────────────────────────────────────────────────────
    if (state.stage === "code_entry") {
      reportStage("code_entry");

      // Try provider first
      let code = null;
      if (codeProvider) {
        console.log("[短信验证] 正在通过短信服务获取验证码 …");
        code = await acquireCode(codeProvider, providerTimeoutMs);
        if (code) {
          console.log("[短信验证] ✓ 已从短信服务获取验证码");
        }
      }

      // Fall back to manual input
      if (!code) {
        const remainingManual = Math.min(manualTimeoutMs, readRemainingMs(deadline, now));
        if (remainingManual <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT");

        if (isTTY) {
          reportStage("manual_code");
          console.warn("[短信验证] 请在终端输入系统设置中显示的 6 位验证码");
          console.warn("[短信验证] 输入时不会回显");
          try {
            code = await acquireCode(manualCodeProvider, remainingManual);
          } catch {
            code = null;
          }
        }

        if (!code && readRemainingMs(deadline, now) <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT");
        if (!code) {
          console.warn("[短信验证] 未输入验证码，将重试…");
          await pause(Math.min(pollIntervalMs, readRemainingMs(deadline, now)));
          continue;
        }
        console.log("[短信验证] ✓ 已接受手动输入的验证码");
      }

      // Fill the code via the native helper (AX first, OCR fallback)
      let filled = await invokeNative("sms-code", { code, suffix });
      if (filled?.ok !== true && ocrAvailable) {
        console.log("[短信验证] AX 填写失败，尝试 OCR 辅助键入 …");
        try {
          const ocrCodeResult = await runSmsOcrHelper("ocr-code", {
            code,
            suffix,
            timeoutMs: nativeCallTimeoutMs,
          });
          if (ocrCodeResult?.ok && ocrCodeResult.stage === "code_submitted") {
            console.log("[短信验证] ✓ OCR 已键入验证码");
            filled = { ok: true, stage: "code_submitted" };
          }
        } catch {
          console.warn("[短信验证] OCR 键入失败");
        }
      }
      if (filled?.ok !== true) {
        console.warn("[短信验证] 自动填写验证码失败，请直接在系统设置中输入后手动提交");
      } else {
        console.log("[短信验证] ✓ 验证码已提交");
      }
      return { status: "submitted" };
    }

    // ── waiting ─────────────────────────────────────────────────────────
    if (state.stage === "waiting") {
      if (waitingStartedAt === 0) {
        waitingStartedAt = now();
        lastWaitProgressAt = now();
        console.log("[短信验证] 等待短信验证界面出现 …");
      }

      const waitedMs = now() - waitingStartedAt;
      // Periodic progress so the user knows the script is still alive.
      if (now() - lastWaitProgressAt >= WAIT_PROGRESS_INTERVAL_MS) {
        const elapsedSec = Math.round(waitedMs / 1000);
        console.log(`[短信验证] 仍在等待 … (已等待 ${elapsedSec} 秒，每 ${pollIntervalMs}ms 检测一次)`);
        lastWaitProgressAt = now();
      }

      // If we have been stuck in "waiting" for too long without ever seeing
      // phone_selection or code_entry, offer the user a manual path.
      if (waitedMs >= MAX_WAIT_WITHOUT_PROGRESS_MS) {
        console.warn(`\n[短信验证] ⚠  已等待 ${Math.round(waitedMs / 1000)} 秒仍未检测到短信验证界面`);
        console.warn("[短信验证]    如果验证码界面已显示，可直接在下方输入验证码");
        console.warn("[短信验证]    如果号码选择界面已显示，请手动选号并点继续后输入验证码\n");

        if (isTTY) {
          try {
            const manualCode = await acquireCode(manualCodeProvider, manualTimeoutMs);
            if (manualCode) {
              console.log("[短信验证] ✓ 已接受手动验证码，正在提交 …");
              let filled = await invokeNative("sms-code", { code: manualCode, suffix });
              if (filled?.ok !== true && ocrAvailable) {
                console.log("[短信验证] AX 填写失败，尝试 OCR 辅助键入 …");
                try {
                  const ocrResult = await runSmsOcrHelper("ocr-code", { code: manualCode, suffix, timeoutMs: nativeCallTimeoutMs });
                  if (ocrResult?.ok && ocrResult.stage === "code_submitted") {
                    console.log("[短信验证] ✓ OCR 已键入验证码");
                    filled = { ok: true, stage: "code_submitted" };
                  }
                } catch { /* OCR fallback failed */ }
              }
              if (filled?.ok !== true) {
                console.warn("[短信验证] 自动填写失败，请在系统设置中直接输入验证码后手动提交");
              } else {
                console.log("[短信验证] ✓ 验证码已提交");
              }
              return { status: "submitted" };
            }
          } catch {
            // Manual input cancelled or timed out.
          }
        }

        // Reset wait tracking so we don't immediately re-prompt.
        waitingStartedAt = now();
        lastWaitProgressAt = now();
        console.warn("[短信验证] 恢复自动检测 …");
      }

      await pause(Math.min(pollIntervalMs, readRemainingMs(deadline, now)));
      continue;
    }

  throw failure("MAC_SETTINGS_SMS_TIMEOUT");
  }
}

export const MAC_SETTINGS_SMS_SUFFIX_RE = TWO_DIGIT_SUFFIX_RE;
