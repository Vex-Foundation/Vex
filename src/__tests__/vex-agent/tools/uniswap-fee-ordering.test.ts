/**
 * Vex's 25 bps fee on a Uniswap swap — ORDERING and ARITHMETIC, the two things
 * that decide whether a user can be charged for something that did not happen.
 *
 * `src/tools/bridge-fee/index.ts` states the rule for bridges and it is
 * identical here: "a bridge that fails at any point NEVER charges a fee for a
 * bridge that did not happen. The worst case is that Vex misses revenue — never
 * that the user pays for nothing. Do not reorder to fee-first."
 *
 * Written against the real handler rather than the fee modules, because the
 * ordering only exists in the composition: a fee module that is correct in
 * isolation and invoked one step too early is exactly the defect this file
 * exists to catch.
 */

import assert from "node:assert/strict";
import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readStandingInForTheParams } from "./_uniswap-approved-snapshot.js";
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex, type TransactionReceipt } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { makeProtocolContext } from "./_test-context.js";
import type { StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import { UNISWAP_FEE_RECEIVER_EVM } from "@tools/uniswap/fee/index.js";

const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const WALLET: Address = "0x1111111111111111111111111111111111111111";
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** 1 token at 18 decimals; 25 bps of it; and the remainder the router receives. */
const TOTAL = 1_000_000_000_000_000_000n;
const FEE = 2_500_000_000_000_000n;
const NET = TOTAL - FEE;

const ensureErc20Balance = vi.fn();
const readUniswapAllowance = vi.fn();
const signUniswapTransaction = vi.fn();
const broadcastUniswapTransaction = vi.fn();
const buildSwapTx = vi.fn();
const buildApproveTx = vi.fn();
const quoteBestRoute = vi.fn();
const createAgentActivityIntent = vi.fn();
const markActivityBroadcast = vi.fn();
const markBroadcastAccepted = vi.fn();
const confirmActivityEvent = vi.fn();
const failActivityEvent = vi.fn();
const abortPlannedEvents = vi.fn();
const waitForSuccessfulReceipt = vi.fn();
const getHoneypotFotInfo = vi.fn();
const signStageBroadcast = vi.fn();

/** Every `agent_activity` event the handler planned, in intent order. */
let plannedEvents: Array<{ eventRole: string; eventIndex: number; amountRaw?: string; tokenAddress?: string }> = [];
/** The transactions handed to the shared staged broadcaster (the FEE legs). */
let feeTxs: Array<{ to: string; data: Hex; value: bigint }> = [];

const FEE_TX_HASH: Hex = `0x${"fe".repeat(32)}`;

/** The last planned event — an empty plan is the test failure, not `undefined`. */
function lastPlannedEvent(): { eventRole: string; eventIndex: number; amountRaw?: string; tokenAddress?: string } {
  const event = plannedEvents.at(-1);
  assert.ok(event, "no events were planned");
  return event;
}

/** The `amountRaw` of the single planned event with `eventRole`. */
function plannedAmountRaw(eventRole: string): string {
  const event = plannedEvents.find((e) => e.eventRole === eventRole);
  assert.ok(event, `no planned event with role ${eventRole}`);
  assert.ok(event.amountRaw, `${eventRole} carries no amountRaw`);
  return event.amountRaw;
}

/** The one fee transaction handed to the staged broadcaster. */
function onlyFeeTx(): { to: string; data: Hex; value: bigint } {
  const [feeTx] = feeTxs;
  assert.ok(feeTx, "no fee transaction was staged");
  return feeTx;
}

/** The route-quote request of the most recent `quoteBestRoute` call. */
function lastRouteQuoteRequest(): { amountIn: bigint } {
  const call = quoteBestRoute.mock.calls.at(-1);
  assert.ok(call, "no route was quoted");
  return call[1] as { amountIn: bigint };
}

vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood", name: "Robinhood Chain", chainId: 4663, weth: WETH,
    v2: { router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba" },
  })),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  // WP2-U: the quote and every leg's pre-sign gate read balances and price the
  // leg plan through this client. A SOLVENT default keeps each suite's own
  // subject the thing that decides its outcome.
  getUniswapPublicClient: vi.fn(() => uniswapSpendabilityFake()),
  // ACCOUNT and CHAIN are present because production's type guarantees both and
  // the fee leg reads them to build its deferred signer (`fee/run.ts`).
  getUniswapEvmClients: vi.fn(() => ({
    publicClient: uniswapSpendabilityFake(),
    walletClient: { account: { address: WALLET, type: "local" }, chain: { id: 4663 } },
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
// Spread over the REAL module so the refusal classes this venue throws
// (`UniswapFeeCapExceededError`, and the final-request refusal the loop
// re-throws by identity) are the real ones; the overrides below stay this
// suite's own seams.
vi.mock("@tools/uniswap/execute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/execute.js")>()),
  NATIVE_TOKEN_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
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
  decodeUniswapExecutedLegs: vi.fn(() => ({ executedAmountInRaw: NET, executedAmountOutRaw: 10n })),
}));
vi.mock("@tools/uniswap/revert-mapping.js", () => ({
  classifyUniswapRevertError: vi.fn(() => ({ failureCode: "broadcast_error", failureReason: "boom" })),
  classifyPreBroadcastFailure: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
}));
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: vi.fn(async () => []),
}));
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: vi.fn(() => ({ getHoneypotFotInfo: (...a: unknown[]) => getHoneypotFotInfo(...a) })),
}));
vi.mock("@tools/evm-chains/registry.js", () => ({ getLocalChain: vi.fn(() => ({ chainId: 4663 })) }));
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
  createAgentActivityPreBroadcastFailure: vi.fn(async () => ({ executionId: 999, event: {} })),
  markActivityBroadcast: (...a: unknown[]) => markActivityBroadcast(...a),
  markBroadcastAccepted: (...a: unknown[]) => markBroadcastAccepted(...a),
  confirmActivityEvent: (...a: unknown[]) => confirmActivityEvent(...a),
  failActivityEvent: (...a: unknown[]) => failActivityEvent(...a),
  abortPlannedEvents: (...a: unknown[]) => abortPlannedEvents(...a),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: String(err) })),
}));
// The execute is bound to an APPROVED quote (2026-08-27 incident): it claims one
// before it prices anything. This suite's subject is elsewhere, so the claim
// stands in with the quote this very call would have produced - see
// `_uniswap-approved-snapshot.ts`.
const readUniswapExecutionSnapshot = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  commitPrequoteClaim: vi.fn(async () => ({ ok: true })),
  readSwapExecutionSnapshot: vi.fn(),
  readUniswapExecutionSnapshot: (...args: unknown[]) => readUniswapExecutionSnapshot(...args),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");
