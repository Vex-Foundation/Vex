/**
 * The attribution client's CONTRACT: the exact signed string, the exact wire
 * body, and a named outcome for every answer the launchpad can give.
 *
 * Attribution is a badge, so nothing here may throw at the caller — the launch
 * handler and the sweep both call it in paths where a throw would be a
 * regression with real cost.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/store.js", () => ({
  loadConfig: () => ({ services: { trenchExpressApiUrl: "https://api.trench.express" } }),
}));

const { attributeLaunchedToken, buildAttestMessage } = await import(
  "@tools/trench-express/attribution.js"
);

/**
 * FIXTURE PROVENANCE — funded live probe 2026-08-05, artifact
 * `agents_dm/trench-live/artifacts/attest-launch.result.json`: a real create on
 * chain 4663, the exact attest string the creator wallet signed (local
 * ecrecover matched), and the launchpad's own HTTP 200 body. Not a documented
 * shape — an observed one (rule 90).
 */
const TOKEN = "0x59fc003177f4C9f391c9536Cc977E73E33F5BFBe";
const LIVE_ATTEST_MESSAGE = "VEX-attest:4663:0x59fc003177f4c9f391c9536cc977e73e33f5bfbe";
/** The launchpad's literal 200 body from that probe. */
const LIVE_SUCCESS_BODY = { success: true, stamped: true };
const SIGNATURE = `0x${"ab".repeat(65)}`;

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

describe("buildAttestMessage", () => {
  it("reproduces the string the live probe's creator wallet actually signed", () => {
    expect(buildAttestMessage(TOKEN)).toBe(LIVE_ATTEST_MESSAGE);
  });

  it("is `VEX-attest:<chainId>:<lowercase address>` for any token", () => {
    expect(buildAttestMessage("0x505c835799F1291eBb5d7Ef8E8E50CA340a3aDE3")).toBe(
      "VEX-attest:4663:0x505c835799f1291ebb5d7ef8e8e50ca340a3ade3",
    );
  });

  it("lowercases regardless of the casing the decoder produced", () => {
    expect(buildAttestMessage(TOKEN.toLowerCase())).toBe(buildAttestMessage(TOKEN));
  });

  it("refuses anything that is not a 20-byte hex address", () => {
    expect(() => buildAttestMessage("not-an-address")).toThrow(/20-byte hex address/);
    expect(() => buildAttestMessage("0xdeadbeef")).toThrow(/20-byte hex address/);
  });
});

describe("attributeLaunchedToken", () => {
  it("POSTs {token, signature} with the address lowercased", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));

    const outcome = await attributeLaunchedToken({ tokenAddress: TOKEN, attestSignature: SIGNATURE });

    expect(outcome).toEqual({ kind: "attributed" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.trench.express/vex/attribute");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      token: TOKEN.toLowerCase(),
      signature: SIGNATURE,
    });
  });

  it("reads the launchpad's REAL 200 body as attributed", async () => {
    // `{"success":true,"stamped":true}` — observed, not documented.
    fetchMock.mockResolvedValue(jsonResponse(200, LIVE_SUCCESS_BODY));
    expect(await attributeLaunchedToken({ tokenAddress: TOKEN, attestSignature: SIGNATURE }))
      .toEqual({ kind: "attributed" });
  });

  it("is a TOLERANT READER — extras alongside `success` are ignored", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ...LIVE_SUCCESS_BODY, badge: "vex", attributedAt: "2026-08-05T00:00:00Z" }),
    );
    expect(await attributeLaunchedToken({ tokenAddress: TOKEN, attestSignature: SIGNATURE }))
      .toEqual({ kind: "attributed" });
  });

  it("does not read a 200 without a success flag as agreement", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: "yes" }));
    const outcome = await attributeLaunchedToken({ tokenAddress: TOKEN, attestSignature: SIGNATURE });
    expect(outcome.kind).toBe("rejected");
  });

  it.each([
    [400, { error: "malformed request" }, "malformed request"],
    [401, { error: "unauthorized" }, "unauthorized"],
    [403, { error: "signature is not from the creator" }, "signature is not from the creator"],
    [503, { error: "upstream unavailable" }, "upstream unavailable"],
  ])("names the provider's own refusal on %i", async (status, body, detail) => {
    fetchMock.mockResolvedValue(jsonResponse(status, body));
    expect(await attributeLaunchedToken({ tokenAddress: TOKEN, attestSignature: SIGNATURE })).toEqual(
      { kind: "rejected", status, detail },
    );
  });

  it("reports a timeout as an AMBIGUOUS transport failure, not a refusal", async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const outcome = await attributeLaunchedToken({ tokenAddress: TOKEN, attestSignature: SIGNATURE });
    expect(outcome.kind).toBe("transport_failed");
    expect(outcome).toMatchObject({ detail: expect.stringContaining("HTTP_TIMEOUT") });
  });

  it("scrubs the endpoint URL out of a transport failure detail", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED https://api.trench.express/vex/attribute"));
    const outcome = await attributeLaunchedToken({ tokenAddress: TOKEN, attestSignature: SIGNATURE });
    expect(outcome.kind).toBe("transport_failed");
    expect(JSON.stringify(outcome)).not.toContain("api.trench.express");
  });

  it("never sends a request for an address that is not 20-byte hex", async () => {
    const outcome = await attributeLaunchedToken({ tokenAddress: "0xdead", attestSignature: SIGNATURE });
    expect(outcome.kind).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
