import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  completeMacSettingsPostSmsFinalization,
  isMacSettingsPostSmsFinalizationEnabled,
  normalizeMacSettingsPostSmsState,
} from "./lib/mac-settings-post-sms-finalization.js";
import {
  isTrustedMacSettingsPostSmsHelperOverride,
  normalizeMacSettingsPostSmsBinding,
  sanitizeMacSettingsPostSmsResult,
} from "./lib/mac-settings-post-sms-finalization-ax.js";

const binding = { axOwnerPid: 401, visualOwnerPid: 402, windowId: 403 };

assert.equal(isMacSettingsPostSmsFinalizationEnabled({}), true);
assert.equal(
  isMacSettingsPostSmsFinalizationEnabled({ APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED: "1" }),
  true
);
assert.equal(
  isMacSettingsPostSmsFinalizationEnabled({ APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED: "0" }),
  false
);
assert.deepEqual(normalizeMacSettingsPostSmsState({ ok: true, stage: "waiting" }), {
  ok: true,
  stage: "waiting",
  digits: null,
  binding: null,
});
for (const stage of ["terms", "mac_password", "location"]) {
  assert.deepEqual(normalizeMacSettingsPostSmsState({ ok: true, stage, binding }), {
    ok: true,
    stage,
    digits: null,
    binding,
  });
}
assert.deepEqual(normalizeMacSettingsPostSmsState({ ok: true, stage: "iphone_unlock", digits: 4, binding }), {
  ok: true,
  stage: "iphone_unlock",
  digits: 4,
  binding,
});
assert.deepEqual(normalizeMacSettingsPostSmsState({ ok: true, stage: "iphone_unlock", digits: 5 }), {
  ok: false,
  stage: "invalid",
  digits: null,
  binding: null,
});
assert.equal(normalizeMacSettingsPostSmsBinding(binding)?.windowId, 403);
assert.equal(normalizeMacSettingsPostSmsBinding({ ...binding, windowId: 0 }), null);
assert.equal(normalizeMacSettingsPostSmsBinding({ ...binding, axOwnerPid: 1.5 }), null);
assert.equal(normalizeMacSettingsPostSmsBinding({ ...binding, visualOwnerPid: 0x80000000 }), null);
assert.equal(normalizeMacSettingsPostSmsBinding({ ...binding, windowId: 0x1_0000_0000 }), null);
assert.deepEqual(sanitizeMacSettingsPostSmsResult("state", { ok: true, stage: "iphone_unlock", digits: 6, binding }), {
  ok: true,
  stage: "iphone_unlock",
  digits: 6,
  binding,
});
assert.deepEqual(sanitizeMacSettingsPostSmsResult("state", { ok: true, stage: "iphone_unlock", digits: 6 }), {
  ok: false,
  stage: "invalid",
  digits: null,
  binding: null,
});
for (const [phase, stage] of [
  ["terms", "terms_submitted"],
  ["mac-password", "mac_password_submitted"],
  ["unlock-code", "iphone_unlock_submitted"],
  ["location", "location_submitted"],
]) {
  assert.deepEqual(sanitizeMacSettingsPostSmsResult(phase, { ok: true, stage }), {
    ok: true,
    stage,
    digits: null,
    binding: null,
  });
}
assert.deepEqual(sanitizeMacSettingsPostSmsResult("unlock-code", { ok: true, stage: "waiting" }), {
  ok: false,
  stage: "invalid",
  digits: null,
  binding: null,
});

{
  const home = "C:\\Users\\post-sms-test";
  const helperDirectory = `${home}\\.apple-automation\\supervised-helpers`;
  const helperPath = `${helperDirectory}\\mac-settings-post-sms-finalization`;
  const stat = (kind, mode = 0o700) => ({
    mode,
    uid: 501,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  });
  const fsApi = {
    lstatSync(target) {
      if (target === helperDirectory) return stat("directory");
      if (target === helperPath) return stat("file", 0o500);
      throw new Error("unknown path");
    },
    realpathSync(target) {
      return target;
    },
  };
  const env = {
    HOME: home,
    APPLE_AUTOMATION_HELPER_DIR: helperDirectory,
    APPLE_AUTOMATION_SUPERVISED_GUI: "1",
    APPLE_AUTOMATION_SUPERVISED_TOKEN: "0123456789abcdef0123456789abcdef",
  };
  assert.equal(
    isTrustedMacSettingsPostSmsHelperOverride(env, { fs: fsApi, getuid: () => 501 }),
    true
  );
  assert.equal(
    isTrustedMacSettingsPostSmsHelperOverride(
      { ...env, APPLE_AUTOMATION_SUPERVISED_TOKEN: "bad" },
      { fs: fsApi, getuid: () => 501 }
    ),
    false
  );
}

