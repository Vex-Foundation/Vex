/**
 * executeEvmTransfer - chain-resolution wiring and the staged write path.
 *
 * Pins the inclusive-resolver wiring:
 *   - source:"local"  → wallet/public clients come from the LOCAL registry
 *     factory (getLocalEvmClients), Khalani factory untouched, tx params pass
 *     through unchanged (native value + ERC-20 transfer calldata).
 *   - source:"khalani" → byte-identical legacy path: createDynamicPublicClient/
 *     createDynamicWalletClient with (khalaniChain, khalaniChains[, pk]), local
 *     factory untouched.
 *
 * And, since migration 084, the ORDER in which money becomes durable: the
 * `agent_activity` row is opened BEFORE signing, the hash is staged BEFORE
 * submission, a stage CAS miss aborts without sending, an ambiguous outcome
 * writes nothing terminal, and the amount signed is the amount recorded. Those
 * are the assertions that go red if the staged split is ever collapsed back into
 * a one-step `sendTransaction`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  getAddress,
  http,
  parseUnits,
  type Account,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { getLocalChain, type LocalChainConfig } from "@tools/evm-chains/registry.js";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";

type EvmChainResolverModule = typeof import("@tools/evm-chains/resolver.js");
type EvmClientModule = typeof import("@tools/evm-chains/evm-client.js");
type KhalaniEvmClientModule = typeof import("@tools/khalani/evm-client.js");

/**
 * REAL viem clients with only the four actions under test replaced by spies.
 *
 * The factories these stand in for return `PublicClient`/`WalletClient`; a
 * four-key object literal does not, so typing the factory mocks used to be
 * impossible without an escape. Building the genuine client and overriding the
 * actions keeps the mock's type exactly the contract's.
 */
const STUB_TRANSPORT = http("http://127.0.0.1:1");
const STUB_ACCOUNT = privateKeyToAccount(`0x${"1".repeat(64)}`);

function stubPublicClient() {
  const client = createPublicClient({ chain: mainnet, transport: STUB_TRANSPORT }) as PublicClient<
    Transport,
    Chain
  >;
  return Object.assign(client, {
    waitForTransactionReceipt: vi.fn(),
    readContract: vi.fn(),
    getBlock: vi.fn(),
  });
}

function stubWalletClient() {
  const client = createWalletClient({
    account: STUB_ACCOUNT,
    chain: mainnet,
    transport: STUB_TRANSPORT,
  }) as WalletClient<Transport, Chain, Account>;
  return Object.assign(client, {
    sendTransaction: vi.fn(),
    writeContract: vi.fn(),
  });
}

// ── Mocks ───────────────────────────────────────────────────────

const mockResolve = vi.fn<EvmChainResolverModule["resolveInclusiveEvmChain"]>();
vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: (...args: Parameters<EvmChainResolverModule["resolveInclusiveEvmChain"]>) => mockResolve(...args),
}));

const localPublicClient = stubPublicClient();
const localWalletClient = stubWalletClient();
const mockGetLocalEvmClients = vi.fn<EvmClientModule["getLocalEvmClients"]>(() => ({
  publicClient: localPublicClient,
  walletClient: localWalletClient,
}));
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalEvmClients: (...args: Parameters<EvmClientModule["getLocalEvmClients"]>) => mockGetLocalEvmClients(...args),
}));

const khalaniPublicClient = stubPublicClient();
const khalaniWalletClient = stubWalletClient();
const mockCreateDynamicPublicClient = vi.fn<KhalaniEvmClientModule["createDynamicPublicClient"]>(() => khalaniPublicClient);
const mockCreateDynamicWalletClient = vi.fn<KhalaniEvmClientModule["createDynamicWalletClient"]>(() => khalaniWalletClient);
vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: (...args: Parameters<KhalaniEvmClientModule["createDynamicPublicClient"]>) => mockCreateDynamicPublicClient(...args),
  createDynamicWalletClient: (...args: Parameters<KhalaniEvmClientModule["createDynamicWalletClient"]>) => mockCreateDynamicWalletClient(...args),
}));

