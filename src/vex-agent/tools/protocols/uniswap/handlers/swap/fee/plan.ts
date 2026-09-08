/**
 * Planning the Vex fee leg for a Uniswap swap.
 *
 * Produces the ready-to-sign transfer and the `agent_activity` row it will be
 * recorded under as ONE object, so a caller cannot sign a leg it did not
 * record. The disclosure it belongs to was already computed with the amount
 * (`@tools/uniswap/fee`'s `resolveUniswapFeeCharge`) - the quote needs it
 * before any of this exists.
 *
 * `null` means NO FEE AT ALL: there is then no leg, no row, and no index in the
 * intent. A zero-value transfer would burn gas, add a meaningless row, and move
 * nothing.
 *
 * The fee row is planned as the LAST event of the execution and driven OUTSIDE
 * the loop that runs the swap's own legs - see `run.ts` for why the ordering is
 * the safety property.
 */

import { formatUnits, type Address, type Hex } from "viem";

import { buildEvmVexFeeTransfer } from "@tools/bridge-fee/evm-fee-transfer.js";
import { UNISWAP_FEE_ACTIVITY_EVENT_ROLE, UNISWAP_FEE_RECEIVER_EVM, type UniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken } from "@tools/uniswap/types.js";
import type { CreatePendingActivityEventInput } from "@vex-agent/db/repos/agent-activity.js";

import { PROTOCOL } from "../protocol-id.js";

/** A plain value transfer carries no calldata. */
const EMPTY_CALLDATA = "0x" as Hex;

export interface UniswapFeeLegPlan {
  /** Exact, in the input token's smallest units. */
  readonly feeRaw: bigint;
  /** True when the leg moves native value rather than calling an ERC-20. */
  readonly isNativeValue: boolean;
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  readonly event: Omit<CreatePendingActivityEventInput, "protocolExecutionId" | "eventIndex">;
}

export function planUniswapFeeLeg(input: {
  readonly charge: UniswapFeeCharge;
  readonly deployment: UniswapDeployment;
  readonly tokenIn: UniswapToken;
  readonly walletAddress: string;
  readonly sessionId: string;
}): UniswapFeeLegPlan | null {
  const { charge, tokenIn, deployment } = input;
  if (charge.feeRaw === null || charge.feeTokenAddress === null) return null;

  const transfer = buildEvmVexFeeTransfer(charge.feeTokenAddress, charge.feeRaw, UNISWAP_FEE_RECEIVER_EVM);
  const feeHuman = formatUnits(charge.feeRaw, tokenIn.decimals);
  return {
    feeRaw: charge.feeRaw,
    isNativeValue: transfer.kind === "native",
    txParams: {
      to: transfer.to,
      data: transfer.kind === "native" ? EMPTY_CALLDATA : transfer.data,
      value: transfer.value,
    },
    event: {
      eventRole: UNISWAP_FEE_ACTIVITY_EVENT_ROLE,
      kind: "swap",
      protocol: PROTOCOL,
      chainId: deployment.chainId,
      chainSlug: deployment.key,
      walletAddress: input.walletAddress,
      sessionId: input.sessionId,
      // The fee IS this row: it lives in `tokenIn`/`amountIn`, exactly as a
      // `bridge_fee` or `pools_fee` row does. The `vexFee`
      // (`AgentActivityVexFeeCharge`) columns are deliberately NOT set - those
      // are for venues that take the fee inside the transaction being recorded,
      // and setting both stores the same money twice.
      tokenIn: {
        tokenAddress: charge.feeTokenAddress,
        tokenSymbol: tokenIn.symbol,
        tokenDecimals: tokenIn.decimals,
        amountHuman: feeHuman,
        amountRaw: charge.feeRaw.toString(),
      },
    },
  };
}
