/**
 * Vex Cloud error copy per status, from REAL errors: the gateway's own error
 * bodies (`VexVirtualsCompute/src/proxy/errors.ts` shape, reasons from
 * `chat-handler.ts` and `http/app.ts`) go through the real SDK client and the
 * real `normalizeOpenRouterError`, and the thrown error is what the chat
 * handler and the error bridge classify.
 *
 * Pinned: in Vex Cloud mode 402 says "top up VEX", 401 says "sign in to Vex
 * Cloud again", 403 says the account is paused, 503 says Vex Cloud is
 * unavailable; the bring-your-own-key copy for the same statuses is
 * unchanged.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger.js", () => {
  const quiet = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
  return { default: quiet, logger: quiet, createChildLogger: () => quiet };
});

const { createInferenceClient } = await import("@vex-agent/inference/openrouter/client-factory.js");
const { normalizeOpenRouterError } = await import("@vex-agent/inference/openrouter/errors.js");
const { classifyEngineError } = await import("../chat/engine-failure-copy.js");
const { classifyEngineRemedy } = await import("@shared/engine-error-classification.js");
const { engineErrorRemedyHint } = await import("@shared/engine-error-copy.js");

const CORR = "corr-vex-cloud";

const BODIES: Record<number, unknown> = {
  402: {
    error: {
      code: 402,
      message: "Your Vex Cloud balance is too low for this request. Top up VEX to continue.",
      metadata: { reason: "insufficient_balance", available_wei: "0", required_wei: "1000", affordable_max_tokens: 0, min_max_tokens: 4096 },
    },
  },
  401: {
    error: { code: 401, message: "Your Vex Cloud session is missing, invalid or expired. Sign in again.", metadata: { reason: "session_invalid" } },
  },
  403: { error: { code: 403, message: "This Vex Cloud account is paused for review.", metadata: { reason: "account_paused" } } },
  503: {
    error: { code: 503, message: "VEX pricing is paused; new requests resume when a fresh rate is available.", metadata: { reason: "rate_unavailable" } },
  },
};

/** The error the engine actually throws for a gateway status. */
async function thrownFor(status: number): Promise<unknown> {
  const client = createInferenceClient(
    { mode: "vexcloud", serverURL: "http://127.0.0.1:8787/v1", apiKey: "vxs_test_bearer_0001" },
    async () =>
      new Response(JSON.stringify(BODIES[status]), { status, headers: { "content-type": "application/json" } }),
  );
  try {
    await client.chat.send(
      { chatRequest: { model: "anthropic/claude-haiku-5.5", messages: [{ role: "user", content: "hi" }], stream: false } },
      { retries: { strategy: "none" } },
    );
  } catch (err) {
    return normalizeOpenRouterError(err, "chat completion");
  }
  throw new Error("expected the send to throw");
}

function signalsOf(err: unknown) {
  const rec = err as Record<string, unknown>;
  const own = (key: string): unknown => (Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined);
  const status = own("statusCode");
  return {
    statusCode: typeof status === "number" ? status : null,
    errorClass: typeof own("errorClass") === "string" ? (own("errorClass") as string) : null,
    errorType: typeof own("errorType") === "string" ? (own("errorType") as string) : null,
    causeCode: null,
  };
}

describe("Vex Cloud mode: the gateway's statuses get Vex Cloud copy", () => {
  it("402 asks to top up VEX", async () => {
    const error = classifyEngineError(await thrownFor(402), CORR, "vexcloud");
    expect(error.code).toBe("provider.insufficient_credits");
    expect(error.message).toMatch(/Top up VEX/);
    expect(error.message).not.toMatch(/provider account/);
  });

  it("401 asks to sign in to Vex Cloud again, never to fix a key", async () => {
    const error = classifyEngineError(await thrownFor(401), CORR, "vexcloud");
    expect(error.message).toMatch(/Sign in to Vex Cloud again/);
    expect(error.message).not.toMatch(/API key/);
  });

  it("403 says the account is paused", async () => {
    const error = classifyEngineError(await thrownFor(403), CORR, "vexcloud");
    expect(error.code).toBe("permissions.denied");
    expect(error.message).toMatch(/paused this account/);
  });

  it("503 says Vex Cloud is unavailable, retryable", async () => {
    const error = classifyEngineError(await thrownFor(503), CORR, "vexcloud");
    expect(error.code).toBe("provider.unavailable");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/Vex Cloud is unavailable/);
  });

  it("the push event's remedy says the same, per status", async () => {
    const hints = await Promise.all(
      [402, 401, 403, 503].map(async (status) => engineErrorRemedyHint(classifyEngineRemedy(signalsOf(await thrownFor(status)), "vexcloud"))),
    );
    expect(hints).toEqual([
      "Top up VEX for Vex Cloud, then retry.",
      "Sign in to Vex Cloud again in Settings, then retry.",
      "Vex Cloud paused this account for review. Nothing more can run until it is cleared.",
      "Vex Cloud is unavailable right now. Retry in a moment.",
    ]);
  });
});

describe("bring-your-own-key copy is unchanged", () => {
  it("402 is provider credits and 401 is the API key", async () => {
    expect(classifyEngineError(await thrownFor(402), CORR).message).toBe(
      "The inference provider account has insufficient credits. Add funds and retry.",
    );
    expect(classifyEngineError(await thrownFor(401), CORR).message).toBe(
      "The inference provider rejected the API key. Verify it in provider setup and retry.",
    );
    expect(engineErrorRemedyHint(classifyEngineRemedy(signalsOf(await thrownFor(402))))).toBe(
      "Top up your provider credits, then retry.",
    );
  });
});
