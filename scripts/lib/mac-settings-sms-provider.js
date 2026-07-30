import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SIX_DIGIT_CODE_RE = /(?<!\d)(\d{6})(?!\d)/g;
const MAX_RESPONSE_BYTES = 256 * 1024;
const FIXED_INCOMPLETE_CONFIG_NOTICE =
  "[短信验证] 号码和服务地址需要一起提供，请重新输入";
const FIXED_INVALID_CONFIG_NOTICE =
  "[短信验证] 号码或服务地址格式无效，请重新输入";
const SMS_RUNTIME_SECRET_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
  "APPLE_AUTOMATION_MANUAL_SMS_CODE",
];
const SMS_RUNTIME_CONFIG_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_ENABLED",
  "APPLE_AUTOMATION_SMS_RECONFIGURE",
];

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fixedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function captureMacSettingsSmsRuntimeEnv(env = process.env) {
  const captured = {};
  for (const key of SMS_RUNTIME_CONFIG_ENV_KEYS) {
    if (typeof env[key] === "string") captured[key] = env[key];
    delete env[key];
  }
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) {
    if (typeof env[key] === "string") captured[key] = env[key];
    delete env[key];
  }
  return captured;
}

export function validateSmsProviderUrl(value) {
  const raw = fixedString(value);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw failure("MAC_SETTINGS_SMS_PROVIDER_URL_INVALID");
  }
  if (url.protocol !== "https:" || !url.hostname || !url.search) {
    throw failure("MAC_SETTINGS_SMS_PROVIDER_URL_INVALID");
  }
  const hasSecretValue = [...url.searchParams.values()].some((item) => item.trim().length > 0);
  if (!hasSecretValue) throw failure("MAC_SETTINGS_SMS_PROVIDER_URL_INVALID");
  return url;
}

export function validateSmsProviderPhone(value) {
  const phone = fixedString(value);
  if (!/^\+?[0-9()\s.-]+$/.test(phone) || phone.replace(/\D/g, "").length < 4) {
    throw failure("MAC_SETTINGS_SMS_PHONE_INVALID");
  }
  return phone;
}

export function isMacSettingsSmsReconfigureRequested(env = process.env) {
  return fixedString(env.APPLE_AUTOMATION_SMS_RECONFIGURE) === "1";
}

async function promptForSecretLine(label) {
  if (
    input.isTTY !== true ||
    output.isTTY !== true ||
    typeof input.setRawMode !== "function"
  ) {
    return null;
  }

  return new Promise((resolve) => {
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = typeof input.isPaused === "function" && input.isPaused();
    let value = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // A detached terminal must not leave a secret prompt hanging.
      }
      if (wasPaused && typeof input.pause === "function") input.pause();
      try {
        output.write("\n");
      } catch {
        // Output closure does not change the prompt result.
      }
      resolve(result);
    };

    function onError() {
      finish(null);
    }

    function onData(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      for (const character of text) {
        if (character === "\u0003" || character === "\u001b") {
          finish(null);
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    }

    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.once("error", onError);
      input.resume();
      output.write(`[短信验证] ${label}: `);
    } catch {
      finish(null);
    }
  });
}

export async function promptForMacSettingsSmsProviderField({ field, secret }) {
  if (input.isTTY !== true || output.isTTY !== true) return null;
  const label = field === "phone" ? "受信任手机号码" : "短信服务 HTTPS 地址";
  if (secret === true) return promptForSecretLine(`${label} (hidden)`);
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    // This runtime-only prompt never writes the value to shell history or project files.
    return await rl.question(`[短信验证] ${label}: `);
  } finally {
    rl.close();
  }
}

export async function resolveMacSettingsSmsProviderConfig(options = {}) {
  const env = options.env ?? process.env;
  const prompt = options.prompt ?? promptForMacSettingsSmsProviderField;
  const notify = options.notify ?? ((message) => console.warn(message));
  const canPrompt =
    typeof options.prompt === "function" || (input.isTTY === true && output.isTTY === true);
  const forceReconfigure = isMacSettingsSmsReconfigureRequested(env);
  let phone = fixedString(env.APPLE_AUTOMATION_SMS_PHONE);
  let apiUrl = fixedString(env.APPLE_AUTOMATION_SMS_API_URL);
  let reconfigureNoticeShown = false;

  while (true) {
    if (!forceReconfigure && phone && apiUrl) {
      try {
        return {
          phoneNumber: validateSmsProviderPhone(phone),
          apiUrl: validateSmsProviderUrl(apiUrl).toString(),
          source: "stored",
        };
      } catch {
        if (!canPrompt) throw failure("MAC_SETTINGS_SMS_PROVIDER_CONFIG_INVALID");
        notify(FIXED_INVALID_CONFIG_NOTICE);
      }
    } else if (!forceReconfigure && (phone || apiUrl)) {
      if (!canPrompt) throw failure("MAC_SETTINGS_SMS_TTY_REQUIRED");
      notify(FIXED_INCOMPLETE_CONFIG_NOTICE);
    } else if (!canPrompt) {
      throw failure("MAC_SETTINGS_SMS_TTY_REQUIRED");
    }

    if (forceReconfigure && !reconfigureNoticeShown) {
      notify("[短信验证] 已请求重新配置，请输入新的号码和服务地址");
      reconfigureNoticeShown = true;
    }

    const promptedPhone = await prompt({ field: "phone", secret: false });
    const promptedUrl = await prompt({ field: "apiUrl", secret: true });
    if (promptedPhone === null || promptedUrl === null) {
      throw failure("MAC_SETTINGS_SMS_TTY_REQUIRED");
    }
    phone = fixedString(promptedPhone);
    apiUrl = fixedString(promptedUrl);
    try {
      return {
        phoneNumber: validateSmsProviderPhone(phone),
        apiUrl: validateSmsProviderUrl(apiUrl).toString(),
        source: "terminal",
      };
    } catch {
      if (!canPrompt) throw failure("MAC_SETTINGS_SMS_PROVIDER_CONFIG_INVALID");
      notify(FIXED_INVALID_CONFIG_NOTICE);
      phone = "";
      apiUrl = "";
    }
  }
}