/**
 * The staged broadcast primitive (migration 084). `executeEvmTransfer` no
 * longer calls `sendTransaction` / `writeContract` - signing, staging and
 * submitting are SPLIT so a durable row exists before funds can move - so the
 * tx params these tests pin are now the ones handed to `signStageBroadcast`.
 * That is the same assertion about the same values, read at the seam where they
 * are now decided.
 */
type StagedBroadcastModule = typeof import("@tools/evm-chains/staged-broadcast.js");
const mockSignStageBroadcast = vi.fn<StagedBroadcastModule["signStageBroadcast"]>();
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: (...args: Parameters<StagedBroadcastModule["signStageBroadcast"]>) =>
    mockSignStageBroadcast(...args),
}));

/**
 * The durable writer, faked at its module boundary. These tests are about chain
 * wiring, not persistence; the writer's own contract is exercised in
 * `send/wallet-transfer-activity.test.ts` against the real repository seam.
 */
type ActivityWriterModule = typeof import("@vex-agent/tools/internal/wallet/send/activity-writer.js");
const activityHandle = {
  executionId: 77,
  rowId: 42,
  reserveEvmNonce: vi.fn(async (request: { nodePendingNonce: number }) => request.nodePendingNonce),
  stageEvm: vi.fn(async () => {}),
  stageSolana: vi.fn(async () => {}),
  noteAccepted: vi.fn(async () => {}),
  confirm: vi.fn(async () => {}),
  fail: vi.fn(async () => {}),
  failSignedNotSubmitted: vi.fn(async () => {}),
  completeExecution: vi.fn(async () => {}),
};
const mockOpenActivity = vi.fn<ActivityWriterModule["openWalletTransferActivity"]>(
  async () => activityHandle,
);
const mockRecordPlanFailure = vi.fn<ActivityWriterModule["recordWalletTransferPlanFailure"]>(
  async () => {},
);
vi.mock("@vex-agent/tools/internal/wallet/send/activity-writer.js", () => ({
  openWalletTransferActivity: (...args: Parameters<ActivityWriterModule["openWalletTransferActivity"]>) =>
    mockOpenActivity(...args),
  recordWalletTransferPlanFailure: (...args: Parameters<ActivityWriterModule["recordWalletTransferPlanFailure"]>) =>
    mockRecordPlanFailure(...args),
}));

const { executeEvmTransfer } = await import(
  "../../../../../vex-agent/tools/internal/wallet/send-execute-evm.js"
);

// ── Fixtures ────────────────────────────────────────────────────

const PRIVATE_KEY = ("0x" + "1".repeat(64)) as `0x${string}`;
const WALLET: EvmWallet = {
  family: "eip155",
  address: "0xabcdef1234567890abcdef1234567890abcdef12" as EvmWallet["address"],
  privateKey: PRIVATE_KEY,
};
const TO = "0xffcf8fdee72ac11b5c542428b35eef5769c409f0";
const ERC20 = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TX_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

/** The ERC-20 fragment the executor encodes, restated here so the test decodes what it asserts. */
const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * The REAL registry entry for Robinhood Chain (4663), not a hand-rolled stub:
 * `LocalChainConfig` is what the resolver hands the factory, and a stub of it
 * drifts silently every time the registry gains a field.
 */
const LOCAL_CONFIG: LocalChainConfig = (() => {
  const config = getLocalChain(4663);
  if (config === undefined) throw new Error("local chain 4663 missing from the registry");
  return config;
})();

const KHALANI_CHAIN = {
  type: "eip155" as const,
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};
const KHALANI_CHAINS = [KHALANI_CHAIN];

