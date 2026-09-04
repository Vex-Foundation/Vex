/**
 * ZERO PROVIDER CALLS BETWEEN THE FENCE AND THE SIGNATURE, proven against a REAL
 * viem wallet client whose transport throws on every request.
 *
 * ## The defect this is the regression guard for
 *
 * The deferred arm exists to make the window between the authority fence and the
 * cryptographic signature as short as the design allows. viem's
 * `signTransaction` WALLET ACTION unconditionally awaits `eth_chainId` before it
 * reaches the local account's signer
 * (`node_modules/viem/_esm/actions/wallet/signTransaction.js`), so the arm that
 * was supposed to have no round trip in that window had exactly one - and a node
 * that is slow, rate-limited or hostile controls how long the window stays open
 * while a decrypted key is in memory.
 *
 * ## What is real here, and why
 *
 * The WALLET CLIENT is a real `createWalletClient` over a real
 * `privateKeyToAccount` and the real `base` chain, and its transport THROWS on
 * every request while recording the method. That is the whole experiment: if the
 * production path reached any viem action that talks to a node - `eth_chainId`
 * included - this test fails with the method name that leaked. The signature it
 * produces is a real one, recovered back to the signing address.
 *
 * The public client stays a fake: preparation, submission and the receipt wait
 * are not what is under test, and driving them through a real transport would
 * add a dozen unrelated RPC shapes to the fixture.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createWalletClient,
  createPublicClient,
  custom,
  parseTransaction,
  recoverTransactionAddress,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { parseAccount, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  signStageBroadcast,
  DeferredOfflineSignerUnavailableError,
  type DeferredEvmSigner,
} from "@tools/evm-chains/staged-broadcast.js";

/** viem's own branded serialized-transaction type, so the readers below type-check. */
type SerializedTransaction = Parameters<
  typeof recoverTransactionAddress
>[0]["serializedTransaction"];

const PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const TO = "0x2222222222222222222222222222222222222222" as const;
const TEST_CHAIN: Chain = base;

/** The prepared EIP-1559 request, exactly the shape viem's preparation returns. */
function preparedRequest() {
  return {
    to: TO,
    data: "0x" as Hex,
    value: 0n,
    gas: 30_000n,
    nonce: 7,
    type: "eip1559" as const,
    chainId: base.id,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    chain: base,
  };
}

/**
 * A transport that records every method asked of it and refuses all of them.
 *
 * It is armed only AFTER `onBeforeSign` returns, so preparation-time calls (of
 * which the deferred arm makes none on this client anyway) could not be mistaken
 * for the leak this test hunts.
 */
function throwingTransport(state: { armed: boolean; methods: string[] }): Transport {
  return custom({
    request: async ({ method }: { method: string }) => {
      state.methods.push(method);
      if (state.armed) {
        throw new Error(`provider call after the fence: ${method}`);
      }
      throw new Error(`unexpected provider call: ${method}`);
    },
  });
}

function fakePublicClient() {
  return Object.assign(createPublicClient({ chain: TEST_CHAIN, transport: throwingTransport({ armed: false, methods: [] }) }), {
    estimateGas: vi.fn(async () => 21_000n),
    prepareTransactionRequest: vi.fn(async () => preparedRequest()),
    // The parameter is DECLARED so the assertion below can read the exact bytes
    // that were broadcast without casting them back into existence.
    sendRawTransaction: vi.fn(
      async (_args: { serializedTransaction: SerializedTransaction }) => "0xhash" as Hex,
    ),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 1n })),
  });
}

