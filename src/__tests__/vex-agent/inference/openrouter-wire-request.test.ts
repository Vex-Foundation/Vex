/**
 * W2 — WIRE-level proof of the request-side additions.
 *
 * The other tests in this directory assert on the camelCase object we hand to
 * `chat.send`. That proves our composition but NOT that the SDK actually emits
 * the snake_case fields OpenRouter reads. Those two can diverge silently: a
 * field we set is simply dropped if the SDK's outbound schema does not know it,
 * and nothing fails.
 *
 * So this suite drives the REAL SDK client with an intercepted fetcher and
 * asserts on the JSON body that would have gone over the wire — the same
 * discipline `rules/90` prescribes for provider-facing changes.
 *
 * Pins three things:
 *   - `provider.require_parameters` is present for tool-bearing requests
 *     (the new behaviour: previously only the judge's responseFormat path set it);
 *   - `session_id` carries the sticky routing key, mission run winning over session;
 *   - a request with neither tools, format, nor context emits NEITHER key, so
 *     background callers stay byte-identical to pre-W2.
 */

import { describe, it, expect } from "vitest";

import { OpenRouter, HTTPClient } from "@openrouter/sdk";
import { buildOpenRouterParams } from "@vex-agent/inference/openrouter/params.js";
import type {
  InferenceConfig,
  InferenceRequestContext,
  ProviderMessage,
  ToolDefinition,
} from "@vex-agent/inference/types.js";

const CONFIG: InferenceConfig = {
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  contextLimit: 128_000,
  maxOutputTokens: 4096,
  inputPricePerM: 3,
  outputPricePerM: 15,
  priceCurrency: "USD",
  cachePricePerM: null,
  cacheWritePricePerM: null,
  reasoningPricePerM: null,
  supportsReasoningEffort: false,
};

const MESSAGES: ProviderMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hello" },
];

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wallet_balance",
      description: "Read a wallet balance",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

/**
 * Minimal well-formed non-streaming completion so the SDK parses a response.
 *
 * `system_fingerprint` is REQUIRED by the 1.1.13 `ChatResult` schema — omitting
 * it makes the SDK reject the response with a ZodError. Recorded here because
 * it is a live-shape constraint the type alone does not advertise.
 */