function makeIntent(overrides: Partial<WalletIntent> = {}): WalletIntent {
  return {
    intentId: "intent-1",
    sessionId: "session-1",
    walletAddress: WALLET.address,
    network: "eip155" as WalletIntent["network"],
    chainAlias: "robinhood",
    toAddress: TO,
    amount: "0.5",
    token: null,
    previewJson: {},
    status: "pending" as WalletIntent["status"],
    activityId: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    idempotencyKey: null,
    repairCheckedAt: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenActivity.mockResolvedValue(activityHandle);
  localPublicClient.readContract.mockResolvedValue(6);
  localPublicClient.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n });
  khalaniPublicClient.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n });
  // A confirmed receipt: the staged primitive is driven end to end by the
  // executor, so the outcome it reports is what the executor branches on.
  mockSignStageBroadcast.mockImplementation(async (_public, _wallet, _params, hooks) => {
    await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: WALLET.address, nonce: 7 });
    await hooks.onAccepted();
    return {
      kind: "confirmed" as const,
      txHash: TX_HASH,
      receipt: stubReceipt("success", []),
    };
  });
});

function firstInvocation(callOrder: readonly number[], label: string): number {
  const first = callOrder[0];
  if (first === undefined) throw new Error(`${label} was not called`);
  return first;
}

/**
 * The one `signStageBroadcast` call, asserted to exist. A missing call is a
 * different defect from a wrong argument, and this says so instead of reading
 * through an assertion.
 */
function stagedCall() {
  const call = mockSignStageBroadcast.mock.calls[0];
  if (call === undefined) throw new Error("signStageBroadcast was never called");
  return call;
}

/** The `txParams` the executor handed the staged primitive. */
function stagedTxParams() {
  return stagedCall()[2];
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * A COMPLETE `TransactionReceipt`, so the staged outcomes below are typed rather
 * than cast through a partial shape. Only `status`, `blockNumber` and `logs`
 * carry meaning for these tests; the rest exist because the contract says a
 * receipt has them.
 */
interface StubLog {
  readonly address: `0x${string}`;
  readonly topics: [`0x${string}`, ...`0x${string}`[]] | [];
  readonly data: `0x${string}`;
}

function stubReceipt(
  status: "success" | "reverted",
  logs: ReadonlyArray<StubLog>,
  blockNumber = 123n,
): TransactionReceipt {
  return {
    blockHash: `0x${"1".repeat(64)}`,
    blockNumber,
    contractAddress: null,
    cumulativeGasUsed: 21_000n,
    effectiveGasPrice: 1n,
    from: WALLET.address as `0x${string}`,
    gasUsed: 21_000n,
    logs: logs.map((log, logIndex) => ({
      address: log.address,
      blockHash: `0x${"1".repeat(64)}` as `0x${string}`,
      blockNumber,
      data: log.data,
      logIndex,
      removed: false,
      topics: log.topics,
      transactionHash: TX_HASH,
      transactionIndex: 0,
    })),
    logsBloom: `0x${"0".repeat(512)}`,
    status,
    to: getAddress(TO),
    transactionHash: TX_HASH,
    transactionIndex: 0,
    type: "eip1559",
  };
}

function paddedAddress(address: string): `0x${string}` {
  return `0x000000000000000000000000${address.slice(2).toLowerCase()}`;
}

/** A well-formed ERC-20 `Transfer(WALLET -> TO, value)` log on the ERC20 fixture contract. */
function erc20TransferLog(value: bigint): StubLog {
  return {
    address: getAddress(ERC20),
    topics: [TRANSFER_TOPIC, paddedAddress(WALLET.address), paddedAddress(TO)],
    data: `0x${value.toString(16).padStart(64, "0")}`,
  };
}

/** Drive the staged primitive to a confirmed receipt carrying `logs`. */
function stageWithLogs(logs: ReadonlyArray<StubLog>) {
  mockSignStageBroadcast.mockImplementation(async (_public, _wallet, _params, hooks) => {
    await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: WALLET.address, nonce: 7 });
    await hooks.onAccepted();
    return {
      kind: "confirmed" as const,
      txHash: TX_HASH,
      receipt: stubReceipt("success", logs),
    };
  });
}

/** The plan the executor handed the durable writer. */
function openedPlan() {
  const call = mockOpenActivity.mock.calls[0];
  if (call === undefined) throw new Error("openWalletTransferActivity was never called");
  return call[1];
}

// ── Local branch ────────────────────────────────────────────────

