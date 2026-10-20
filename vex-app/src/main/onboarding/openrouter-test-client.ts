/**
 * OpenRouter "verify connection" wrapper (M10 Step 6).
 *
 * Sends a single 16-token chat completion to the user-supplied
 * `(apiKey, model)` pair. Used by `providerPersist` BEFORE writing
 * the .env keys — verify-then-persist atomicity (codex turn 2 RED #1).
 *
 * Safety contracts (all enforced):
 *   - SDK debug logging neutralised via OPENROUTER_NOOP_LOGGER. The SDK falls
 *     back to `console` whenever no `debugLogger` is supplied AND
 *     `OPENROUTER_DEBUG` is truthy (`@openrouter/sdk/esm/lib/sdks.js:65`),
 *     which would leak the `Authorization` header. Passing this
 *     no-op logger short-circuits that fallback (codex turn 2 RED #6
 *     + turn 3 verdict).
 *   - SDK retries disabled at both constructor and per-call. The SDK
 *     retry backoff is NOT signal-aware, so a hard wall-clock 15s
 *     timeout via AbortController is the source of truth (codex turn
 *     2 RED #5).
 *   - Error mapping uses `instanceof` for HTTP-client error classes
 *     (`RequestAbortedError`, `RequestTimeoutError`, `ConnectionError`)
 *     FIRST, then `OpenRouterError.statusCode` for HTTP responses.
 *     The order matters because client errors do NOT have a
 *     `statusCode` (codex turn 3 RED + turn 4 caveat).
 *   - SDK error messages may contain raw provider/body internals.
 *     They are logged with the correlationId but NEVER surfaced in
 *     the returned `VexError.message` — UI uses fixed copy per code
 *     (codex turn 2 YELLOW).
 *
 * Returns `Result<{latencyMs}, VexError>`. `latencyMs` is wall-clock
 * from before `chat.send` to after it resolves; on timeout this
 * returns `provider.unavailable` without leaking latency.
 */

import {
  ConnectionError,
  OPENROUTER_API_BASE_URL,
  OpenRouter,
  OpenRouterError,
  RequestAbortedError,
  RequestTimeoutError,
} from "@vex-lib/openrouter-client.js";
import { extractCauseCode } from "@vex-lib/error-cause.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { log } from "../logger/index.js";
import {
  OPENROUTER_APP_TITLE,
  OPENROUTER_APP_URL,
  OPENROUTER_NOOP_LOGGER,
} from "./openrouter-app-identity.js";

const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_MAX_OUTPUT_TOKENS = 16;

export interface OpenRouterVerifyInput {
  readonly apiKey: string;
  readonly model: string;
}

export interface OpenRouterVerifyOptions {
  /** Override timeout for tests. Production callers omit. */
  readonly timeoutMs?: number;
  /**
   * Inject a custom SDK constructor for tests. Production callers
   * omit and use the real `OpenRouter` import.
   */
  readonly clientFactory?: (apiKey: string, timeoutMs: number) => {
    chat: {
      send: (
        body: unknown,
        options?: { signal?: AbortSignal; retries?: { strategy: "none" } },
      ) => Promise<unknown>;
    };
  };
}

function defaultClientFactory(apiKey: string, timeoutMs: number) {
  return new OpenRouter({
    apiKey,
    serverURL: OPENROUTER_API_BASE_URL,
    debugLogger: OPENROUTER_NOOP_LOGGER,
    retryConfig: { strategy: "none" },
    timeoutMs,
    httpReferer: OPENROUTER_APP_URL,
    appTitle: OPENROUTER_APP_TITLE,
  });
}

/**
 * Maps an SDK error to the M10 `provider.*` VexError code set.
 *
 * Order MATTERS (codex turn 4): HTTP-client error classes
 * (RequestAbortedError, RequestTimeoutError, ConnectionError) do
 * not carry `.statusCode`; check them first via `instanceof` so the
 * subsequent OpenRouterError branch can rely on `statusCode` being
 * present.
 *
 * Cause-code diagnostics (error-diagnostics plan D-WIZARD): every
 * branch surfaces the errno-shaped cause code extracted from the
 * caught value's `.cause` chain — appended to the existing log line
 * and attached as `details.causeCode` on the returned VexError.
 * ONLY the matched errno string crosses (never message text); when
 * no code exists, `details` is omitted entirely.
 */
