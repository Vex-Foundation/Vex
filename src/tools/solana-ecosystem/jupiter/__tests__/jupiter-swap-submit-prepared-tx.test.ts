/**
 * `submitPreparedTx` unit tests (W5 design §2/R2/R2b; landing-lane design
 * `solana-landing-lanes-design.md` D1/D4) — the TIP-GATED Jupiter
 * `/tx/v1/submit` lane. Mocks the shared `fetchJson` boundary exactly like
 * `jupiter-swap-v2-client.test.ts` does for `jupiterSwapSubmit` itself.
 *
 * The lane gate is enforced by the COMPILER: `submitPreparedTx` requires a
 * `JupiterSubmitTipProof`, which only `JupiterSubmitTipProof.certify` can
 * produce and only for a tip that is both on Jupiter's published receiver
 * allowlist and at/above the documented 1,000,000-lamport minimum. The
 * `@ts-expect-error` cases below fail the build if that gate is ever loosened
 * into a caller convention.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { VexError, ErrorCodes } from "../../../../errors.js";
import {
  JUPITER_SUBMIT_MIN_TIP_LAMPORTS,
  JUPITER_TIP_RECEIVER_ADDRESSES,
} from "../jupiter-swaps/constants.js";
import { JupiterSubmitTipProof } from "../jupiter-swaps/submit-tip-proof.js";

const mockFetchJson = vi.fn();
vi.mock("@utils/http.js", () => ({
  fetchJson: (...args: unknown[]) => (mockFetchJson as (...a: unknown[]) => unknown)(...args),
}));

const { submitPreparedTx } = await import(
  "@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-prepared-tx.js"
);

const TIP_RECEIVER = JUPITER_TIP_RECEIVER_ADDRESSES[0]!;

/** A real, honestly-minted proof — the only way to reach `/tx/v1/submit`. */
function qualifyingTipProof(): JupiterSubmitTipProof {
  const proof = JupiterSubmitTipProof.certify({
    recipient: TIP_RECEIVER,
    lamports: BigInt(JUPITER_SUBMIT_MIN_TIP_LAMPORTS),
  });
  if (!proof) throw new Error("test fixture: a minimum-tip to an allowlisted receiver must certify");
  return proof;
}

function preparedFixture(signature: string) {
  return {
    serialized: Buffer.from("prepared-signed-transaction-bytes"),
    signature,
    recentBlockhash: "11111111111111111111111111111112",
    lastValidBlockHeight: 100,
  };
}

function httpError(status: number, message: string): VexError {
  const err = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, message);
  err.httpStatus = status;
  return err;
}

describe("JupiterSubmitTipProof — the only producer of /submit lane evidence", () => {
  it("certifies a tip at the documented minimum to an allowlisted receiver", () => {
    const proof = JupiterSubmitTipProof.certify({
      recipient: TIP_RECEIVER,
      lamports: BigInt(JUPITER_SUBMIT_MIN_TIP_LAMPORTS),
    });
    expect(proof?.describe()).toEqual({
      tipLamports: JUPITER_SUBMIT_MIN_TIP_LAMPORTS,
      tipReceiver: TIP_RECEIVER,
    });
  });

  it("refuses to certify a BELOW-minimum tip — Jupiter documents 400 'missing or insufficient tip'", () => {
    expect(
      JupiterSubmitTipProof.certify({
        recipient: TIP_RECEIVER,
        lamports: BigInt(JUPITER_SUBMIT_MIN_TIP_LAMPORTS) - 1n,
      }),
    ).toBeNull();
  });

  it("refuses to certify a tip paid to a NON-allowlisted receiver", () => {
    expect(
      JupiterSubmitTipProof.certify({
        recipient: "AttackerControlledAddress1111111111111111111",
        lamports: BigInt(JUPITER_SUBMIT_MIN_TIP_LAMPORTS),
      }),
    ).toBeNull();
  });

  it("cannot be forged structurally — a look-alike object is not assignable (compile-time gate)", () => {
    // The literal stays on ONE line so the directive covers the line TypeScript
    // actually reports the error on — a multi-line literal reports at the first
    // excess property, leaving the directive above the declaration unused.
    // @ts-expect-error a plain object cannot satisfy the nominal proof class
    const forged: JupiterSubmitTipProof = { tipLamports: JUPITER_SUBMIT_MIN_TIP_LAMPORTS, tipReceiver: TIP_RECEIVER };
    void forged;
  });
});

describe("submitPreparedTx", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, JUPITER_API_KEY: "test-jupiter-key" };
  });

  it("cannot be called without tip proof (compile-time lane gate)", async () => {
    mockFetchJson.mockResolvedValueOnce({ signature: "local-sig-1" });
    // @ts-expect-error /tx/v1/submit is unreachable without proof of a qualifying tip
    await submitPreparedTx(preparedFixture("local-sig-1"));
  });

  it("submits the base64 of the prepared bytes and reports accepted on a matching signature", async () => {
    mockFetchJson.mockResolvedValueOnce({ signature: "local-sig-1" });

    const prepared = preparedFixture("local-sig-1");
    const outcome = await submitPreparedTx(prepared, qualifyingTipProof());

    expect(outcome).toEqual({ kind: "accepted", signature: "local-sig-1" });
    const [url, opts] = mockFetchJson.mock.calls[0]!;
    expect(url).toBe("https://api.jup.ag/tx/v1/submit");
    expect(JSON.parse((opts as { body: string }).body)).toEqual({
      signedTransaction: Buffer.from(prepared.serialized).toString("base64"),
    });
  });

  it("reports signature_mismatch WITHOUT throwing when the provider echoes a different signature", async () => {
    mockFetchJson.mockResolvedValueOnce({ signature: "provider-sig-different" });

    const outcome = await submitPreparedTx(preparedFixture("local-sig-1"), qualifyingTipProof());

    expect(outcome).toEqual({
      kind: "signature_mismatch",
      localSignature: "local-sig-1",
      providerSignature: "provider-sig-different",
    });
  });

  it("classifies a 400 (e.g. missing/insufficient tip) as a DEFINITIVE rejection — nothing was broadcast", async () => {
    mockFetchJson.mockRejectedValueOnce(httpError(400, "missing or insufficient tip"));

    const outcome = await submitPreparedTx(preparedFixture("local-sig-1"), qualifyingTipProof());

    expect(outcome.kind).toBe("rejected_before_broadcast");
  });

  it("classifies a 429 as a definitive rejection too — the request was refused, not forwarded", async () => {
    mockFetchJson.mockRejectedValueOnce(httpError(429, "rate limited"));

    const outcome = await submitPreparedTx(preparedFixture("local-sig-1"), qualifyingTipProof());

    expect(outcome.kind).toBe("rejected_before_broadcast");
  });

  it("classifies a 5xx as AMBIGUOUS — the bytes may already have been forwarded", async () => {
    mockFetchJson.mockRejectedValueOnce(httpError(502, "bad gateway"));

    const outcome = await submitPreparedTx(preparedFixture("local-sig-1"), qualifyingTipProof());

    expect(outcome.kind).toBe("transport_uncertain");
  });

  it("classifies a network failure as AMBIGUOUS instead of throwing (row stays pending upstream)", async () => {
    mockFetchJson.mockRejectedValueOnce(new Error("network blip"));

    const outcome = await submitPreparedTx(preparedFixture("local-sig-1"), qualifyingTipProof());

    expect(outcome.kind).toBe("transport_uncertain");
  });
});