{
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (phase, options) => {
      calls.push({ phase, ...options });
      return phase === "state"
        ? { ok: true, stage: "iphone_unlock", digits: 6, binding }
        : { ok: true, stage: "iphone_unlock_submitted" };
    },
    passcodeProvider: async (digits) => (digits === 6 ? "123456" : null),
  });
  assert.deepEqual(result, { status: "submitted" });
  assert.deepEqual(calls.map(({ phase }) => phase), ["state", "unlock-code"]);
  assert.equal(calls[1].passcode, "000000");
  assert.deepEqual(calls[1].binding, binding);
}

for (const [stateStage, phase, submittedStage] of [
  ["terms", "terms", "terms_submitted"],
  ["mac_password", "mac-password", "mac_password_submitted"],
  ["location", "location", "location_submitted"],
]) {
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (calledPhase, options) => {
      calls.push({ phase: calledPhase, ...options });
      return calledPhase === "state"
        ? { ok: true, stage: stateStage, binding }
        : { ok: true, stage: submittedStage };
    },
  });
  assert.deepEqual(result, { status: "submitted" });
  assert.deepEqual(calls.map(({ phase: calledPhase }) => calledPhase), ["state", phase]);
  assert.deepEqual(calls[1].binding, binding);
  if (stateStage === "mac_password") assert.equal(calls[1].password, "000000");
}

{
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (phase) => {
      calls.push(phase);
      return phase === "state"
        ? { ok: true, stage: "iphone_unlock", digits: 4, binding }
        : { ok: true, stage: "iphone_unlock_submitted" };
    },
  });
  assert.deepEqual(result, { status: "submitted" });
  assert.deepEqual(calls, ["state", "unlock-code"]);
}

{
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (phase) => {
      calls.push(phase);
      return { ok: true, stage: "iphone_unlock", digits: 4 };
    },
    passcodeProvider: async () => {
      throw new Error("a state without its original binding must not prompt");
    },
  });
  assert.deepEqual(result, { status: "manual_required" });
  assert.deepEqual(calls, ["state"]);
}

{
  let clock = 0;
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    scanTimeoutMs: 100,
    pollIntervalMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    nativeRunner: async () => ({ ok: true, stage: "waiting" }),
  });
  assert.deepEqual(result, { status: "not_required" });
}

assert.deepEqual(
  await completeMacSettingsPostSmsFinalization({ platform: "win32", supervised: true, isTTY: true }),
  { status: "manual_required" }
);

