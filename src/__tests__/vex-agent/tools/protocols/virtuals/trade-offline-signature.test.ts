/**
 * NOTHING REACHES THE NETWORK BETWEEN THE VIRTUALS TRADE'S FINAL AUTHORITY GATE
 * AND ITS SIGNATURE.
 *
 * ## The defect this is the reproducer for
 *
 * The arc's round-2 review measured it on the installed library rather than
 * inferring it: the trade leg handed `signStageBroadcast` the EAGER wallet
 * client, and viem's `signTransaction` wallet action unconditionally awaits
 * `eth_chainId` before it reaches the local account's signer
 * (`node_modules/viem/_esm/actions/wallet/signTransaction.js`; the same
 * measurement is pinned repo-wide by
 * `src/__tests__/tools/evm-chains/staged-broadcast-offline-signature.test.ts`).
 *
 * That single round trip sits AFTER the gate that just proved the proposal
 * unexpired, the taxes unchanged, the implementations unmoved and the floor
 * reachable - and a node decides how long it takes. The reviewer's own
 * reproduction let the gate pass with 15 seconds of proposal life remaining and
 * had the chain-id request stall for 16, and the signing callback was reached
 * expired. The verdict the human approved was therefore about a state that had
 * already lapsed by the time the bytes committed to it.
 *
 * ## What is real here, and why
 *
 * The WALLET CLIENT is a real `createWalletClient` over a real
 * `privateKeyToAccount` and a real chain, and its transport RECORDS every method
 * asked of it. That is the whole experiment: the window is measured on the
 * wire, not asserted from reading the code, and the doubles the handler suites
 * use conceal it precisely because they replace `signStageBroadcast` itself.
 *
 * `signStageBroadcast` is the REAL function. Preparation and submission are
 * stubbed on the public client - they are not the subject, and driving them
 * through a transport would add a dozen unrelated RPC shapes to the fixture.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createWalletClient,
  custom,
  parseTransaction,
  recoverTransactionAddress,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type { BuiltCurveTx } from "@tools/virtuals/curve/index.js";
import { publicClientDouble } from "../../../../_test-evm-clients.js";

const PRIVATE_KEY = `0x${"22".repeat(32)}` as Hex;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const BONDING = "0x3333333333333333333333333333333333333333" as const;
const CALLDATA = "0x1a2b3c4d" as Hex;
const EVENT_ID = 4242;

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  reserveActivityEvmNonce: async () => 11,
  markActivityBroadcast: async () => ({ applied: true }),
  markBroadcastAccepted: async () => ({ applied: true }),
  failActivityEvent: async () => undefined,
}));

vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason: async () => undefined,
}));

const { runCurveLeg } = await import(
  "@vex-agent/tools/protocols/virtuals/handlers/trade/broadcast.js"
);

/** viem's own branded serialized-transaction type, so the readers below type-check. */
type SerializedTransaction = Parameters<
  typeof recoverTransactionAddress
>[0]["serializedTransaction"];

/** The prepared EIP-1559 request, exactly the shape viem's preparation returns. */
function preparedRequest() {
  return {
    to: BONDING,
    data: CALLDATA,
    value: 0n,
    gas: 300_000n,
    nonce: 11,
    type: "eip1559" as const,
    chainId: base.id,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    chain: base,
  };
}

/**
 * The event row `runCurveLeg` records against. Only its `id` is read by the
 * production path, and every repository call it reaches is mocked above; the
 * remaining ~90 columns are the durable row's, not this test's subject, which is
 * why the fixture is narrowed rather than transcribed (the same shape
 * `src/__tests__/vex-agent/sync/executed-amount-fallback.test.ts` uses).
 */
function tradeEvent(): AgentActivityEvent {
  return { id: EVENT_ID, eventRole: "swap" } as AgentActivityEvent;
}

function tradeTx(): BuiltCurveTx {
  return { to: BONDING, data: CALLDATA, value: 0n };
}

/**
 * A transport that RECORDS every method asked of it, and answers `eth_chainId`
 * the way a real node would.
 *
 * `armedAt` is set by the fence, so the recording splits cleanly into "before
 * the gate" and "in the window the gate's verdict has to survive".
 */
function recordingTransport(state: {
  armed: boolean;
  before: string[];
  after: string[];
  onChainId?: () => void;
}): Transport {
  return custom({
    request: async ({ method }: { method: string }) => {
      (state.armed ? state.after : state.before).push(method);
      if (method === "eth_chainId") {
        state.onChainId?.();
        return `0x${base.id.toString(16)}`;
      }
      throw new Error(`this test double has no script for the JSON-RPC method ${method}`);
    },
  });
}

