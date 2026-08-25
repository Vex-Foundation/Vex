/**
 * `signStageBroadcast`'s TWO SIGNER ARMS - the eager one every venue passes, and
 * the deferred one the generic wallet-transaction confirm passes.
 *
 * ## Why a CENTRAL trace test rather than per-venue mocks
 *
 * The eager arm has thirteen production call sites (WalletSend, KyberSwap,
 * Morpho's two legs, Pendle, Pools' claim and launch, Relay's bridge and fee
 * leg, the shared native-fee leg, Trench's launch and trade loop, Uniswap's fee
 * run) and each of them mocks this primitive in its own suite - so a change in
 * ITS behaviour is exactly what those suites cannot see. This test observes the
 * primitive itself and pins the ORDER and the ARGUMENTS of every call it makes,
 * so a regression shows up here whatever the venue.
 *
 * The type system carries the other half: every eager call site still passes a
 * bare `WalletClient` positionally, and the whole tree compiling is the proof
 * that none of them had to change.
 *
 * ## The deferred contract, asserted as an order
 *
 *   keyless prepare -> onBeforeSign (exactly once) -> createSigner ->
 *   identity check -> signTransaction, with NO provider call in between.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  signStageBroadcast,
  DeferredSignerIdentityError,
  type DeferredEvmSigner,
} from "@tools/evm-chains/staged-broadcast.js";

const TO = "0x2222222222222222222222222222222222222222" as const;
const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const FROM = ACCOUNT.address;
const OTHER = "0x9999999999999999999999999999999999999999" as const;
const SERIALIZED = "0xdeadbeef" as Hex;

const CHAIN: Chain = base;

function testTransport(): Transport {
  return http("http://127.0.0.1:1");
}

/**
 * The two arms sign through DIFFERENT functions, and that is the contract:
 *
 *   EAGER    - viem's `walletClient.signTransaction` action, unchanged.
 *   DEFERRED - the local account's OWN `signTransaction`, offline, because the
 *              action awaits `eth_chainId` first and that round trip would sit
 *              between the authority fence and the signature.
 *
 * `staged-broadcast-offline-signature.test.ts` proves the deferred arm makes no
 * provider call at all with a real viem client and a throwing transport; this
 * file pins which function each arm reaches.
 */

/** Every call the primitive makes, in order, as one readable trace. */
function harness(overrides: { chainId?: number; account?: Address } = {}) {
  const trace: string[] = [];
  const prepared = {
    to: TO,
    data: "0x" as Hex,
    value: 0n,
    gas: 30_000n,
    nonce: 7,
    chain: CHAIN,
  };

  const publicClient = Object.assign(createPublicClient({
    chain: CHAIN,
    transport: testTransport(),
  }), {
    estimateGas: vi.fn(async () => {
      trace.push("publicClient.estimateGas");
      return 21_000n;
    }),
    prepareTransactionRequest: vi.fn(async () => {
      trace.push("publicClient.prepareTransactionRequest");
      return prepared;
    }),
    sendRawTransaction: vi.fn(async () => {
      trace.push("publicClient.sendRawTransaction");
      return "0xhash" as Hex;
    }),
    waitForTransactionReceipt: vi.fn(async () => {
      trace.push("publicClient.waitForTransactionReceipt");
      return { status: "success", blockNumber: 1n };
    }),
  });

  const accountSignTransaction = vi.fn(async () => {
    trace.push("account.signTransaction");
    return SERIALIZED;
  });

  const signingAccount = {
      ...ACCOUNT,
      address: overrides.account ?? FROM,
      signTransaction: accountSignTransaction,
  };
  const signingChain: Chain = overrides.chainId === undefined
    ? CHAIN
    : { ...CHAIN, id: overrides.chainId };
  const walletClient = Object.assign(createWalletClient({
    account: signingAccount,
    chain: signingChain,
    transport: testTransport(),
  }), {
    chain: signingChain,
    prepareTransactionRequest: vi.fn(async () => {
      trace.push("walletClient.prepareTransactionRequest");
      return prepared;
    }),
    signTransaction: vi.fn(async () => {
      trace.push("walletClient.signTransaction");
      return SERIALIZED;
    }),
  });

  const hooks = {
    onNonceReserved: vi.fn(async (request: { nodePendingNonce: number }) => {
      trace.push("hooks.onNonceReserved");
      return request.nodePendingNonce;
    }),
    onHashStaged: vi.fn(async () => {
      trace.push("hooks.onHashStaged");
    }),
    onAccepted: vi.fn(async () => {
      trace.push("hooks.onAccepted");
    }),
  };

  return { trace, publicClient, walletClient, hooks, accountSignTransaction };
}