function primitiveText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function providerMessageSuffixes(text) {
  const result = new Set();
  const expression =
    /(?:to|sent\s+to|ending(?:\s+in)?|suffix|phone|mobile|number|tel|\*{2}|\u53d1\u9001(?:\u77ed\u4fe1)?\u81f3|\u5c3e\u53f7|\u672b\u5c3e)[^\d]{0,20}(\d{2})(?!\d)/gi;
  for (const match of text.matchAll(expression)) result.add(match[1]);
  const fullPhoneExpression =
    /(?:phone(?:\s+number)?|mobile(?:\s+number)?|tel(?:ephone)?|cell(?:\s+number)?|\u624b\u673a(?:\u53f7)?|\u7535\u8bdd(?:\u53f7)?)[^\d]{0,20}([+\d][\d()\s.-]{1,})/gi;
  for (const match of text.matchAll(fullPhoneExpression)) {
    const digits = match[1].replace(/\D/g, "");
    if (digits.length >= 2) result.add(digits.slice(-2));
  }
  return result;
}

function isPhoneFieldName(key) {
  return /(?:phone|mobile|number|tel|\u624b\u673a|\u53f7\u7801)/i.test(key);
}

function collectSmsMessageRecords(value) {
  const scalar = primitiveText(value);
  if (scalar !== null) return [{ text: scalar, suffixes: providerMessageSuffixes(scalar) }];
  if (Array.isArray(value)) return value.flatMap(collectSmsMessageRecords);
  if (!value || typeof value !== "object") return [];

  const directParts = [];
  const directSuffixes = new Set();
  const nestedRecords = [];
  for (const [key, item] of Object.entries(value)) {
    const itemText = primitiveText(item);
    if (itemText !== null) {
      directParts.push(`${key}: ${itemText}`);
      for (const suffix of providerMessageSuffixes(itemText)) directSuffixes.add(suffix);
      if (isPhoneFieldName(key)) {
        const digits = itemText.replace(/\D/g, "");
        if (digits.length >= 2) directSuffixes.add(digits.slice(-2));
      }
      continue;
    }
    nestedRecords.push(...collectSmsMessageRecords(item));
  }
  if (directParts.length > 0) {
    return [{ text: directParts.join("\n"), suffixes: directSuffixes }, ...nestedRecords];
  }
  return nestedRecords;
}

export function extractSmsVerificationCode(body, suffix) {
  const text = typeof body === "string" ? body : "";
  const records = (() => {
    try {
      return collectSmsMessageRecords(JSON.parse(text));
    } catch {
      return collectSmsMessageRecords(text);
    }
  })();
  const codes = new Set(
    records.flatMap(({ text: recordText }) =>
      [...recordText.matchAll(SIX_DIGIT_CODE_RE)].map((match) => match[1])
    )
  );
  if (codes.size !== 1) return null;

  const [code] = codes;
  let associatedWithTarget = false;
  let unassociated = false;
  for (const record of records) {
    if (![...record.text.matchAll(SIX_DIGIT_CODE_RE)].some((match) => match[1] === code)) {
      continue;
    }
    if (record.suffixes.size === 0) {
      unassociated = true;
      continue;
    }
    if (record.suffixes.size === 1 && record.suffixes.has(suffix)) {
      associatedWithTarget = true;
      continue;
    }
    return null;
  }
  return associatedWithTarget || unassociated ? code : null;
}

async function readBoundedBody(response, signal) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return null;
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (signal?.aborted) return null;
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } finally {
    reader.releaseLock?.();
  }
}

export function createSmsProviderCodePoller(config, options = {}) {
  const providerUrl = validateSmsProviderUrl(config?.apiUrl).toString();
  const suffix = validateSmsProviderPhone(config?.phoneNumber).replace(/\D/g, "").slice(-2);
  const request = options.fetch ?? globalThis.fetch;
  const pause = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = Math.max(250, Math.trunc(options.pollIntervalMs ?? 3_000));
  if (typeof request !== "function") throw failure("MAC_SETTINGS_SMS_PROVIDER_UNAVAILABLE");
  return async ({ signal, timeoutMs }) => {
    const deadline = now() + timeoutMs;
    while (!signal?.aborted && now() < deadline) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const remainingMs = Math.max(1, deadline - now());
        const timer = setTimeout(() => controller.abort(), Math.min(15_000, remainingMs));
        let response;
        try {
          response = await request(providerUrl, {
            method: "GET",
            redirect: "error",
            signal: controller.signal,
            headers: {
              accept: "application/json, text/plain, text/html;q=0.9, */*;q=0.8",
              "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
              "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
                "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
                "Version/18.0 Safari/605.1.15",
              "sec-fetch-dest": "empty",
              "sec-fetch-mode": "cors",
              "sec-fetch-site": "none",
            },
          });
          if (response?.ok) {
            const code = extractSmsVerificationCode(
              await readBoundedBody(response, controller.signal),
              suffix
            );
            if (code) return code;
          }
        } finally { clearTimeout(timer); }
      } catch {
        // Provider availability details and secret URL are intentionally not exposed.
      } finally { signal?.removeEventListener("abort", onAbort); }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await pause(Math.min(pollIntervalMs, remainingMs));
    }
    return null;
  };
}
