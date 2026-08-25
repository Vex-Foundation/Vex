/**
 * THE PER-(ADDRESS, CHAIN) NONCE OWNER, and the deferred arm that holds it.
 *
 * The defect under test is not hypothetical and it is invisible to every
 * per-venue mock: `prepareTransactionRequest` fills the nonce from the node's
 * PENDING count, which only moves once a transaction reaches the node. Two
 * confirms for one wallet that prepare before either has submitted therefore
 * read the SAME number, sign the SAME nonce, and the network silently drops one
 * of them.
 *
 * So the harness below models exactly that: a fake node whose pending count
 * advances on `sendRawTransaction` and nowhere else. Under the owner the second
 * confirm must read a FRESH nonce; without it, both would read 7.
 *
 * Every other case here is about the RELEASE, because a lock that is not
 * released on some arm is worse than no lock: it converts a refused transaction
 * into a wallet that can never sign again in this process.
 */

import { describe, it, expect, vi } from "vitest";
import type { Account, Chain, Hex } from "viem";

import {
  acquireEvmNonceOwner,
  evmNonceOwnerCountForTest,
  EvmNonceOwnerUnavailableError,
} from "@tools/evm-chains/nonce-owner.js";
import {
  signStageBroadcast,
  type DeferredEvmSigner,
} from "@tools/evm-chains/staged-broadcast.js";

const TO = "0x2222222222222222222222222222222222222222" as const;
const FROM = "0x1111111111111111111111111111111111111111" as const;
const OTHER_WALLET = "0x9999999999999999999999999999999999999999" as const;
const SERIALIZED = "0xdeadbeef" as Hex;
const CHAIN = { id: 8453, name: "Base" } as unknown as Chain;
const ACCOUNT = { address: FROM, type: "local" } as unknown as Account;

type Args = Parameters<typeof signStageBroadcast>;

/** A node whose PENDING COUNT is the only source of the nonce, advanced by sends. */
function fakeNode() {
  const state = { pendingCount: 7, sends: 0 };
  const preparedNonces: number[] = [];
  const publicClient = {
    estimateGas: async () => 21_000n,
    prepareTransactionRequest: async (request: Record<string, unknown>) => {
      const nonce = state.pendingCount;
      preparedNonces.push(nonce);
      return { ...request, gas: 30_000n, nonce, chain: CHAIN };
    },
    sendRawTransaction: async () => {
      state.sends += 1;
      state.pendingCount += 1;
      return "0xhash" as Hex;
    },
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 1n }),
  };
  return { state, preparedNonces, publicClient };
}

function walletClientFor(address: string) {
  return {
    account: { ...ACCOUNT, address, signTransaction: async () => SERIALIZED },
    chain: CHAIN,
    prepareTransactionRequest: async () => {
      throw new Error("the deferred arm must never prepare on the wallet client");
    },
    signTransaction: async () => {
      throw new Error("the deferred arm must never use viem's wallet action");
    },
  };
}

function deferredSigner(
  address: string,
  overrides: Partial<DeferredEvmSigner> = {},
): DeferredEvmSigner {
  return {
    kind: "deferred",
    address: address as `0x${string}`,
    chain: CHAIN,
    onBeforeSign: async () => undefined,
    createSigner: async () =>
      walletClientFor(address) as unknown as Awaited<ReturnType<DeferredEvmSigner["createSigner"]>>,
    ...overrides,
  };
}

function passiveHooks() {
  return {
    onHashStaged: vi.fn(async () => undefined),
    onAccepted: vi.fn(async () => undefined),
  };
}

