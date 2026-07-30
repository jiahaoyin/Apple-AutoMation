#!/usr/bin/env node
/**
 * 打包 Apple ID 自动化流程为可分发目录 + zip（适用于其他 macOS 机器测试）
 *
 * 用法:
 *   node scripts/build-release.mjs [--no-bump] [--upload] [--clean]
 *   npm run release          # patch+1 → 打包 → 上传 GitHub Release → 清理本地 dist
 *   npm run package          # 仅本地打包（保留 dist）
 *
 * 默认打包前自动 patch +1（1.0.0 → 1.0.1）；--no-bump 跳过递增
 * --upload  创建/更新 GitHub Release 并上传 zip（需 gh CLI）
 * --clean   上传后删除本地 dist 目录与 zip（常与 --upload 联用）
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bumpPatchVersion, readPkgVersion, writePkgVersion } from "./bump-patch-version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
let VERSION = null;
let RELEASE_NAME = null;
let OUT_DIR = null;
let ZIP_PATH = null;
let uploadRelease = false;
let cleanLocal = false;

/** @type {string[]} 相对仓库根目录 */
export const COPY_PATHS = [
  "scripts/apple-id-full-flow.mjs",
  "scripts/mac-settings-apple-login.applescript",
  "scripts/mac-settings-ui-dump.applescript",
  "scripts/mac-settings-signed-in.applescript",
  "scripts/swift/mac-settings-ax-fill.swift",
  "scripts/swift/mac-settings-sms-verification.swift",
  "scripts/swift/mac-settings-sms-ocr.swift",
  "scripts/swift/mac-settings-post-sms-finalization.swift",
  "scripts/swift/mac-settings-2fa-code.swift",
  "scripts/swift/mac-2fa-click-allow.swift",
  "scripts/swift/mac-2fa-popup-read.swift",
  "scripts/swift/mac-2fa-popup-ocr.swift",
  "scripts/fill-debug.mjs",
  "scripts/lib/mac-settings-ax-fill.js",
  "scripts/lib/mac-settings-sms-ax.js",
  "scripts/lib/mac-settings-sms-verification.js",
  "scripts/lib/mac-settings-sms-ocr.js",
  "scripts/lib/mac-settings-post-sms-finalization-ax.js",
  "scripts/lib/mac-settings-post-sms-finalization.js",
  "scripts/lib/mac-settings-sms-provider.js",
  "scripts/lib/mac-settings-2fa.js",
  "scripts/lib/browser-backend.js",
  "scripts/lib/firefox-runtime.js",
  "scripts/lib/mac-settings-login.js",
  "scripts/lib/account-browser-flow.js",
  "scripts/lib/flow-audit.js",
  "scripts/lib/credentials.js",
  "scripts/lib/prompt.js",
  "scripts/lib/ruyipage-backend-runner.js",
  "scripts/lib/ruyipage-runtime.js",
  "scripts/lib/two-fa-sidecar.js",
  "scripts/lib/2fa-audit.js",
  "scripts/lib/mac-2fa-allow.js",
  "scripts/lib/mac-2fa-ocr.js",
  "scripts/lib/mac-2fa-popup.js",
  "scripts/lib/native-helper-path.js",
  "scripts/lib/manual-verification-prompt.js",
  "scripts/lib/manual-2fa-prompt.js",
  "scripts/lib/report.js",
  "scripts/ruyipage/apple_account_flow.py",
  "scripts/test-2fa-settings-code.mjs",
  "scripts/test-mac-settings-sms-verification.mjs",
  "scripts/test-mac-settings-sms-provider.mjs",
  "scripts/test-mac-settings-sms-provider-coordinator.mjs",
  "scripts/test-mac-settings-sms-provider-config.mjs",
  "scripts/test-mac-settings-post-sms-finalization.mjs",
  "scripts/check-environment.mjs",
  "scripts/setup-environment.mjs",
  "scripts/preflight-2fa-permissions.mjs",
  "scripts/bootstrap-macos.sh",
  "scripts/lib/env-setup.js",
  "scripts/lib/macos.js",
  "scripts/bump-patch-version.mjs",
  "scripts/automation-check.applescript",
  "scripts/lib/accessibility.js",
  "docs/RUNTIME_RUNBOOK.md",
  "docs/PROJECT.md",
  "docs/2FA_HANDOFF_DIAGNOSTICS.md",
];

function normalizeRelPath(relPath) {
  return relPath.replace(/\\/g, "/");
}

function resolveRelativeImport(importerRel, specifier) {
  const importerDir = path.dirname(importerRel);
  const candidate = normalizeRelPath(path.normalize(path.join(importerDir, specifier)));
  const candidates = path.extname(candidate)
    ? [candidate]
    : [`${candidate}.js`, `${candidate}.mjs`, `${candidate}.json`, `${candidate}/index.js`];

  return candidates.find((rel) => fs.existsSync(path.join(ROOT, rel))) ?? candidate;
}