function stubbedPublicClient(sent: { serialized: SerializedTransaction | null }) {
  return publicClientDouble(
    {
      estimateGas: vi.fn(async () => 250_000n),
      prepareTransactionRequest: vi.fn(async () => preparedRequest()),
      sendRawTransaction: vi.fn(async (args: { serializedTransaction: SerializedTransaction }) => {
        sent.serialized = args.serializedTransaction;
        return `0x${"cd".repeat(32)}` as Hex;
      }),
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success" as const,
        blockNumber: 99n,
        logs: [],
      })),
    },
    base.id,
  );
}

/**
 * The wallet the leg signs with: a REAL local account on a REAL chain over the
 * recording transport, with only preparation stubbed. Preparation runs on this
 * client on the eager arm and on the public client on the deferred one, so
 * stubbing it here keeps the recording a measurement of the SIGNING window on
 * either arm rather than of viem's nonce and fee filling.
 */
function recordingWalletClient(transport: Transport) {
  return Object.assign(
    createWalletClient({ account: ACCOUNT, chain: base, transport }),
    { prepareTransactionRequest: vi.fn(async () => preparedRequest()) },
  );
}

async function runLeg(input: {
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly onBeforeSign: () => void;
}) {
  return await runCurveLeg({
    event: tradeEvent(),
    tx: tradeTx(),
    clients: { publicClient: input.publicClient, walletClient: input.walletClient },
    priorLeg: undefined,
    label: "curve trade",
    // THE FENCE, standing exactly where `assertCurveTradeFinalAuthority` stands
    // in production: the last thing the leg is given before the key is used.
    onBeforeSign: async () => {
      input.onBeforeSign();
    },
  });
}

describe("the Virtuals trade leg signs OFFLINE", () => {
  it("makes no provider request at all between the final authority gate and the signature", async () => {
    const state = { armed: false, before: [] as string[], after: [] as string[] };
    const sent = { serialized: null as SerializedTransaction | null };
    const publicClient = stubbedPublicClient(sent);
    const walletClient = recordingWalletClient(recordingTransport(state));

    const outcome = await runLeg({
      publicClient,
      walletClient,
      onBeforeSign: () => {
        state.armed = true;
      },
    });

    expect(outcome.kind).toBe("confirmed");
    // THE ASSERTION THIS FILE EXISTS FOR. Not "few", not "only viem's":
    // the window the gate's verdict has to survive is EMPTY.
    expect(state.after).toEqual([]);

    // And the leg really did sign - an empty window proves nothing if nothing
    // was signed in it. The bytes recover to the wallet that was resolved, on
    // the chain and nonce preparation fixed.
    const serialized = sent.serialized;
    if (serialized === null) throw new Error("nothing was broadcast");
    const parsed = parseTransaction(serialized);
    expect(parsed.chainId).toBe(base.id);
    expect(parsed.nonce).toBe(11);
    expect(parsed.to?.toLowerCase()).toBe(BONDING);
    expect(parsed.data).toBe(CALLDATA);
    await expect(
      recoverTransactionAddress({ serializedTransaction: serialized }),
    ).resolves.toBe(ACCOUNT.address);
  });

  it("cannot have its signature pushed past the deadline the gate just proved by a stalling node", async () => {
    // The reviewer's own measurement, as a test: a node that takes 16 seconds to
    // answer `eth_chainId` while the proposal had 15 left. The clock here is a
    // number the transport moves, so the question the test asks is the exact
    // one the money path asks - was the state the gate proved still the state
    // the bytes committed to?
    const DEADLINE_MS = 15_000;
    const clock = { elapsedMs: 0 };
    const state = {
      armed: false,
      before: [] as string[],
      after: [] as string[],
      onChainId: () => {
        clock.elapsedMs += 16_000;
      },
    };
    const sent = { serialized: null as SerializedTransaction | null };
    const publicClient = stubbedPublicClient(sent);
    const walletClient = recordingWalletClient(recordingTransport(state));

    let elapsedAtGate = -1;
    const outcome = await runLeg({
      publicClient,
      walletClient,
      onBeforeSign: () => {
        state.armed = true;
        elapsedAtGate = clock.elapsedMs;
      },
    });

    expect(outcome.kind).toBe("confirmed");
    expect(elapsedAtGate).toBeLessThan(DEADLINE_MS);
    // The signature committed under the SAME clock the gate proved: the stalling
    // node never got the chance to move it, because it was never asked.
    expect(clock.elapsedMs).toBe(elapsedAtGate);
    expect(clock.elapsedMs).toBeLessThan(DEADLINE_MS);
    expect(state.after).not.toContain("eth_chainId");
  });
});
