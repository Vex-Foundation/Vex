/**
 * The Morpho write path: what gets RECORDED, in what ORDER, and what is refused
 * to be recorded at all.
 *
 * ── WHY `chain_family` AND `chain_id` HAVE THEIR OWN CASES ──────────────────
 *
 * Migration 079 widened `agent_activity_kind_family_binding` to admit
 * `kind = 'lend' AND chain_family = 'eip155'`. Before it, a lend writer that
 * forgot the family was rejected by the database on its first insert; after it,
 * both families satisfy the CHECK and only the writer knows which is true. 079's
 * own header records that risk in those words. So the value that lands in the
 * column is asserted here rather than trusted to a default that no longer means
 * anything, and the chain id is asserted to come from the caller's registry-
 * resolved value rather than from anything a model supplied.
 *
 * ── WHY THE ORDERING CASES ARE THE MONEY CASES ──────────────────────────────
 *
 * Two failures would be expensive and both are invisible without a test:
 *
 *   1. Broadcasting the deposit after its simulation PROVED a revert. The whole
 *      point of simulating after the approval lands is that a doomed deposit
 *      costs nothing; a lane that simulated and then sent anyway would have
 *      spent the gas for no reason at all.
 *   2. Terminalizing a row whose broadcast ended ambiguously. An ambiguous send
 *      may already have moved funds. Writing `definitively_failed` on it, or
 *      re-broadcasting it, are the two ways one transaction becomes two.
 *
 * The clients are stubs and the staged-broadcast primitive is mocked: this suite
 * is about the protocol around a broadcast, not about signing, which has its own
 * owner and its own fork proof.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateIntent = vi.fn();
const mockConfirm = vi.fn();
const mockFail = vi.fn();
const mockAbort = vi.fn();
const mockMarkBroadcast = vi.fn();
const mockMarkAccepted = vi.fn();
const mockNoteBlockTime = vi.fn();
const mockSignStageBroadcast = vi.fn();
const mockNotePendingReason = vi.fn();
const mockPrepareExecution = vi.fn();
const mockPrepareLeg = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createAgentActivityIntent: (...a: unknown[]) => mockCreateIntent(...a),
    confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
    failActivityEvent: (...a: unknown[]) => mockFail(...a),
    abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
    markActivityBroadcast: (...a: unknown[]) => mockMarkBroadcast(...a),
    markBroadcastAccepted: (...a: unknown[]) => mockMarkAccepted(...a),
    noteSettledBlockTime: (...a: unknown[]) => mockNoteBlockTime(...a),
  };
});

vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: (...a: unknown[]) => mockSignStageBroadcast(...a),
}));

vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason: (...a: unknown[]) => mockNotePendingReason(...a),
}));

vi.mock("@tools/morpho/mutations.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prepareMorphoVaultExecution: (...a: unknown[]) => mockPrepareExecution(...a),
    prepareMorphoOperationLeg: (...a: unknown[]) => mockPrepareLeg(...a),
  };
});

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { executeMorphoVaultDeposit, executeMorphoVaultWithdraw } = await import(
  "@vex-agent/tools/protocols/morpho/handlers/signed-broadcast.js"
);

const CHAIN_ID = 8453;
const WALLET = "0xaAaAbBbBccCCddddEeeEFffF0000111122223333" as const;
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const VAULT = "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca";
const ADAPTER = "0xb98c948cfa24072e58935bc004a8a7b376ae746a";
const BUNDLER3 = "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEPOSIT_ASSETS = 1_000_000n;
const MINTED_SHARES = 970_000_000_000_000_000n;

function pad(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function transfer(token: string, from: string, to: string, amount: bigint) {
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(amount) };
}

/** A fresh accrued vault reading, in the shape `readMorphoVaultState` returns. */
function vaultState() {
  return {
    generation: "v1" as const,
    address: VAULT,
    assetAddress: ASSET,
    assetDecimals: 6,
    assetSymbol: "USDC",
    shareDecimals: 18,
    shareSymbol: "steakUSDC",
    name: "Steakhouse USDC",
    assetsPerShareRaw: 1_030_000n,
    toShares: () => MINTED_SHARES,
    toAssets: () => DEPOSIT_ASSETS,
    performanceFeeRaw: null,
    managementFeeRaw: null,
  };
}

/** An allowance plan that still owes one exact-amount approval. */
function allowancePlanNeedingApproval() {
  return {
    shape: "approve" as const,
    token: ASSET,
    owner: WALLET,
    spender: ADAPTER,
    spenderRole: "GeneralAdapter1",
    requiredAmountRaw: DEPOSIT_ASSETS,
    currentAllowanceRaw: 0n,
    steps: [{
      kind: "allowance" as const,
      to: ASSET,
      data: "0xapprove" as const,
      spender: ADAPTER,
      amountRaw: DEPOSIT_ASSETS,
      explanation: "exact",
    }],
  };
}