function mapSdkError(
  cause: unknown,
  correlationId: string,
): VexError {
  const baseLog = `[openrouter-test-client] verify failed correlationId=${correlationId}`;
  const causeCode = extractCauseCode(cause);
  const causeSuffix = causeCode === null ? "" : ` causeCode=${causeCode}`;
  const details =
    causeCode === null ? {} : { details: { causeCode } as const };

  if (cause instanceof RequestAbortedError) {
    log.warn(`${baseLog} class=RequestAbortedError${causeSuffix}`);
    return {
      code: "provider.unavailable",
      domain: "onboarding",
      message:
        "Couldn't reach OpenRouter (request aborted or timed out). Check your connection and retry.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId,
      ...details,
    };
  }
  if (cause instanceof RequestTimeoutError) {
    log.warn(`${baseLog} class=RequestTimeoutError${causeSuffix}`);
    return {
      code: "provider.unavailable",
      domain: "onboarding",
      message:
        "OpenRouter took too long to respond. Try again in a few moments.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId,
      ...details,
    };
  }
  if (cause instanceof ConnectionError) {
    log.warn(`${baseLog} class=ConnectionError${causeSuffix}`);
    return {
      code: "provider.unavailable",
      domain: "onboarding",
      message:
        "Couldn't reach OpenRouter (network error). Check your connection and retry.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId,
      ...details,
    };
  }

  if (cause instanceof OpenRouterError) {
    const status = cause.statusCode;
    log.warn(
      `${baseLog} class=OpenRouterError statusCode=${status}${causeSuffix}`,
    );
    if (status === 401) {
      return {
        code: "provider.invalid_api_key",
        domain: "onboarding",
        message:
          "OpenRouter rejected the API key. Verify the key in your OpenRouter dashboard and try again.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId,
        ...details,
      };
    }
    if (status === 402) {
      return {
        code: "provider.insufficient_credits",
        domain: "onboarding",
        message:
          "Your OpenRouter account has insufficient credits. Add funds in the OpenRouter dashboard and retry.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId,
        ...details,
      };
    }
    if (status === 404) {
      return {
        code: "provider.model_unsupported",
        domain: "onboarding",
        message:
          "OpenRouter couldn't find the model. Verify the model id in the OpenRouter models catalogue and try again.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId,
        ...details,
      };
    }
    if (status === 429 || (typeof status === "number" && status >= 500)) {
      return {
        code: "provider.unavailable",
        domain: "onboarding",
        message:
          "OpenRouter is temporarily unavailable (rate limit or service outage). Try again in a few minutes.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId,
        ...details,
      };
    }
  }

  // Generic fallback. Log class name (NOT message) so support can
  // correlate via the requestId without leaking SDK internals to
  // the renderer.
  const className =
    cause instanceof Error ? cause.constructor.name : typeof cause;
  log.warn(`${baseLog} class=${className}${causeSuffix}`);
  return {
    code: "provider.test_failed",
    domain: "onboarding",
    message:
      "Verification failed. Try again, or check the OpenRouter dashboard for service issues.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
    ...details,
  };
}

/**
 * Verify (apiKey, model) by sending a 16-token chat completion.
 * The hard wall-clock timeout via AbortController is the source of
 * truth — the SDK's internal timeoutMs is set but not relied upon.
 */
export async function verifyOpenRouterConnection(
  input: OpenRouterVerifyInput,
  options: OpenRouterVerifyOptions & { readonly correlationId: string },
): Promise<Result<{ readonly latencyMs: number }, VexError>> {
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const factory = options.clientFactory ?? defaultClientFactory;
  const client = factory(input.apiKey, timeoutMs);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const t0 = Date.now();
  try {
    await client.chat.send(
      {
        chatRequest: {
          model: input.model,
          messages: [{ role: "user", content: "ping" }],
          maxCompletionTokens: VERIFY_MAX_OUTPUT_TOKENS,
        },
      },
      { signal: ac.signal, retries: { strategy: "none" } },
    );
    return ok({ latencyMs: Date.now() - t0 });
  } catch (cause) {
    return err(mapSdkError(cause, options.correlationId));
  } finally {
    clearTimeout(timer);
  }
}
