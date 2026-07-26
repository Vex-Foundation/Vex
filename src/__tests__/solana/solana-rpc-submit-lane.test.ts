/**
 * `submitPreparedTxOverRpc` unit tests — the protocol-agnostic RPC landing
 * lane (landing-lane design `solana-landing-lanes-design.md` D2/D3/D4).
 *
 * This lane exists because `POST /tx/v1/submit` REQUIRES a >= 1,000,000
 * lamport tip to one of Jupiter's 16 published receivers, and Lend / Borrow /
 * Prediction transactions are built by their own provider endpoints with NO
 * tip. Sending them there made them vanish on real funds (2026-07-24 funded
 * gate). These tests pin the four properties that make the replacement safe:
 * byte-for-byte relay, no rebuild/re-sign, canonical-signature authority, and
 * an honest definitive-vs-ambiguous failure split.
 *
 * The `Connection` is injected, so nothing here touches a real RPC.
 */

import { describe, expect, it, vi } from "vitest";
import { Connection, SendTransactionError } from "@solana/web3.js";

import { submitPreparedTxOverRpc } from "@tools/solana-ecosystem/shared/solana-transaction/rpc-submit.js";
import type { PreparedSolanaTx } from "@tools/solana-ecosystem/shared/solana-transaction/prepare.js";

const LOCAL_SIGNATURE = "LocalCanonicalSignature1111111111111111111111";

function preparedFixture(signature = LOCAL_SIGNATURE): PreparedSolanaTx {
  return {
    serialized: new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]),
    signature,
    recentBlockhash: "11111111111111111111111111111112",
    lastValidBlockHeight: 1234,
  };
}

/** A `Connection` stand-in exposing only what this lane uses. */
function connectionWith(sendRawTransaction: ReturnType<typeof vi.fn>): Connection {
  return { sendRawTransaction } as unknown as Connection;
}

describe("submitPreparedTxOverRpc", () => {
  it("relays EXACTLY prepared.serialized — byte-for-byte, never rebuilt or re-signed", async () => {
    const sendRawTransaction = vi.fn().mockResolvedValue(LOCAL_SIGNATURE);
    const prepared = preparedFixture();

    await submitPreparedTxOverRpc(prepared, { connection: connectionWith(sendRawTransaction) });

    const [sentBytes] = sendRawTransaction.mock.calls[0]!;
    // Identity AND byte equality: the exact array the signer produced.
    expect(sentBytes).toBe(prepared.serialized);
    expect(Array.from(sentBytes as Uint8Array)).toEqual([1, 2, 3, 4, 5, 250, 251, 252]);
  });

  it("keeps preflight ON and OMITS maxRetries so the node rebroadcasts the same bytes until blockhash expiry", async () => {
    const sendRawTransaction = vi.fn().mockResolvedValue(LOCAL_SIGNATURE);

    await submitPreparedTxOverRpc(preparedFixture(), {
      connection: connectionWith(sendRawTransaction),
    });

    const [, options] = sendRawTransaction.mock.calls[0]!;
    expect(options).toEqual({ skipPreflight: false, preflightCommitment: "confirmed" });
    expect(options).not.toHaveProperty("maxRetries");
  });

  it("reports accepted when the RPC echoes the canonical local signature", async () => {
    const sendRawTransaction = vi.fn().mockResolvedValue(LOCAL_SIGNATURE);

    const outcome = await submitPreparedTxOverRpc(preparedFixture(), {
      connection: connectionWith(sendRawTransaction),
    });

    expect(outcome).toEqual({ kind: "accepted", signature: LOCAL_SIGNATURE });
  });

  it("reports signature_mismatch — and never substitutes the RPC's signature — when they diverge", async () => {
    const sendRawTransaction = vi.fn().mockResolvedValue("SomeOtherSignature999");

    const outcome = await submitPreparedTxOverRpc(preparedFixture(), {
      connection: connectionWith(sendRawTransaction),
    });

    expect(outcome).toEqual({
      kind: "signature_mismatch",
      localSignature: LOCAL_SIGNATURE,
      providerSignature: "SomeOtherSignature999",
    });
  });

  it("treats a malformed RPC response as ambiguous rather than trusting it (untrusted input)", async () => {
    const sendRawTransaction = vi.fn().mockResolvedValue({ not: "a signature" });

    const outcome = await submitPreparedTxOverRpc(preparedFixture(), {
      connection: connectionWith(sendRawTransaction),
    });

    expect(outcome.kind).toBe("transport_uncertain");
  });

  it("classifies a preflight/simulation rejection as DEFINITIVE — the node answered, nothing was broadcast", async () => {
    const sendRawTransaction = vi.fn().mockRejectedValue(
      new SendTransactionError({
        action: "simulate",
        signature: "",
        transactionMessage: "Transaction simulation failed: insufficient funds for rent",
      }),
    );

    const outcome = await submitPreparedTxOverRpc(preparedFixture(), {
      connection: connectionWith(sendRawTransaction),
    });

    expect(outcome.kind).toBe("rejected_before_broadcast");
  });

  it("classifies a transport failure as AMBIGUOUS — the bytes may still have gone out", async () => {
    const sendRawTransaction = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const outcome = await submitPreparedTxOverRpc(preparedFixture(), {
      connection: connectionWith(sendRawTransaction),
    });

    expect(outcome.kind).toBe("transport_uncertain");
  });

  it("never throws out of the lane, whatever the RPC does", async () => {
    const sendRawTransaction = vi.fn().mockRejectedValue("a non-Error rejection");

    await expect(
      submitPreparedTxOverRpc(preparedFixture(), { connection: connectionWith(sendRawTransaction) }),
    ).resolves.toMatchObject({ kind: "transport_uncertain" });
  });

  it("calls the RPC exactly once — no application-level resend of already-signed bytes", async () => {
    const sendRawTransaction = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));

    await submitPreparedTxOverRpc(preparedFixture(), {
      connection: connectionWith(sendRawTransaction),
    });

    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