/** The rows `createAgentActivityIntent` would have returned for this plan. */
function rowsFor(events: readonly Record<string, unknown>[]) {
  return events.map((event, index) => ({
    id: 100 + index,
    protocolExecutionId: 7,
    eventIndex: index,
    ...event,
    tokenInAddress: (event.tokenIn as { tokenAddress?: string } | undefined)?.tokenAddress ?? null,
    tokenOutAddress: (event.tokenOut as { tokenAddress?: string } | undefined)?.tokenAddress ?? null,
    amountInRaw: (event.tokenIn as { amountRaw?: string } | undefined)?.amountRaw ?? null,
    amountOutRaw: (event.tokenOut as { amountRaw?: string } | undefined)?.amountRaw ?? null,
  }));
}

const clients = {
  publicClient: { getBlock: vi.fn(async () => ({ timestamp: 1_760_000_000n })) },
  walletClient: {},
  actionClient: {},
} as never;

function request(overrides: Record<string, unknown> = {}) {
  return {
    toolId: "morpho.vault.deposit",
    sessionId: "session-1",
    intentParams: { vault: VAULT, amount: "1" },
    chainId: CHAIN_ID,
    vaultAddress: VAULT,
    walletAddress: WALLET,
    amountRaw: DEPOSIT_ASSETS,
    slippageBps: 100,
    ...overrides,
  } as never;
}

/** The event inputs the module handed to `createAgentActivityIntent`. */
function capturedEvents(): Record<string, unknown>[] {
  return mockCreateIntent.mock.calls[0]![0].events as Record<string, unknown>[];
}

function confirmedOutcome(logs: unknown[], txHash = "0xdep") {
  return {
    kind: "confirmed",
    txHash,
    receipt: { blockNumber: 42n, logs, status: "success" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkBroadcast.mockResolvedValue({ applied: true });
  mockMarkAccepted.mockResolvedValue({ applied: true });
  mockConfirm.mockResolvedValue({ applied: true });
  mockFail.mockResolvedValue({ applied: true });
  mockAbort.mockResolvedValue([]);
  mockNoteBlockTime.mockResolvedValue(true);
  mockCreateIntent.mockImplementation(async (input: { events: Record<string, unknown>[] }) => ({
    executionId: 7,
    events: rowsFor(input.events),
  }));
  mockPrepareExecution.mockResolvedValue({
    state: vaultState(),
    allowancePlan: allowancePlanNeedingApproval(),
    expectedSharesRaw: MINTED_SHARES,
    bundle: { to: BUNDLER3, shape: "bundler3-multicall" },
  });
  mockPrepareLeg.mockResolvedValue({
    to: BUNDLER3,
    data: "0xdeposit",
    value: 0n,
    bundle: { to: BUNDLER3 },
    gas: { nodeEstimate: "100000", vexGasLimit: "150000" },
    preflight: { verdict: "ok", revertReason: null, explanation: "" },
  });
});

describe("the durable rows a Morpho deposit writes", () => {
  it("STATES chain_family eip155 explicitly on every leg, because 079 stopped catching an omission", async () => {
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([
      transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
      transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
    ]));

    await executeMorphoVaultDeposit(clients, request());

    const events = capturedEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.chainFamily).toBe("eip155");
      expect(event.kind).toBe("lend");
      expect(event.protocol).toBe("morpho");
    }
  });

  it("takes chain_id and its slug from the caller's registry-resolved chain, never from params", async () => {
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([
      transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
      transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
    ]));

    // The params carry a DIFFERENT chain. Only `chainId` may decide the column.
    await executeMorphoVaultDeposit(clients, request({ intentParams: { chain: "ethereum" } }));

    for (const event of capturedEvents()) {
      expect(event.chainId).toBe(CHAIN_ID);
      expect(event.chainSlug).toBe("base");
    }
  });

  it("files the approval and the deposit under their own roles, approval first", async () => {
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([
      transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
      transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
    ]));

    await executeMorphoVaultDeposit(clients, request());

    expect(capturedEvents().map((e) => e.eventRole)).toEqual(["allowance", "lend_deposit"]);
  });

  it("gives every leg its address, symbol, decimals, human and raw amount at BOTH scales", async () => {
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([
      transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
      transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
    ]));

    await executeMorphoVaultDeposit(clients, request());

    const deposit = capturedEvents()[1]!;
    // The asset is 6 decimals and the share token is 18. A single `decimals`
    // field beside these two raw numbers is the thousandfold error rules/90
    // names, so each leg carries its own.
    expect(deposit.tokenIn).toEqual({
      tokenAddress: ASSET,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      amountHuman: "1",
      amountRaw: DEPOSIT_ASSETS.toString(),
    });
    expect(deposit.tokenOut).toEqual({
      tokenAddress: VAULT,
      tokenSymbol: "steakUSDC",
      tokenDecimals: 18,
      amountHuman: "0.97",
      amountRaw: MINTED_SHARES.toString(),
    });
  });

  it("persists the settlement-decode hint on the OPERATION leg, naming the verified target", async () => {
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([
      transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
      transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
    ]));

    await executeMorphoVaultDeposit(clients, request());

    const events = capturedEvents();
    const hint = (events[1]!.routeProvenance as Record<string, unknown>).settlementDecode;
    expect(hint).toEqual({ v: 1, decoder: "morpho", chainId: CHAIN_ID, routerAddress: BUNDLER3 });
    // The approval leg carries no hint: its decoder declines the role anyway, so
    // a hint there would promise a decode that can never happen.
    expect((events[0]!.routeProvenance as Record<string, unknown>).settlementDecode).toBeUndefined();
  });

  it("plans a withdrawal as ONE direct leg with no approval at all", async () => {
    mockPrepareExecution.mockResolvedValue({
      state: vaultState(),
      allowancePlan: null,
      expectedSharesRaw: MINTED_SHARES,
      bundle: { to: VAULT, shape: "direct-vault-call" },
    });
    mockPrepareLeg.mockResolvedValue({
      to: VAULT, data: "0xwithdraw", value: 0n,
      bundle: { to: VAULT },
      gas: { nodeEstimate: "1", vexGasLimit: "2" },
      preflight: { verdict: "ok", revertReason: null, explanation: "" },
    });
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([
      transfer(VAULT, WALLET, ZERO, MINTED_SHARES),
      transfer(ASSET, VAULT, WALLET, DEPOSIT_ASSETS),
    ]));

    const outcome = await executeMorphoVaultWithdraw(clients, request({ toolId: "morpho.vault.withdraw" }));

    expect(capturedEvents().map((e) => e.eventRole)).toEqual(["lend_withdraw"]);
    expect(outcome.kind).toBe("confirmed");
  });
});

