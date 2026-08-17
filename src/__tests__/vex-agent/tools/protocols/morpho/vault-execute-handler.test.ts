/**
 * `morpho.vault.deposit` / `morpho.vault.withdraw` handler behaviour: the
 * agent-facing contract of the two tools that actually spend.
 *
 * The EXECUTION ENGINE is not under test here - it is Lamport's, it has its own
 * suite and its own fork harness, and it is stubbed so these cases can assert
 * only what the agent layer owns:
 *
 *   - the input contract, including the wrong direction's amount key being
 *     refused BY NAME rather than dropped, which on a money path is the
 *     difference between a rejection and a silent substitution;
 *   - `dryRun` returning the FULL preview, including the allowance plan, and
 *     signing nothing (no wallet is resolved, no client is built);
 *   - the disclosure carry: gating reaching the output on both the preview and
 *     the executed path;
 *   - the one place this lane FAILS CLOSED - a live call whose governance read
 *     did not answer refuses before signing, while a dryRun degrades;
 *   - the outcome mapping for all four endings, and specifically that
 *     `unproven` refuses a retry and that nothing is ever reported as a generic
 *     error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { MORPHO_VAULT_NOT_FOUND, MORPHO_VAULT_V1_DETAIL, MORPHO_VAULT_V2_DETAIL_GATED } from "./vault-fixtures.js";

const preview = vi.hoisted(() => vi.fn());
const executeDeposit = vi.hoisted(() => vi.fn());
const executeWithdraw = vi.hoisted(() => vi.fn());
const recordRefusal = vi.hoisted(() => vi.fn(async () => 1));
const evmClients = vi.hoisted(() => vi.fn());
const selectedAddress = vi.hoisted(() => vi.fn());
const signingWallet = vi.hoisted(() => vi.fn());

vi.mock("@tools/morpho/mutations.js", () => ({
  previewMorphoVaultOperation: preview,
  morphoActionsExtension: () => (client: unknown) => client,
}));

vi.mock("@tools/morpho/evm-client.js", () => ({
  getMorphoEvmClients: evmClients,
}));

// The wallet RESOLUTION is not what these cases are about: it has its own suite
// and its own failure taxonomy. Stubbing it keeps the assertions on the handler
// contract instead of on a fixture of the session inventory.
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: selectedAddress,
  resolveSigningWallet: signingWallet,
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : "wallet scope error",
  }),
}));

vi.mock(
  "../../../../../vex-agent/tools/protocols/morpho/handlers/signed-broadcast.js",
  () => ({
    executeMorphoVaultDeposit: executeDeposit,
    executeMorphoVaultWithdraw: executeWithdraw,
    recordMorphoRefusal: recordRefusal,
  }),
);

const { morphoVaultDeposit, morphoVaultWithdraw } = await import(
  "../../../../../vex-agent/tools/protocols/morpho/handlers/vault-execute.js"
);

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const PRIVATE_KEY = `0x${"11".repeat(32)}`;

let vaultSeq = 0;
let VAULT = "";
function nextVaultAddress(): string {
  vaultSeq += 1;
  return `0x${(vaultSeq + 0x5000).toString(16).padStart(40, "0")}`;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

/** Answer each outbound query by OPERATION NAME; the V2 probe runs before V1. */
function stubMorphoByOperation(bodies: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { query: string };
      const key = Object.keys(bodies).find((k) => sent.query.includes(k));
      return jsonResponse(key === undefined ? MORPHO_VAULT_NOT_FOUND : bodies[key]);
    }),
  );
}

/** A governance read that answers with an ordinary, ungated V1 vault. */
function stubHealthyGovernance(): void {
  stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_NOT_FOUND, VexMorphoVaultV1: MORPHO_VAULT_V1_DETAIL });
}

/** The live V2 capture, which carries a real deposit gate. */
function stubGatedGovernance(): void {
  stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_V2_DETAIL_GATED });
}

