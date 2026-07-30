import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectRuntimeImports,
  COPY_PATHS,
  renderInstallSh,
  renderRunSh,
} from "./build-release.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const legacy2FAHelpers = [
  ["apple-2fa", "wait.scpt"].join("-"),
  ["apple-2fa", "phase.applescript"].join("-"),
  ["2fa", "automation", "check.applescript"].join("-"),
  ["accessibility", "check.applescript"].join("-"),
];
const ignoredRepositoryDirectories = new Set([
  ".git",
  ".runtime",
  "data",
  "dist",
  "node_modules",
]);
const ignoredRepositorySubtrees = new Set(["docs/superpowers"]);
const repositoryTextExtensions = new Set([
  ".applescript",
  ".cjs",
  ".json",
  ".js",
  ".md",
  ".mjs",
  ".py",
  ".scpt",
  ".sh",
  ".swift",
  ".txt",
  ".yaml",
  ".yml",
]);

function readonlyArray(source, name) {
  const match = source.match(new RegExp(`readonly ${name}=\\(\\r?\\n([\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `${name} array is required`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function collectRepositoryTextFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const relativeEntryPath = path
      .relative(repositoryRoot, entryPath)
      .split(path.sep)
      .join("/");
    if (entry.isDirectory()) {
      if (
        !ignoredRepositoryDirectories.has(entry.name) &&
        !ignoredRepositorySubtrees.has(relativeEntryPath)
      ) {
        files.push(...collectRepositoryTextFiles(entryPath));
      }
      continue;
    }
    if (entry.isFile() && repositoryTextExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

const legacyViolations = [];
const environmentSetupSource = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "lib", "env-setup.js"),
  "utf8"
);
for (const helper of legacy2FAHelpers) {
  const relativePath = `scripts/${helper}`;
  if (COPY_PATHS.includes(relativePath)) {
    legacyViolations.push(`${relativePath} remains in COPY_PATHS`);
  }
  if (environmentSetupSource.includes(relativePath)) {
    legacyViolations.push(`${relativePath} remains in the executable-layout list`);
  }
  if (fs.existsSync(path.join(repositoryRoot, relativePath))) {
    legacyViolations.push(`${relativePath} still exists`);
  }
}
for (const filePath of collectRepositoryTextFiles(repositoryRoot)) {
  const source = fs.readFileSync(filePath, "utf8");
  for (const helper of legacy2FAHelpers) {
    if (source.includes(helper)) {
      legacyViolations.push(
        `${path.relative(repositoryRoot, filePath)} still references ${helper}`
      );
    }
  }
}
assert.deepEqual(
  legacyViolations,
  [],
  `legacy 2FA helper cleanup is incomplete:\n${legacyViolations.join("\n")}`
);

for (const rel of [
  "scripts/lib/browser-backend.js",
  "scripts/lib/firefox-runtime.js",
  "scripts/lib/ruyipage-runtime.js",
  "scripts/lib/ruyipage-backend-runner.js",
  "scripts/ruyipage/apple_account_flow.py",
  "scripts/lib/2fa-audit.js",
  "scripts/lib/mac-2fa-allow.js",
  "scripts/lib/mac-2fa-ocr.js",
  "scripts/lib/mac-2fa-popup.js",
  "scripts/swift/mac-2fa-click-allow.swift",
  "scripts/swift/mac-2fa-popup-read.swift",
  "scripts/swift/mac-2fa-popup-ocr.swift",
  "scripts/swift/mac-settings-post-sms-finalization.swift",
  "scripts/lib/mac-settings-post-sms-finalization-ax.js",
  "scripts/lib/mac-settings-post-sms-finalization.js",
  "scripts/lib/manual-verification-prompt.js",
  "scripts/lib/manual-2fa-prompt.js",
  "scripts/test-2fa-settings-code.mjs",
  "scripts/test-mac-settings-sms-verification.mjs",
  "scripts/test-mac-settings-post-sms-finalization.mjs",
  "scripts/preflight-2fa-permissions.mjs",
  "scripts/bootstrap-macos.sh",
]) {
  assert.ok(COPY_PATHS.includes(rel), `${rel} missing from COPY_PATHS`);
}

assert.equal(
  COPY_PATHS.includes("scripts/ruyipage-fifo-relay.mjs"),
  false,
  "the retired FIFO relay must not be copied into releases"
);
assert.equal(
  fs.existsSync(path.join(repositoryRoot, "scripts", "ruyipage-fifo-relay.mjs")),
  false,
  "the retired FIFO relay file must be removed"
);

for (const rel of [
  "scripts/browser-fill-debug.mjs",
  "scripts/lib/bidi-client.js",
  "scripts/lib/human-input-bidi.js",
  "scripts/lib/anti-automation.js",
  "scripts/lib/browser-input.js",
  "scripts/lib/browser-session.js",
]) {
  assert.equal(COPY_PATHS.includes(rel), false, `${rel} must not ship in the ruyipage-only release`);
  assert.equal(fs.existsSync(new URL(`../${rel}`, import.meta.url)), false, `${rel} must be deleted`);
}

for (const rel of COPY_PATHS) {
  assert.equal(fs.existsSync(new URL(`../${rel}`, import.meta.url)), true, `${rel} does not exist`);
  assert.equal(rel.startsWith("scripts/bin/"), false, `${rel} must be built on the target Mac`);
}

const imports = collectRuntimeImports(["scripts/lib/account-browser-flow.js"]);
assert.ok(imports.has("scripts/lib/env-setup.js"));
assert.ok(imports.has("scripts/lib/ruyipage-backend-runner.js"));
assert.ok(imports.has("scripts/lib/browser-backend.js"));
assert.ok(imports.has("scripts/lib/firefox-runtime.js"));
for (const rel of [
  "scripts/lib/bidi-client.js",
  "scripts/lib/human-input-bidi.js",
  "scripts/lib/anti-automation.js",
  "scripts/lib/browser-input.js",
  "scripts/lib/browser-session.js",
]) {
  assert.equal(imports.has(rel), false, `${rel} must not be imported by the browser flow`);
}

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
assert.equal(pkg.scripts["browser:debug"], undefined);
assert.equal(pkg.scripts["browser:test-session"], undefined);
assert.match(pkg.scripts["test:ruyipage-flow"], /test-ruyipage-flow\.mjs/);
assert.match(pkg.scripts["test:2fa-sidecar"], /test-two-fa-sidecar\.mjs/);
assert.match(pkg.scripts["test:2fa-settings-unit"], /test-mac-settings-2fa\.mjs/);
assert.match(pkg.scripts["test:2fa-settings"], /test-2fa-settings-code\.mjs/);
assert.match(pkg.scripts["test:account-browser-flow"], /test-account-browser-flow\.mjs/);

const releaseImports = collectRuntimeImports([
  "scripts/apple-id-full-flow.mjs",
  "scripts/setup-environment.mjs",
  "scripts/check-environment.mjs",
]);
for (const rel of releaseImports) {
  assert.ok(COPY_PATHS.includes(rel), `${rel} is imported at runtime but missing from COPY_PATHS`);
}

const rootInstallSh = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const generatedInstallSh = renderInstallSh("test-version");
const twoFaAuditSource = fs.readFileSync(
  new URL("./lib/2fa-audit.js", import.meta.url),
  "utf8"
);
assert.doesNotMatch(
  twoFaAuditSource,
  /screenshotPathFor/,
  "the 2FA audit module must not retain the unused screenshot-path API"
);
const requiredSwiftHelpers = [
  "mac-2fa-popup-read",
  "mac-2fa-click-allow",
  "mac-settings-2fa-code",
  "mac-2fa-popup-ocr",
];
const optionalSwiftHelpers = [
  "mac-settings-ax-fill",
  "mac-settings-sms-verification",
  "mac-settings-post-sms-finalization",
];
const compiledSwiftHelpers = [
  ...requiredSwiftHelpers,
  ...optionalSwiftHelpers,
];
assert.deepEqual(readonlyArray(rootInstallSh, "REQUIRED_SWIFT_HELPERS"), requiredSwiftHelpers);
assert.deepEqual(readonlyArray(rootInstallSh, "OPTIONAL_SWIFT_HELPERS"), optionalSwiftHelpers);
for (const helper of optionalSwiftHelpers) {
  assert.ok(
    COPY_PATHS.includes(`scripts/swift/${helper}.swift`),
    `${helper} source must be copied into the release package`
  );
}
const installContractViolations = [];
if (generatedInstallSh !== rootInstallSh) {
  installContractViolations.push("generated install.sh differs from repository install.sh");
}
for (const [label, installSource] of [
  ["repository", rootInstallSh],
  ["generated", generatedInstallSh],
]) {
  const requirePattern = (pattern, reason) => {
    if (!pattern.test(installSource)) installContractViolations.push(`${label}: ${reason}`);
  };
  requirePattern(/swiftc_usable\(\)/, "missing usable swiftc probe");
  requirePattern(/\/usr\/bin\/xcrun --find swiftc/, "swiftc is not resolved through xcrun");
  requirePattern(/"\$swiftc_path" --version/, "resolved swiftc is not executed");
  requirePattern(/\/usr\/bin\/xcrun --sdk macosx --show-sdk-path/, "macOS SDK is not verified through xcrun");
  requirePattern(/readonly SWIFT_MODULE_CACHE_DIR=/, "missing Swift module cache directory");
  requirePattern(/run_swiftc\(\)/, "missing xcrun Swift compiler wrapper");
  requirePattern(/\/usr\/bin\/xcrun swiftc -module-cache-path/, "Swift helpers are not compiled through xcrun with a module cache");
  requirePattern(/\/usr\/sbin\/softwareupdate --install/, "missing automatic Command Line Tools install fallback");
  requirePattern(/\/usr\/bin\/sudo -v/, "missing admin authorization refresh for Command Line Tools install");
  if (/command -v swiftc/.test(installSource)) {
    installContractViolations.push(`${label}: accepts a swiftc shim without executing it`);
  }
  requirePattern(/ensure_swiftc\(\)/, "missing swiftc dependency function");
  requirePattern(
    /\/usr\/bin\/xcode-select --install/,
    "missing official Xcode Command Line Tools request"
  );
  requirePattern(
    /readonly SWIFTC_INSTALL_MAX_ATTEMPTS=[1-9][0-9]*/,
    "missing fixed positive CLT polling bound"
  );
  requirePattern(
    /readonly SWIFTC_INSTALL_POLL_SECONDS=[1-9][0-9]*/,
    "missing fixed positive CLT polling interval"
  );
  requirePattern(
    /readonly SWIFT_SOFTWAREUPDATE_LIST_TIMEOUT_SECONDS=[1-9][0-9]*/,
    "missing bounded softwareupdate list timeout"
  );
  requirePattern(
    /readonly SWIFT_SOFTWAREUPDATE_INSTALL_TIMEOUT_SECONDS=[1-9][0-9]*/,
    "missing bounded softwareupdate install timeout"
  );
  requirePattern(/run_command_with_timeout\(\)/, "missing bounded command runner for softwareupdate");
  requirePattern(
    /for \(\( attempt = 1; attempt <= SWIFTC_INSTALL_MAX_ATTEMPTS; attempt\+\+ \)\)/,
    "CLT polling is not bounded by SWIFTC_INSTALL_MAX_ATTEMPTS"
  );
  requirePattern(
    /错误: 未找到 swiftc。请完成 Apple 官方 Xcode Command Line Tools 安装后重新运行 \.\/install\.sh。/,
    "missing fixed rerun error when swiftc remains unavailable"
  );
  requirePattern(
    /validate_required_swift_sources\(\)[\s\S]*\[\[ -f "scripts\/swift\/\$\{helper\}\.swift" \]\]/,
    "required Swift sources are not validated"
  );
  requirePattern(
    /validate_required_swift_artifacts\(\)[\s\S]*\[\[ -f "scripts\/bin\/\$\{helper\}" && -x "scripts\/bin\/\$\{helper\}" \]\]/,
    "required Swift artifacts are not validated as executable files"
  );
  requirePattern(
    /mktemp -d "scripts\/bin\/\.swift-helpers\.[A-Za-z0-9_-]*X{6}"/,
    "Swift helpers are not compiled in a unique scripts/bin temporary directory"
  );
  requirePattern(
    /swift_product_is_executable\(\)[\s\S]*\[\[ -f "\$1" && -x "\$1" \]\]/,
    "untouched Swift products are not validated as regular executable files"
  );
  requirePattern(
    /compile_swift_helper\(\)[\s\S]*-o "\$output_path"/,
    "Swift compiler output is not isolated to an uncreated temporary path"
  );
  requirePattern(
    /\/bin\/mv -f -- "\$temp_dir\/\$\{helper\}" "scripts\/bin\/\$\{helper\}"/,
    "validated Swift products are not atomically replaced on one filesystem"
  );
  requirePattern(
    /cleanup_swift_helper_temp_dir\(\)[\s\S]*\/bin\/rm -f -- "\$temp_dir\/\$\{helper\}"[\s\S]*\/bin\/rmdir "\$temp_dir"/,
    "Swift temporary products are not removed one file at a time"
  );
  if (/\bchmod\b/.test(installSource)) {
    installContractViolations.push(`${label}: repairs compiler output modes with chmod`);
  }
  requirePattern(
    /ensure_swiftc\s+validate_required_swift_sources\s+compile_swift_helpers\s+validate_required_swift_artifacts/,
    "Swift dependency, source, compile, and artifact gates are not ordered"
  );
  if (/AppleScript.{0,40}回退|回退.{0,40}AppleScript/s.test(installSource)) {
    installContractViolations.push(`${label}: advertises an AppleScript fallback`);
  }
  if (/xcodebuild[^\n]*license|curl[^\n]*(?:swift|xcode)|brew[^\n]*install/i.test(installSource)) {
    installContractViolations.push(`${label}: contains an unapproved Swift toolchain install path`);
  }
  for (const helper of requiredSwiftHelpers) {
    requirePattern(new RegExp(`"${helper}"`), `${helper} is not a required Swift helper`);
  }
}
assert.deepEqual(
  installContractViolations,
  [],
  `install contract is incomplete:\n${installContractViolations.join("\n")}`
);

assert.match(
  generatedInstallSh,
  /for required_helper in "\$\{REQUIRED_SWIFT_HELPERS\[@\]\}"; do[\s\S]*compile_swift_helper "\$temp_dir" "\$required_helper"/,
  "every required Swift helper must be compiled before installation continues"
);
for (const helper of requiredSwiftHelpers) {
  assert.match(
    generatedInstallSh,
    new RegExp(`"${helper}"`),
    `${helper} must remain in the required Swift helper contract`
  );
}
assert.match(
  generatedInstallSh,
  /mac-2fa-popup-ocr\)[\s\S]{0,360}-framework Vision -framework CoreGraphics[\s\S]{0,120}-framework ScreenCaptureKit/,
  "the required OCR helper must compile with the ScreenCaptureKit framework"
);
assert.match(
  generatedInstallSh,
  /mac-settings-post-sms-finalization\)[\s\S]{0,420}-framework Vision -framework CoreGraphics[\s\S]{0,120}-framework ScreenCaptureKit/,
  "the optional iPhone unlock helper must compile with Vision and ScreenCaptureKit"
);
for (const helper of optionalSwiftHelpers) {
  assert.match(
    generatedInstallSh,
    new RegExp(`"${helper}"`),
    `${helper} must be listed as an optional Swift helper`
  );
}
assert.doesNotMatch(generatedInstallSh, /cliclick/);
assert.match(generatedInstallSh, /setup-environment\.mjs --install-ruyipage/);
assert.match(
  generatedInstallSh,
  /setup-environment\.mjs --install-ruyipage[\s\S]*node scripts\/preflight-2fa-permissions\.mjs --all/,
  "install must confirm the required 2FA permissions after building the exact native helpers"
);
assert.match(generatedInstallSh, /bootstrap_macos_install_runtime/);
const generatedRunSh = renderRunSh();
assert.match(generatedRunSh, /--skip-browser/);
assert.match(generatedRunSh, /--skip-mac/);
assert.match(generatedRunSh, /--skip-firefox --skip-ruyipage/);
const launcherAuditStages = [
  "launcher_entered",
  "launcher_bootstrap_started",
  "launcher_bootstrap_ready",
  "launcher_env_setup_started",
  "launcher_env_setup_skipped",
  "launcher_env_setup_ready",
  "launcher_preflight_started",
  "launcher_preflight_skipped",
  "launcher_preflight_ready",
  "flow_main_started",
  "credentials_ready",
  "apple_flow_exec",
  "apple_flow_completed",
  "failure",
];
assert.match(
  generatedRunSh,
  /launcher_report_root="\$\{APPLE_AUTOMATION_REPORT_ROOT:-data\/reports\}"/,
  "release run.sh must default launcher audit storage to data/reports"
);
assert.match(
  generatedRunSh,
  /mktemp -d "\$launcher_report_root\/\.launcher-audit\.XXXXXX"/,
  "release run.sh must isolate each launcher audit in a unique directory"
);
assert.match(generatedRunSh, /launcher-audit\.jsonl/);
assert.match(generatedRunSh, /umask 077/);
assert.match(generatedRunSh, /\/bin\/chmod 600 "\$launcher_audit_path"/);
assert.match(
  generatedRunSh,
  /\{"version":1,"runId":"%s","sequence":%d,"timestamp":"%s","stage":"%s","exitCode":%d\}/,
  "normal launcher audit records must carry the versioned run correlation and fixed stage fields"
);
assert.match(
  generatedRunSh,
  /\{"version":1,"runId":"%s","sequence":%d,"timestamp":"%s","stage":"%s","exitCode":%d,"failedStage":"%s"\}/,
  "launcher failure records must preserve run correlation and the last fixed stage"
);
assert.match(generatedRunSh, /export APPLE_AUTOMATION_RUN_ID="\$launcher_run_id"/);
assert.match(generatedRunSh, /launcher_audit_sequence=0/);
assert.match(generatedRunSh, /launcher_audit_sequence=\$\(\(launcher_audit_sequence \+ 1\)\)/);
assert.match(
  generatedRunSh,
  /launcher_normalize_flag\(\) \{[\s\S]*launcher_trim_value[\s\S]*\/usr\/bin\/tr '\[:upper:\]' '\[:lower:\]'/,
  "launcher debug parsing must trim and lowercase values like the Node diagnostic parser"
);
assert.match(
  generatedRunSh,
  /launcher_pre_audit_failure\(\) \{\s*printf '\[×\] 启动失败（阶段：launcher_entered，退出码：1）\\n' >&2 \|\| true\s*printf '\[日志\] 启动审计尚未创建\\n' >&2 \|\| true\s*exit 1\s*\}/,
  "launcher failures before audit creation must still produce a fixed terminal summary"
);
assert.ok(
  (generatedRunSh.match(/\blauncher_pre_audit_failure\b/g) ?? []).length >= 6,
  "every launcher audit initialization failure path must use the fixed early summary"
);
assert.match(
  generatedRunSh,
  /launcher_terminal_debug_enabled[\s\S]*printf '\[apple-automation\] stage:%s\\n' "\$1"/,
  "launcher machine progress must use the fixed stdout format only in diagnostic mode"
);
for (const stage of launcherAuditStages) {
  assert.match(
    generatedRunSh,
    new RegExp(`\\b${stage}\\b`),
    `release run.sh is missing the fixed launcher stage ${stage}`
  );
}
assert.match(
  generatedRunSh,
  /launcher_audit_record failure "\$exit_code" "\$failed_stage" \|\| true/,
  "launcher failures must be recorded with the process exit code and current stage"
);
assert.match(
  generatedRunSh,
  /if \[\[ "\$failed_stage" != "apple_flow_exec" \]\]; then\s*printf '\[×\] 启动失败（阶段：%s，退出码：%d）\\n' "\$failed_stage" "\$exit_code" >&2 \|\| true\s*printf '\[日志\] %s\\n' "\$launcher_audit_path" >&2 \|\| true\s*fi/,
  "launcher failures must stay concise without duplicating the Apple flow report and audit summary"
);
assert.doesNotMatch(generatedRunSh, /\btee\b/, "launcher must not tee raw process output");
assert.doesNotMatch(
  generatedRunSh,
  /node scripts\/(?:setup-environment|preflight-2fa-permissions|apple-id-full-flow)\.mjs[^\n]*(?:\||>|2>&1|1>)/,
  "launcher must not capture or redirect Node process output"
);
assert.doesNotMatch(
  generatedRunSh,
  /(?:^|[;\n])\s*exec\s+node\s+scripts\/apple-id-full-flow\.mjs/m,
  "launcher must leave Node exit handling to the EXIT trap"
);
assert.match(
  generatedRunSh,
  /\nnode scripts\/apple-id-full-flow\.mjs --skip-setup "\$@"/,
  "launcher must preserve the Apple flow arguments without exec"
);
assert.match(
  generatedRunSh,
  /if \[\[ "\$\{skip_mac\}" == "1" \]\]; then[\s\S]*setup_args\+=\(--skip-automation\)[\s\S]*fi/,
  "release run.sh must skip Mac-login Automation checks for --skip-mac"
);
assert.match(generatedRunSh, /preflight-2fa-permissions\.mjs --quiet --all/);
assert.match(generatedRunSh, /bootstrap_macos_runtime/);
assert.doesNotMatch(generatedRunSh, /bootstrap_macos_install_runtime/);
assert.doesNotMatch(generatedRunSh, /source\s+(?:["']?)\.env|set\s+-a/);
assert.match(generatedRunSh, /credentials\.js loads \.env as data/);
assert.match(
  generatedRunSh,
  /if \[\[ "\$\{skip_browser\}" != "1" \]\]; then[\s\S]*preflight-2fa-permissions\.mjs --quiet --all[\s\S]*fi/,
  "release run.sh must skip browser-only permission checks for --skip-browser"
);

const rootRunSh = fs.readFileSync(new URL("../run.sh", import.meta.url), "utf-8");
assert.equal(
  rootRunSh.replaceAll("\r\n", "\n"),
  generatedRunSh.replaceAll("\r\n", "\n"),
  "repository and release run.sh routing must stay identical"
);
const launcherAuditPathPrint = rootRunSh.indexOf(
  "printf '%s\\n' \"$launcher_audit_path\""
);
const bootstrapSource = rootRunSh.indexOf(
  'source "$(dirname "$0")/scripts/bootstrap-macos.sh"'
);
assert.ok(
  launcherAuditPathPrint >= 0 && launcherAuditPathPrint < bootstrapSource,
  "diagnostic launcher audit path must be available before bootstrap source execution"
);
assert.match(
  rootRunSh,
  /if launcher_terminal_debug_enabled; then\s*printf '%s\\n' "\$launcher_audit_path"\s*fi/,
  "default launcher output must hide the internal audit path while diagnostic mode retains it"
);
assert.match(
  rootRunSh,
  /launcher_stage\(\) \{\s*launcher_current_stage="\$1"\s*launcher_audit_record "\$1" 0\s*if launcher_terminal_debug_enabled; then\s*printf '\[apple-automation\] stage:%s\\n' "\$1"\s*fi\s*\}/,
  "launcher stages must retain the current fixed stage, audit it, and only mirror it in diagnostic mode"
);
assert.match(rootRunSh, /--skip-browser/);
assert.match(rootRunSh, /--skip-mac/);
assert.match(rootRunSh, /--skip-firefox --skip-ruyipage/);
assert.match(
  rootRunSh,
  /if \[\[ "\$\{skip_mac\}" == "1" \]\]; then[\s\S]*setup_args\+=\(--skip-automation\)[\s\S]*fi/,
  "repository run.sh must skip Mac-login Automation checks for --skip-mac"
);
assert.match(rootRunSh, /bootstrap_macos_runtime/);
assert.doesNotMatch(rootRunSh, /bootstrap_macos_install_runtime/);
assert.doesNotMatch(rootRunSh, /source\s+(?:["']?)\.env|set\s+-a/);
assert.match(rootRunSh, /credentials\.js loads \.env as data/);
assert.match(
  rootRunSh,
  /if \[\[ "\$\{skip_browser\}" != "1" \]\]; then[\s\S]*preflight-2fa-permissions\.mjs --quiet --all[\s\S]*fi/
);

const setupEnvironment = fs.readFileSync(
  new URL("./setup-environment.mjs", import.meta.url),
  "utf-8"
);
const bootstrapMacOS = fs.readFileSync(
  new URL("./bootstrap-macos.sh", import.meta.url),
  "utf-8"
);
assert.match(bootstrapMacOS, /\/usr\/bin\/sudo -v/);
assert.match(bootstrapMacOS, /resolve_trusted_python_signer/);
assert.doesNotMatch(bootstrapMacOS, /BMM5U3QVKW|DJ3H93M7VJ/);
assert.match(bootstrapMacOS, /\/usr\/bin\/sudo -k/);
assert.match(setupEnvironment, /process\.argv\.includes\("--skip-ruyipage"\)/);
assert.match(setupEnvironment, /process\.argv\.includes\("--skip-automation"\)/);
assert.match(
  setupEnvironment,
  /checkEnvironment\(\{[\s\S]*skipAutomation,[\s\S]*\}\)/,
  "environment summary must honor the Mac-login Automation skip"
);
const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf-8");
assert.match(envExample, /运行 \.\/run\.sh/);
assert.doesNotMatch(envExample, /杩愯/);
assert.match(envExample, /^APPLE_AUTOMATION_SMS_ENABLED=1$/m);
assert.match(envExample, /^APPLE_AUTOMATION_SMS_PHONE=$/m);
assert.match(envExample, /^APPLE_AUTOMATION_SMS_API_URL=$/m);
assert.match(envExample, /^APPLE_AUTOMATION_SMS_RECONFIGURE=0$/m);
assert.match(envExample, /RUYIPAGE_BACKEND_TIMEOUT_MS=720000/);
assert.match(envExample, /BROWSER_2FA_SETTINGS_AFTER_MS=30000/);
assert.match(envExample, /BROWSER_2FA_SETTINGS_FALLBACK=1/);
assert.match(envExample, /BROWSER_2FA_MANUAL_FALLBACK=1/);
assert.match(envExample, /BROWSER_2FA_POLL_MS=800/);
assert.match(envExample, /APPLE_AUTOMATION_TERMINAL_DEBUG=1/);
assert.match(envExample, /name=.*个人信息页采集后写入/);
assert.match(envExample, /birthday=.*个人信息页采集后写入/);
assert.doesNotMatch(envExample, /BROWSER_2FA_POPUP_WAIT_MS/);

const releaseBuilder = fs.readFileSync(new URL("./build-release.mjs", import.meta.url), "utf-8");
const releaseMainStart = releaseBuilder.indexOf("function main(");
const releaseMainEnd = releaseBuilder.indexOf("if (process.argv[1]", releaseMainStart);
assert.ok(releaseMainStart >= 0 && releaseMainEnd > releaseMainStart, "release main is required");
const releaseBuilderMain = releaseBuilder.slice(releaseMainStart, releaseMainEnd);
assert.match(
  releaseBuilder,
  /fs\.copyFileSync\(path\.join\(ROOT, "README\.md"\), path\.join\(destRoot, "README\.md"\)\)/,
  "release package must copy the canonical repository README"
);
assert.match(
  releaseBuilder,
  /fs\.copyFileSync\(path\.join\(ROOT, "\.env\.example"\), path\.join\(destRoot, "\.env\.example"\)\)/,
  "release package must copy the canonical environment example"
);
assert.match(
  releaseBuilderMain,
  /for \(const rel of COPY_PATHS\) \{[\s\S]*?copyFile\(rel, OUT_DIR\);[\s\S]*?\}/,
  "release main must copy every declared runtime and documentation path"
);
assert.match(
  releaseBuilderMain,
  /buildReadme\(OUT_DIR\);\s*buildEnvExample\(OUT_DIR\);/,
  "release main must emit the canonical README and environment example"
);
for (const rel of [
  "docs/RUNTIME_RUNBOOK.md",
  "docs/PROJECT.md",
  "docs/2FA_HANDOFF_DIAGNOSTICS.md",
]) {
  assert.ok(COPY_PATHS.includes(rel), `release package must include ${rel}`);
}
const repositoryReadme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf-8");
const environmentExample = fs.readFileSync(
  new URL("../.env.example", import.meta.url),
  "utf-8"
);
const runtimeRunbook = fs.readFileSync(
  new URL("../docs/RUNTIME_RUNBOOK.md", import.meta.url),
  "utf-8"
);
const projectReference = fs.readFileSync(new URL("../docs/PROJECT.md", import.meta.url), "utf-8");
for (const [label, documentSource] of [
  ["repository README", repositoryReadme],
  ["runtime runbook", runtimeRunbook],
  ["project reference", projectReference],
]) {
  assert.match(documentSource, /DEVELOPER_MEMBERSHIP_GATE=0/, `${label} must document test-mode gate`);
  assert.match(documentSource, /developer_membership/, `${label} must document membership persistence`);
  assert.match(documentSource, /03-developer-membership\.png/, `${label} must document active-member screenshot`);
  assert.match(documentSource, /02-account-information\.png/, `${label} must document information screenshot`);
  assert.match(documentSource, /ruyiPage/, `${label} must preserve the ruyiPage-only browser contract`);
}
assert.match(repositoryReadme, /Developer-first/);
assert.match(environmentExample, /DEVELOPER_MEMBERSHIP_GATE=0/);
assert.match(environmentExample, /BROWSER_ATTACH_EXISTING=1/);
assert.match(
  environmentExample,
  /接管已有 Firefox 会话；仍先执行 Developer-first，再新建 Account 标签页/
);
assert.doesNotMatch(environmentExample, /优先复用已打开的 account\.apple\.com 标签页/);
assert.match(runtimeRunbook, /developer_membership_gate_blocked/);
assert.match(projectReference, /recordAccountHomeAcceptanceMarker/);
assert.match(releaseBuilder, /"docs\/RUNTIME_RUNBOOK\.md"/);
assert.match(
  releaseBuilder,
  /"test:2fa-settings":\s*"node scripts\/test-2fa-settings-code\.mjs"/,
  "release package must expose the safe Settings smoke command"
);
assert.match(
  releaseBuilder,
  /"test:mac-settings-sms-verification":\s*"node scripts\/test-mac-settings-sms-verification\.mjs"/,
  "release package must expose the supervised SMS verification contract test"
);
const environmentSetup = fs.readFileSync(
  new URL("./lib/env-setup.js", import.meta.url),
  "utf-8"
);
assert.match(environmentSetup, /if \(!options\.skipFirefox && !firefoxInstalled\(\)\)/);
assert.match(environmentSetup, /if \(!options\.skipRuyiPage\)/);
assert.match(environmentSetup, /if \(!options\.skipAutomation\)/);
assert.doesNotMatch(environmentSetup, /check2FAAutomationGranted|ensure2FAAutomation/);

const accessibilitySource = fs.readFileSync(
  new URL("./lib/accessibility.js", import.meta.url),
  "utf-8"
);
assert.doesNotMatch(accessibilitySource, /check2FAAutomationGranted|ensure2FAAutomation/);
assert.match(
  accessibilitySource,
  /run2FAPermissionPreflight[\s\S]*ensureAccessibility/
);
assert.doesNotMatch(
  accessibilitySource,
  /run2FAPermissionPreflight[\s\S]*ensureAutomation/
);

const fullFlowSource = fs.readFileSync(
  new URL("./apple-id-full-flow.mjs", import.meta.url),
  "utf-8"
);
assert.match(
  fullFlowSource,
  /ensureEnvironment\(\{[\s\S]*skipAutomation:\s*skipMac/
);

const browserOrchestrator = fs.readFileSync(
  new URL("./lib/account-browser-flow.js", import.meta.url),
  "utf-8"
);
assert.doesNotMatch(
  browserOrchestrator,
  /WebSocket|remote-debugging|document\.|launchFirefox|BidiClient|webdriver/i,
  "Node browser orchestration must not control or inspect pages"
);

console.log("release copy paths: ok");
