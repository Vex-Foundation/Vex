import { beforeEach, expect, it, vi } from "vitest";
import { createPublicClient, createWalletClient, custom } from "viem";
import { mainnet } from "viem/chains";
import { attachConfirmedUniswapFee } from "@vex-agent/tools/protocols/uniswap/handlers/swap/fee/attach-confirmed.js";
import { planUniswapFeeLeg } from "@vex-agent/tools/protocols/uniswap/handlers/swap/fee/plan.js";
import { buildUniswapFeeDisclosure, UNISWAP_FEE_RECEIVER_EVM, type UniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import { nativeDeployment, nativeWallet, nativeToken } from "./native-balance.fixture.js";

const mocks = vi.hoisted(() => ({ reduce: vi.fn(), run: vi.fn(), withheld: vi.fn() }));
vi.mock("@vex-agent/db/repos/agent-activity.js", async original => ({
  ...await original<typeof import("@vex-agent/db/repos/agent-activity.js")>(), reduceUniswapNativeFee: mocks.reduce,
}));
vi.mock("@vex-agent/tools/protocols/uniswap/handlers/swap/fee/run.js", async original => ({
  ...await original<typeof import("@vex-agent/tools/protocols/uniswap/handlers/swap/fee/run.js")>(),
  runUniswapFeeLeg: mocks.run, recordUniswapFeeNotCollected: mocks.withheld,
}));
const token = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const charge: UniswapFeeCharge = { totalRaw: 100000n, swapAmountRaw: 99750n, feeRaw: 250n, feeTokenAddress: token,
  disclosure: buildUniswapFeeDisclosure({ tokenAddress: token, tokenSymbol: "ETH", tokenDecimals: 18,
    feeRaw: 250n, swappedRaw: 99750n, totalRaw: 100000n, receiver: UNISWAP_FEE_RECEIVER_EVM }) };
const plan = planUniswapFeeLeg({ charge, deployment: nativeDeployment,
  tokenIn: { address: nativeDeployment.weth, symbol: "ETH", decimals: 18, isNative: true }, walletAddress: nativeWallet, sessionId: "bound-fee" });
if (!plan) throw new Error("Native fee fixture must have a plan");
const transport = custom({ request: async () => { throw new Error("The fee test must not reach a provider or signer"); } });
function args(bound?: string, status = "confirmed") {
  return { finalized: { result: { success: true, output: "confirmed", data: { status } },
      outputPayload: { status, pendingReason: "native_output_unproven_hooked", amountOut: null }, feeInputBoundRaw: bound },
    feeCharge: charge, feePlan: plan, feeRowId: 2, executionId: 1, swapLegCount: 1, chainId: 4663, tokenDecimals: 18,
    clients: { publicClient: createPublicClient({ chain: mainnet, transport }), walletClient: createWalletClient({ chain: mainnet, transport, account: nativeWallet }) },
    priorLeg: undefined, debitGate: async () => {}, feeCap: { mode: "legacy" as const, gasPriceWei: 1n } };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.reduce.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ collection: "confirmed", collectionNote: "fee confirmed", txHash: "0xfee" });
  mocks.withheld.mockImplementation(async (_id, reason) => ({ collection: "not_attempted", collectionNote: reason, txHash: null }));
});
it("charges only 25 bps of the native lower bound and never calls it exact debit", async () => {
  const result = await attachConfirmedUniswapFee(args("90000"));
  expect(mocks.reduce).toHaveBeenCalledWith(2, 250n, 225n, 18);
  expect(mocks.run.mock.calls[0]?.[0].plan).toMatchObject({ feeRaw: 225n, txParams: { value: 225n } });
  expect(JSON.parse(result.output).vexFee.disclosure).toMatchObject({ feeAmountRaw: "225", totalDebitedRaw: null,
    swappedAmountBasis: "lower_bound", totalDebitedLowerBoundRaw: "90225" });
});
it("withholds a zero-bound fee without invoking the signer owner", async () => {
  await attachConfirmedUniswapFee(args("0"));
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.withheld).toHaveBeenCalledWith(2, expect.stringContaining("zero fee"));
});
it("a bound above the requested input cannot raise the original fee", async () => {
  await attachConfirmedUniswapFee(args("200000"));
  expect(mocks.run.mock.calls[0]?.[0].plan.feeRaw).toBe(250n);
});
it("charges the existing ERC-20 fee when only native output is unproven", async () => {
  const input = args();
  const tokenCharge = { ...charge, feeTokenAddress: nativeToken };
  const tokenPlan = planUniswapFeeLeg({ charge: tokenCharge, deployment: nativeDeployment,
    tokenIn: { address: nativeToken, symbol: "TOK", decimals: 18, isNative: false }, walletAddress: nativeWallet, sessionId: "bound-fee" });
  if (!tokenPlan) throw new Error("Expected an ERC-20 fee plan");
  const result = await attachConfirmedUniswapFee({ ...input, feePlan: tokenPlan, feeCharge: tokenCharge });
  expect(result.success).toBe(true);
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.reduce).not.toHaveBeenCalled();
  expect(mocks.run.mock.calls[0]?.[0].plan.txParams.value).toBe(0n);
});
it("missing input proof or a failed reduction never reaches fee signing", async () => {
  await attachConfirmedUniswapFee(args(undefined, "confirmed_pending_amounts"));
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.reduce.mockRejectedValueOnce(new Error("ledger unavailable"));
  await attachConfirmedUniswapFee(args("90000"));
  expect(mocks.run).not.toHaveBeenCalled();
});
