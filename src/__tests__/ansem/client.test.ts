/**
 * Ansem client behaviour — honest classification of every way the feed can
 * refuse, and the token discipline on the one optional credential.
 *
 * The measured production reality (2026-08-28) is a Cloudflare challenge on
 * every path for non-browser clients; the FIRST test here pins that exact
 * shape landing in ANSEM_UNAVAILABLE, because that classification is what
 * turns a challenged feed into a fail-closed, stack-untouched run instead of
 * a mystery.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../errors.js";
import { AnsemClient } from "@tools/ansem/client.js";
import { ANSEM_API_KEY_ENV } from "@tools/ansem/constants.js";

const BASE = "https://ansem.io";
const SOL = "So11111111111111111111111111111111111111112";
const VALID = [{ mint: SOL, marketCap: 1_000_000, symbol: "SOL", universe: "Z500 Curated" }];

interface Captured { urls: string[]; headers: Array<Record<string, string>> }

function stubFetch(make: () => Response): Captured {
  const captured: Captured = { urls: [], headers: [] };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    captured.urls.push(url);
    captured.headers.push((init?.headers ?? {}) as Record<string, string>);
    return Promise.resolve(make());
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[ANSEM_API_KEY_ENV];
});

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try { await promise; return null; } catch (err) { return (err as { code?: string }).code ?? null; }
}

describe("refusal classification", () => {
  it("a bot-management challenge (403 + HTML) is UNAVAILABLE — an access control, never solved", async () => {
    stubFetch(() => new Response("<!DOCTYPE html><title>Just a moment...</title>", {
      status: 403, headers: { "content-type": "text/html; charset=UTF-8" },
    }));
    expect(await codeOf(new AnsemClient(BASE).fetchSnapshot())).toBe(ErrorCodes.ANSEM_UNAVAILABLE);
  });

  it("an HTML body on HTTP 200 is STILL unavailable — a challenge can answer ok", async () => {
    stubFetch(() => new Response("<html>challenge</html>", {
      status: 200, headers: { "content-type": "text/html" },
    }));
    expect(await codeOf(new AnsemClient(BASE).fetchSnapshot())).toBe(ErrorCodes.ANSEM_UNAVAILABLE);
  });

  it("a 2xx non-JSON non-HTML body is INVALID — the feed answered garbage", async () => {
    stubFetch(() => new Response("plainly not json", {
      status: 200, headers: { "content-type": "application/json" },
    }));
    expect(await codeOf(new AnsemClient(BASE).fetchSnapshot())).toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
  });

  it("a 5xx is UNAVAILABLE", async () => {
    stubFetch(() => new Response("{}", { status: 503 }));
    expect(await codeOf(new AnsemClient(BASE).fetchSnapshot())).toBe(ErrorCodes.ANSEM_UNAVAILABLE);
  });

  it("valid JSON flows through the snapshot validator", async () => {
    stubFetch(() => new Response(JSON.stringify(VALID), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const snapshot = await new AnsemClient(BASE).fetchSnapshot();
    expect(snapshot.coins[0]?.mintAddress).toBe(SOL);
  });
});

describe("feed-token discipline", () => {
  it("sends no Authorization header when ANSEM_API_KEY is absent", async () => {
    const captured = stubFetch(() => new Response(JSON.stringify(VALID), { status: 200 }));
    await new AnsemClient(BASE).fetchSnapshot();
    expect(captured.headers[0]?.authorization).toBeUndefined();
  });

  it("sends the bearer token when configured, and never leaks it into an error", async () => {
    process.env[ANSEM_API_KEY_ENV] = "test-ansem-token";
    const captured = stubFetch(() => new Response("<html>denied</html>", { status: 403, headers: { "content-type": "text/html" } }));
    try {
      await new AnsemClient(BASE).fetchSnapshot();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(captured.headers[0]?.authorization).toBe("Bearer test-ansem-token");
      const text = `${(err as Error).message} ${(err as { hint?: string }).hint ?? ""}`;
      expect(text).not.toContain("test-ansem-token");
    }
  });

  it("targets /api/coins on the configured origin", async () => {
    const captured = stubFetch(() => new Response(JSON.stringify(VALID), { status: 200 }));
    await new AnsemClient(BASE).fetchSnapshot();
    expect(captured.urls[0]).toBe("https://ansem.io/api/coins");
  });
});