describe("executeEvmTransfer - local registry branch", () => {
  beforeEach(() => {
    mockResolve.mockResolvedValue({
      source: "local",
      chainId: 4663,
      family: "eip155",
      config: LOCAL_CONFIG,
    });
  });

  it("builds clients from the LOCAL factory and passes native tx params through", async () => {
    const outcome = await executeEvmTransfer(makeIntent(), WALLET);

    expect(mockResolve).toHaveBeenCalledWith("robinhood");
    // Local factory got the registry config object + the signing key.
    expect(mockGetLocalEvmClients).toHaveBeenCalledWith(LOCAL_CONFIG, PRIVATE_KEY);
    // Khalani factory untouched - no Khalani dependency on this path.
    expect(mockCreateDynamicPublicClient).not.toHaveBeenCalled();
    expect(mockCreateDynamicWalletClient).not.toHaveBeenCalled();

    // The LOCAL clients are the ones handed to the staged primitive.
    expect(stagedCall()[0]).toBe(localPublicClient);
    expect(stagedCall()[1]).toBe(localWalletClient);
    // Tx params pass through: checksummed recipient, 18-decimals value, and a
    // native send carries no calldata.
    expect(stagedTxParams()).toEqual({
      to: getAddress(TO),
      data: "0x",
      value: parseUnits("0.5", 18),
    });

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind === "confirmed") {
      expect(outcome.txHash).toBe(TX_HASH);
      expect(outcome.data.chain).toBe("Robinhood Chain");
      // The durable row is threaded, not a fabricated `_tradeCapture` blob.
      expect(outcome.data._executionId).toBe(activityHandle.executionId);
      expect(outcome.data._explorerRefs).toEqual([
        { chain: "Robinhood Chain", txRef: TX_HASH },
      ]);
    }
  });

  it("writes the durable row BEFORE it signs, and stages the hash before submission", async () => {
    const order: string[] = [];
    mockOpenActivity.mockImplementation(async () => {
      order.push("intent");
      return activityHandle;
    });
    activityHandle.stageEvm.mockImplementation(async () => {
      order.push("stage");
    });
    mockSignStageBroadcast.mockImplementation(async (_p, _w, _params, hooks) => {
      order.push("sign");
      await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: WALLET.address, nonce: 7 });
      order.push("submit");
      return {
        kind: "confirmed" as const,
        txHash: TX_HASH,
        receipt: stubReceipt("success", []),
      };
    });

    await executeEvmTransfer(makeIntent(), WALLET);

    // The ordering IS the safety property: a crash at any point leaves a
    // discoverable row rather than an invisible transaction.
    expect(order).toEqual(["intent", "sign", "stage", "submit"]);
    expect(activityHandle.confirm).toHaveBeenCalledTimes(1);
    expect(activityHandle.completeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirmed", txHash: TX_HASH }),
    );
    expect(firstInvocation(
      activityHandle.completeExecution.mock.invocationCallOrder,
      "completeExecution",
    )).toBeLessThan(firstInvocation(activityHandle.confirm.mock.invocationCallOrder, "confirm"));
  });

  it("records the SAME atomic amount on the row that it signs into the transaction", async () => {
    await executeEvmTransfer(makeIntent({ amount: "0.5" }), WALLET);

    const signedValue = stagedTxParams().value;
    const plan = openedPlan();
    // One bigint, two consumers. A float round-trip anywhere between them would
    // separate these two numbers, which is the defect this asserts against.
    expect(plan.amountRaw).toBe(signedValue);
    expect(plan.amountRaw).toBe(parseUnits("0.5", 18));
    expect(plan.amountHuman).toBe("0.5");
    expect(plan.tokenDecimals).toBe(18);
  });

  it("aborts before submission when the stage CAS misses, and never terminalizes a second row", async () => {
    activityHandle.stageEvm.mockRejectedValueOnce(new Error("CAS miss"));
    let submitted = false;
    mockSignStageBroadcast.mockImplementation(async (_p, _w, _params, hooks) => {
      // The real primitive propagates an `onHashStaged` throw WITHOUT sending.
      await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: WALLET.address, nonce: 7 });
      submitted = true;
      throw new Error("unreachable");
    });

    const outcome = await executeEvmTransfer(makeIntent(), WALLET);

    expect(submitted).toBe(false);
    expect(outcome.kind).toBe("pre_broadcast_failed");
    // The EXISTING event is finalized; a second execution row is never created.
    expect(activityHandle.fail).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "broadcast_error" }),
    );
    expect(mockRecordPlanFailure).not.toHaveBeenCalled();
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "failed_before_broadcast",
    });
    expect(firstInvocation(
      activityHandle.completeExecution.mock.invocationCallOrder,
      "completeExecution",
    )).toBeLessThan(firstInvocation(activityHandle.fail.mock.invocationCallOrder, "fail"));
  });

  it("leaves an AMBIGUOUS outcome pending on the activity row, but still closes the tool attempt", async () => {
    let submissions = 0;
    mockSignStageBroadcast.mockImplementation(async (_p, _w, _params, hooks) => {
      submissions++;
      await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: WALLET.address, nonce: 7 });
      return {
        kind: "ambiguous" as const, txHash: TX_HASH, stage: "send" as const, reason: "rpc timeout",
      };
    });

    const outcome = await executeEvmTransfer(makeIntent(), WALLET);

    expect(outcome.kind).toBe("confirmation_unknown");
    if (outcome.kind === "confirmation_unknown") expect(outcome.txHash).toBe(TX_HASH);
    // The CHAIN state stays unresolved: nothing terminal, and never a resend.
    expect(activityHandle.fail).not.toHaveBeenCalled();
    expect(activityHandle.confirm).not.toHaveBeenCalled();
    expect(submissions).toBe(1);
    // The TOOL ATTEMPT is closed. The compaction safe-moment gate selects an
    // `execution_status = 'intent'` row independently of `agent_activity`, so
    // leaving it open would block compaction even after the sweep resolved the
    // activity row.
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "confirmation_unknown", txHash: TX_HASH,
    });
  });

  it("finalizes a definitive revert as failed, and completes the execution", async () => {
    mockSignStageBroadcast.mockImplementation(async (_p, _w, _params, hooks) => {
      await hooks.onHashStaged({ txHash: TX_HASH, fromAddress: WALLET.address, nonce: 7 });
      return {
        kind: "reverted" as const, txHash: TX_HASH, receipt: stubReceipt("reverted", [], 9n),
      };
    });

    const outcome = await executeEvmTransfer(makeIntent(), WALLET);

    expect(outcome.kind).toBe("chain_failed");
    expect(activityHandle.fail).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "mined_revert" }),
    );
    expect(activityHandle.completeExecution).toHaveBeenCalledWith({
      kind: "reverted", txHash: TX_HASH,
    });
    expect(firstInvocation(
      activityHandle.completeExecution.mock.invocationCallOrder,
      "completeExecution",
    )).toBeLessThan(firstInvocation(activityHandle.fail.mock.invocationCallOrder, "fail"));
    expect(activityHandle.confirm).not.toHaveBeenCalled();
  });

  it("refuses to sign when the durable row cannot be written", async () => {
    mockOpenActivity.mockRejectedValueOnce(new Error("db down"));

    const outcome = await executeEvmTransfer(makeIntent(), WALLET);

    expect(outcome.kind).toBe("pre_broadcast_failed");
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
  });

  it("routes ERC-20 transfers through the local clients (decimals read + transfer calldata)", async () => {
    stageWithLogs([erc20TransferLog(parseUnits("25", 6))]);
    const outcome = await executeEvmTransfer(makeIntent({ token: ERC20, amount: "25" }), WALLET);

    // decimals read via the LOCAL public client.
    expect(localPublicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: getAddress(ERC20), functionName: "decimals" }),
    );
    // The transfer travels as CALLDATA to the token contract now, with the
    // amount scaled by the decimals that were read. Decoding it back asserts
    // the same two values the old `writeContract` args did.
    const params = stagedTxParams();
    expect(params.to).toBe(getAddress(ERC20));
    expect(params.value).toBe(0n);
    expect(decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: params.data })).toEqual({
      functionName: "transfer",
      args: [getAddress(TO), parseUnits("25", 6)],
    });
    // The row records the same scaled amount, with the same decimals.
    const plan = openedPlan();
    expect(plan.amountRaw).toBe(parseUnits("25", 6));
    expect(plan.tokenDecimals).toBe(6);
    expect(plan.tokenAddress).toBe(getAddress(ERC20));
    expect(outcome.kind).toBe("confirmed");
  });

  it("records an ERC-20 amount as EXECUTED only when the receipt's Transfer log proves it", async () => {
    stageWithLogs([erc20TransferLog(parseUnits("25", 6))]);

    await executeEvmTransfer(makeIntent({ token: ERC20, amount: "25" }), WALLET);

    expect(activityHandle.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ provenAmountRaw: parseUnits("25", 6) }),
    );
  });

  it("proves NOTHING for an ERC-20 whose receipt carries no Transfer log", async () => {
    // The defect: `transfer` returns `bool`, so a nonconforming token can answer
    // `false` WITHOUT reverting. Inclusion is then not proof of movement.
    stageWithLogs([]);

    await executeEvmTransfer(makeIntent({ token: ERC20, amount: "25" }), WALLET);

    expect(activityHandle.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ provenAmountRaw: null }),
    );
  });

  it("proves NOTHING for an ERC-20 whose Transfer log carries a DIFFERENT amount", async () => {
    // A fee-on-transfer token delivering less than requested.
    stageWithLogs([erc20TransferLog(parseUnits("24", 6))]);

    await executeEvmTransfer(makeIntent({ token: ERC20, amount: "25" }), WALLET);

    expect(activityHandle.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ provenAmountRaw: null }),
    );
  });

  it("keeps inclusion as proof for a NATIVE send - the protocol moves tx.value itself", async () => {
    stageWithLogs([]);

    await executeEvmTransfer(makeIntent(), WALLET);

    expect(activityHandle.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ provenAmountRaw: parseUnits("0.5", 18) }),
    );
  });
});