const execute = UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"];
const quote = UNISWAP_SWAP_HANDLERS["uniswap.swap.quote"];

const context: ProtocolExecutionContext = makeProtocolContext({
  sessionPermission: "full",
  approved: true,
  sessionId: "session-1",
});

const ERC20_PARAMS = { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" };
const NATIVE_PARAMS = { chain: "robinhood", tokenIn: "ETH", tokenOut: TOKEN_OUT, amountIn: "1" };

function feeOf(result: { data?: unknown }): {
  collection: string;
  collectionNote: string;
  txHash: string | null;
  disclosure: Record<string, unknown>;
} {
  return (result.data as { vexFee: { collection: string; collectionNote: string; txHash: string | null; disclosure: Record<string, unknown> } }).vexFee;
}

/** A complete `TransactionReceipt`; only `blockNumber` is read downstream. */
function feeReceipt(status: "success" | "reverted"): TransactionReceipt {
  return {
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: 2n,
    contractAddress: null,
    cumulativeGasUsed: 21_000n,
    effectiveGasPrice: 1n,
    from: WALLET,
    gasUsed: 21_000n,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    to: UNISWAP_FEE_RECEIVER_EVM,
    transactionHash: FEE_TX_HASH,
    transactionIndex: 0,
    type: "eip1559",
  };
}

function feeOutcome(kind: StagedBroadcastOutcome["kind"]): StagedBroadcastOutcome {
  if (kind === "confirmed") return { kind: "confirmed", txHash: FEE_TX_HASH, receipt: feeReceipt("success") };
  if (kind === "reverted") return { kind: "reverted", txHash: FEE_TX_HASH, receipt: feeReceipt("reverted") };
  return { kind: "ambiguous", txHash: FEE_TX_HASH, stage: "confirm", reason: "rpc timeout" };
}


/**
 * The router allowance this suite's quote saw, kept in step with what the
 * execute's own allowance read answers: since WP2-B the execute REFUSES a leg
 * set that is not the approved one, so `setAllowance` moves both together (a
 * real allowance change would have come with a fresh quote).
 */
let currentAllowance = 10n ** 30n;
function setAllowance(value: bigint): void {
  currentAllowance = value;
  readUniswapAllowance.mockResolvedValue(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  readUniswapExecutionSnapshot.mockImplementation(
    readStandingInForTheParams({
      chainId: 4663,
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currentAllowance: () => currentAllowance,
    }),
  );
  plannedEvents = [];
  feeTxs = [];
  ensureErc20Balance.mockResolvedValue(undefined);
  setAllowance(10n ** 30n);
  quoteBestRoute.mockResolvedValue({ route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: 10n } });
  buildSwapTx.mockReturnValue({ to: "0xrouter", data: "0x", value: 0n });
  buildApproveTx.mockReturnValue({ to: "0xtoken", data: "0x", value: 0n });
  signUniswapTransaction.mockResolvedValue({ serializedTransaction: "0xsigned", txHash: "0xswap", fromAddress: WALLET, nonce: 1 });
  broadcastUniswapTransaction.mockResolvedValue("0xswap");
  waitForSuccessfulReceipt.mockResolvedValue({ logs: [], blockNumber: 1n });
  getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
  createAgentActivityIntent.mockImplementation(
    async (input: { events: Array<{ eventRole: string; eventIndex: number; tokenIn?: { amountRaw?: string; tokenAddress?: string } }> }) => {
      plannedEvents = input.events.map((e) => ({
        eventRole: e.eventRole, eventIndex: e.eventIndex,
        ...(e.tokenIn?.amountRaw === undefined ? {} : { amountRaw: e.tokenIn.amountRaw }),
        ...(e.tokenIn?.tokenAddress === undefined ? {} : { tokenAddress: e.tokenIn.tokenAddress }),
      }));
      return { executionId: 7, events: input.events.map((e, i) => ({ id: 100 + i, eventIndex: e.eventIndex, eventRole: e.eventRole })) };
    },
  );
  markActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
  markBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  confirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  failActivityEvent.mockResolvedValue({ applied: true, row: {} });
  abortPlannedEvents.mockResolvedValue(undefined);
  signStageBroadcast.mockImplementation(
    async (_p: unknown, _w: unknown, tx: { to: string; data: Hex; value: bigint }, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
      feeTxs.push(tx);
      await hooks.onHashStaged({ txHash: "0xfee", fromAddress: WALLET, nonce: 2 });
      await hooks.onAccepted();
      return feeOutcome("confirmed");
    },
  );
});