describe("leg ordering and the refusals that protect it", () => {
  it("NEVER broadcasts the deposit when its simulation proved a revert", async () => {
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([], "0xapproval"));
    const { VexError } = await import("../../../../../errors.js");
    mockPrepareLeg.mockRejectedValue(
      new VexError("MORPHO_PREFLIGHT_REVERTED", "the node proved it reverts", "nothing was signed"),
    );

    const outcome = await executeMorphoVaultDeposit(clients, request());

    // Exactly ONE broadcast happened: the approval. The deposit never reached
    // the signer at all.
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("refused");
    // The deposit row is terminalized with the code that says a SIMULATION
    // refused it, not one that implies something was sent.
    expect(mockFail).toHaveBeenCalledWith(101, expect.objectContaining({ failureCode: "simulation_reverted" }));
  });

  it("names the residual allowance the landed approval left behind, with its remediation", async () => {
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([], "0xapproval"));
    const { VexError } = await import("../../../../../errors.js");
    mockPrepareLeg.mockRejectedValue(new VexError("MORPHO_PREFLIGHT_REVERTED", "reverts", "hint"));

    const outcome = await executeMorphoVaultDeposit(clients, request());

    expect(outcome.message).toContain("1 USDC");
    expect(outcome.message).toContain(ADAPTER);
    expect(outcome.message).toContain("Retrying the same deposit consumes it");
  });

  it("refuses to send a rebuilt deposit that points at a target the row does not name", async () => {
    mockSignStageBroadcast.mockResolvedValue(confirmedOutcome([], "0xapproval"));
    mockPrepareLeg.mockResolvedValue({
      to: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      data: "0xdeposit", value: 0n,
      bundle: { to: BUNDLER3 },
      gas: { nodeEstimate: "1", vexGasLimit: "2" },
      preflight: { verdict: "ok", revertReason: null, explanation: "" },
    });

    const outcome = await executeMorphoVaultDeposit(clients, request());

    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("refused");
  });

  it("does not attempt the deposit when the approval REVERTED, and abandons the rest", async () => {
    mockSignStageBroadcast.mockResolvedValue({ kind: "reverted", txHash: "0xapproval", receipt: { blockNumber: 1n } });

    const outcome = await executeMorphoVaultDeposit(clients, request());

    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
    expect(mockPrepareLeg).not.toHaveBeenCalled();
    expect(mockAbort).toHaveBeenCalledWith(7, 1, expect.stringContaining("reverted"));
    expect(outcome.kind).toBe("reverted");
  });
});

