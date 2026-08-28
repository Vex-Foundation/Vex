/**
 * The pre-sign gate sees THE TRANSACTION THAT WILL BE SIGNED.
 *
 * ## The defect this file pins
 *
 * `signStageBroadcast` signs the object `prepareTransactionRequest` returns, not
 * the `txParams` the caller handed in - viem may fill or route preparation
 * through the node, and the reply is what gets serialized. The pre-sign hook used
 * to be called with NO arguments, so the only thing a caller could re-check was
 * its own closure: a `to`, `data` or `value` that changed on the preparation path
 * would have been signed under a verdict that never looked at it.
 *
 * The seam these tests inject through is `prepareTransactionRequest` itself: the
 * fake client returns a request whose target, calldata and value all differ from
 * the caller's, and the assertions are that BOTH signer arms hand that altered
 * request to the gate, and that a gate which refuses it leaves nothing signed and
 * nothing broadcast.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  signStageBroadcast,
  type DeferredEvmSigner,
  type FinalSignedRequest,
} from "@tools/evm-chains/staged-broadcast.js";

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const FROM = ACCOUNT.address;
const CHAIN: Chain = base;
const SERIALIZED = "0xdeadbeef" as Hex;

/** What the CALLER asks to sign. */
const REQUESTED = {
  to: "0x2222222222222222222222222222222222222222" as const,
  data: "0xaaaa" as Hex,
  value: 1n,
};

/** What PREPARATION returns instead - a different target, blob and value. */
const ALTERED = {
  to: "0x9999999999999999999999999999999999999999" as const,
  data: "0xbbbb" as Hex,
  value: 777n,
};

function testTransport(): Transport {
  return http("http://127.0.0.1:1");
}

function harness() {
  const prepared = { ...ALTERED, gas: 30_000n, nonce: 7, chain: CHAIN };

  const publicClient = Object.assign(
    createPublicClient({ chain: CHAIN, transport: testTransport() }),
    {
      estimateGas: vi.fn(async () => 21_000n),
      prepareTransactionRequest: vi.fn(async () => prepared),
      sendRawTransaction: vi.fn(async () => "0xhash" as Hex),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 1n })),
    },
  );

  const accountSignTransaction = vi.fn(async () => SERIALIZED);
  const walletClient = Object.assign(
    createWalletClient({
      account: { ...ACCOUNT, signTransaction: accountSignTransaction },
      chain: CHAIN,
      transport: testTransport(),
    }),
    {
      chain: CHAIN,
      prepareTransactionRequest: vi.fn(async () => prepared),
      // Typed by what it RECEIVES: the assertions read the signed request off
      // this mock, and a bare `vi.fn()` would make that read an untyped cast.
      signTransaction: vi.fn(async (_request: Record<string, unknown>) => SERIALIZED),
    },
  );

  const hooks = {
    onNonceReserved: vi.fn(async (request: { nodePendingNonce: number }) => request.nodePendingNonce),
    onHashStaged: vi.fn(async () => {}),
    onAccepted: vi.fn(async () => {}),
    onBeforeSign: vi.fn(async (_request: FinalSignedRequest) => {}),
  };

  return { publicClient, walletClient, hooks, accountSignTransaction };
}

/** The request the gate must be shown: preparation's fields, the headroomed gas. */
const EXPECTED_FINAL: FinalSignedRequest = {
  to: ALTERED.to,
  data: ALTERED.data,
  value: ALTERED.value,
  gas: gasLimitWithHeadroom(21_000n),
  nonce: 7,
};

describe("the EAGER arm gates on the prepared request", () => {
  it("hands the gate the prepared to/data/value, not the caller's", async () => {
    const h = harness();

    const outcome = await signStageBroadcast(
      h.publicClient, h.walletClient, REQUESTED, h.hooks,
    );

    expect(outcome.kind).toBe("confirmed");
    expect(h.hooks.onBeforeSign).toHaveBeenCalledTimes(1);
    expect(h.hooks.onBeforeSign).toHaveBeenCalledWith(EXPECTED_FINAL);
    // The point, stated as a difference: what the caller asked to sign is NOT
    // what the gate was shown, and before this contract the gate saw neither.
    expect(EXPECTED_FINAL.to).not.toBe(REQUESTED.to);
    expect(EXPECTED_FINAL.data).not.toBe(REQUESTED.data);
    expect(EXPECTED_FINAL.value).not.toBe(REQUESTED.value);
  });

  it("a gate that refuses the prepared request signs nothing and broadcasts nothing", async () => {
    const h = harness();
    h.hooks.onBeforeSign.mockRejectedValueOnce(new Error("refused: not the approved transaction"));

    await expect(
      signStageBroadcast(h.publicClient, h.walletClient, REQUESTED, h.hooks),
    ).rejects.toThrow("refused: not the approved transaction");

    expect(h.walletClient.signTransaction).not.toHaveBeenCalled();
    expect(h.accountSignTransaction).not.toHaveBeenCalled();
    expect(h.hooks.onHashStaged).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("the object the gate saw is the object that is signed", async () => {
    const h = harness();
    await signStageBroadcast(h.publicClient, h.walletClient, REQUESTED, h.hooks);

    const call = h.walletClient.signTransaction.mock.calls[0];
    if (call === undefined) throw new Error("signTransaction was never called");
    const signed = call[0];
    expect(signed.to).toBe(EXPECTED_FINAL.to);
    expect(signed.data).toBe(EXPECTED_FINAL.data);
    expect(signed.value).toBe(EXPECTED_FINAL.value);
    expect(signed.gas).toBe(EXPECTED_FINAL.gas);
    expect(signed.nonce).toBe(EXPECTED_FINAL.nonce);
  });
});

describe("the DEFERRED arm gates on the same prepared request", () => {
  function deferredSigner(
    h: ReturnType<typeof harness>,
    onBeforeSign: DeferredEvmSigner["onBeforeSign"],
  ): DeferredEvmSigner {
    return {
      kind: "deferred",
      address: FROM,
      chain: CHAIN,
      onBeforeSign,
      createSigner: vi.fn(async () => h.walletClient),
    };
  }

  it("hands its authority fence the prepared to/data/value", async () => {
    const h = harness();
    const gate = vi.fn(async (_request: FinalSignedRequest) => {});

    const outcome = await signStageBroadcast(
      h.publicClient, deferredSigner(h, gate), REQUESTED, h.hooks,
    );

    expect(outcome.kind).toBe("confirmed");
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith(EXPECTED_FINAL);
  });

  it("a refusal there loads no key and signs nothing", async () => {
    const h = harness();
    const gate = vi.fn(async () => {
      throw new Error("authority revoked");
    });
    const signer = deferredSigner(h, gate);

    await expect(
      signStageBroadcast(h.publicClient, signer, REQUESTED, h.hooks),
    ).rejects.toThrow("authority revoked");

    expect(signer.createSigner).not.toHaveBeenCalled();
    expect(h.accountSignTransaction).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });
});