describe("the deferred arm signs OFFLINE - no provider call after the fence", () => {
  it("produces a real signature with the throwing transport never being asked anything", async () => {
    const state = { armed: false, methods: [] as string[] };
    const publicClient = fakePublicClient();
    const walletClient = createWalletClient({
      account: ACCOUNT,
      chain: TEST_CHAIN,
      transport: throwingTransport(state),
    });
    const hooks = {
      onNonceReserved: vi.fn(async (request: { nodePendingNonce: number }) => request.nodePendingNonce),
      onHashStaged: vi.fn(async () => undefined),
      onAccepted: vi.fn(async () => undefined),
    };
    const signer: DeferredEvmSigner = {
      kind: "deferred",
      address: ACCOUNT.address,
      chain: TEST_CHAIN,
      onBeforeSign: async () => {
        // THE FENCE. From this instant on, any request the production path makes
        // is a request made while the key is about to be, or already is, in
        // memory - and the transport turns it into a failure.
        state.armed = true;
      },
      createSigner: async () => walletClient,
    };

    const outcome = await signStageBroadcast(
      publicClient,
      signer,
      { to: TO, data: "0x" },
      hooks,
    );

    expect(outcome.kind).toBe("confirmed");
    // THE ASSERTION THIS FILE EXISTS FOR: not one request reached the transport,
    // `eth_chainId` included.
    expect(state.methods).toEqual([]);

    // The signature is REAL, over the request that was prepared, on the chain it
    // was prepared for, and it recovers to the wallet that was resolved.
    const serialized = publicClient.sendRawTransaction.mock.calls[0]?.[0];
    if (serialized === undefined) throw new Error("nothing was broadcast");
    const parsed = parseTransaction(serialized.serializedTransaction);
    expect(parsed.chainId).toBe(base.id);
    expect(parsed.nonce).toBe(7);
    // The HEADROOMED gas, not the node's own unbuffered figure on the request.
    expect(parsed.gas).toBe(gasLimitWithHeadroom(21_000n));
    expect(parsed.to?.toLowerCase()).toBe(TO);
    await expect(
      recoverTransactionAddress({ serializedTransaction: serialized.serializedTransaction }),
    ).resolves.toBe(ACCOUNT.address);
  });

  it("viem's wallet ACTION on the same client DOES call the node, which is why it is not used", async () => {
    // The negative control. Without it, "no method reached the transport" could
    // be read as "this transport is never consulted by anything", rather than as
    // "the production path deliberately avoids the call that would consult it".
    const state = { armed: true, methods: [] as string[] };
    const walletClient = createWalletClient({
      account: ACCOUNT,
      chain: base,
      transport: throwingTransport(state),
    });

    await expect(walletClient.signTransaction(preparedRequest())).rejects.toThrow();
    expect(state.methods).toContain("eth_chainId");
  });

  it("refuses a resolved wallet that cannot sign locally rather than falling back to the node", async () => {
    const state = { armed: false, methods: [] as string[] };
    const publicClient = fakePublicClient();
    // A JSON-RPC account: viem would sign it through `eth_signTransaction`, i.e.
    // through the provider, in exactly the window this arm closes.
    const walletClient = createWalletClient({
      account: parseAccount(ACCOUNT.address),
      chain: TEST_CHAIN,
      transport: throwingTransport(state),
    });
    const hooks = {
      onNonceReserved: vi.fn(async (request: { nodePendingNonce: number }) => request.nodePendingNonce),
      onHashStaged: vi.fn(async () => undefined),
      onAccepted: vi.fn(async () => undefined),
    };
    const signer: DeferredEvmSigner = {
      kind: "deferred",
      address: ACCOUNT.address,
      chain: TEST_CHAIN,
      onBeforeSign: async () => {
        state.armed = true;
      },
      createSigner: async () => walletClient,
    };

    await expect(
      signStageBroadcast(publicClient, signer, { to: TO, data: "0x" }, hooks),
    ).rejects.toBeInstanceOf(DeferredOfflineSignerUnavailableError);
    expect(hooks.onHashStaged).not.toHaveBeenCalled();
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(state.methods).toEqual([]);
  });
});

