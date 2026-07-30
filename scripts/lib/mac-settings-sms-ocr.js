/**
 * OCR fallback for SMS verification – when AX cannot detect code entry
 * fields, use ScreenCaptureKit + Vision to locate and fill the input.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveNativeHelperPath } from "./native-helper-path.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OCR_HELPER_NAME = "mac-settings-sms-ocr";
const OCR_BIN = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  OCR_HELPER_NAME
);

function ocrFailure(message = "ocr_unavailable") {
  return { ok: false, stage: "ocr_unavailable", suffix: null, message };
}

export function isSmsOcrHelperAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    const stat = fs.statSync(OCR_BIN);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Run the SMS OCR helper.
 * @param {"ocr-state"|"ocr-code"} phase
 * @param {{ suffix?: string, code?: string, timeoutMs?: number }} [options]
 */
export async function runSmsOcrHelper(phase, options = {}) {
  if (!isSmsOcrHelperAvailable()) return ocrFailure("helper not compiled");

  const args = ["--phase", phase];
  if (options.suffix && /^[0-9]{2}$/.test(options.suffix)) {
    args.push("--suffix", options.suffix);
  }
  if (phase === "ocr-code" && options.code && /^[0-9]{6}$/.test(options.code)) {
    args.push("--code", options.code);
  }
  const timeoutMs = Math.trunc(options.timeoutMs ?? 15_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return ocrFailure();

  const env = { ...process.env };
  delete env.APPLE_AUTOMATION_MANUAL_SMS_CODE;
  delete env.APPLE_AUTOMATION_SMS_PHONE;
  delete env.APPLE_AUTOMATION_SMS_API_URL;

  try {
    const { stdout } = await execFileAsync(OCR_BIN, args, {
      timeout: timeoutMs,
      env,
      maxBuffer: 64 * 1024,
    });
    const result = JSON.parse(stdout);
    // Surface OCR diagnostic steps
    try {
      const { stderr } = await execFileAsync(OCR_BIN, args, {
        timeout: timeoutMs, env, maxBuffer: 64 * 1024,
      });
      // stderr diagnostics are already handled by the helper directly
    } catch { /* ignore stderr-only call */ }

    return {
      ok: result.ok === true,
      stage: result.stage || "unknown",
      suffix: result.suffix || null,
      message: result.message || "",
      inputFieldCount: Number.isInteger(result.inputFieldCount) ? result.inputFieldCount : 0,
    };
  } catch {
    return ocrFailure("ocr call failed");
  }
}

export function smsOcrHelperPath() {
  return OCR_BIN;
}
