/**
 * Uniswap execute - post-buy delivery verification (Phase A1).
 *
 * The fallback venue settles from token Transfer logs exactly as Kyber does, so
 * it carries the SAME fake-transfer exposure the 2026-08-10 TOM incident
 * exercised on Robinhood Chain: a decodable settlement, a wallet balance of
 * zero, and an agent that retries the exit blind.
 *
 * Mock wiring mirrors `uniswap-tracked-token-pin.test.ts` (same handler, same
 * staged-broadcast doubles); the contract pinned here is the delivery check:
 * local chain + acquired ERC-20 only, verdict on an exact zero, silence on a
 * non-zero balance or a failed read, and never a failure of the swap result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";
import { readStandingInForTheParams } from "./_uniswap-approved-snapshot.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const TOKEN_IN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
const TOKEN_OUT = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const WALLET = "0x1111111111111111111111111111111111111111";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const readErc20Balance = vi.fn();
const readUniswapAllowance = vi.fn();
const signUniswapTransaction = vi.fn();
const broadcastUniswapTransaction = vi.fn();
const getLocalChain = vi.fn();
const createAgentActivityIntent = vi.fn();
const markActivityBroadcast = vi.fn();
const markBroadcastAccepted = vi.fn();
const confirmActivityEvent = vi.fn();
const decodeUniswapExecutedLegs = vi.fn();
const waitForSuccessfulReceipt = vi.fn();

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({ getHoneypotFotInfo: async () => ({ isHoneypot: false, isFOT: false, tax: 0 }) }),
}));
vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    weth: WETH,
    v2: { router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba" },
  })),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  // WP2-U: the quote and every leg's pre-sign gate read balances and price the
  // leg plan through this client. A SOLVENT default keeps each suite's own
  // subject the thing that decides its outcome.
  getUniswapPublicClient: vi.fn(() => uniswapSpendabilityFake()),
  getUniswapEvmClients: vi.fn(() => ({ publicClient: uniswapSpendabilityFake(), walletClient: {} })),
}));
vi.mock("@tools/uniswap/erc20.js", () => ({
  readUniswapErc20Metadata: vi.fn(async (_client: unknown, address: string) => ({
    address,
    symbol: "TKN",
    decimals: 18,
    isNative: false,
  })),
  validateUniswapSpender: vi.fn(),
  readUniswapAllowance: (...args: unknown[]) => readUniswapAllowance(...args),
}));
vi.mock("@tools/uniswap/quote.js", () => ({
  quoteBestRoute: vi.fn(async () => ({ route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: 10n } })),
  applySlippage: vi.fn((amount: bigint) => amount),
}));
// Spread over the REAL module so the refusal classes this venue throws
// (`UniswapFeeCapExceededError`, and the final-request refusal the loop
// re-throws by identity) are the real ones; the overrides below stay this
// suite's own seams.
vi.mock("@tools/uniswap/execute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/execute.js")>()),
  NATIVE_TOKEN_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  buildSwapTx: vi.fn(() => ({ to: "0xrouter", data: "0x", value: 0n })),
  buildApproveTx: vi.fn(() => ({ to: "0xtoken", data: "0x", value: 0n })),
  signUniswapTransaction: (...args: unknown[]) => signUniswapTransaction(...args),
  broadcastUniswapTransaction: (...args: unknown[]) => broadcastUniswapTransaction(...args),
}));
vi.mock("@tools/uniswap/safety.js", () => ({ checkRouteFactories: vi.fn(), probeFotSignal: vi.fn(), UNISWAP_MIN_LIQUIDITY_USD: 5000 }));
vi.mock("@tools/uniswap/receipt-decoder.js", () => ({
  decodeUniswapExecutedLegs: (...args: unknown[]) => decodeUniswapExecutedLegs(...args),
}));
vi.mock("@tools/uniswap/revert-mapping.js", () => ({
  classifyUniswapRevertError: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
  classifyPreBroadcastFailure: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
}));
// S11a: the quote-safety liquidity check reads through the `price-read`
// seam. An empty pool list keeps this suite's prior behaviour: the check
// finds no liquidity and the suite's subject is elsewhere.
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: vi.fn(async () => []),
}));
vi.mock("@tools/evm-chains/registry.js", () => ({ getLocalChain: (...args: unknown[]) => getLocalChain(...args) }));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({ ensureErc20Balance: vi.fn() }));
vi.mock("@tools/evm-chains/erc20-reads.js", () => ({
  ERC20_READ_ABI: [],
  readErc20Balance: (...args: unknown[]) => readErc20Balance(...args),
  readErc20Decimals: vi.fn(),
}));
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({
  waitForSuccessfulReceipt: (...args: unknown[]) => waitForSuccessfulReceipt(...args),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: vi.fn() }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => createAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: vi.fn(),
  markActivityBroadcast: (...args: unknown[]) => markActivityBroadcast(...args),
  markBroadcastAccepted: (...args: unknown[]) => markBroadcastAccepted(...args),
  confirmActivityEvent: (...args: unknown[]) => confirmActivityEvent(...args),
  failActivityEvent: vi.fn(),
  abortPlannedEvents: vi.fn(),
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

vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");

const context = {
  sessionPermission: "full",
  approved: true,
  sessionId: "session-1",
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
} as ProtocolExecutionContext;

function execute(params: Record<string, unknown>) {
  const handler = UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"];
  if (!handler) throw new Error("uniswap.swap.execute is not registered");
  return handler(params, context);
}

function buy() {
  return execute({ chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" });
}

const ZERO_VERDICT = "balanceOf returned zero immediately after the confirmed buy";

beforeEach(() => {
  vi.clearAllMocks();
  readUniswapExecutionSnapshot.mockImplementation(
    readStandingInForTheParams({ chainId: 4663, weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" }),
  );
  readUniswapAllowance.mockResolvedValue(10n ** 30n);
  signUniswapTransaction.mockResolvedValue({ serializedTransaction: "0xsigned", txHash: "0xhash", fromAddress: WALLET, nonce: 1 });
  broadcastUniswapTransaction.mockResolvedValue("0xhash");
  waitForSuccessfulReceipt.mockResolvedValue({ logs: [] });
  decodeUniswapExecutedLegs.mockReturnValue({ executedAmountInRaw: 1n, executedAmountOutRaw: 1n });
  createAgentActivityIntent.mockResolvedValue({
    executionId: 1,
    events: [{ id: 100, eventIndex: 0, eventRole: "swap" }],
  });
  markActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
  markBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  confirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  getLocalChain.mockReturnValue({ chainId: 4663 });
  readErc20Balance.mockResolvedValue(1n);
});

describe("Uniswap execute - post-buy delivery verification", () => {
  it("reads balanceOf for the ACQUIRED token and the buying wallet, once", async () => {
    await buy();

    expect(readErc20Balance).toHaveBeenCalledTimes(1);
    const call = readErc20Balance.mock.calls[0] ?? [];
    expect(call[1]).toBe(TOKEN_OUT);
    expect(call[2]).toBe(WALLET);
  });

  it("appends the zero-delivery verdict to a confirmed buy that delivered nothing", async () => {
    readErc20Balance.mockResolvedValue(0n);

    const result = await buy();

    expect(result.success).toBe(true);
    expect(result.output).toContain(ZERO_VERDICT);
    expect(result.output).toContain("do not retry the sale on this evidence");
  });

  it("says nothing when the wallet actually holds the acquired token", async () => {
    const result = await buy();

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(ZERO_VERDICT);
  });

  it("says nothing, and does not fail the swap, when the read itself fails", async () => {
    readErc20Balance.mockRejectedValue(new Error("rpc down"));

    const result = await buy();

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(ZERO_VERDICT);
  });

  it("still verifies delivery when the settlement was undecodable", async () => {
    decodeUniswapExecutedLegs.mockReturnValue({});
    readErc20Balance.mockResolvedValue(0n);

    const result = await buy();

    expect(result.success).toBe(true);
    expect(result.output).toContain(ZERO_VERDICT);
  });

  it("never reads for a NATIVE token-out leg (nothing was acquired as an ERC-20)", async () => {
    await execute({ chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: "native", amountIn: "1" });

    expect(readErc20Balance).not.toHaveBeenCalled();
  });

  it("never reads on a non-local chain", async () => {
    getLocalChain.mockReturnValue(undefined);

    await buy();

    expect(readErc20Balance).not.toHaveBeenCalled();
  });
});
