import { promptForHiddenVerificationCode } from "./manual-verification-prompt.js";
import { runMacSettingsSmsHelper } from "./mac-settings-sms-ax.js";
import { sleep } from "./prompt.js";

const VALID_STAGES = new Set(["phone_selection", "code_entry", "waiting"]);
const SIX_DIGIT_CODE_RE = /^[0-9]{6}$/;
const TWO_DIGIT_SUFFIX_RE = /^[0-9]{2}$/;

// Per-invocation native helper timeout – short enough that a stuck helper
// won't block the poll loop for minutes, long enough for real AX work.
const NATIVE_CALL_TIMEOUT_MS = 15_000;
const PHONE_SELECTION_TOTAL_MS = 60_000;
const PROVIDER_POLL_MS = 250;

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
        phone_selection: `[SMS] Detecting trusted phone number … tail **${suffix}`,
        code_entry: "[SMS] Waiting for verification code …",
        waiting: "[SMS] System Settings is still preparing the SMS flow …",
        manual_phone: `[SMS] Phone selection did not complete automatically.`,
        manual_code: "[SMS] Verification code not received automatically.",
      };
      const msg = messages[stage] || `[SMS] Stage: ${stage}`;
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
      console.warn("[SMS] Unable to read the SMS verification screen. Is System Settings visible?");
      await pause(Math.min(pollIntervalMs, readRemainingMs(deadline, now)));
      continue;
    }

    // ── phone selection ────────────────────────────────────────────────
    if (state.stage === "phone_selection" && !selectionSubmitted) {
      reportStage("phone_selection");
      const phoneDeadline = now() + PHONE_SELECTION_TOTAL_MS;

      while (!selectionSubmitted && now() < phoneDeadline && readRemainingMs(deadline, now) > 0) {
        try {
          const selection = await invokeNative("sms-select", { suffix });
          if (selection?.ok === true) {
            console.log(`[SMS] ✓ Trusted number matched (${suffix}), clicking Continue…`);
            const continued = await invokeNative("sms-continue", { suffix });
            if (continued?.ok === true) {
              console.log("[SMS] ✓ Continue clicked, waiting for code entry…");
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
        console.warn(`\n[SMS] ⚠  Automatic phone selection did not complete.`);
        console.warn(`[SMS]    Please manually select the phone ending in **${suffix}`);
        console.warn("[SMS]    and click Continue in the System Settings window.");
        console.warn("[SMS]    Press Enter here when done (or wait for timeout)…\n");

        // Wait for user confirmation or remaining time.
        const manualDeadline = Math.min(deadline, now() + manualTimeoutMs);
        try {
          await promptForHiddenVerificationCode({
            prompt: `[SMS] Press Enter after selecting the phone **${suffix} and clicking Continue`,
            timeoutMs: readRemainingMs(manualDeadline, now),
            allowEmpty: true,
          });
          console.log("[SMS] Continuing after manual phone selection…");
          selectionSubmitted = true;
        } catch {
          console.warn("[SMS] Manual phone selection timed out, will retry…");
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
        console.log("[SMS] Polling the SMS provider for the verification code…");
        code = await acquireCode(codeProvider, providerTimeoutMs);
        if (code) {
          console.log("[SMS] ✓ Verification code received from provider.");
        }
      }

      // Fall back to manual input
      if (!code) {
        const remainingManual = Math.min(manualTimeoutMs, readRemainingMs(deadline, now));
        if (remainingManual <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT");

        if (isTTY) {
          reportStage("manual_code");
          console.warn("[SMS] Please enter the 6-digit verification code shown in System Settings.");
          console.warn("[SMS] The code will be hidden while you type.");
          try {
            code = await acquireCode(manualCodeProvider, remainingManual);
          } catch {
            code = null;
          }
        }

        if (!code && readRemainingMs(deadline, now) <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT");
        if (!code) {
          console.warn("[SMS] No code entered. Will retry…");
          await pause(Math.min(pollIntervalMs, readRemainingMs(deadline, now)));
          continue;
        }
        console.log("[SMS] ✓ Manual code accepted.");
      }

      // Fill the code via the native helper
      const filled = await invokeNative("sms-code", { code, suffix });
      if (filled?.ok !== true) {
        console.warn("[SMS] Failed to fill the code via AX. Please enter it manually in System Settings.");
        console.warn("[SMS] Press Enter when done…");
        try {
          await promptForHiddenVerificationCode({
            prompt: "[SMS] Press Enter after entering the verification code",
            timeoutMs: readRemainingMs(deadline, now),
            allowEmpty: true,
          });
        } catch {
          // Continue – the user may have submitted anyway.
        }
      } else {
        console.log("[SMS] ✓ Verification code submitted.");
      }
      return { status: "submitted" };
    }

    // ── waiting ─────────────────────────────────────────────────────────
    if (state.stage === "waiting") {
      if (pollCount === 0) reportStage("waiting");
      await pause(Math.min(pollIntervalMs, readRemainingMs(deadline, now)));
      continue;
    }
  }

  throw failure("MAC_SETTINGS_SMS_TIMEOUT");
}

export const MAC_SETTINGS_SMS_SUFFIX_RE = TWO_DIGIT_SUFFIX_RE;