/** A governance read that cannot answer at all. */
function stubUnreachableGovernance(): void {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
}

function previewResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 8453,
    direction: "deposit",
    vault: {
      address: VAULT,
      name: "Steakhouse USDC",
      generation: "v1",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      assetSymbol: "USDC",
      assetDecimals: 6,
      shareDecimals: 18,
    },
    input: { raw: "1000000", decimals: 6, human: "1", symbol: "USDC" },
    expectedShares: { raw: "970000000000000000", decimals: 18, human: "0.97", symbol: null },
    sharePrice: { assetsPerShareRaw: "1030000", assetDecimals: 6, maxSharePriceRaw: "1", vexCeilingRaw: "2", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS, note: "n" },
    requirements: [
      { kind: "approval", token: "0x8335", spender: "0xadapter", spenderRole: "GeneralAdapter1", amountRaw: "1000000", explanation: "exact amount" },
    ],
    allowance: {
      shape: "approve",
      spender: "0xadapter",
      spenderRole: "GeneralAdapter1",
      currentAllowanceRaw: "0",
      requiredAmountRaw: "1000000",
      note: "allowance note",
    },
    bundle: { shape: "bundler3-multicall", to: "0xbundler", toRole: "bundler3", selector: "0x1", functionName: "multicall", valueRaw: "0", legs: [], maxSharePriceRaw: "1", verifiedAmountRaw: "1000000", verifiedRecipient: WALLET },
    bundleAllowlist: ["bundler3.multicall"],
    gas: { nodeEstimate: null, vexGasLimit: null, unavailableReason: "unknown", note: "gas note" },
    preflight: { verdict: "reverted", revertReason: "insufficient allowance", explanation: "the approval does not exist yet" },
    walletAddressUsed: WALLET,
    walletAddressWasSupplied: true,
    disclaimer: "THIS IS A PREVIEW.",
    ...overrides,
  };
}

/** A context whose wallet resolution yields one usable EVM signer. */
function context(overrides: Record<string, unknown> = {}) {
  return {
    sessionPermission: "full",
    approved: true,
    sessionId: "session-1",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...overrides,
  } as never;
}

function depositParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { vaultAddress: VAULT, chain: "base", depositAmountRaw: "1000000", ...overrides };
}