// ── Khalani branch regression ───────────────────────────────────

describe("executeEvmTransfer - khalani branch (regression)", () => {
  beforeEach(() => {
    mockResolve.mockResolvedValue({
      source: "khalani",
      chainId: 8453,
      family: "eip155",
      khalaniChain: KHALANI_CHAIN,
      khalaniChains: KHALANI_CHAINS,
    });
  });

  it("keeps the legacy Khalani client path byte-identical (factories + args)", async () => {
    const outcome = await executeEvmTransfer(makeIntent({ chainAlias: "base" }), WALLET);

    expect(mockCreateDynamicPublicClient).toHaveBeenCalledWith(KHALANI_CHAIN, KHALANI_CHAINS);
    expect(mockCreateDynamicWalletClient).toHaveBeenCalledWith(KHALANI_CHAIN, KHALANI_CHAINS, PRIVATE_KEY);
    // Local factory untouched on the Khalani path.
    expect(mockGetLocalEvmClients).not.toHaveBeenCalled();

    expect(stagedCall()[0]).toBe(khalaniPublicClient);
    expect(stagedCall()[1]).toBe(khalaniWalletClient);
    expect(stagedTxParams()).toEqual({
      to: getAddress(TO),
      data: "0x",
      value: parseUnits("0.5", 18),
    });

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind === "confirmed") {
      expect(outcome.data.chain).toBe("Base");
    }
  });
});

// ── Resolver failure stays pre-broadcast ────────────────────────

describe("executeEvmTransfer - resolver failure", () => {
  it("maps an unresolvable chain to pre_broadcast_failed (no client built, no tx)", async () => {
    mockResolve.mockRejectedValue(new Error("Unsupported chain: narnia"));

    const outcome = await executeEvmTransfer(makeIntent({ chainAlias: "narnia" }), WALLET);

    expect(outcome.kind).toBe("pre_broadcast_failed");
    expect(mockGetLocalEvmClients).not.toHaveBeenCalled();
    expect(mockCreateDynamicWalletClient).not.toHaveBeenCalled();
    expect(localWalletClient.sendTransaction).not.toHaveBeenCalled();
    expect(khalaniWalletClient.sendTransaction).not.toHaveBeenCalled();
  });
});
