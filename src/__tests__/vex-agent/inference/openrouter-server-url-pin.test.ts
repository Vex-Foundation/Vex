/**
 * The keyed engine client always targets openrouter.ai, whatever the process
 * environment says.
 *
 * `@openrouter/sdk@1.4.x` resolves its origin as `serverURL` option, else
 * `server` option, else the `OPENROUTER_BASE_URL` environment variable
 * (`esm/lib/config.js` `serverURLFromOptions`). An unpinned client would send
 * the user's key to whatever host that variable names. This drives the REAL
 * `OpenRouterProvider` and SDK with only the global `fetch` intercepted (the
 * production `roundFetch` delegates to it outside an inference round) and
 * asserts on the URL of the request that would have gone over the wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnv } from "@openrouter/sdk/lib/env.js";

vi.mock("@utils/logger.js", () => {
  const quiet = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
  return { default: quiet, logger: quiet, createChildLogger: () => quiet };
});

const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");

const REDIRECT_HOST = "redirect.invalid";

function requestUrl(input: unknown): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return String(input);
}

let requestedUrls: string[] = [];

beforeEach(() => {
  requestedUrls = [];
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  vi.stubEnv("AGENT_MODEL", "test/model");
  vi.stubEnv("OPENROUTER_BASE_URL", `https://${REDIRECT_HOST}/api/v1`);
  // The SDK memoizes its env read; drop it so the stubbed variable is seen.
  resetEnv();
  vi.stubGlobal("fetch", async (input: unknown) => {
    requestedUrls.push(requestUrl(input));
    return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 4 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnv();
});

describe("OpenRouterProvider - pinned API origin", () => {
  it("ignores OPENROUTER_BASE_URL and sends the keyed request to openrouter.ai", async () => {
    const provider = new OpenRouterProvider();

    await provider.getBalance();

    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://openrouter.ai");
      expect(parsed.pathname.startsWith("/api/v1/")).toBe(true);
    }
    expect(requestedUrls.some((url) => url.includes(REDIRECT_HOST))).toBe(false);
  });
});
