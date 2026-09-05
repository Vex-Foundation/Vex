/**
 * `uniswap.swap.execute` holds its fee to the statement the CARD made, before
 * any key is touched.
 *
 * ## What this adds to the binding already in place
 *
 * The execution SNAPSHOT already carries a fee disposition and amount, and
 * `compareUniswapExecutionInputs` already refuses when the execute's fresh
 * derivation disagrees with it. That is the trade's own binding, sealed in
 * `route_ref` and digest-checked at the claim.
 *
 * The row's `safety_detail.vexFee` block is a DIFFERENT authority: it is what
 * the approval card rendered, what the row-disclosure digest covers, and what
 * the human actually read. It also carries figures the snapshot's fee does not
 * carry at all - the rate, the treasury RECEIVER, the amount routed and the
 * total debited - so a fee paid to another address, or a rate that moved, is
 * invisible to the snapshot comparison and visible here.
 *
 * The scenario below is the one where the two records disagree: the snapshot
 * says the fee was declined (the token is fee-on-transfer, as this execute's own
 * oracle read now says too), while the block the card was built from says a fee
 * IS taken. The trade-level comparison passes - both sides agree the fee is
 * declined - and the card-level one refuses, which is the whole point of having
 * it.
 *
 * ## How "before signing" is proved
 *
 * Not by the result's wording: by the signer fakes. `signUniswapTransaction`
 * signs the allowance and swap legs, `signStageBroadcast` signs the fee leg,
 * and `createAgentActivityIntent` is the durable row every signature is
 * recorded against. A refusal that reached any of them would not be a pre-sign
 * refusal, whatever it said.
 */

import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { makeProtocolContext } from "./_test-context.js";

const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const WALLET: Address = "0x1111111111111111111111111111111111111111";
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const CHAIN_ID = 4663;

/** 1 token at 18 decimals - the amount every case in this file swaps. */
const AMOUNT_IN_HUMAN = "1";
const AMOUNT_IN_RAW = 1_000_000_000_000_000_000n;
const QUOTED_OUT = 10n;

const ensureErc20Balance = vi.fn();
const readUniswapAllowance = vi.fn();
const signUniswapTransaction = vi.fn();
const broadcastUniswapTransaction = vi.fn();
const buildSwapTx = vi.fn();
const buildApproveTx = vi.fn();
const quoteBestRoute = vi.fn();
const createAgentActivityIntent = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();
const waitForSuccessfulReceipt = vi.fn();
const getHoneypotFotInfo = vi.fn();
const signStageBroadcast = vi.fn();
const readUniswapExecutionSnapshot = vi.fn();
const commitPrequoteClaim = vi.fn();

vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood", name: "Robinhood Chain", chainId: CHAIN_ID, weth: WETH,
    v2: { router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba" },
  })),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: vi.fn(() => uniswapSpendabilityFake()),
  getUniswapEvmClients: vi.fn(() => ({
    publicClient: uniswapSpendabilityFake(),
    walletClient: { account: { address: WALLET, type: "local" }, chain: { id: CHAIN_ID } },
  })),
}));
vi.mock("@tools/uniswap/erc20.js", () => ({
  readUniswapErc20Metadata: vi.fn(async (_c: unknown, address: string) => ({
    address, symbol: "TKN", decimals: 18, isNative: false,
  })),
  validateUniswapSpender: vi.fn(),
  readUniswapAllowance: (...a: unknown[]) => readUniswapAllowance(...a),
}));
vi.mock("@tools/uniswap/quote.js", () => ({
  quoteBestRoute: (...a: unknown[]) => quoteBestRoute(...a),
  applySlippage: vi.fn((amount: bigint) => amount),
}));
vi.mock("@tools/uniswap/execute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/execute.js")>()),
  buildSwapTx: (...a: unknown[]) => buildSwapTx(...a),
  buildApproveTx: (...a: unknown[]) => buildApproveTx(...a),
  signUniswapTransaction: (...a: unknown[]) => signUniswapTransaction(...a),
  broadcastUniswapTransaction: (...a: unknown[]) => broadcastUniswapTransaction(...a),
}));
vi.mock("@tools/uniswap/safety.js", () => ({
  checkRouteFactories: vi.fn(async () => ({ checked: true, allowlisted: true })),
  probeFotSignal: vi.fn(async () => false),
  UNISWAP_MIN_LIQUIDITY_USD: 5000,
}));
vi.mock("@tools/uniswap/receipt-decoder.js", () => ({
  decodeUniswapExecutedLegs: vi.fn(() => ({ executedAmountInRaw: 1n, executedAmountOutRaw: 1n })),
}));
vi.mock("@tools/uniswap/revert-mapping.js", () => ({
  classifyUniswapRevertError: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
  classifyPreBroadcastFailure: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
}));
vi.mock("@tools/dexscreener/price-read.js", () => ({ readTokensPairs: vi.fn(async () => []) }));
// The eligibility oracle: the ONE input that can flip the fee disposition
// between the quote and the click, which is the divergence this file drives.
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: vi.fn(() => ({ getHoneypotFotInfo: (...a: unknown[]) => getHoneypotFotInfo(...a) })),
}));
vi.mock("@tools/evm-chains/registry.js", () => ({ getLocalChain: vi.fn(() => ({ chainId: CHAIN_ID })) }));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...a: unknown[]) => ensureErc20Balance(...a),
}));
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({
  waitForSuccessfulReceipt: (...a: unknown[]) => waitForSuccessfulReceipt(...a),
}));
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: (...a: unknown[]) => signStageBroadcast(...a),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: vi.fn(async () => ({ inserted: true })) }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...a: unknown[]) => createAgentActivityIntent(...a),
  createAgentActivityPreBroadcastFailure: (...a: unknown[]) => createAgentActivityPreBroadcastFailure(...a),
  markActivityBroadcast: vi.fn(async () => ({ applied: true, row: {} })),
  markBroadcastAccepted: vi.fn(async () => ({ applied: true, row: {} })),
  confirmActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  failActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  abortPlannedEvents: vi.fn(async () => undefined),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: String(err) })),
}));
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  commitPrequoteClaim: (...a: unknown[]) => commitPrequoteClaim(...a),
  readSwapExecutionSnapshot: vi.fn(),
  readUniswapExecutionSnapshot: (...a: unknown[]) => readUniswapExecutionSnapshot(...a),
}));
vi.mock("@utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");
const { approvedUniswapSnapshot, approvedUniswapVexFee } = await import("./_uniswap-approved-snapshot.js");
const { toVexFeePreview } = await import("@vex-agent/tools/protocols/prequote/fee-disclosure.js");
const { UNISWAP_FEE_RECEIVER_EVM } = await import("@tools/uniswap/fee/index.js");

const execute = UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"];
if (execute === undefined) throw new Error("uniswap.swap.execute is not registered");

const context: ProtocolExecutionContext = makeProtocolContext({
  sessionPermission: "full", approved: true, sessionId: "session-1",
});

const TOKEN_IN_LEG = { address: TOKEN_IN, symbol: "TKN", decimals: 18, isNative: false } as const;
const TOKEN_OUT_LEG = { address: TOKEN_OUT, symbol: "TKN", decimals: 18, isNative: false } as const;

const SNAPSHOT_INPUT = {
  chainId: CHAIN_ID,
  tokenIn: TOKEN_IN_LEG,
  tokenOut: TOKEN_OUT_LEG,
  amountInRaw: AMOUNT_IN_RAW,
  approvedAmountOutRaw: QUOTED_OUT,
  approvedMinOutRaw: QUOTED_OUT,
} as const;

/** A clean token: the oracle declines nothing, so the fee is charged. */
function oracleSaysClean(): void {
  getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
}

/** A taxing token: the fee is declined, because a transfer would under-deliver. */
function oracleSaysFeeOnTransfer(): void {
  getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: true, tax: 5 });
}

/**
 * The ticket the read hands to the claim. Its contents are the repository's
 * business; what this file asserts is WHETHER the claim is reached at all.
 */
const CLAIM_TICKET = {
  sessionId: "session-1",
  prequoteId: "prequote-fee",
  matchHash: "h".repeat(64),
  kind: "swap" as const,
  expectedDisclosure: {},
  freshQuoteTool: "uniswap__swap_quote",
};

/**
 * Build a snapshot and a fee block under the eligibility the callback installs,
 * then restore the oracle the execute itself will read.
 *
 * The two halves of a claimed row are built SEPARATELY on purpose: this file's
 * subject is what happens when they disagree, and a helper that always derived
 * both from one oracle read could not express that state at all.
 */
async function claimedRow(input: {
  readonly snapshotUnder: () => void;
  readonly blockUnder: () => void;
  readonly executeUnder: () => void;
}) {
  input.snapshotUnder();
  const snapshot = await approvedUniswapSnapshot(SNAPSHOT_INPUT);
  input.blockUnder();
  const vexFee = await approvedUniswapVexFee(SNAPSHOT_INPUT);
  input.executeUnder();
  return { ok: true as const, prequoteId: "prequote-fee", snapshot, vexFee, claim: CLAIM_TICKET };
}

