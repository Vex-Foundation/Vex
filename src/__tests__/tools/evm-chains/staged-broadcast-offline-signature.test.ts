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
  custom,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
function throwingTransport(state: { armed: boolean; methods: string[] }) {
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
  return {
    estimateGas: vi.fn(async () => 21_000n),
    prepareTransactionRequest: vi.fn(async () => preparedRequest()),
    // The parameter is DECLARED so the assertion below can read the exact bytes
    // that were broadcast without casting them back into existence.
    sendRawTransaction: vi.fn(
      async (_args: { serializedTransaction: SerializedTransaction }) => "0xhash" as Hex,
    ),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 1n })),
  };
}

type Args = Parameters<typeof signStageBroadcast>;

describe("the deferred arm signs OFFLINE - no provider call after the fence", () => {
  it("produces a real signature with the throwing transport never being asked anything", async () => {
    const state = { armed: false, methods: [] as string[] };
    const publicClient = fakePublicClient();
    const walletClient = createWalletClient({
      account: ACCOUNT,
      chain: base,
      transport: throwingTransport(state),
    });
    const hooks = {
      onHashStaged: vi.fn(async () => undefined),
      onAccepted: vi.fn(async () => undefined),
    };
    const signer: DeferredEvmSigner = {
      kind: "deferred",
      address: ACCOUNT.address,
      chain: base,
      onBeforeSign: async () => {
        // THE FENCE. From this instant on, any request the production path makes
        // is a request made while the key is about to be, or already is, in
        // memory - and the transport turns it into a failure.
        state.armed = true;
      },
      createSigner: async () => walletClient,
    };

    const outcome = await signStageBroadcast(
      publicClient as unknown as Args[0],
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
      account: ACCOUNT.address,
      chain: base,
      transport: throwingTransport(state),
    });
    const hooks = {
      onHashStaged: vi.fn(async () => undefined),
      onAccepted: vi.fn(async () => undefined),
    };
    const signer: DeferredEvmSigner = {
      kind: "deferred",
      address: ACCOUNT.address,
      chain: base,
      onBeforeSign: async () => {
        state.armed = true;
      },
      createSigner: async () => walletClient as unknown as Awaited<
        ReturnType<DeferredEvmSigner["createSigner"]>
      >,
    };

    await expect(
      signStageBroadcast(publicClient as unknown as Args[0], signer, { to: TO, data: "0x" }, hooks),
    ).rejects.toBeInstanceOf(DeferredOfflineSignerUnavailableError);
    expect(hooks.onHashStaged).not.toHaveBeenCalled();
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(state.methods).toEqual([]);
  });
});