const CHAT_RESULT_BODY = JSON.stringify({
  id: "gen-1",
  model: CONFIG.model,
  object: "chat.completion",
  created: 1,
  system_fingerprint: "fp-test",
  choices: [
    { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/**
 * Send `chatRequest` through a real `OpenRouter` client whose fetcher is
 * intercepted, and return the parsed JSON body that would have been sent.
 */
async function captureWireBody(
  chatRequest: Parameters<OpenRouter["chat"]["send"]>[0]["chatRequest"],
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null;

  const httpClient = new HTTPClient({
    fetcher: async (input) => {
      const request = input as Request;
      captured = JSON.parse(await request.text()) as Record<string, unknown>;
      return new Response(CHAT_RESULT_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const client = new OpenRouter({ apiKey: "sk-or-test", httpClient });
  await client.chat.send({ chatRequest });

  if (captured === null) throw new Error("fetcher was never invoked");
  return captured;
}

/**
 * Same interception, but returns the request HEADERS alongside the body and
 * lets the caller supply the full envelope (not just `chatRequest`).
 *
 * `xOpenRouterMetadata` is an ENVELOPE field, a sibling of `chatRequest` — the
 * SDK serialises it to the `X-OpenRouter-Metadata` HEADER, not into the JSON
 * body (verified against the installed 1.1.13:
 * `esm/models/operations/sendchatcompletionrequest.d.ts` `$Outbound`). So a
 * body-only assertion could not tell whether we opted in at all.
 */
async function captureWireEnvelope(
  request: Parameters<OpenRouter["chat"]["send"]>[0],
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
  let capturedBody: Record<string, unknown> | null = null;
  let capturedHeaders: Headers | null = null;

  const httpClient = new HTTPClient({
    fetcher: async (input) => {
      const req = input as Request;
      capturedHeaders = req.headers;
      capturedBody = JSON.parse(await req.text()) as Record<string, unknown>;
      return new Response(CHAT_RESULT_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const client = new OpenRouter({ apiKey: "sk-or-test", httpClient });
  await client.chat.send(request);

  if (capturedBody === null || capturedHeaders === null) {
    throw new Error("fetcher was never invoked");
  }
  return { body: capturedBody, headers: capturedHeaders };
}

describe("OpenRouter wire request — routing-metadata opt-in", () => {
  it("emits the X-OpenRouter-Metadata header when the envelope opts in", async () => {
    const params = buildOpenRouterParams(MESSAGES, TOOLS, CONFIG, false);
    const { headers } = await captureWireEnvelope({
      xOpenRouterMetadata: "enabled",
      chatRequest: { ...params, stream: false },
    });

    expect(headers.get("x-openrouter-metadata")).toBe("enabled");
  });

  it("emits NO such header when the envelope does not opt in", async () => {
    const params = buildOpenRouterParams(MESSAGES, TOOLS, CONFIG, false);
    const { headers } = await captureWireEnvelope({
      chatRequest: { ...params, stream: false },
    });

    expect(headers.has("x-openrouter-metadata")).toBe(false);
  });

  it("leaves the request BODY byte-identical whether or not it opts in", async () => {
    // The envelope field must not leak into `ChatRequest`. If it ever did, it
    // would change the prompt-cache key for every conversational turn.
    const params = buildOpenRouterParams(MESSAGES, TOOLS, CONFIG, false);
    const withMetadata = await captureWireEnvelope({
      xOpenRouterMetadata: "enabled",
      chatRequest: { ...params, stream: false },
    });
    const without = await captureWireEnvelope({
      chatRequest: { ...params, stream: false },
    });

    expect(JSON.stringify(withMetadata.body)).toBe(JSON.stringify(without.body));
  });
});

describe("OpenRouter wire request — provider preferences", () => {
  it("emits provider.require_parameters for a TOOL-bearing request", async () => {
    const params = buildOpenRouterParams(MESSAGES, TOOLS, CONFIG, false);
    const body = await captureWireBody({ ...params, stream: false });

    expect(body.provider).toEqual({ require_parameters: true });
    // The tools themselves must still be on the wire — require_parameters is
    // meaningless without them.
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("emits NO provider key when there are no tools, no format and no pin", async () => {
    const params = buildOpenRouterParams(MESSAGES, [], CONFIG, false);
    const body = await captureWireBody({ ...params, stream: false });

    expect("provider" in body).toBe(false);
  });
});

describe("OpenRouter wire request — sticky routing key", () => {
  it("emits session_id from the sessionId when there is no mission run", async () => {
    const context: InferenceRequestContext = {
      sessionId: "session-abc",
      missionRunId: null,
    };
    const params = buildOpenRouterParams(
      MESSAGES,
      TOOLS,
      CONFIG,
      false,
      undefined,
      context,
    );
    const body = await captureWireBody({ ...params, stream: false });

    expect(body.session_id).toBe("session-abc");
  });

  it("prefers the missionRunId over the sessionId as the grouping key", async () => {
    const context: InferenceRequestContext = {
      sessionId: "session-abc",
      missionRunId: "run-xyz",
    };
    const params = buildOpenRouterParams(
      MESSAGES,
      TOOLS,
      CONFIG,
      false,
      undefined,
      context,
    );
    const body = await captureWireBody({ ...params, stream: false });

    expect(body.session_id).toBe("run-xyz");
  });

  it("emits NO session_id when no context is supplied (background calls)", async () => {
    const params = buildOpenRouterParams(MESSAGES, [], CONFIG, false);
    const body = await captureWireBody({ ...params, stream: false });

    expect("session_id" in body).toBe(false);
  });

  it("omits an over-long id rather than truncating it into a collision", async () => {
    const context: InferenceRequestContext = {
      sessionId: "s".repeat(257),
      missionRunId: null,
    };
    const params = buildOpenRouterParams(
      MESSAGES,
      [],
      CONFIG,
      false,
      undefined,
      context,
    );
    const body = await captureWireBody({ ...params, stream: false });

    expect("session_id" in body).toBe(false);
  });
});