describe("the fee leg is planned LAST and signed LAST", () => {
  it("plans a `swap_fee` row as the final event of the intent, before anything is signed", async () => {
    await execute(ERC20_PARAMS, context);

    expect(plannedEvents.map((e) => e.eventRole)).toEqual(["swap", "swap_fee"]);
    expect(lastPlannedEvent().eventIndex).toBe(plannedEvents.length - 1);
    // The intent exists before any signing happens.
    expect(createAgentActivityIntent).toHaveBeenCalledBefore(signUniswapTransaction);
  });

  it("splits the amount exactly: the swap row carries the NET, the fee row the fee, and they sum to the total", async () => {
    await execute(ERC20_PARAMS, context);

    const swapAmountRaw = plannedAmountRaw("swap");
    const feeAmountRaw = plannedAmountRaw("swap_fee");
    expect(BigInt(swapAmountRaw)).toBe(NET);
    expect(BigInt(feeAmountRaw)).toBe(FEE);
    expect(BigInt(swapAmountRaw) + BigInt(feeAmountRaw)).toBe(TOTAL);
  });

  it("quotes and swaps on `amountIn − fee`, while the balance guard demands the FULL amount", async () => {
    await execute(ERC20_PARAMS, context);

    expect(quoteBestRoute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountIn: NET }));
    expect(buildSwapTx).toHaveBeenCalledWith(expect.objectContaining({ amountIn: NET }));
    expect(ensureErc20Balance).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ required: TOTAL }));
  });

  it("signs the swap FIRST and the treasury transfer only after it confirmed", async () => {
    const result = await execute(ERC20_PARAMS, context);

    expect(broadcastUniswapTransaction).toHaveBeenCalledBefore(signStageBroadcast);
    expect(feeTxs).toHaveLength(1);
    // An ERC-20 fee is a `transfer` call on the INPUT token, never a value transfer.
    const feeTx = onlyFeeTx();
    expect(getAddress(feeTx.to)).toBe(TOKEN_IN);
    expect(feeTx.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), data: feeTx.data });
    expect(decoded.args).toEqual([UNISWAP_FEE_RECEIVER_EVM, FEE]);
    expect(result.success).toBe(true);
    expect(feeOf(result).collection).toBe("confirmed");
  });

  it("a NATIVE input pays the fee as a bare value transfer to the treasury (no calldata)", async () => {
    await execute(NATIVE_PARAMS, context);

    expect(feeTxs).toHaveLength(1);
    const feeTx = onlyFeeTx();
    expect(feeTx.to).toBe(UNISWAP_FEE_RECEIVER_EVM);
    expect(feeTx.value).toBe(FEE);
    expect(feeTx.data).toBe("0x");
    // The fee row's identity token is the shared native sentinel, never WETH:
    // the leg moves ETH the user never wrapped.
    expect(lastPlannedEvent().tokenAddress).toBe(NATIVE_SENTINEL);
  });
});