function run() {
  return execute(
    { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN },
    context,
  );
}

/** Nothing was signed, and no durable execution was opened to sign against. */
function expectNothingSigned(): void {
  expect(signUniswapTransaction).not.toHaveBeenCalled();
  expect(signStageBroadcast).not.toHaveBeenCalled();
  expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
  expect(createAgentActivityIntent).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  commitPrequoteClaim.mockResolvedValue({ ok: true });
  oracleSaysClean();
  // A router allowance already in place, so the plan is swap plus fee leg and no
  // allowance leg is needed. The allowance case is covered by its own suite; the
  // signer assertions below cover both legs regardless.
  readUniswapAllowance.mockResolvedValue(10n ** 30n);
  ensureErc20Balance.mockResolvedValue(undefined);
  quoteBestRoute.mockResolvedValue({
    route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: QUOTED_OUT },
    priceImpact: 0.001,
  });
  buildSwapTx.mockReturnValue({ to: "0xrouter", data: "0x", value: 0n });
  buildApproveTx.mockReturnValue({ to: "0xtoken", data: "0x", value: 0n });
  signUniswapTransaction.mockResolvedValue({
    serializedTransaction: "0xsigned", txHash: "0xswap", fromAddress: WALLET, nonce: 1,
  });
  broadcastUniswapTransaction.mockResolvedValue("0xswap");
  waitForSuccessfulReceipt.mockResolvedValue({ logs: [], blockNumber: 1n });
  signStageBroadcast.mockResolvedValue({
    kind: "confirmed", txHash: `0x${"fe".repeat(32)}` as Hex, receipt: { blockNumber: 2n, logs: [] },
  });
  createAgentActivityIntent.mockResolvedValue({
    executionId: 1,
    events: [
      { id: 100, eventIndex: 0, eventRole: "swap" },
      { id: 101, eventIndex: 1, eventRole: "swap_fee" },
    ],
  });
  createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 999, event: {} });
});

describe("the fee statement the card made is re-checked before signing", () => {
  it("refuses when the row's block says a fee is charged and this execute declines it", async () => {
    // The card said "Vex takes 0.0025 TKN". By execute time the oracle calls the
    // token fee-on-transfer, so this execute would swap the FULL amount and take
    // nothing. The snapshot agrees with the execute, so the trade-level binding
    // passes; the card-level one does not.
    readUniswapExecutionSnapshot.mockResolvedValue(
      await claimedRow({
        snapshotUnder: oracleSaysFeeOnTransfer,
        blockUnder: oracleSaysClean,
        executeUnder: oracleSaysFeeOnTransfer,
      }),
    );

    const result = await run();

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(result.output).toContain("Refused before signing");
    expect(result.output).toContain("whether a Vex fee is taken at all");
    expect(result.output).toContain("uniswap__swap_quote");
  });

  it("refuses when the row's block names a treasury this execute would not pay", async () => {
    // The snapshot's fee carries a disposition and an amount but no RECEIVER, so
    // a redirected fee is invisible to it. This is the check that sees it.
    const snapshot = await approvedUniswapSnapshot(SNAPSHOT_INPUT);
    const honest = await approvedUniswapVexFee(SNAPSHOT_INPUT);
    const redirected = toVexFeePreview("uniswap.swap.quote", {
      ...honest,
      swappedAmountRaw: honest.netAmountRaw,
      receiver: "0x9999999999999999999999999999999999999999",
    });
    if (redirected === undefined) throw new Error("the redirected block must still project");
    readUniswapExecutionSnapshot.mockResolvedValue({
      ok: true, prequoteId: "prequote-fee", snapshot, vexFee: redirected, claim: CLAIM_TICKET,
    });

    const result = await run();

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(result.output).toContain("the address the fee is paid to");
    // The refusal names the figure, never the address itself.
    expect(result.output).not.toContain("0x9999999999999999999999999999999999999999");
    expect(result.output).not.toContain(UNISWAP_FEE_RECEIVER_EVM);
  });

  it("fails closed when the claimed row carries no fee statement at all", async () => {
    // The gate refuses a fee-bearing execute in this state, so reaching the
    // executor means the gate was bypassed. It signs nothing either way.
    readUniswapExecutionSnapshot.mockResolvedValue({
      ok: true,
      prequoteId: "prequote-fee",
      snapshot: await approvedUniswapSnapshot(SNAPSHOT_INPUT),
      vexFee: undefined,
      claim: CLAIM_TICKET,
    });

    const result = await run();

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(result.output).toContain("the approved quote states no Vex fee at all");
  });

  it("executes when the statement still holds - the check is not a blanket refusal", async () => {
    readUniswapExecutionSnapshot.mockResolvedValue(
      await claimedRow({
        snapshotUnder: oracleSaysClean,
        blockUnder: oracleSaysClean,
        executeUnder: oracleSaysClean,
      }),
    );

    const result = await run();

    expect(result.success, `handler output: ${result.output}`).toBe(true);
    expect(createAgentActivityIntent).toHaveBeenCalledTimes(1);
    expect(signUniswapTransaction).toHaveBeenCalled();
  });

  it("executes a genuinely fee-free trade when the card said the fee was declined", async () => {
    // The mirror of the first case, and the reason `charged` is compared in both
    // directions: a quote that honestly disclosed no fee must still execute.
    readUniswapExecutionSnapshot.mockResolvedValue(
      await claimedRow({
        snapshotUnder: oracleSaysFeeOnTransfer,
        blockUnder: oracleSaysFeeOnTransfer,
        executeUnder: oracleSaysFeeOnTransfer,
      }),
    );

    const result = await run();

    expect(result.success, `handler output: ${result.output}`).toBe(true);
    expect(signStageBroadcast).not.toHaveBeenCalled();
  });
});