/** 从入口脚本递归收集 runtime 相对 import，打包前校验 COPY_PATHS 无遗漏 */
export function collectRuntimeImports(entryRelPaths) {
  const runtimeFiles = new Set();
  const scanned = new Set();
  const queue = entryRelPaths.map(normalizeRelPath);
  const importRe =
    /(?:from\s+["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\s+["'](\.{1,2}\/[^"']+)["'])/g;

  while (queue.length) {
    const rel = normalizeRelPath(queue.pop());
    if (scanned.has(rel)) continue;
    scanned.add(rel);

    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !/\.(?:js|mjs)$/i.test(rel)) continue;

    const src = fs.readFileSync(abs, "utf-8");
    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(src))) {
      const specifier = m[1] || m[2] || m[3];
      const importedRel = resolveRelativeImport(rel, specifier);
      if (!importedRel.startsWith("scripts/")) continue;
      if (!runtimeFiles.has(importedRel)) {
        runtimeFiles.add(importedRel);
        queue.push(importedRel);
      }
    }
  }

  return runtimeFiles;
}

function validateCopyPaths() {
  const entries = [
    "scripts/apple-id-full-flow.mjs",
    "scripts/setup-environment.mjs",
    "scripts/check-environment.mjs",
  ];
  const requiredLibs = collectRuntimeImports(entries);
  const copySet = new Set(COPY_PATHS);
  const missing = [...requiredLibs].filter((p) => !copySet.has(p));

  if (missing.length) {
    console.error("COPY_PATHS 缺少以下依赖文件:");
    for (const p of missing) console.error(`  - ${p}`);
    process.exit(1);
  }

  for (const rel of COPY_PATHS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error(`打包源文件不存在: ${rel}`);
      process.exit(1);
    }
  }
}