describe("a swap that did not definitively happen is NEVER charged", () => {
  it("a MINED REVERT never signs the fee and finalizes the fee row as never-attempted", async () => {
    const { VexError, ErrorCodes } = await import("../../../errors.js");
    waitForSuccessfulReceipt.mockRejectedValueOnce(new VexError(ErrorCodes.SWAP_FAILED, "reverted"));

    const result = await execute(ERC20_PARAMS, context);

    expect(result.success).toBe(false);
    expect(signStageBroadcast).not.toHaveBeenCalled();
    // Everything strictly after the swap leg — i.e. the fee row at index 1.
    expect(abortPlannedEvents).toHaveBeenCalledWith(7, 1, expect.stringContaining("reverted"));
  });

  it("an AMBIGUOUS swap never signs the fee either — an unknown outcome is not a confirmed one", async () => {
    broadcastUniswapTransaction.mockRejectedValueOnce(new Error("rpc rejected"));

    const result = await execute(ERC20_PARAMS, context);

    expect(result.success).toBe(false);
    expect(signStageBroadcast).not.toHaveBeenCalled();
    expect(abortPlannedEvents).toHaveBeenCalledWith(7, 1, expect.stringContaining("ambiguous"));
  });

  it("a PRE-SIGN refusal never signs the fee", async () => {
    signUniswapTransaction.mockRejectedValueOnce(new Error("estimate reverted"));

    const result = await execute(ERC20_PARAMS, context);

    expect(result.success).toBe(false);
    expect(signStageBroadcast).not.toHaveBeenCalled();
    expect(abortPlannedEvents).toHaveBeenCalledWith(7, 1, expect.anything());
  });
});

describe("a fee that fails NEVER touches the swap", () => {
  it("a REVERTED fee leaves the swap successful and says so, failing only the fee row", async () => {
    signStageBroadcast.mockImplementationOnce(async (_p: unknown, _w: unknown, tx: { to: string; data: Hex; value: bigint }) => {
      feeTxs.push(tx);
      return feeOutcome("reverted");
    });

    const result = await execute(ERC20_PARAMS, context);

    expect(result.success).toBe(true);
    expect(feeOf(result).collection).toBe("reverted");
    // Only the FEE row (id 101) was failed — the swap row (id 100) was confirmed.
    expect(failActivityEvent).toHaveBeenCalledTimes(1);
    expect(failActivityEvent).toHaveBeenCalledWith(101, expect.objectContaining({ failureCode: "mined_revert" }));
    expect(confirmActivityEvent).toHaveBeenCalledWith(100, expect.anything());
  });

  it("a REFUSED fee (nothing signed) leaves the swap successful and reports not_attempted", async () => {
    signStageBroadcast.mockRejectedValueOnce(new Error("gas estimate failed"));

    const result = await execute(ERC20_PARAMS, context);

    expect(result.success).toBe(true);
    expect(feeOf(result).collection).toBe("not_attempted");
    expect(failActivityEvent).not.toHaveBeenCalled();
  });

  it("an AMBIGUOUS fee is left pending and NEVER retried — a blind resend could charge twice", async () => {
    signStageBroadcast.mockImplementationOnce(async (_p: unknown, _w: unknown, tx: { to: string; data: Hex; value: bigint }, hooks: { onHashStaged: (h: unknown) => Promise<void> }) => {
      feeTxs.push(tx);
      await hooks.onHashStaged({ txHash: "0xfee", fromAddress: WALLET, nonce: 2 });
      return feeOutcome("ambiguous");
    });

    const result = await execute(ERC20_PARAMS, context);

    expect(result.success).toBe(true);
    expect(feeOf(result).collection).toBe("unconfirmed");
    expect(signStageBroadcast).toHaveBeenCalledTimes(1);
    expect(failActivityEvent).not.toHaveBeenCalled();
  });
});

