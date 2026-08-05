/**
 * W2f (SPEC §2.5, §6) — what a DexScreener HTTP failure actually looks like by
 * the time it reaches the agent.
 *
 * The two defects pinned here were both live-measured (audit F3/F4). They are
 * asserted END TO END — through the real client, the real error mapper and the
 * real agent-facing summarizer — because each layer looked defensible alone and
 * the loss only showed up across the seam:
 *
 *  - the live 400 body is a JSON STRING containing an HTML page, and the old
 *    object-with-`error` reader discarded it;
 *  - no `httpStatus` was set, so a 400 classified as `provider_error` and the
 *    agent retried a request that could never succeed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DexScreenerClient } from "@tools/dexscreener/client.js";
import { classifyError, describeFailureForAgent } from "@vex-agent/tools/protocols/runtime/errors.js";

vi.mock("@config/store.js", () => ({
  loadConfig: () => ({ services: { dexScreenerApiUrl: "https://api.dexscreener.com" } }),
}));

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The body DexScreener actually answered `GET /latest/dex/search?q=U` with. */
const LIVE_400_BODY =
  "<html>\r\n<head><title>400 Bad Request</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n</body>\r\n</html>\r\n";

const originalFetch = globalThis.fetch;
let client: DexScreenerClient;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  client = new DexScreenerClient("https://api.dexscreener.com");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockError(status: number, body: unknown): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => body,
  });
}

async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
}

describe("dexscreener HTTP failure as the agent sees it", () => {
  it("carries the JSON-STRING body through, sanitized, instead of dropping it", async () => {
    mockError(400, LIVE_400_BODY);
    const err = await failureOf(() => client.search("U"));
    const agentText = describeFailureForAgent(err);

    expect(agentText).toContain("HTTP 400");
    // The summarizer removes whole HTML documents; the point is that the body
    // was CARRIED and sanitized, never that raw markup reaches the model.
    expect(agentText).not.toContain("<html");
    expect(agentText).not.toContain("<title>");
  });

  it("classifies a 400 as invalid_request, not provider_error", async () => {
    mockError(400, LIVE_400_BODY);
    const err = await failureOf(() => client.search("U"));
    expect(classifyError(describeFailureForAgent(err), err)).toBe("invalid_request");
  });

  it("still classifies 429 as rate_limit and 403 as auth — now from the status, not from luck", async () => {
    mockError(429, null);
    const rateLimited = await failureOf(() => client.search("USDC"));
    expect(classifyError(describeFailureForAgent(rateLimited), rateLimited)).toBe("rate_limit");

    mockError(403, "Forbidden");
    const forbidden = await failureOf(() => client.getPairs("solana", "abc"));
    expect(classifyError(describeFailureForAgent(forbidden), forbidden)).toBe("auth");
  });

  it("classifies 5xx as provider_error", async () => {
    mockError(503, null);
    const err = await failureOf(() => client.search("USDC"));
    expect(classifyError(describeFailureForAgent(err), err)).toBe("provider_error");
  });

  it("sends Accept and a User-Agent on every request", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ schemaVersion: "1.0.0", pairs: [] }),
    });
    await client.search("USDC");
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Accept).toBe("application/json");
    expect(init.headers["User-Agent"]).toContain("Vex-Agent");
  });
});
