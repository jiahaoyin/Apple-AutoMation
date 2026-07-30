const VERIFICATION_PROMPT =
  "[Verification] Enter the 6-digit verification code shown on this Mac: ";

const DEVICE_PASSCODE_PROMPT =
  "[Mac Settings] Enter the iPhone passcode in this terminal (input is hidden): ";

/**
 * Read a caller-bounded ASCII numeric value without echoing terminal input.
 * Returns null when the prompt is unavailable, cancelled, or timed out.
 *
 * @param {{
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   allowPipedOutput?: boolean,
 *   setTimeout?: typeof globalThis.setTimeout,
 *   clearTimeout?: typeof globalThis.clearTimeout,
 * }} options
 * @returns {Promise<string|null>}
 */
export function promptForHiddenNumericValue(options = {}) {
  const {
    signal,
    timeoutMs,
    allowedLengths = [6],
    prompt = VERIFICATION_PROMPT,
    input = process.stdin,
    output = process.stdout,
    allowPipedOutput = process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1",
    allowEmpty = false,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
  } = options;

  const lengths = new Set(
    Array.isArray(allowedLengths)
      ? allowedLengths.filter((value) => Number.isInteger(value) && value > 0)
      : []
  );

  if (
    signal?.aborted ||
    input?.isTTY !== true ||
    typeof output?.write !== "function" ||
    (output?.isTTY !== true && allowPipedOutput !== true) ||
    typeof input.setRawMode !== "function" ||
    lengths.size === 0 ||
    typeof prompt !== "string" ||
    prompt.length === 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;
    let entry = "";
    let settled = false;
    let timeoutToken = null;

    const restoreInput = () => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (timeoutToken != null) cancel(timeoutToken);
      try {
        input.setRawMode(wasRaw);
      } catch {
        /* terminal may already be detached */
      }
      if (wasPaused && typeof input.pause === "function") input.pause();
      try {
        output.write("\n");
      } catch {
        /* output closure must not block terminal restoration */
      }
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      restoreInput();
      resolve(value);
    };

    function onAbort() {
      finish(null);
    }

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
        if (character === "\u0015") {
          entry = "";
          continue;
        }
        if (character === "\u007f" || character === "\b") {
          entry = entry.slice(0, -1);
          continue;
        }
        if (character === "\r" || character === "\n") {
          if (options.allowEmpty === true && entry.length === 0) {
            finish("");
            return;
          }
          if (/^[0-9]+$/.test(entry) && lengths.has(entry.length)) {
            finish(entry);
            return;
          }
          entry = "";
          continue;
        }
        if (character >= "0" && character <= "9") {
          entry += character;
        } else {
          entry += "\u0000";
        }
      }
    }

    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      input.resume();
      output.write(prompt);
      timeoutToken = schedule(() => finish(null), timeoutMs);
      if (typeof timeoutToken?.unref === "function") timeoutToken.unref();
    } catch {
      finish(null);
    }
  });
}

export function promptForHiddenVerificationCode(options = {}) {
  return promptForHiddenNumericValue({
    ...options,
    allowedLengths: [6],
    prompt: VERIFICATION_PROMPT,
  });
}

/** Read a four- or six-digit device passcode without echoing it. */
export function promptForHiddenDevicePasscode(digits, options = {}) {
  if (digits !== 4 && digits !== 6) return Promise.resolve(null);
  return promptForHiddenNumericValue({
    ...options,
    allowedLengths: [digits],
    prompt: DEVICE_PASSCODE_PROMPT,
  });
}