beforeEach(() => {
  VAULT = nextVaultAddress();
  preview.mockReset();
  executeDeposit.mockReset();
  executeWithdraw.mockReset();
  recordRefusal.mockClear();
  evmClients.mockReset();
  selectedAddress.mockReset();
  signingWallet.mockReset();
  selectedAddress.mockReturnValue(WALLET);
  signingWallet.mockReturnValue({ family: "eip155", address: WALLET, privateKey: PRIVATE_KEY });
  evmClients.mockReturnValue({
    publicClient: { extend: () => ({}) },
    walletClient: {},
  });
  preview.mockResolvedValue(previewResult());
  stubHealthyGovernance();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Input contract ────────────────────────────────────────────────────────

describe("the input contract refuses rather than substitutes", () => {
  it("refuses the WRONG direction's amount key BY NAME on a deposit", async () => {
    const result = await morphoVaultDeposit(
      { vaultAddress: VAULT, chain: "base", withdrawAmountRaw: "1000000" },
      context(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("withdrawAmountRaw");
    expect(result.output).toContain("morpho.vault.deposit");
    expect(executeDeposit).not.toHaveBeenCalled();
  });

  it("refuses the WRONG direction's amount key BY NAME on a withdrawal", async () => {
    const result = await morphoVaultWithdraw(
      { vaultAddress: VAULT, chain: "base", depositAmountRaw: "1000000" },
      context(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("depositAmountRaw");
    expect(executeWithdraw).not.toHaveBeenCalled();
  });

  it("refuses a human decimal amount rather than rounding it", async () => {
    const result = await morphoVaultDeposit(depositParams({ depositAmountRaw: "1.5" }), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("RAW base units");
    expect(executeDeposit).not.toHaveBeenCalled();
  });

  it("refuses a market id supplied where a vault address belongs, naming what it is", async () => {
    const result = await morphoVaultDeposit(
      depositParams({ vaultAddress: `0x${"a".repeat(64)}` }),
      context(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("MARKET id");
  });

  it("refuses a call with no session, because every attempt must be recorded against one", async () => {
    const result = await morphoVaultDeposit(depositParams(), context({ sessionId: undefined }));

    expect(result.success).toBe(false);
    expect(result.output).toContain("session");
    expect(executeDeposit).not.toHaveBeenCalled();
  });
});

// ── dryRun ────────────────────────────────────────────────────────────────

describe("dryRun previews everything and signs nothing", () => {
  it("returns the full preview including the allowance plan", async () => {
    const result = await morphoVaultDeposit(depositParams({ dryRun: true }), context());

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.allowancePlan).toMatchObject({ shape: "approve", spenderRole: "GeneralAdapter1" });
    expect(data.requirements).toHaveLength(1);
    expect(data.quote).toBeDefined();
  });

  it("builds no signing client and calls no execution path", async () => {
    await morphoVaultDeposit(depositParams({ dryRun: true }), context());

    expect(evmClients).not.toHaveBeenCalled();
    expect(executeDeposit).not.toHaveBeenCalled();
    expect(recordRefusal).not.toHaveBeenCalled();
  });

  it("states the two-transaction plan on a deposit and the single one on a withdrawal", async () => {
    const deposit = await morphoVaultDeposit(depositParams({ dryRun: true }), context());
    preview.mockResolvedValue(previewResult({ direction: "withdraw" }));
    const withdraw = await morphoVaultWithdraw(
      { vaultAddress: VAULT, chain: "base", withdrawAmountRaw: "1000000", dryRun: true },
      context(),
    );

    expect(String((deposit.data as Record<string, unknown>).plan)).toContain("TWO transactions");
    expect(String((withdraw.data as Record<string, unknown>).plan)).toContain("ONE transaction");
  });

  it("DEGRADES rather than refusing when the governance read cannot answer", async () => {
    stubUnreachableGovernance();

    const result = await morphoVaultDeposit(depositParams({ dryRun: true }), context());

    expect(result.success).toBe(true);
    const notes = (result.data as Record<string, Record<string, string>>).notes;
    expect(notes.gating).toContain("UNKNOWN");
  });
});

// ── Disclosure carry ──────────────────────────────────────────────────────

describe("the disclosure travels with the operation", () => {
  it("carries a V2 vault's withdrawal gate onto the preview", async () => {
    stubGatedGovernance();

    const result = await morphoVaultDeposit(depositParams({ dryRun: true }), context());

    const governance = (result.data as Record<string, Record<string, unknown>>).governance;
    expect(governance.status).toBe("read");
    expect(governance.depositGated).toBe(true);
  });

  it("DISCLOSES a gate rather than blocking on it", async () => {
    stubGatedGovernance();
    executeDeposit.mockResolvedValue({
      kind: "confirmed",
      executionId: 7,
      txHash: "0xabc",
      executed: { amountInRaw: "1000000", amountInHuman: "1", amountOutRaw: "97", amountOutHuman: "0.97" },
      shares: { withinApprovedBound: true, accrualDriftRaw: "0" },
      message: "Deposited 1 USDC.",
    });

    const result = await morphoVaultDeposit(depositParams(), context());

    expect(result.success).toBe(true);
    expect(executeDeposit).toHaveBeenCalled();
    const governance = (result.data as Record<string, Record<string, unknown>>).governance;
    expect(governance.depositGated).toBe(true);
  });

  it("FAILS CLOSED on the live path when the disclosure cannot be produced at all", async () => {
    stubUnreachableGovernance();

    const result = await morphoVaultDeposit(depositParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("NOTHING was signed");
    expect(executeDeposit).not.toHaveBeenCalled();
    expect(recordRefusal).toHaveBeenCalled();
  });
});

// ── Outcome mapping ───────────────────────────────────────────────────────

describe("all four execution endings are reported as themselves", () => {
  function confirmed() {
    return {
      kind: "confirmed",
      executionId: 11,
      txHash: "0xdeadbeef",
      executed: { amountInRaw: "1000000", amountInHuman: "1", amountOutRaw: "970000000000000000", amountOutHuman: "0.97" },
      shares: { withinApprovedBound: true, accrualDriftRaw: "42", approvedBoundRaw: "9", boundSide: "minimum_shares_received" },
      message: "morpho.vault.deposit: Deposited 1 USDC and received 0.97 shares. Tx: 0xdeadbeef.",
    };
  }

  it("reports a confirmed deposit with the PROVEN amounts and the bound verdict", async () => {
    executeDeposit.mockResolvedValue(confirmed());

    const result = await morphoVaultDeposit(depositParams(), context());

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("confirmed");
    expect(data.txHash).toBe("0xdeadbeef");
    expect(data.executed).toMatchObject({ amountOutHuman: "0.97" });
    expect(data.shares).toMatchObject({ withinApprovedBound: true, accrualDriftRaw: "42" });
  });

  it("labels the quoted-vs-settled difference as accrual drift rather than as a fault", async () => {
    executeDeposit.mockResolvedValue(confirmed());

    const result = await morphoVaultDeposit(depositParams(), context());

    const notes = (result.data as Record<string, Record<string, string>>).notes;
    expect(notes.accrualDrift).toContain("normal");
  });

  it("reports a refusal as a failure carrying the execution layer's own words", async () => {
    executeDeposit.mockResolvedValue({
      kind: "refused",
      executionId: 12,
      role: "allowance",
      message: "The approval was refused by the node: insufficient balance for gas.",
    });

    const result = await morphoVaultDeposit(depositParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("insufficient balance for gas");
    expect((result.data as Record<string, unknown>).status).toBe("refused");
  });

  it("reports a revert with its transaction hash, because the gas was really spent", async () => {
    executeDeposit.mockResolvedValue({
      kind: "reverted",
      executionId: 13,
      role: "lend_deposit",
      txHash: "0xrevert",
      message: "The deposit mined and reverted.",
    });

    const result = await morphoVaultDeposit(depositParams(), context());

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("reverted");
    expect(data.txHash).toBe("0xrevert");
  });

  it("reports an unproven broadcast with an explicit DO NOT RETRY", async () => {
    executeDeposit.mockResolvedValue({
      kind: "unproven",
      executionId: 14,
      role: "lend_deposit",
      reason: "ambiguous",
      txHash: "0xmaybe",
      message: "Cannot prove whether this broadcast landed. Do not retry; this attempt is recorded as pending and resolves automatically.",
    });

    const result = await morphoVaultDeposit(depositParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).toContain("Do not retry");
    expect((result.data as Record<string, unknown>).status).toBe("unproven");
  });

  it("names the REAL cause of a plan-time refusal instead of a generic error", async () => {
    executeDeposit.mockRejectedValue(new Error("the built transaction does not survive the decode"));

    const result = await morphoVaultDeposit(depositParams(), context());

    expect(result.success).toBe(false);
    expect(result.output).not.toContain("unexpected error");
    expect(result.output).toContain("No transaction was sent");
    expect(recordRefusal).toHaveBeenCalled();
  });

  it("routes a withdrawal through the WITHDRAW entry point and never the deposit one", async () => {
    executeWithdraw.mockResolvedValue({ ...confirmed(), executionId: 15 });

    await morphoVaultWithdraw(
      { vaultAddress: VAULT, chain: "base", withdrawAmountRaw: "1000000" },
      context(),
    );

    expect(executeWithdraw).toHaveBeenCalled();
    expect(executeDeposit).not.toHaveBeenCalled();
  });
});