/** A promise plus its resolver, for pinning an ordering without a sleep. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

describe("two concurrent DEFERRED confirms for one wallet cannot sign the same nonce", () => {
  it("serializes them, and the second reads a nonce the first's submit moved", async () => {
    const node = fakeNode();
    // The first confirm parks INSIDE its pre-sign fence, which is the exact
    // window in which the second used to read the same pending count.
    const held = gate();
    const first = signStageBroadcast(
      node.publicClient as unknown as Args[0],
      deferredSigner(FROM, { onBeforeSign: async () => await held.promise }),
      { to: TO, data: "0x" },
      passiveHooks(),
    );

    // Let the first reach its fence, then start the second and let the event
    // loop run as far as it can.
    await Promise.resolve();
    await Promise.resolve();
    const second = signStageBroadcast(
      node.publicClient as unknown as Args[0],
      deferredSigner(FROM),
      { to: TO, data: "0x" },
      passiveHooks(),
    );
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    // THE ASSERTION THE OWNER EXISTS FOR: the second has not prepared anything
    // while the first holds the turn, so it cannot have read the stale count.
    expect(node.preparedNonces).toEqual([7]);

    held.open();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome.kind).toBe("confirmed");
    expect(secondOutcome.kind).toBe("confirmed");
    expect(node.preparedNonces).toEqual([7, 8]);
    expect(node.state.sends).toBe(2);
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });

  it("a DIFFERENT wallet is not blocked by the first wallet's turn", async () => {
    const node = fakeNode();
    const held = gate();
    const first = signStageBroadcast(
      node.publicClient as unknown as Args[0],
      deferredSigner(FROM, { onBeforeSign: async () => await held.promise }),
      { to: TO, data: "0x" },
      passiveHooks(),
    );
    await Promise.resolve();

    // Completes while the first is still parked: different key, different turn.
    const otherOutcome = await signStageBroadcast(
      node.publicClient as unknown as Args[0],
      deferredSigner(OTHER_WALLET),
      { to: TO, data: "0x" },
      passiveHooks(),
    );
    expect(otherOutcome.kind).toBe("confirmed");

    held.open();
    await first;
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });

  it("the EAGER arm takes no owner at all, so it never waits on one", async () => {
    const node = fakeNode();
    // The wallet's turn is held by someone else for the whole test.
    const lease = await acquireEvmNonceOwner(FROM, CHAIN.id);
    const eagerClient = {
      account: { ...ACCOUNT, address: FROM },
      chain: CHAIN,
      prepareTransactionRequest: async (request: Record<string, unknown>) => ({
        ...request,
        gas: 30_000n,
        nonce: 7,
        chain: CHAIN,
      }),
      signTransaction: async () => SERIALIZED,
    };

    const outcome = await signStageBroadcast(
      node.publicClient as unknown as Args[0],
      eagerClient as unknown as Args[1],
      { to: TO, data: "0x" },
      passiveHooks(),
    );

    expect(outcome.kind).toBe("confirmed");
    lease.release();
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });
});

describe("the turn is RELEASED on every outcome", () => {
  /** Prove the wallet can sign again: the next confirm completes. */
  async function nextConfirmSucceeds(node: ReturnType<typeof fakeNode>): Promise<void> {
    const outcome = await signStageBroadcast(
      node.publicClient as unknown as Args[0],
      deferredSigner(FROM),
      { to: TO, data: "0x" },
      passiveHooks(),
    );
    expect(outcome.kind).toBe("confirmed");
    expect(evmNonceOwnerCountForTest()).toBe(0);
  }

  it("after a REFUSED pre-sign fence", async () => {
    const node = fakeNode();
    await expect(
      signStageBroadcast(
        node.publicClient as unknown as Args[0],
        deferredSigner(FROM, {
          onBeforeSign: async () => {
            throw new Error("authority fence refused");
          },
        }),
        { to: TO, data: "0x" },
        passiveHooks(),
      ),
    ).rejects.toThrow("authority fence refused");
    await nextConfirmSucceeds(node);
  });

  it("after a FAILED staging hook", async () => {
    const node = fakeNode();
    const hooks = passiveHooks();
    hooks.onHashStaged.mockRejectedValueOnce(new Error("durable write failed"));
    await expect(
      signStageBroadcast(
        node.publicClient as unknown as Args[0],
        deferredSigner(FROM),
        { to: TO, data: "0x" },
        hooks,
      ),
    ).rejects.toThrow("durable write failed");
    await nextConfirmSucceeds(node);
  });

  it("after an AMBIGUOUS submit", async () => {
    const node = fakeNode();
    const failingSend = {
      ...node.publicClient,
      sendRawTransaction: async () => {
        throw new Error("rpc did not answer");
      },
    };
    const outcome = await signStageBroadcast(
      failingSend as unknown as Args[0],
      deferredSigner(FROM),
      { to: TO, data: "0x" },
      passiveHooks(),
    );
    expect(outcome.kind).toBe("ambiguous");
    await nextConfirmSucceeds(node);
  });

  it("after a THROWN preparation, before any nonce existed", async () => {
    const node = fakeNode();
    const throwingPrepare = {
      ...node.publicClient,
      prepareTransactionRequest: async () => {
        throw new Error("node unreachable");
      },
    };
    await expect(
      signStageBroadcast(
        throwingPrepare as unknown as Args[0],
        deferredSigner(FROM),
        { to: TO, data: "0x" },
        passiveHooks(),
      ),
    ).rejects.toThrow("node unreachable");
    await nextConfirmSucceeds(node);
  });

  it("and the RECEIPT WAIT happens outside the turn, so it cannot serialize the next one", async () => {
    const node = fakeNode();
    const waiting = gate();
    const slowReceipt = {
      ...node.publicClient,
      waitForTransactionReceipt: async () => {
        await waiting.promise;
        return { status: "success", blockNumber: 1n };
      },
    };
    const first = signStageBroadcast(
      slowReceipt as unknown as Args[0],
      deferredSigner(FROM),
      { to: TO, data: "0x" },
      passiveHooks(),
    );
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    // The submit has settled, so the turn is over even though the first call
    // has not returned yet.
    const second = await signStageBroadcast(
      node.publicClient as unknown as Args[0],
      deferredSigner(FROM),
      { to: TO, data: "0x" },
      passiveHooks(),
    );
    expect(second.kind).toBe("confirmed");
    expect(node.preparedNonces).toEqual([7, 8]);

    waiting.open();
    expect((await first).kind).toBe("confirmed");
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });
});

