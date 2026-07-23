/**
 * Uniswap execute — balance preflight. An insufficient ERC-20 input balance
 * is rejected BEFORE any allowance read, approval, or broadcast — and the
 * rejection is durably recorded as a hashless `agent_activity`
 * pre-broadcast failure (plan §11.1) rather than silently dropped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VexError, ErrorCodes } from "../../../errors.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const TOKEN_IN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
const TOKEN_OUT = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const WALLET = "0x1111111111111111111111111111111111111111";

const ensureErc20Balance = vi.fn();
const validateUniswapSpender = vi.fn();
const readUniswapAllowance = vi.fn();
const signUniswapTransaction = vi.fn();
const broadcastUniswapTransaction = vi.fn();
const createAgentActivityIntent = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();

vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    v2: { router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba" },
  })),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: vi.fn(() => ({})),
  getUniswapEvmClients: vi.fn(() => ({ publicClient: {}, walletClient: {} })),
}));
vi.mock("@tools/uniswap/erc20.js", () => ({
  readUniswapErc20Metadata: vi.fn(async (_client: unknown, address: string) => ({
    address,
    symbol: "TKN",
    decimals: 18,
    isNative: false,
  })),
  validateUniswapSpender: (...args: unknown[]) => validateUniswapSpender(...args),
  readUniswapAllowance: (...args: unknown[]) => readUniswapAllowance(...args),
}));
vi.mock("@tools/uniswap/quote.js", () => ({
  quoteBestRoute: vi.fn(async () => ({ route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: 10n } })),
  applySlippage: vi.fn((amount: bigint) => amount),
}));
vi.mock("@tools/uniswap/execute.js", () => ({
  NATIVE_TOKEN_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  buildSwapTx: vi.fn(),
  buildApproveTx: vi.fn(),
  signUniswapTransaction: (...args: unknown[]) => signUniswapTransaction(...args),
  broadcastUniswapTransaction: (...args: unknown[]) => broadcastUniswapTransaction(...args),
}));
vi.mock("@tools/uniswap/safety.js", () => ({ checkRouteFactories: vi.fn(), probeFotSignal: vi.fn(), UNISWAP_MIN_LIQUIDITY_USD: 5000 }));
vi.mock("@tools/uniswap/receipt-decoder.js", () => ({ decodeUniswapExecutedLegs: vi.fn() }));
vi.mock("@tools/uniswap/revert-mapping.js", () => ({
  classifyUniswapRevertError: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
  classifyPreBroadcastFailure: vi.fn((err: unknown) =>
    err instanceof VexError && err.code === ErrorCodes.INSUFFICIENT_BALANCE
      ? { failureCode: "allowance_or_balance", failureReason: err.message }
      : { failureCode: "unknown", failureReason: "unused" },
  ),
}));
vi.mock("@tools/dexscreener/client.js", () => ({ getDexScreenerClient: vi.fn() }));
vi.mock("@tools/evm-chains/registry.js", () => ({ getLocalChain: vi.fn() }));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...args: unknown[]) => ensureErc20Balance(...args),
}));
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({ waitForSuccessfulReceipt: vi.fn() }));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: vi.fn() }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => createAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => createAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: vi.fn(),
  markBroadcastAccepted: vi.fn(),
  confirmActivityEvent: vi.fn(),
  failActivityEvent: vi.fn(),
  abortPlannedEvents: vi.fn(),
}));
vi.mock("@vex-agent/sync/settlement-decoders.js", () => ({ registerSettlementDecoder: vi.fn() }));
vi.mock("@vex-agent/tools/registry/uniswap-reveal.js", () => ({ clearUniswapPairReveal: vi.fn() }));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn(),
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

describe("Uniswap execute — balance preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureErc20Balance.mockRejectedValue(new VexError(ErrorCodes.INSUFFICIENT_BALANCE, "short balance"));
    createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 42, event: {} });
  });

  it("fails closed without approving, staging an allowance read, or broadcasting", async () => {
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(result.success).toBe(false);
    expect(validateUniswapSpender).not.toHaveBeenCalled();
    expect(readUniswapAllowance).not.toHaveBeenCalled();
    expect(signUniswapTransaction).not.toHaveBeenCalled();
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
    expect(createAgentActivityIntent).not.toHaveBeenCalled();
  });

  it("durably records a hashless pre-broadcast failure and threads its _executionId", async () => {
    const result = await UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    );
    expect(createAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    const call = createAgentActivityPreBroadcastFailure.mock.calls[0]![0] as {
      toolId: string;
      event: { failureCode: string; walletAddress: string; chainId: number };
    };
    expect(call.toolId).toBe("uniswap.swap.execute");
    expect(call.event.failureCode).toBe("allowance_or_balance");
    expect(call.event.walletAddress).toBe(WALLET);
    expect(call.event.chainId).toBe(4663);
    expect((result.data as { _executionId: number } | undefined)?._executionId).toBe(42);
  });
});