function rimraf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyFile(srcRel, destRoot) {
  const src = path.join(ROOT, srcRel);
  const dest = path.join(destRoot, srcRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function buildPackageJson(destRoot) {
  const pkg = {
    name: "apple-id-automation",
    version: VERSION,
    private: true,
    description:
      "macOS 系统设置 Apple ID 登录 + ruyiPage-only account.apple.com 采集（独立分发包）",
    type: "module",
    engines: { node: ">=18" },
    scripts: {
      flow: "node scripts/apple-id-full-flow.mjs",
      "flow:browser-only": "node scripts/apple-id-full-flow.mjs --skip-mac",
      "flow:mac-only": "node scripts/apple-id-full-flow.mjs --skip-browser",
      check: "node scripts/check-environment.mjs",
      setup: "node scripts/setup-environment.mjs",
      install: "./install.sh",
      "check:automation": "osascript scripts/automation-check.applescript",
      "dump:mac-ui": "osascript scripts/mac-settings-ui-dump.applescript",
      "fill:debug": "node scripts/fill-debug.mjs",
      "test:2fa-settings": "node scripts/test-2fa-settings-code.mjs",
      "test:mac-settings-sms-verification": "node scripts/test-mac-settings-sms-verification.mjs",
      "test:mac-settings-post-sms-finalization": "node scripts/test-mac-settings-post-sms-finalization.mjs",
    },
  };
  fs.writeFileSync(
    path.join(destRoot, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n"
  );
}

function buildReadme(destRoot) {
  fs.copyFileSync(path.join(ROOT, "README.md"), path.join(destRoot, "README.md"));
}

function buildEnvExample(destRoot) {
  fs.copyFileSync(path.join(ROOT, ".env.example"), path.join(destRoot, ".env.example"));
}

function buildGitignore(destRoot) {
  fs.writeFileSync(
    path.join(destRoot, ".gitignore"),
    `.env
data/
.runtime/
.DS_Store
`
  );
}

export function renderInstallSh(_version) {
  return fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
}

function buildInstallSh(destRoot) {
  writeExecutable(path.join(destRoot, "install.sh"), renderInstallSh(VERSION));
}

export function renderRunSh() {
  return fs.readFileSync(path.join(ROOT, "run.sh"), "utf8");
}

function buildRunSh(destRoot) {
  writeExecutable(path.join(destRoot, "run.sh"), renderRunSh());
}

function createZip(sourceDir, zipPath) {
  rimraf(zipPath);
  const parent = path.dirname(sourceDir);
  const name = path.basename(sourceDir);
  execSync(`cd "${parent}" && zip -r "${zipPath}" "${name}"`, {
    stdio: "inherit",
  });
}

function getGitHubRepo() {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
    const m =
      remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i) ??
      remote.match(/github\.com[:/](.+)$/i);
    if (!m) {
      throw new Error(`无法从 origin 解析 GitHub 仓库: ${remote}`);
    }
    return m[1];
  } catch (err) {
    throw new Error(`读取 git remote 失败: ${err.message}`);
  }
}

function releaseExists(repo, tag) {
  try {
    execSync(`gh release view "${tag}" -R "${repo}"`, {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function uploadToGitHubRelease(version, zipPath) {
  const repo = getGitHubRepo();
  const tag = `v${version}`;
  const assetName = path.basename(zipPath);
  const customNotes = process.env.RELEASE_NOTES?.trim();
  const notes = customNotes
    ? [
        `## 更新说明`,
        "",
        customNotes,
        "",
        `- 版本: **${version}**`,
        `- 附件: \`${assetName}\``,
        "",
        "### 使用",
        "",
        "```bash",
        `curl -fsSL https://raw.githubusercontent.com/${repo}/main/scripts/fetch-latest.sh | bash`,
        `cd apple-id-automation-latest/apple-id-automation-${version}`,
        "./install.sh && ./run.sh",
        "```",
      ].join("\n")
    : [
    `## Apple ID 自动化 macOS 分发包`,
    "",
    `- 版本: **${version}**`,
    `- 附件: \`${assetName}\``,
    "",
    "### 使用",
    "",
    "```bash",
    "# 下载并解压（需 gh CLI）",
    `gh release download -R ${repo} --pattern '*-macos.zip'`,
    `unzip ${assetName}`,
    `cd apple-id-automation-${version}`,
    "./install.sh && ./run.sh",
    "```",
  ].join("\n");

  const notesFile = path.join(ROOT, "dist", `.release-notes-${version}.md`);
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, notes);

  console.log(`上传 GitHub Release ${tag} (${repo}) …`);

  try {
    if (releaseExists(repo, tag)) {
      execSync(
        `gh release upload "${tag}" "${zipPath}" --clobber -R "${repo}"`,
        { cwd: ROOT, stdio: "inherit" }
      );
      console.log(`已更新 Release 附件: ${assetName}`);
      return;
    }

    execSync(
      `gh release create "${tag}" "${zipPath}" --title "${tag}" --notes-file "${notesFile}" -R "${repo}"`,
      { cwd: ROOT, stdio: "inherit" }
    );
    console.log(`已创建 Release: https://github.com/${repo}/releases/tag/${tag}`);
  } finally {
    rimraf(notesFile);
  }
}

function cleanLocalArtifacts(outDir, zipPath) {
  rimraf(outDir);
  rimraf(zipPath);
  const distDir = path.join(ROOT, "dist");
  if (fs.existsSync(distDir)) {
    for (const entry of fs.readdirSync(distDir)) {
      const abs = path.join(distDir, entry);
      if (
        entry.startsWith("apple-id-automation-") ||
        entry.endsWith("-macos.zip")
      ) {
        rimraf(abs);
      }
    }
    if (fs.readdirSync(distDir).length === 0) {
      fs.rmdirSync(distDir);
    }
  }
  console.log("已清理本地打包产物");
}

function main(argv = process.argv.slice(2)) {
  const noBump = argv.includes("--no-bump");
  uploadRelease = argv.includes("--upload");
  cleanLocal = argv.includes("--clean");
  if (!noBump && !process.env.RELEASE_VERSION) {
    const current = readPkgVersion();
    const next = bumpPatchVersion(current);
    writePkgVersion(next);
    console.log(`版本递增: ${current} → ${next}`);
  }

  VERSION = process.env.RELEASE_VERSION ?? readPkgVersion();
  RELEASE_NAME = `apple-id-automation-${VERSION}`;
  OUT_DIR = path.join(ROOT, "dist", RELEASE_NAME);
  ZIP_PATH = path.join(ROOT, "dist", `${RELEASE_NAME}-macos.zip`);

  validateCopyPaths();
  console.log(`打包 ${RELEASE_NAME} …`);
  rimraf(OUT_DIR);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const rel of COPY_PATHS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error(`缺少文件: ${rel}`);
      process.exit(1);
    }
    copyFile(rel, OUT_DIR);
  }

  buildPackageJson(OUT_DIR);
  buildReadme(OUT_DIR);
  buildEnvExample(OUT_DIR);
  buildGitignore(OUT_DIR);
  buildInstallSh(OUT_DIR);
  buildRunSh(OUT_DIR);

  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  createZip(OUT_DIR, ZIP_PATH);

  if (uploadRelease) {
    uploadToGitHubRelease(VERSION, ZIP_PATH);
  }

  if (cleanLocal) {
    cleanLocalArtifacts(OUT_DIR, ZIP_PATH);
  }

  console.log("");
  console.log("完成:");
  if (!cleanLocal) {
    console.log(`  目录: ${OUT_DIR}`);
    console.log(`  压缩包: ${ZIP_PATH}`);
  }
  if (uploadRelease) {
    console.log(`  GitHub Release: v${VERSION}`);
    console.log("");
    console.log("其他 Mac 拉取最新版:");
    console.log("  ./scripts/fetch-latest.sh");
    console.log("  或: gh release download -R $(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+).*#\\1#') --pattern '*-macos.zip'");
  } else {
    console.log("");
    console.log("分发到其他 Mac:");
    console.log(`  1. npm run release   # 上传至 GitHub Releases`);
    console.log(`  2. 或手动复制 ${path.basename(ZIP_PATH)}`);
    console.log("  3. unzip 后 ./install.sh && ./run.sh");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
