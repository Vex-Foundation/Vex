/**
 * Uniswap execute — tracked-token auto-pin (target contract; W0 gap-fill,
 * narrowed by Codex spine-review round 1 finding 15).
 *
 * `relay-bridge-capture.test.ts` already pins the relay.bridge auto-pin
 * contract in full. The Uniswap execute handler calls the SAME
 * `pinTrackedToken` primitive when a swap lands on a LOCAL chain (plan §4.2:
 * "New unified handlers explicitly `pinTrackedToken` on ACQUIRED ERC-20s"),
 * but no existing suite asserted it.
 *
 * FIX-W0 delta (finding 15): pins ONLY the acquired token-OUT leg — the
 * input leg is SPENT, not something the wallet newly holds, so pinning it is
 * unneeded bookkeeping.
 *
 * W2b delta (File→owner index, Codex turn-5 conflict resolution): the buy/
 * sell split is gone (plan §4.2/§11.2 — one unified `uniswap.swap.execute`).
 * Mock WIRING below targets that single handler and its staged-broadcast
 * dependencies (agent_activity intent/CAS, settlement decoder registration,
 * reveal clear) — the PINNED CONTRACT itself (pin only the acquired
 * token-out; native legs pin nothing on that side; local-chain gate;
 * fail-soft) is unchanged from the W0 original.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";
import { claimStandingInForTheParams } from "./_uniswap-approved-snapshot.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const TOKEN_IN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
const TOKEN_OUT = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const WALLET = "0x1111111111111111111111111111111111111111";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const ensureErc20Balance = vi.fn();
const readUniswapAllowance = vi.fn();
const signUniswapTransaction = vi.fn();
const broadcastUniswapTransaction = vi.fn();
const pinTrackedToken = vi.fn();
const getLocalChain = vi.fn();
const createAgentActivityIntent = vi.fn();
const markActivityBroadcast = vi.fn();
const markBroadcastAccepted = vi.fn();
const confirmActivityEvent = vi.fn();
const failActivityEvent = vi.fn();
const decodeUniswapExecutedLegs = vi.fn();
const clearUniswapPairReveal = vi.fn();
const waitForSuccessfulReceipt = vi.fn();
const abortPlannedEvents = vi.fn();

// The fee-eligibility oracle (migration 066's `swap_fee` leg) is a token fact,
// never a live network call in a unit test.
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
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...args: unknown[]) => ensureErc20Balance(...args),
}));
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({
  waitForSuccessfulReceipt: (...args: unknown[]) => waitForSuccessfulReceipt(...args),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: (...args: unknown[]) => pinTrackedToken(...args) }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => createAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: vi.fn(),
  markActivityBroadcast: (...args: unknown[]) => markActivityBroadcast(...args),
  markBroadcastAccepted: (...args: unknown[]) => markBroadcastAccepted(...args),
  confirmActivityEvent: (...args: unknown[]) => confirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => failActivityEvent(...args),
  abortPlannedEvents: (...args: unknown[]) => abortPlannedEvents(...args),
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
const claimUniswapExecutionSnapshot = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimSwapExecutionSnapshot: vi.fn(),
  claimUniswapExecutionSnapshot: (...args: unknown[]) => claimUniswapExecutionSnapshot(...args),
}));

vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");

const context = {
  sessionPermission: "full",
  approved: true,
  sessionId: "session-1",
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
} as unknown as ProtocolExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  claimUniswapExecutionSnapshot.mockImplementation(
    claimStandingInForTheParams({ chainId: 4663, weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" }),
  );
  ensureErc20Balance.mockResolvedValue(undefined);
  readUniswapAllowance.mockResolvedValue(10n ** 30n); // sufficient — no allowance events planned
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
  pinTrackedToken.mockResolvedValue({ inserted: true });
  getLocalChain.mockReturnValue({ chainId: 4663 });
  abortPlannedEvents.mockResolvedValue(undefined);
});

describe("Uniswap execute — auto-pin on a LOCAL chain", () => {
  it("pins ONLY the acquired token-OUT leg — the spent token-IN is never pinned", async () => {
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(result.success).toBe(true);
    expect(pinTrackedToken).toHaveBeenCalledTimes(1);
    expect(pinTrackedToken).toHaveBeenCalledWith({
      walletAddress: WALLET, chainId: 4663, tokenAddress: TOKEN_OUT, source: "swap",
    });
    expect(pinTrackedToken).not.toHaveBeenCalledWith(
      expect.objectContaining({ tokenAddress: TOKEN_IN }),
    );
  });

  it("pins even when settlement decoding returns nothing (confirmed_pending_amounts) — Codex round-4 finding 3", async () => {
    decodeUniswapExecutedLegs.mockReturnValue({});
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(result.success).toBe(true);
    expect((result.data as { status?: string })?.status).toBe("confirmed_pending_amounts");
    expect(pinTrackedToken).toHaveBeenCalledTimes(1);
    expect(pinTrackedToken).toHaveBeenCalledWith({
      walletAddress: WALLET, chainId: 4663, tokenAddress: TOKEN_OUT, source: "swap",
    });
  });

  it("pins even when the settlement decoder THROWS (bounded C38 path) — Codex round-4 finding 3", async () => {
    decodeUniswapExecutedLegs.mockImplementation(() => { throw new Error("garbage log"); });
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(result.success).toBe(true);
    expect(pinTrackedToken).toHaveBeenCalledTimes(1);
  });

  it("a NATIVE token-in leg (nothing to pin on that side) still pins the acquired ERC-20 token-out leg", async () => {
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: "native", tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(result.success).toBe(true);
    expect(pinTrackedToken).toHaveBeenCalledTimes(1);
    expect(pinTrackedToken).toHaveBeenCalledWith({
      walletAddress: WALLET, chainId: 4663, tokenAddress: TOKEN_OUT, source: "swap",
    });
  });

  it("a NATIVE token-out leg (selling an ERC-20 for native) pins NOTHING — spending an ERC-20 is not acquiring it", async () => {
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: "native", amountIn: "1" },
      context,
    );
    expect(result.success).toBe(true);
    expect(pinTrackedToken).not.toHaveBeenCalled();
  });

  it("checks getLocalChain with the deployment's chainId", async () => {
    await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(getLocalChain).toHaveBeenCalledWith(4663);
  });
});

describe("Uniswap execute — auto-pin gated to LOCAL chains only", () => {
  it("never pins on a non-local chain (getLocalChain returns undefined)", async () => {
    getLocalChain.mockReturnValue(undefined);
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(result.success).toBe(true);
    expect(pinTrackedToken).not.toHaveBeenCalled();
  });
});

describe("Uniswap execute — pin failure is fail-soft", () => {
  it("a rejected pin does not fail the swap result", async () => {
    pinTrackedToken.mockRejectedValue(new Error("db down"));
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(result.success).toBe(true);
    expect((result.data as { txHash: string }).txHash).toBe("0xhash");
  });
});
