/**
 * The pools.fun attribution client's CONTRACT: the exact signed string, the
 * exact wire body, and a named outcome for every answer the partner can give.
 *
 * Attribution is a badge, so nothing here may throw at the caller - the launch
 * handler and the sweep both call it in paths where a throw would be a
 * regression with real cost.
 *
 * The classification table is the load-bearing part. `rejected` removes a row
 * from the retry lane FOREVER, so every answer that is not a code from the
 * closed terminal vocabulary - a 429, a 5xx, an unknown code, a 2xx with no
 * success flag - must come back `retryable` instead. A misclassification in
 * either direction is silent: one drops badges that would have landed, the
 * other loops on a refusal that can never change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    services: { poolsFunAttestApiUrl: "https://attest.pools.test" },
  }),
}));

const { attributePoolsLaunch, buildPoolsAttestMessage } = await import(
  "@tools/pools-fun/attribution.js"
);
const { POOLS_ATTEST_TERMINAL_CODES, POOLS_ATTEST_RETRYABLE_CODES } = await import(
  "@tools/pools-fun/attribution-codes.js"
);

/** A real pools.fun token address from the launch fixtures in this directory. */
const TOKEN = "0x01e685D39E6BF52Ad0c421a4bE1e092CE684E6bb";
const TOKEN_LOWER = TOKEN.toLowerCase();
const SIGNATURE = `0x${"ab".repeat(65)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const ENDPOINT = "https://attest.pools.test/pools-fun/vex/attestations";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function attribute() {
  return attributePoolsLaunch({
    tokenAddress: TOKEN,
    attestSignature: SIGNATURE,
    txHash: TX_HASH,
  });
}

describe("buildPoolsAttestMessage - the exact bytes the launching wallet signs", () => {
  it("is `VEX-attest:v1:pools.fun:4663:<lowercase address>`", () => {
    expect(buildPoolsAttestMessage(TOKEN)).toBe(
      `VEX-attest:v1:pools.fun:4663:${TOKEN_LOWER}`,
    );
  });

  it("carries no trailing newline and no surrounding whitespace", () => {
    const message = buildPoolsAttestMessage(TOKEN);
    expect(message).toBe(message.trim());
    expect(message.endsWith("\n")).toBe(false);
  });

  it("lowercases regardless of the casing the decoder produced", () => {
    expect(buildPoolsAttestMessage(TOKEN_LOWER)).toBe(buildPoolsAttestMessage(TOKEN));
  });

  it("is NOT the trench string - the two venues share chain 4663 and must not share bytes", () => {
    expect(buildPoolsAttestMessage(TOKEN)).not.toBe(`VEX-attest:4663:${TOKEN_LOWER}`);
  });

  it("refuses anything that is not a 20-byte hex address", () => {
    expect(() => buildPoolsAttestMessage("not-an-address")).toThrow(/20-byte hex address/);
    expect(() => buildPoolsAttestMessage("0xdeadbeef")).toThrow(/20-byte hex address/);
    expect(() => buildPoolsAttestMessage("")).toThrow(/20-byte hex address/);
    expect(() => buildPoolsAttestMessage(`${TOKEN}00`)).toThrow(/20-byte hex address/);
  });
});

describe("attributePoolsLaunch - the wire contract", () => {
  it("POSTs the exact body to the exact path, with the address lowercased", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));

    expect(await attribute()).toEqual({ kind: "attributed" });

    const firstCall = fetchMock.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected exactly one fetch call");
    const [url, init] = firstCall;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      chainId: 4663,
      tokenAddress: TOKEN_LOWER,
      attestSignature: SIGNATURE,
      txHash: TX_HASH,
    });
  });

  it("keeps the txHash OUT of the signed bytes - it is a locator only", () => {
    expect(buildPoolsAttestMessage(TOKEN)).not.toContain(TX_HASH);
  });

  it("is a TOLERANT READER - extras alongside `success` are ignored", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, badge: "vex", attestedAt: "2026-08-23T00:00:00Z" }),
    );
    expect(await attribute()).toEqual({ kind: "attributed" });
  });
});

describe("attributePoolsLaunch - the classification table", () => {
  it("does NOT read a 2xx without `success:true` as agreement", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: "yes" }));
    expect(await attribute()).toEqual({ kind: "retryable", status: 200, code: null });
  });

  it("does NOT read `success:false` on a 2xx as a refusal either", async () => {
    // The partner answered 2xx and then denied it. That is a protocol
    // violation, not a definitive no - a row must never leave the lane on it.
    fetchMock.mockResolvedValue(jsonResponse(202, { success: false }));
    expect(await attribute()).toEqual({ kind: "retryable", status: 202, code: null });
  });

  it.each(POOLS_ATTEST_TERMINAL_CODES.map((code) => [code] as const))(
    "classifies the terminal code %s as a definitive rejection",
    async (code) => {
      fetchMock.mockResolvedValue(jsonResponse(400, { code }));
      expect(await attribute()).toEqual({ kind: "rejected", status: 400, code });
    },
  );

  it.each(POOLS_ATTEST_RETRYABLE_CODES.map((code) => [code] as const))(
    "classifies the retryable code %s as retryable, never terminal",
    async (code) => {
      fetchMock.mockResolvedValue(jsonResponse(409, { code }));
      expect(await attribute()).toEqual({ kind: "retryable", status: 409, code });
    },
  );

  it.each([429, 500, 502, 503, 504])(
    "classifies %i as retryable - the server answered, so it is neither transport nor terminal",
    async (status) => {
      fetchMock.mockResolvedValue(jsonResponse(status, { error: "upstream unavailable" }));
      expect(await attribute()).toEqual({ kind: "retryable", status, code: null });
    },
  );

  it("classifies an UNKNOWN code as a retryable protocol violation, never a refusal", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { code: "teapot_overheated" }));
    expect(await attribute()).toEqual({ kind: "retryable", status: 403, code: null });
  });

  it("classifies a MISSING code the same way", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, {}));
    expect(await attribute()).toEqual({ kind: "retryable", status: 400, code: null });
  });

  it("never lets partner free text into the outcome", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        code: "invalid_signature",
        message: "your signature 0xdeadbeef is wrong, visit https://evil.test",
        detail: "attacker controlled",
      }),
    );
    const outcome = await attribute();
    expect(outcome).toEqual({ kind: "rejected", status: 400, code: "invalid_signature" });
    expect(JSON.stringify(outcome)).not.toContain("evil.test");
    expect(JSON.stringify(outcome)).not.toContain("attacker controlled");
  });
});

describe("attributePoolsLaunch - transport and refusal to send", () => {
  it("reports a timeout as an AMBIGUOUS transport failure, not a refusal", async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const outcome = await attribute();
    expect(outcome.kind).toBe("transport_failed");
    expect(outcome).toMatchObject({ detail: expect.stringContaining("HTTP_TIMEOUT") });
  });

  it("scrubs the endpoint URL out of a transport failure detail", async () => {
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED ${ENDPOINT}`));
    const outcome = await attribute();
    expect(outcome.kind).toBe("transport_failed");
    expect(JSON.stringify(outcome)).not.toContain("attest.pools.test");
  });

  it("never sends a request for an address that is not 20-byte hex", async () => {
    const outcome = await attributePoolsLaunch({
      tokenAddress: "0xdead",
      attestSignature: SIGNATURE,
      txHash: TX_HASH,
    });
    expect(outcome).toEqual({ kind: "rejected", status: 0, code: "validation_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws for any answer shape", async () => {
    for (const body of ["not json at all", "", "null", "[]", "42"]) {
      fetchMock.mockResolvedValue(new Response(body, { status: 500 }));
      await expect(attribute()).resolves.toBeTruthy();
    }
  });
});
