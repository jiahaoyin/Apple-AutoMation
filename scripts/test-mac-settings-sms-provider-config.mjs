import assert from "node:assert/strict";
import fs from "node:fs";
import {
  captureMacSettingsSmsRuntimeEnv,
  isMacSettingsSmsReconfigureRequested,
  promptForMacSettingsSmsProviderField,
  resolveMacSettingsSmsProviderConfig,
} from "./lib/mac-settings-sms-provider.js";
import {
  isMacSettingsSmsRuntimeEnabled,
  sanitizedMacSettingsChildEnv,
  waitForMacSettingsLoginComplete,
} from "./lib/mac-settings-login.js";
import { sanitizedAxFillChildEnv } from "./lib/mac-settings-ax-fill.js";

assert.equal(isMacSettingsSmsRuntimeEnabled({}), true);
assert.equal(isMacSettingsSmsRuntimeEnabled({ APPLE_AUTOMATION_SMS_ENABLED: "1" }), true);
assert.equal(isMacSettingsSmsRuntimeEnabled({ APPLE_AUTOMATION_SMS_PHONE: "+8613800130051" }), true);
assert.equal(isMacSettingsSmsRuntimeEnabled({ APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private" }), true);
assert.equal(
  isMacSettingsSmsRuntimeEnabled({
    APPLE_AUTOMATION_SMS_ENABLED: "0",
    APPLE_AUTOMATION_SMS_PHONE: "+8613800130051",
    APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private",
  }),
  false
);
assert.equal(isMacSettingsSmsRuntimeEnabled({ APPLE_AUTOMATION_SMS_RECONFIGURE: "1" }), true);
assert.equal(isMacSettingsSmsReconfigureRequested({ APPLE_AUTOMATION_SMS_RECONFIGURE: "1" }), true);
assert.equal(isMacSettingsSmsReconfigureRequested({ APPLE_AUTOMATION_SMS_RECONFIGURE: "0" }), false);
const secretEnvFixture = {
  PATH: "/test/bin",
  APPLE_AUTOMATION_SMS_ENABLED: "1",
  APPLE_AUTOMATION_SMS_RECONFIGURE: "1",
  APPLE_AUTOMATION_SMS_PHONE: "+8613800130051",
  APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private",
  APPLE_AUTOMATION_MANUAL_SMS_CODE: "123456",
  APPLE_SCRIPT_APPLE_ID: "fixture@example.test",
};
const capturedSmsEnv = captureMacSettingsSmsRuntimeEnv({ ...secretEnvFixture });
assert.equal(capturedSmsEnv.APPLE_AUTOMATION_SMS_ENABLED, "1");
assert.equal(capturedSmsEnv.APPLE_AUTOMATION_SMS_RECONFIGURE, "1");
assert.equal(capturedSmsEnv.APPLE_AUTOMATION_SMS_PHONE, "+8613800130051");
assert.equal(capturedSmsEnv.APPLE_AUTOMATION_SMS_API_URL, "https://example.test/record?token=private");
const parentEnvFixture = { ...secretEnvFixture };
captureMacSettingsSmsRuntimeEnv(parentEnvFixture);
assert.equal(Object.hasOwn(parentEnvFixture, "APPLE_AUTOMATION_SMS_PHONE"), false);
assert.equal(Object.hasOwn(parentEnvFixture, "APPLE_AUTOMATION_SMS_API_URL"), false);
assert.equal(Object.hasOwn(parentEnvFixture, "APPLE_AUTOMATION_MANUAL_SMS_CODE"), false);
assert.equal(Object.hasOwn(parentEnvFixture, "APPLE_AUTOMATION_SMS_RECONFIGURE"), false);
for (const sanitize of [sanitizedMacSettingsChildEnv, sanitizedAxFillChildEnv]) {
  const childEnv = sanitize(secretEnvFixture);
  assert.equal(childEnv.PATH, "/test/bin");
  assert.equal(childEnv.APPLE_SCRIPT_APPLE_ID, "fixture@example.test");
  assert.equal(Object.hasOwn(childEnv, "APPLE_AUTOMATION_SMS_PHONE"), false);
  assert.equal(Object.hasOwn(childEnv, "APPLE_AUTOMATION_SMS_API_URL"), false);
  assert.equal(Object.hasOwn(childEnv, "APPLE_AUTOMATION_MANUAL_SMS_CODE"), false);
}
const config = await resolveMacSettingsSmsProviderConfig({ env: { APPLE_AUTOMATION_SMS_PHONE: "+8613800130051", APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private" } });
assert.equal(config.phoneNumber, "+8613800130051");
assert.equal(config.source, "stored");
const prompted = await resolveMacSettingsSmsProviderConfig({ env: {}, prompt: async ({ field }) => field === "phone" ? "+8613800130051" : "https://example.test/record?token=private" });
assert.equal(prompted.phoneNumber, "+8613800130051");
assert.equal(prompted.source, "terminal");
const notices = [];
const retries = [];
const repaired = await resolveMacSettingsSmsProviderConfig({
  env: { APPLE_AUTOMATION_SMS_PHONE: "+8613800130051" },
  notify: (message) => notices.push(message),
  prompt: async ({ field, secret }) => {
    retries.push({ field, secret });
    return field === "phone" ? "+8613800130052" : "https://example.test/record?token=private";
  },
});
assert.equal(repaired.phoneNumber, "+8613800130052");
assert.equal(repaired.source, "terminal");
assert.deepEqual(retries, [
  { field: "phone", secret: false },
  { field: "apiUrl", secret: true },
]);
assert.equal(notices.length, 1);
const reconfigurePrompts = [];
const reconfigured = await resolveMacSettingsSmsProviderConfig({
  env: {
    APPLE_AUTOMATION_SMS_PHONE: "+8613800130051",
    APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private",
    APPLE_AUTOMATION_SMS_RECONFIGURE: "1",
  },
  notify: () => {},
  prompt: async ({ field, secret }) => {
    reconfigurePrompts.push({ field, secret });
    return field === "phone" ? "+8613800130053" : "https://example.test/new?token=private";
  },
});
assert.equal(reconfigured.phoneNumber, "+8613800130053");
assert.equal(reconfigured.source, "terminal");
assert.deepEqual(reconfigurePrompts, [
  { field: "phone", secret: false },
  { field: "apiUrl", secret: true },
]);
await assert.rejects(
  () => resolveMacSettingsSmsProviderConfig({ env: { APPLE_AUTOMATION_SMS_PHONE: "+8613800130051" } }),
  (error) => error?.code === "MAC_SETTINGS_SMS_TTY_REQUIRED"
);
assert.equal(await promptForMacSettingsSmsProviderField({ field: "phone", secret: false }), null, "non-TTY interactive config is rejected without emitting secrets");
let signedInChecks = 0;
assert.deepEqual(
  await waitForMacSettingsLoginComplete({
    timeoutMs: 100,
    intervalMs: 1,
    settleMs: 0,
    sleep: async () => {},
    isSignedIn: async () => {
      signedInChecks += 1;
      return true;
    },
  }),
  { signedIn: true }
);
assert.equal(signedInChecks, 2);
let finalizationSignedInChecks = 0;
let finalizationCalls = 0;
const finalizationResults = [{ status: "submitted" }, { status: "not_required" }];
assert.deepEqual(
  await waitForMacSettingsLoginComplete({
    timeoutMs: 100,
    intervalMs: 1,
    settleMs: 0,
    sleep: async () => {},
    isSignedIn: async () => {
      finalizationSignedInChecks += 1;
      return finalizationSignedInChecks > 1;
    },
    postSmsFinalization: async () => {
      finalizationCalls += 1;
      return finalizationResults.shift() ?? { status: "not_required" };
    },
  }),
  { signedIn: true }
);
assert.equal(finalizationCalls, 2);
let signedInWithModalCalls = 0;
let signedInWithModalStates = [
  { status: "submitted" },
  { status: "not_required" },
];
assert.deepEqual(
  await waitForMacSettingsLoginComplete({
    timeoutMs: 100,
    intervalMs: 1,
    settleMs: 0,
    postSmsIntervalMs: 1,
    sleep: async () => {},
    isSignedIn: async () => true,
    postSmsFinalization: async () => {
      signedInWithModalCalls += 1;
      return signedInWithModalStates.shift() ?? { status: "not_required" };
    },
  }),
  { signedIn: true }
);
assert.equal(
  signedInWithModalCalls,
  2,
  "a signed-in probe must not skip a pending modal or the follow-up no-modal scan"
);
assert.doesNotMatch(fs.readFileSync(new URL("./lib/mac-settings-sms-ax.js", import.meta.url), "utf8"), /env\.APPLE_AUTOMATION_SMS_API_URL =/);
assert.match(fs.readFileSync(new URL("./lib/mac-settings-sms-provider.js", import.meta.url), "utf8"), /promptForSecretLine/);
const loginSource = fs.readFileSync(new URL("./lib/mac-settings-login.js", import.meta.url), "utf8");
assert.match(loginSource, /allowManualContinuation: false/);
assert.match(loginSource, /sanitizedMacSettingsChildEnv\(\)/);
assert.match(loginSource, /clearMacSettingsSmsRuntimeSecrets\(\)/);
assert.match(loginSource, /saveMacSettingsSmsProviderConfig\(smsConfig\)/);
assert.match(loginSource, /postSmsFinalization:/);
assert.match(loginSource, /scanTimeoutMs: 30_000/);
assert.match(loginSource, /const smsEnv = \{ \.\.\.process\.env, \.\.\.\(options\.smsEnv \?\? \{\}\) \};/);
assert.match(
  fs.readFileSync(new URL("./apple-id-full-flow.mjs", import.meta.url), "utf8"),
  /captureMacSettingsSmsRuntimeEnv\(\)/
);
assert.match(
  fs.readFileSync(new URL("./lib/mac-settings-ax-fill.js", import.meta.url), "utf8"),
  /sanitizedAxFillChildEnv\(\{ \.\.\.process\.env, \.\.\.\(opts\.env \?\? \{\}\) \}\)/
);
assert.match(
  fs.readFileSync(new URL("./lib/credentials.js", import.meta.url), "utf8"),
  /RUNTIME_ONLY_SMS_ENV_KEYS[\s\S]*?APPLE_AUTOMATION_MANUAL_SMS_CODE/
);
assert.doesNotMatch(
  fs.readFileSync(new URL("./lib/credentials.js", import.meta.url), "utf8").match(/RUNTIME_ONLY_SMS_ENV_KEYS[\s\S]*?\]\);/)?.[0] ?? "",
  /APPLE_AUTOMATION_SMS_API_URL/
);
assert.match(
  fs.readFileSync(new URL("../run.sh", import.meta.url), "utf8"),
  /unset APPLE_AUTOMATION_SMS_PHONE APPLE_AUTOMATION_SMS_API_URL APPLE_AUTOMATION_MANUAL_SMS_CODE/
);
assert.match(
  fs.readFileSync(new URL("./check-environment.mjs", import.meta.url), "utf8"),
  /loadEnvFile\(\);\s*captureMacSettingsSmsRuntimeEnv\(\);/
);
console.log("sms provider config: ok");