describe("ambiguity never terminalizes and never re-broadcasts", () => {
  it("leaves an ambiguous approval PENDING, records why, and stops the execution", async () => {
    mockSignStageBroadcast.mockResolvedValue({
      kind: "ambiguous", txHash: "0xapproval", stage: "confirm", reason: "receipt wait failed",
    });

    const outcome = await executeMorphoVaultDeposit(clients, request());

    // The row is neither confirmed nor failed: the transaction may already be
    // on chain, so only the sweep may decide.
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    // And it is not re-sent.
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
    expect(mockNotePendingReason).toHaveBeenCalledWith(
      "morpho.vault.deposit", 100, "broadcast_ambiguous_confirm",
    );
    expect(outcome).toMatchObject({ kind: "unproven", reason: "ambiguous", txHash: "0xapproval" });
    expect(outcome.message).toContain("Do not retry");
  });

  it("leaves an ambiguous DEPOSIT pending too, and tells the agent not to retry", async () => {
    mockSignStageBroadcast
      .mockResolvedValueOnce(confirmedOutcome([], "0xapproval"))
      .mockResolvedValueOnce({ kind: "ambiguous", txHash: "0xdep", stage: "send", reason: "submit unclear" });

    const outcome = await executeMorphoVaultDeposit(clients, request());

    expect(mockFail).not.toHaveBeenCalled();
    expect(mockNotePendingReason).toHaveBeenCalledWith("morpho.vault.deposit", 101, "broadcast_ambiguous_send");
    expect(outcome).toMatchObject({ kind: "unproven", reason: "ambiguous" });
  });

  it("leaves a mined-but-undecodable deposit pending rather than reporting a guessed fill", async () => {
    mockSignStageBroadcast
      .mockResolvedValueOnce(confirmedOutcome([], "0xapproval"))
      // Mined SUCCESSFULLY with no transfer the decoder can prove.
      .mockResolvedValueOnce(confirmedOutcome([], "0xdep"));

    const outcome = await executeMorphoVaultDeposit(clients, request());

    expect(mockNotePendingReason).toHaveBeenCalledWith("morpho.vault.deposit", 101, "settlement_undecodable");
    expect(outcome).toMatchObject({ kind: "unproven", reason: "undecodable" });
    // The confirm that DID run was the approval's, never the deposit's.
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith(100, {});
  });
});

describe("a settled deposit", () => {
  beforeEach(() => {
    mockSignStageBroadcast
      .mockResolvedValueOnce(confirmedOutcome([], "0xapproval"))
      .mockResolvedValueOnce(confirmedOutcome([
        transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
        transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
      ], "0xdep"));
  });

  it("confirms with the amounts the RECEIPT proved, at each leg's own decimals", async () => {
    const outcome = await executeMorphoVaultDeposit(clients, request());

    expect(outcome.kind).toBe("confirmed");
    expect(mockConfirm).toHaveBeenCalledWith(101, {
      executedAmountInRaw: DEPOSIT_ASSETS.toString(),
      executedAmountInHuman: "1",
      executedAmountOutRaw: MINTED_SHARES.toString(),
      executedAmountOutHuman: "0.97",
    });
  });

  it("records the settling BLOCK's own time, read from the chain", async () => {
    await executeMorphoVaultDeposit(clients, request());

    expect(mockNoteBlockTime).toHaveBeenCalledWith(101, new Date(1_760_000_000 * 1000).toISOString());
  });

  it("judges the shares against the ABSOLUTE bound the approved slippage allows", async () => {
    const outcome = await executeMorphoVaultDeposit(clients, request());

    expect(outcome).toMatchObject({
      kind: "confirmed",
      shares: {
        withinApprovedBound: true,
        actualRaw: MINTED_SHARES.toString(),
        shareDecimals: 18,
        slippageBps: 100,
        boundSide: "minimum_shares_received",
      },
    });
  });

  it("reports the quoted-vs-settled difference as accrual drift rather than as a verdict", async () => {
    const outcome = await executeMorphoVaultDeposit(clients, request());

    // The fork run of 2026-08-17 measured an ordinary 1 USDC deposit drifting
    // past the old fixed 1e-9-share tolerance. The drift is still REPORTED; what
    // changed is that it no longer decides the verdict.
    expect(outcome).toMatchObject({ kind: "confirmed" });
    if (outcome.kind !== "confirmed") throw new Error("expected a confirmed outcome");
    expect(outcome.shares.accrualDriftRaw).toBeDefined();
    expect(outcome.message).not.toContain("outside the");
  });
});