/**
 * THE ORDERING THE MONEY PATH DEPENDS ON: the last pre-sign callback MAY read
 * the chain, and after it resolves nothing may.
 *
 * The authoritative debit read belongs in this window and nowhere earlier
 * (contract C2.6): only here is the transaction that will be signed already
 * fixed. What must not exist is a provider call AFTER the callback, because a
 * balance validated at the end of the callback has to still be the balance the
 * bytes commit to.
 *
 * The two arms differ, and both are pinned so the difference cannot widen
 * unnoticed:
 *   - the DEFERRED arm signs offline, so the window is EMPTY;
 *   - the EAGER arm goes through viem's wallet action, which awaits one
 *     `eth_chainId` of its own (viem 2.54.3). That single round trip belongs to
 *     viem, not to any Vex gate, and it is the whole residual.
 */
describe("the last pre-sign callback may read the chain; nothing after it may", () => {
  function hooksWith(onBeforeSign: () => Promise<void>) {
    return {
      onNonceReserved: vi.fn(async (request: { nodePendingNonce: number }) => request.nodePendingNonce),
      onHashStaged: vi.fn(async () => undefined),
      onAccepted: vi.fn(async () => undefined),
      onBeforeSign: vi.fn(onBeforeSign),
    };
  }

  it("deferred: the hook's own reads are allowed and the window after it is EMPTY", async () => {
    const state = { armed: false, methods: [] as string[] };
    const publicClient = fakePublicClient();
    const walletClient = createWalletClient({
      account: ACCOUNT,
      chain: TEST_CHAIN,
      transport: throwingTransport(state),
    });
    const order: string[] = [];
    // The authoritative read the venue adapters will do here. It is a REAL
    // await inside the hook, so if the fence were placed before the hook rather
    // than after it, this call would be the failure instead of the proof.
    const authoritativeRead = vi.fn(async () => {
      order.push("authoritative-read");
      return 10n ** 18n;
    });
    const hooks = hooksWith(async () => {
      await authoritativeRead();
      order.push("gate-resolved");
      state.armed = true;
    });
    const signer: DeferredEvmSigner = {
      kind: "deferred",
      address: ACCOUNT.address,
      chain: TEST_CHAIN,
      onBeforeSign: async () => {
        order.push("authority-fence");
      },
      createSigner: async () => walletClient,
    };

    const outcome = await signStageBroadcast(publicClient, signer, { to: TO, data: "0x" }, hooks);

    expect(outcome.kind).toBe("confirmed");
    expect(hooks.onBeforeSign).toHaveBeenCalledTimes(1);
    expect(authoritativeRead).toHaveBeenCalledTimes(1);
    // The authority fence, then the key, then the caller's debit gate, then the
    // signature - and nothing at all on the wire after the gate.
    expect(order).toEqual(["authority-fence", "authoritative-read", "gate-resolved"]);
    expect(state.methods).toEqual([]);
    expect(publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("eager: the only traffic after the gate is viem's own chain-identity read", async () => {
    const state = { armed: false, methods: [] as string[] };
    const publicClient = fakePublicClient();
    // A PERMISSIVE recording transport: the point here is to COUNT what happens
    // after the gate, not to forbid it, so the eager arm can complete and the
    // residual can be named exactly.
    const walletClient = Object.assign(
      createWalletClient({
        account: ACCOUNT,
        chain: TEST_CHAIN,
        transport: custom({
          request: async ({ method }: { method: string }) => {
            if (state.armed) state.methods.push(method);
            if (method === "eth_chainId") return `0x${TEST_CHAIN.id.toString(16)}`;
            throw new Error(`unexpected provider call: ${method}`);
          },
        }),
      }),
      // Preparation is not what is under test here, and on the eager arm it runs
      // on the WALLET client; stubbing it keeps the recording transport a
      // measurement of the post-gate window only.
      { prepareTransactionRequest: vi.fn(async () => preparedRequest()) },
    );
    const hooks = hooksWith(async () => {
      state.armed = true;
    });

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, hooks);

    expect(outcome.kind).toBe("confirmed");
    // Exactly one, and it is viem's, not ours. A second entry here means Vex
    // grew a call in the window a pre-sign balance read must be able to trust.
    expect(state.methods).toEqual(["eth_chainId"]);
  });
});
