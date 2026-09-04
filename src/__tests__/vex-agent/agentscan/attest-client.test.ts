/**
 * AgentScan token-attestation client — wire shape + outcome mapping.
 *
 * Pinned here:
 *   - POST <baseUrl>/v1/tokens/attest, NO Authorization header (the proof is
 *     the signature itself, exactly like the trench attribution client);
 *   - the exact body fields, address lowercased on the wire;
 *   - a base-URL subpath survives the join;
 *   - every server answer maps to the outcome the sweep keys off: only
 *     429/5xx/network are retryable, any 400 (validation_failed,
 *     invalid_signature, chain_unsupported) is permanent for that row;
 *   - `Retry-After` is surfaced on 429;
 *   - nothing throws;
 *   - the signature never reaches a detail string, on any path.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

import {
  fetchTokenAttestationVerdict,
  postTokenAttestation,
} from "../../../vex-agent/agentscan/attest-client.js";

const SIGNATURE = `0x${"ab".repeat(65)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const TOKEN_ADDRESS = "0x59fc003177f4C9f391c9536Cc977E73E33F5BFBe";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const INPUT = {
  chainId: 4663,
  launchpad: "pools_fun" as const,
  tokenAddress: TOKEN_ADDRESS,
  attestSignature: SIGNATURE,
  txHash: TX_HASH,
};

describe("postTokenAttestation — wire shape", () => {
  it("POSTs to /v1/tokens/attest with NO auth header and the exact, lowercased body", async () => {
    const mock = stubFetch(jsonResponse(200, { status: "accepted", verifyStatus: "verified" }));
    const outcome = await postTokenAttestation("http://localhost", INPUT);

    // ACCEPTED carries the QUEUE state the server named, not a verdict: the
    // POST answers `{status:"accepted", verifyStatus}` and the verdict is read
    // back separately.
    expect(outcome).toEqual({ kind: "accepted", verifyStatus: "verified" });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost/v1/tokens/attest");
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    // The launchpad is on the wire and is NEVER defaulted here: it selects which
    // creation proof the verifier applies, so the caller states it.
    expect(JSON.parse(init.body as string)).toEqual({
      chainId: 4663,
      launchpad: "pools_fun",
      tokenAddress: TOKEN_ADDRESS.toLowerCase(),
      attestSignature: SIGNATURE,
      txHash: TX_HASH,
    });
  });

  it("preserves a base-URL subpath", async () => {
    const mock = stubFetch(jsonResponse(200, { status: "accepted" }));
    await postTokenAttestation("https://example.org/scan/", INPUT);
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toBe("https://example.org/scan/v1/tokens/attest");
  });

  it.each([
    ["validation_failed"],
    ["invalid_signature"],
    ["chain_unsupported"],
  ])("maps 400 %s to invalid — permanent for the row", async (code) => {
    stubFetch(jsonResponse(400, { error: { code } }));
    const outcome = await postTokenAttestation("http://localhost", INPUT);
    expect(outcome.kind).toBe("invalid");
  });

  it("maps 429 to retryable, carrying Retry-After", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "45" }));
    const outcome = await postTokenAttestation("http://localhost", INPUT);
    expect(outcome).toMatchObject({ kind: "retryable", status: 429, retryAfterSeconds: 45 });
  });

  it("maps 500 to retryable", async () => {
    stubFetch(jsonResponse(500, { error: { code: "internal" } }));
    const outcome = await postTokenAttestation("http://localhost", INPUT);
    expect(outcome).toMatchObject({ kind: "retryable", status: 500, retryAfterSeconds: null });
  });

  it("maps a network failure to retryable with a null status", async () => {
    stubFetch(new Error("connect ECONNREFUSED"));
    const outcome = await postTokenAttestation("http://localhost", INPUT);
    expect(outcome).toMatchObject({ kind: "retryable", status: null, retryAfterSeconds: null });
  });

  it("never lets the signature reach a detail string, on any path", async () => {
    stubFetch(
      jsonResponse(400, {
        error: { code: "invalid_signature", message: `signature ${SIGNATURE} did not match the creator` },
      }),
    );
    const invalid = await postTokenAttestation("http://localhost", INPUT);
    expect(JSON.stringify(invalid)).not.toContain(SIGNATURE);

    stubFetch(new Error(`upstream echoed ${SIGNATURE}`));
    const network = await postTokenAttestation("http://localhost", INPUT);
    expect(JSON.stringify(network)).not.toContain(SIGNATURE);
  });
});

/**
 * The verdict read-back. A 2xx on the POST proves only that the claim entered
 * the verify queue; this route is the only place the server says whether the
 * creation proof was checked and held.
 */
describe("fetchTokenAttestationVerdict", () => {
  const VERDICT_INPUT = { chainId: 4663, tokenAddress: TOKEN_ADDRESS };

  it("GETs the public token route with the address lowercased and no auth header", async () => {
    const mock = stubFetch(jsonResponse(200, { status: "verified", recommended: true }));
    const outcome = await fetchTokenAttestationVerdict("https://example.org/scan/", VERDICT_INPUT);

    expect(outcome).toEqual({ kind: "verdict", status: "verified" });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://example.org/scan/v1/tokens/4663/${TOKEN_ADDRESS.toLowerCase()}`);
    expect((init.headers as Record<string, string> | undefined)?.["Authorization"]).toBeUndefined();
  });

  it.each(["unverified", "verified", "mismatch", "unverifiable", "revoked"])(
    "carries the server's own status %s through unchanged",
    async (status) => {
      stubFetch(jsonResponse(200, { status }));
      expect(await fetchTokenAttestationVerdict("http://localhost", VERDICT_INPUT)).toEqual({
        kind: "verdict",
        status,
      });
    },
  );

  it("reads a 404 as ABSENT: the honest answer for a token with no candidate row", async () => {
    stubFetch(jsonResponse(404, { error: { code: "not_found", message: "token attestation not found" } }));
    expect(await fetchTokenAttestationVerdict("http://localhost", VERDICT_INPUT)).toEqual({
      kind: "absent",
    });
  });

  it("refuses to store a status this build does not recognize", async () => {
    // Inventing a verdict, or writing an unknown word into a CHECK-constrained
    // column, are both worse than saying "ask again": the server never gave a
    // verdict this build can name.
    stubFetch(jsonResponse(200, { status: "provisionally_maybe" }));
    const outcome = await fetchTokenAttestationVerdict("http://localhost", VERDICT_INPUT);
    expect(outcome.kind).toBe("retryable");
  });

  it("maps 429 to retryable with Retry-After, 500 to retryable, and 400 to invalid", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "42" }));
    expect(await fetchTokenAttestationVerdict("http://localhost", VERDICT_INPUT)).toMatchObject({
      kind: "retryable",
      status: 429,
      retryAfterSeconds: 42,
    });

    stubFetch(jsonResponse(500, {}));
    expect((await fetchTokenAttestationVerdict("http://localhost", VERDICT_INPUT)).kind).toBe(
      "retryable",
    );

    stubFetch(jsonResponse(400, { error: { code: "validation_failed" } }));
    expect((await fetchTokenAttestationVerdict("http://localhost", VERDICT_INPUT)).kind).toBe(
      "invalid",
    );
  });

  it("maps a network failure to retryable with a null status, and never throws", async () => {
    stubFetch(new Error("ECONNREFUSED"));
    expect(await fetchTokenAttestationVerdict("http://localhost", VERDICT_INPUT)).toMatchObject({
      kind: "retryable",
      status: null,
    });
  });
});