/**
 * Codex final-review blocker 4. Once the swap has CONFIRMED on-chain, every
 * remaining fee/audit write is bookkeeping. A repository that throws is a
 * bookkeeping gap to disclose — never a licence to rewrite what the chain
 * already said.
 */
describe("post-confirmation bookkeeping can NEVER rewrite chain truth", () => {
  it("a fee-row audit cleanup that THROWS still reports the confirmed swap as successful, and discloses the gap", async () => {
    // A fee DOES apply, but the intent came back without the fee row — the
    // `feeRowId === null` cleanup path — and that cleanup write fails.
    createAgentActivityIntent.mockImplementation(async () => ({
      executionId: 7,
      events: [{ id: 100, eventIndex: 0, eventRole: "swap" }],
    }));
    abortPlannedEvents.mockRejectedValue(new Error("agent_activity: connection terminated"));

    const result = await execute(ERC20_PARAMS, context);

    // The parent swap is CONFIRMED. Its success is not the bookkeeper's to flip.
    expect(result.success).toBe(true);
    expect(feeOf(result).collection).toBe("not_attempted");
    // …and the report says the audit rows could not be finalized rather than
    // silently implying they were.
    expect(feeOf(result).collectionNote).toContain("could not be finalized");
    // Nothing was signed for a fee with no row to record it under.
    expect(signStageBroadcast).not.toHaveBeenCalled();
  });

  it("a revert-record write that THROWS leaves the outcome `reverted` WITH its known hash — never downgraded to not_attempted", async () => {
    signStageBroadcast.mockImplementationOnce(async (_p: unknown, _w: unknown, tx: { to: string; data: Hex; value: bigint }) => {
      feeTxs.push(tx);
      return feeOutcome("reverted");
    });
    failActivityEvent.mockRejectedValue(new Error("agent_activity: connection terminated"));

    const result = await execute(ERC20_PARAMS, context);

    expect(result.success).toBe(true);
    const fee = feeOf(result);
    // The receipt proved the revert and the hash. A failed DB write unsays neither.
    expect(fee.collection).toBe("reverted");
    expect(fee.txHash).toBe(FEE_TX_HASH);
    expect(failActivityEvent).toHaveBeenCalledWith(101, expect.objectContaining({ failureCode: "mined_revert" }));
  });
});

describe("when Vex declines the fee", () => {
  it("DUST: a fee that floors to zero has no leg, no row, and the swap runs on the full amount", async () => {
    const result = await execute({ ...ERC20_PARAMS, amountIn: "0.000000000000000001" }, context);

    expect(plannedEvents.map((e) => e.eventRole)).toEqual(["swap"]);
    expect(signStageBroadcast).not.toHaveBeenCalled();
    expect(quoteBestRoute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountIn: 1n }));
    expect(feeOf(result).collection).toBe("not_charged");
    expect(feeOf(result).disclosure.charged).toBe(false);
  });

  it("FEE-ON-TRANSFER input: the fee is declined WITH A STATED REASON and the swap runs on the FULL amount", async () => {
    getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: true, tax: 5 });

    const result = await execute(ERC20_PARAMS, context);

    expect(plannedEvents.map((e) => e.eventRole)).toEqual(["swap"]);
    expect(quoteBestRoute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountIn: TOTAL }));
    expect(result.success).toBe(true);
    expect(feeOf(result).disclosure.charged).toBe(false);
    expect(String(feeOf(result).disclosure.reason)).toContain("fee-on-transfer");
  });

  it("HONEYPOT input: same — declined by name, swap unaffected", async () => {
    getHoneypotFotInfo.mockResolvedValue({ isHoneypot: true, isFOT: false, tax: 0 });

    const result = await execute(ERC20_PARAMS, context);

    expect(plannedEvents.map((e) => e.eventRole)).toEqual(["swap"]);
    expect(String(feeOf(result).disclosure.reason)).toContain("honeypot");
  });
});