describe("the owner itself", () => {
  it("hands the turn over in FIFO order and drops the key when idle", async () => {
    const order: string[] = [];
    const first = await acquireEvmNonceOwner(FROM, CHAIN.id);
    const second = acquireEvmNonceOwner(FROM, CHAIN.id).then((lease) => {
      order.push("second");
      return lease;
    });
    const third = acquireEvmNonceOwner(FROM, CHAIN.id).then((lease) => {
      order.push("third");
      return lease;
    });

    expect(evmNonceOwnerCountForTest()).toBe(1);
    first.release();
    (await second).release();
    (await third).release();

    expect(order).toEqual(["second", "third"]);
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });

  it("a second release is a NO-OP, never a second hand-off", async () => {
    const held = await acquireEvmNonceOwner(FROM, CHAIN.id);
    const queued = acquireEvmNonceOwner(FROM, CHAIN.id);
    held.release();
    held.release();
    const next = await queued;
    // The turn is genuinely held by the waiter: a third caller must still wait.
    let thirdGranted = false;
    void acquireEvmNonceOwner(FROM, CHAIN.id).then((lease) => {
      thirdGranted = true;
      lease.release();
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(thirdGranted).toBe(false);

    next.release();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(thirdGranted).toBe(true);
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });

  it("a waiter that never gets its turn REFUSES rather than waiting forever", async () => {
    const held = await acquireEvmNonceOwner(FROM, CHAIN.id);
    await expect(acquireEvmNonceOwner(FROM, CHAIN.id, 5)).rejects.toBeInstanceOf(
      EvmNonceOwnerUnavailableError,
    );
    held.release();
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });

  it("the SAME address on a DIFFERENT chain is a different turn", async () => {
    const base = await acquireEvmNonceOwner(FROM, 8453);
    const mainnet = await acquireEvmNonceOwner(FROM, 1);
    base.release();
    mainnet.release();
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });

  it("the address is matched case-insensitively, so a checksummed form is the same turn", async () => {
    const held = await acquireEvmNonceOwner(FROM.toUpperCase(), CHAIN.id);
    await expect(acquireEvmNonceOwner(FROM, CHAIN.id, 5)).rejects.toBeInstanceOf(
      EvmNonceOwnerUnavailableError,
    );
    held.release();
    expect(evmNonceOwnerCountForTest()).toBe(0);
  });
});