describe("signStageBroadcast - the EAGER arm is unchanged", () => {
  it("makes exactly the same calls, in the same order, as before the split", async () => {
    const h = harness();

    const outcome = await signStageBroadcast(
      h.publicClient,
      h.walletClient,
      { to: TO, data: "0x" },
      h.hooks,
    );

    expect(outcome.kind).toBe("confirmed");
    // THE CONTRACT, as a trace. Preparation happens on the WALLET client (the
    // key-bearing one), the signature precedes the staging hook, the staging
    // hook precedes the send, and the receipt read is last.
    expect(h.trace).toEqual([
      "publicClient.estimateGas",
      "walletClient.prepareTransactionRequest",
      "hooks.onNonceReserved",
      "walletClient.signTransaction",
      "hooks.onHashStaged",
      "publicClient.sendRawTransaction",
      "hooks.onAccepted",
      "publicClient.waitForTransactionReceipt",
    ]);
    // The public client is NEVER used to prepare on this arm: doing so would
    // change which node fills the nonce and the fees for every venue.
    expect(h.publicClient.prepareTransactionRequest).not.toHaveBeenCalled();
    // And the offline path is NEVER taken here: the eager arm keeps viem's
    // wallet action, byte for byte, for all thirteen venue call sites.
    expect(h.accountSignTransaction).not.toHaveBeenCalled();
  });

  it("stages the account's own address and the prepared nonce, and signs the headroomed gas", async () => {
    const h = harness();
    await signStageBroadcast(
      h.publicClient,
      h.walletClient,
      { to: TO, data: "0x" },
      h.hooks,
    );

    expect(h.hooks.onHashStaged).toHaveBeenCalledWith({
      txHash: expect.any(String),
      fromAddress: FROM,
      nonce: 7,
    });
    const signedCall: unknown = h.walletClient.signTransaction.mock.calls[0];
    if (!Array.isArray(signedCall) || signedCall.length === 0) {
      throw new Error("signTransaction was never called");
    }
    const signedRequest: unknown = signedCall[0];
    if (typeof signedRequest !== "object" || signedRequest === null || !("gas" in signedRequest)) {
      throw new Error("signed request carried no gas field");
    }
    // The HEADROOMED limit, re-asserted on the request that is serialized -
    // never the node's own unbuffered figure that came back on `prepared`.
    expect(signedRequest.gas).toBe(gasLimitWithHeadroom(21_000n));
    expect(signedRequest.gas).not.toBe(30_000n);
  });

  it("a throw from the staging hook prevents the submission entirely", async () => {
    const h = harness();
    h.hooks.onHashStaged.mockRejectedValueOnce(new Error("durable write failed"));

    await expect(
      signStageBroadcast(
        h.publicClient,
        h.walletClient,
        { to: TO, data: "0x" },
        h.hooks,
      ),
    ).rejects.toThrow("durable write failed");
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("signStageBroadcast - the DEFERRED arm", () => {
  function deferred(
    h: ReturnType<typeof harness>,
    overrides: Partial<DeferredEvmSigner> = {},
  ): DeferredEvmSigner {
    return {
      kind: "deferred",
      address: FROM,
      chain: CHAIN,
      onBeforeSign: vi.fn(async () => {
        h.trace.push("onBeforeSign");
      }),
      createSigner: vi.fn(async () => {
        h.trace.push("createSigner");
        return h.walletClient;
      }),
      ...overrides,
    };
  }

  it("prepares KEYLESS, gates ONCE, then loads the key and signs with nothing in between", async () => {
    const h = harness();
    const signer = deferred(h);

    const outcome = await signStageBroadcast(
      h.publicClient,
      signer,
      { to: TO, data: "0x" },
      h.hooks,
    );

    expect(outcome.kind).toBe("confirmed");
    expect(h.trace).toEqual([
      "publicClient.estimateGas",
      // Prepared on the PUBLIC client: nonce and fees need no key.
      "publicClient.prepareTransactionRequest",
      // Reserved durably before the pre-sign authority fence.
      "hooks.onNonceReserved",
      // The gate, AFTER every awaited preparation call.
      "onBeforeSign",
      // Then, and only then, the key.
      "createSigner",
      // And immediately the signature - OFFLINE, through the local account's own
      // signer, so NO provider call can sit in between.
      "account.signTransaction",
      "hooks.onHashStaged",
      "publicClient.sendRawTransaction",
      "hooks.onAccepted",
      "publicClient.waitForTransactionReceipt",
    ]);
    expect(signer.onBeforeSign).toHaveBeenCalledTimes(1);
    expect(h.walletClient.prepareTransactionRequest).not.toHaveBeenCalled();
    // viem's wallet ACTION is not reached on this arm: it awaits `eth_chainId`
    // before invoking the local signer, which is the round trip this arm exists
    // to remove.
    expect(h.walletClient.signTransaction).not.toHaveBeenCalled();
  });

  it("a refusing pre-sign hook signs, stages and submits NOTHING", async () => {
    const h = harness();
    const createSigner = vi.fn();
    const signer = deferred(h, {
      onBeforeSign: vi.fn(async () => {
        throw new Error("authority fence refused");
      }),
      createSigner,
    });

    await expect(
      signStageBroadcast(
        h.publicClient,
        signer,
        { to: TO, data: "0x" },
        h.hooks,
      ),
    ).rejects.toThrow("authority fence refused");

    expect(createSigner).not.toHaveBeenCalled();
    expect(h.accountSignTransaction).not.toHaveBeenCalled();
    expect(h.hooks.onHashStaged).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a failing signer factory signs, stages and submits NOTHING", async () => {
    const h = harness();
    const signer = deferred(h, {
      createSigner: vi.fn(async () => {
        throw new Error("keystore locked");
      }),
    });

    await expect(
      signStageBroadcast(
        h.publicClient,
        signer,
        { to: TO, data: "0x" },
        h.hooks,
      ),
    ).rejects.toThrow("keystore locked");
    expect(h.hooks.onHashStaged).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses a signer whose ACCOUNT is not the one the request was prepared for", async () => {
    const h = harness({ account: OTHER });
    const signer = deferred(h);

    await expect(
      signStageBroadcast(
        h.publicClient,
        signer,
        { to: TO, data: "0x" },
        h.hooks,
      ),
    ).rejects.toBeInstanceOf(DeferredSignerIdentityError);
    expect(h.accountSignTransaction).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses a signer whose CHAIN is not the one the request was prepared for", async () => {
    const h = harness({ chainId: 1 });
    const signer = deferred(h);

    await expect(
      signStageBroadcast(
        h.publicClient,
        signer,
        { to: TO, data: "0x" },
        h.hooks,
      ),
    ).rejects.toBeInstanceOf(DeferredSignerIdentityError);
    expect(h.accountSignTransaction).not.toHaveBeenCalled();
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a throw from the staging hook still prevents the submission on this arm", async () => {
    const h = harness();
    const signer = deferred(h);
    h.hooks.onHashStaged.mockRejectedValueOnce(new Error("post-stage fence refused"));

    await expect(
      signStageBroadcast(
        h.publicClient,
        signer,
        { to: TO, data: "0x" },
        h.hooks,
      ),
    ).rejects.toThrow("post-stage fence refused");
    // SEAM A: the local signature already happened and is not retroactively
    // cancelled; what the post-stage refusal prevents is the BROADCAST.
    expect(h.accountSignTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });
});