/**
 * a divergence must not burn the approved quote.
 *
 * Before the fix the handler claimed the row before it had re-derived anything,
 * so a refusal here spent the quote on the way out and the retry the refusal
 * instructed the agent to make got `already_claimed`. The claim is now a
 * separate, later call, and these cases prove it is never reached on a
 * divergence - which is what makes "request a fresh quote" a real remedy.
 */
describe("a refused execute leaves the approved quote unconsumed", () => {
  it("does not claim the row when the card's fee statement no longer holds", async () => {
    readUniswapExecutionSnapshot.mockResolvedValue(
      await claimedRow({
        snapshotUnder: oracleSaysFeeOnTransfer,
        blockUnder: oracleSaysClean,
        executeUnder: oracleSaysFeeOnTransfer,
      }),
    );

    const result = await run();

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(commitPrequoteClaim).not.toHaveBeenCalled();
  });

  it("does not claim the row when the approved quote carries no fee statement", async () => {
    readUniswapExecutionSnapshot.mockResolvedValue({
      ok: true,
      prequoteId: "prequote-fee",
      snapshot: await approvedUniswapSnapshot(SNAPSHOT_INPUT),
      vexFee: undefined,
      claim: CLAIM_TICKET,
    });

    await run();

    expect(commitPrequoteClaim).not.toHaveBeenCalled();
  });

  it("claims the row that was read, once, when every comparison passes", async () => {
    readUniswapExecutionSnapshot.mockResolvedValue(
      await claimedRow({
        snapshotUnder: oracleSaysClean,
        blockUnder: oracleSaysClean,
        executeUnder: oracleSaysClean,
      }),
    );

    const result = await run();

    expect(result.success, `handler output: ${result.output}`).toBe(true);
    expect(commitPrequoteClaim).toHaveBeenCalledTimes(1);
    const [ticket, claimedBy] = commitPrequoteClaim.mock.calls[0] as [typeof CLAIM_TICKET, string];
    expect(ticket).toBe(CLAIM_TICKET);
    expect(claimedBy).toContain("uniswap.swap.execute");
  });

  it("refuses without signing when a concurrent execute won the same row", async () => {
    // The one state where "already claimed" is the truth: the comparison passed
    // and another execute took the row first. The signing wallet is resolved
    // only after this point, so nothing is signed either.
    readUniswapExecutionSnapshot.mockResolvedValue(
      await claimedRow({
        snapshotUnder: oracleSaysClean,
        blockUnder: oracleSaysClean,
        executeUnder: oracleSaysClean,
      }),
    );
    commitPrequoteClaim.mockResolvedValue({
      ok: false,
      refusal: { kind: "already_claimed", message: "Refused before signing: this quote has already been claimed." },
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.output).toContain("already been claimed");
    expectNothingSigned();
  });
});

/**
 * The typed reason must reach the RESULT, not only the log line: an agent that
 * reads "uniswap.swap.execute failed" cannot tell a moved fee statement from any
 * other swap failure, and the two have different remedies.
 */
describe("the typed refusal reason reaches the tool result", () => {
  function refusalOf(result: { readonly data?: Record<string, unknown> }): Record<string, unknown> {
    const block = result.data?._vexFeeRefusal;
    if (block === undefined || block === null || typeof block !== "object") {
      throw new Error("expected the result to carry a typed _vexFeeRefusal block");
    }
    return block as Record<string, unknown>;
  }

  it("carries `vex_fee_statement_changed` and the fields that moved", async () => {
    readUniswapExecutionSnapshot.mockResolvedValue(
      await claimedRow({
        snapshotUnder: oracleSaysFeeOnTransfer,
        blockUnder: oracleSaysClean,
        executeUnder: oracleSaysFeeOnTransfer,
      }),
    );

    const refusal = refusalOf(await run());

    expect(refusal.reason).toBe("vex_fee_statement_changed");
    expect(refusal.movedFields).toContain("charged");
    expect(String(refusal.remediation)).toContain("uniswap__swap_quote");
  });

  it("carries `vex_fee_statement_missing` when the approved quote states no fee", async () => {
    readUniswapExecutionSnapshot.mockResolvedValue({
      ok: true,
      prequoteId: "prequote-fee",
      snapshot: await approvedUniswapSnapshot(SNAPSHOT_INPUT),
      vexFee: undefined,
      claim: CLAIM_TICKET,
    });

    expect(refusalOf(await run()).reason).toBe("vex_fee_statement_missing");
  });

  it("never leaks an address into the typed block", async () => {
    const snapshot = await approvedUniswapSnapshot(SNAPSHOT_INPUT);
    const honest = await approvedUniswapVexFee(SNAPSHOT_INPUT);
    const redirected = toVexFeePreview("uniswap.swap.quote", {
      ...honest,
      swappedAmountRaw: honest.netAmountRaw,
      receiver: "0x9999999999999999999999999999999999999999",
    });
    if (redirected === undefined) throw new Error("the redirected block must still project");
    readUniswapExecutionSnapshot.mockResolvedValue({
      ok: true, prequoteId: "prequote-fee", snapshot, vexFee: redirected, claim: CLAIM_TICKET,
    });

    expect(JSON.stringify(refusalOf(await run()))).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

/**
 * PIN, DO NOT RE-DERIVE (fixed decision 2026-09-04, recorded beside
 * `vexFeePreviewSchema`).
 *
 * The Vex fee transfer is the LAST leg: it is signed after the swap has already
 * confirmed. The approved statement is its authority there, so a token the
 * oracle flags in that window changes nothing about what is signed, and nothing
 * on the path can raise the fee above the statement.
 */
describe("the fee leg signs exactly the approved statement", () => {
  it("signs the approved amount and receiver even when eligibility flips after the swap confirms", async () => {
    readUniswapExecutionSnapshot.mockResolvedValue(
      await claimedRow({
        snapshotUnder: oracleSaysClean,
        blockUnder: oracleSaysClean,
        executeUnder: oracleSaysClean,
      }),
    );
    // The statement the card made, captured before the oracle turns.
    oracleSaysClean();
    const approved = await approvedUniswapVexFee(SNAPSHOT_INPUT);
    if (!approved.charged) throw new Error("this arrangement must state a charged fee");
    // The oracle turns hostile the moment the swap leg confirms - the exact
    // window a late re-derivation would read.
    signUniswapTransaction.mockImplementation(async () => {
      oracleSaysFeeOnTransfer();
      return { serializedTransaction: "0xsigned", txHash: "0xswap", fromAddress: WALLET, nonce: 1 };
    });

    const result = await run();
    expect(result.success, `handler output: ${result.output}`).toBe(true);

    // The fee leg is signed through the staged broadcaster, exactly once.
    expect(signStageBroadcast).toHaveBeenCalledTimes(1);
    const feeCall = signStageBroadcast.mock.calls[0];
    if (feeCall === undefined) throw new Error("the fee leg must have been signed");
    const request = feeCall[2] as { readonly to: string; readonly data: string };
    const feeHex = BigInt(approved.feeAmountRaw).toString(16).padStart(64, "0");
    expect(request.data.toLowerCase().endsWith(feeHex)).toBe(true);
    expect(request.data.toLowerCase()).toContain(UNISWAP_FEE_RECEIVER_EVM.slice(2).toLowerCase());
    expect(request.to.toLowerCase()).toBe(TOKEN_IN.toLowerCase());
  });
});