const helperSourceUrl = new URL(
  "./swift/mac-settings-post-sms-finalization.swift",
  import.meta.url
);
const helperSourcePath = fileURLToPath(helperSourceUrl);
const helperSource = fs.readFileSync(helperSourceUrl, "utf8");
if (process.platform === "darwin") {
  const typecheck = spawnSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-module-cache-path",
      path.join(os.tmpdir(), "apple-automation-swift-module-cache"),
      "-typecheck",
      helperSourcePath,
      "-framework",
      "ApplicationServices",
      "-framework",
      "AppKit",
      "-framework",
      "Vision",
      "-framework",
      "CoreGraphics",
      "-framework",
      "ScreenCaptureKit",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
  assert.equal(
    typecheck.status,
    0,
    typecheck.stderr || typecheck.stdout || typecheck.error?.message
  );
}
assert.match(helperSource, /CFGetTypeID\(positionValue\) == AXValueGetTypeID\(\)/);
assert.match(helperSource, /CFGetTypeID\(sizeValue\) == AXValueGetTypeID\(\)/);
assert.doesNotMatch(helperSource, /as\?\s+AXValue/);
assert.match(helperSource, /VNRecognizeTextRequest/);
assert.match(helperSource, /VNDetectRectanglesRequest/);
assert.match(helperSource, /request\.maximumAspectRatio = 1\.0/);
assert.doesNotMatch(helperSource, /request\.maximumAspectRatio = 1\.35/);
assert.match(helperSource, /guard !windows\.isEmpty else \{ continue \}/);
assert.match(helperSource, /axRole\(candidateRoot\) == kAXWindowRole as String/);
assert.match(helperSource, /return textContainsAny\(directTexts\(element\), passwordMarkers\)/);
assert.match(helperSource, /private func hasMacPasswordEvidence\(/);
assert.match(helperSource, /hasMacPasswordEvidence\(passwordText\)/);
assert.match(helperSource, /private func hasTermsEvidence\(/);
assert.match(helperSource, /private func hasLocationEvidence\(/);
assert.match(helperSource, /find my mac/);
assert.match(helperSource, /value\.contains\("enter"\)/);
assert.match(helperSource, /apple\\u\{8D26\}\\u\{53F7\}/);
assert.match(helperSource, /apple\\u\{5E33\}\\u\{865F\}/);
assert.match(helperSource, /\\u\{4E0D\}\\u\{77E5\}\\u\{9053\}\\u\{5BC6\}\\u\{78BC\}/);
assert.match(helperSource, /\\u\{5FD8\}\\u\{8A18\}\\u\{5BC6\}\\u\{78BC\}/);
assert.match(helperSource, /\\u\{89E3\}\\u\{9396\}/);
assert.match(helperSource, /\\u\{5BC6\}\\u\{78BC\}/);
assert.match(helperSource, /private func titleLinesAreAdjacent\(/);
assert.ok(
  helperSource.includes('looksLikeVisionUnlockTitle("\\(upper.text) \\(lower.text)")')
);
const targetBindingBody = helperSource.slice(
  helperSource.indexOf("private func uniqueUnlockTarget"),
  helperSource.indexOf("private func sameTarget")
);
assert.match(targetBindingBody, /guard hasUnlockSecondaryEvidence\(text\) else/);
assert.doesNotMatch(targetBindingBody, /looksLikeIPhoneUnlockSheet\(text\)/);
assert.match(helperSource, /candidate[s]?\.count == 4 \|\| candidate[s]?\.count == 6/);
assert.match(helperSource, /cellGroupsAreStable/);
assert.match(helperSource, /private func unlockCellsAreVisuallyEmpty\(/);
assert.match(helperSource, /private func cellInteriorHasVisibleMark\(/);
assert.match(helperSource, /targetWindowIsTopmostAtPoint/);
assert.match(helperSource, /hitTestMatchesBoundTarget/);
assert.match(helperSource, /private func axElementsEqual\(/);
assert.match(helperSource, /private func isDescendant\(/);
assert.match(helperSource, /private func hitTestMatchesBoundSurface\(/);
assert.match(helperSource, /private func activateBoundModalTarget\(/);
assert.match(helperSource, /private func submitTerms\(/);
assert.match(helperSource, /private func submitMacPassword\(/);
assert.match(helperSource, /private func submitLocation\(/);
assert.match(helperSource, /fixedMacPassword = String\(repeating: "0", count: 6\)/);
assert.match(
  helperSource,
  /if axOwnerPID == visualHost\.processIdentifier,[\s\S]*?surfaceWindowID != visualWindow\.windowID/
);
const hitTestBody = helperSource.slice(
  helperSource.indexOf("private func hitTestMatchesBoundTarget"),
  helperSource.indexOf("private func activateBoundSettingsWindow")
);
assert.match(hitTestBody, /if axElementsEqual\(node, target\.window\) \{ return true \}/);
assert.doesNotMatch(hitTestBody, /isTrustedAppleIDSettingsExtension\(axOwner\)[\s\S]*?return true\s*\n\}/);
assert.match(helperSource, /private func activateBoundSettingsWindow\(/);
assert.match(helperSource, /visualHost\.activate\(options: \[\.activateIgnoringOtherApps\]\)/);
assert.match(helperSource, /AXUIElementPerformAction\(visualWindow, kAXRaiseAction as CFString\)/);
assert.match(helperSource, /private func waitForUnlockAdvanceOrPressContinue\(/);
assert.match(helperSource, /for attempt in 0\.\.<25/);
const advanceBody = helperSource.slice(
  helperSource.indexOf("private func waitForUnlockAdvanceOrPressContinue"),
  helperSource.indexOf("private func submitUnlockPasscode")
);
assert.match(advanceBody, /let automaticAdvanceGracePolls = 7/);
assert.match(
  advanceBody,
  /if attempt >= automaticAdvanceGracePolls && isEnabled\(remainingTarget\.continueButton\)/
);
assert.match(helperSource, /FileHandle\.standardInput\.readDataToEndOfFile/);
assert.match(helperSource, /case "unlock-code"/);
assert.match(helperSource, /case "terms"/);
assert.match(helperSource, /case "mac-password"/);
assert.match(helperSource, /case "location"/);
assert.match(helperSource, /\["terms", "mac-password", "unlock-code", "location"\]/);
assert.match(helperSource, /identifier: "action-button-2"/);
assert.doesNotMatch(helperSource, /AXUIElementPerformAction\(target\.secondaryButton/);
assert.match(helperSource, /--ax-owner-pid/);
assert.match(helperSource, /--visual-owner-pid/);
assert.match(helperSource, /--window-id/);
assert.doesNotMatch(helperSource, /NSPasteboard|writeToFile|createFile|ProcessInfo\.processInfo\.environment/);
assert.doesNotMatch(helperSource, /APPLE_AUTOMATION_MANUAL_SMS_CODE|APPLE_ID|APPLE_PASSWORD/);
const submitBody = helperSource.slice(
  helperSource.indexOf("private func submitUnlockPasscode"),
  helperSource.indexOf("private struct Invocation")
);
assert.match(
  submitBody,
  /let preActivationTarget = uniqueUnlockTarget\(\),[\s\S]*?preActivationTarget\.binding == expectedBinding,[\s\S]*?await activateBoundSettingsWindow\(preActivationTarget\)/
);
assert.ok(
  submitBody.indexOf("await activateBoundSettingsWindow(preActivationTarget)") <
    submitBody.indexOf("stableUnlockCellTarget("),
  "the trusted System Settings window must be foregrounded before visual cell capture and input"
);
assert.match(submitBody, /expectedBinding: expectedBinding/);
assert.match(submitBody, /currentTarget\.binding == expectedBinding/);
assert.match(submitBody, /refreshedTarget\.binding == expectedBinding/);
assert.match(submitBody, /await waitForUnlockAdvanceOrPressContinue\(/);
assert.doesNotMatch(submitBody, /Task\.sleep\(nanoseconds: 900_000_000\)/);

const stableTargetBody = helperSource.slice(
  helperSource.indexOf("private func stableUnlockCellTarget"),
  helperSource.indexOf("private func postClickUnicodeDigit")
);
assert.match(stableTargetBody, /captureWindowByID\(firstWindow\.binding\.windowID\)/);
assert.match(stableTargetBody, /captureWindowByID\(currentWindow\.binding\.windowID\)/);
assert.doesNotMatch(stableTargetBody, /\b(?:firstWindow|currentWindow)\.windowID\b/);
assert.match(
  stableTargetBody,
  /let firstPoint = screenPointForCell\(firstCells\[0\], in: firstWindow\),[\s\S]*?targetWindowIsTopmostAtPoint\(firstWindow, point: firstPoint\),[\s\S]*?hitTestMatchesBoundTarget\(firstTarget, window: firstWindow, point: firstPoint\)/
);
assert.match(
  stableTargetBody,
  /let currentPoint = screenPointForCell\(secondCells\[0\], in: currentWindow\),[\s\S]*?targetWindowIsTopmostAtPoint\(currentWindow, point: currentPoint\),[\s\S]*?hitTestMatchesBoundTarget\(currentTarget, window: currentWindow, point: currentPoint\)/
);

const wrapperSource = fs.readFileSync(
  new URL("./lib/mac-settings-post-sms-finalization-ax.js", import.meta.url),
  "utf8"
);
assert.match(wrapperSource, /stdinExec/);
assert.match(wrapperSource, /child\.stdin\.end\(input\)/);
assert.match(wrapperSource, /phase === "unlock-code"/);
assert.match(wrapperSource, /phase === "mac-password"/);
assert.match(wrapperSource, /new Set\(\["state", "terms", "mac-password", "unlock-code", "location"\]\)/);
assert.match(wrapperSource, /options\.password !== "000000"/);
assert.match(wrapperSource, /normalizeMacSettingsPostSmsBinding\(options\.binding\)/);
assert.match(wrapperSource, /"--ax-owner-pid"/);
assert.match(wrapperSource, /"--visual-owner-pid"/);
assert.match(wrapperSource, /"--window-id"/);
assert.match(wrapperSource, /CHILD_SECRET_ENV_KEYS/);
assert.match(wrapperSource, /for \(const key of CHILD_SECRET_ENV_KEYS\) delete env\[key\]/);
assert.doesNotMatch(wrapperSource, /args\.push\("--(?:value|passcode)/);
assert.doesNotMatch(wrapperSource, /https?:\/\/|\bfetch\s*\(/i);

const controllerSource = fs.readFileSync(
  new URL("./lib/mac-settings-post-sms-finalization.js", import.meta.url),
  "utf8"
);
assert.doesNotMatch(controllerSource, /promptForHiddenDevicePasscode/);
assert.match(controllerSource, /"0"\.repeat\(state\.digits\)/);
assert.match(controllerSource, /actionOptions\.password = "000000"/);
assert.match(controllerSource, /mac-password/);
assert.match(controllerSource, /location/);
assert.match(controllerSource, /APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED/);
assert.doesNotMatch(controllerSource, /readFile(?:Sync)?\([^)]*\.env/);
assert.doesNotMatch(controllerSource, /APPLE_PASSWORD|APPLE_ID(?:\W|$)/);

console.log("mac settings post-SMS finalization: ok");