describe("quote / execute parity", () => {
  it("the quote prices the SAME net input and discloses the SAME fee the execute charges", async () => {
    const quoted = await quote(ERC20_PARAMS, context);
    const quotedFor = lastRouteQuoteRequest();
    const payload = JSON.parse(quoted.output) as {
      amountInRaw: string; swapAmountRaw: string;
      vexFee: { charged: boolean; feeAmountRaw: string; swappedAmountRaw: string; totalDebitedRaw: string; receiver: string };
    };

    expect(quotedFor.amountIn).toBe(NET);
    expect(payload.amountInRaw).toBe(TOTAL.toString());
    expect(payload.swapAmountRaw).toBe(NET.toString());
    expect(payload.vexFee).toMatchObject({
      charged: true,
      feeAmountRaw: FEE.toString(),
      swappedAmountRaw: NET.toString(),
      totalDebitedRaw: TOTAL.toString(),
      receiver: UNISWAP_FEE_RECEIVER_EVM,
    });

    vi.clearAllMocks();
    readUniswapExecutionSnapshot.mockImplementation(
      readStandingInForTheParams({
      chainId: 4663,
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currentAllowance: () => currentAllowance,
    }),
    );
    beforeEachDefaults();
    const executed = await execute(ERC20_PARAMS, context);
    const executedFor = lastRouteQuoteRequest();

    expect(executedFor.amountIn).toBe(quotedFor.amountIn);
    expect(feeOf(executed).disclosure).toEqual(payload.vexFee);
  });
});

describe("a caller-supplied fee parameter is rejected BY NAME", () => {
  for (const key of ["fee", "feeBps", "feeReceiver", "feeAmount"]) {
    it(`rejects "${key}" on the execute before anything is recorded or signed`, async () => {
      const result = await execute({ ...ERC20_PARAMS, [key]: 0 }, context);
      expect(result.success).toBe(false);
      expect(result.output).toContain(`"${key}"`);
      expect(createAgentActivityIntent).not.toHaveBeenCalled();
      expect(signUniswapTransaction).not.toHaveBeenCalled();
    });

    it(`rejects "${key}" on the quote too, so no quote can appear to authorize it`, async () => {
      const result = await quote({ ...ERC20_PARAMS, [key]: 0 }, context);
      expect(result.success).toBe(false);
      expect(result.output).toContain(`"${key}"`);
      expect(quoteBestRoute).not.toHaveBeenCalled();
    });
  }

  it("rejects a fee param even when it carries `undefined` — presence is the violation", async () => {
    const result = await execute({ ...ERC20_PARAMS, feeReceiver: undefined }, context);
    expect(result.success).toBe(false);
    expect(result.output).toContain('"feeReceiver"');
  });
});

/** Re-arm the mocks the parity test clears mid-way through its own assertions. */
function beforeEachDefaults(): void {
  ensureErc20Balance.mockResolvedValue(undefined);
  setAllowance(10n ** 30n);
  quoteBestRoute.mockResolvedValue({ route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: 10n } });
  buildSwapTx.mockReturnValue({ to: "0xrouter", data: "0x", value: 0n });
  signUniswapTransaction.mockResolvedValue({ serializedTransaction: "0xsigned", txHash: "0xswap", fromAddress: WALLET, nonce: 1 });
  broadcastUniswapTransaction.mockResolvedValue("0xswap");
  waitForSuccessfulReceipt.mockResolvedValue({ logs: [], blockNumber: 1n });
  getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
  createAgentActivityIntent.mockImplementation(async (input: { events: Array<{ eventRole: string; eventIndex: number }> }) => ({
    executionId: 7, events: input.events.map((e, i) => ({ id: 100 + i, eventIndex: e.eventIndex, eventRole: e.eventRole })),
  }));
  markActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
  markBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  confirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  signStageBroadcast.mockImplementation(async (_p: unknown, _w: unknown, _tx: unknown, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
    await hooks.onHashStaged({ txHash: "0xfee", fromAddress: WALLET, nonce: 2 });
    await hooks.onAccepted();
    return feeOutcome("confirmed");
  });
}
