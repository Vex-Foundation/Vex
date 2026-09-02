/**
 * The approved-quote snapshot a `uniswap.swap.execute` claims, for suites whose
 * subject is something else.
 *
 * It is built through the SAME functions the handler uses - the real fee
 * resolution and the real snapshot codec - so a suite never hand-writes a fee
 * amount or a disclosure sentence that the handler would then reject as drift.
 * Callers state only what their own scenario is about: the pair, the amount and
 * the approved output.
 *
 * Not a test spec: a helper module (rule 06).
 */

import { parseUnits } from "viem";

import { resolveUniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken } from "@tools/uniswap/types.js";
import { resolveUniswapToken } from "@vex-agent/tools/protocols/uniswap/handlers/swap/token-resolution.js";
import { buildUniswapQuoteSnapshot } from "@vex-agent/tools/protocols/uniswap/handlers/swap/execution-binding.js";
import type { UniswapExecutionSnapshot } from "@vex-agent/tools/protocols/quote-authority/uniswap.js";

export interface ApprovedSnapshotInput {
  readonly chainId: number;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  /** The FULL requested input, before the fee. */
  readonly amountInRaw: bigint;
  readonly approvedAmountOutRaw: bigint;
  readonly approvedMinOutRaw: bigint;
  readonly slippageBps?: number;
  readonly expiresAt?: string;
}

export async function approvedUniswapSnapshot(
  input: ApprovedSnapshotInput,
): Promise<UniswapExecutionSnapshot> {
  const charge = await resolveUniswapFeeCharge({
    chainId: input.chainId,
    tokenIn: input.tokenIn,
    amountInRaw: input.amountInRaw,
  });
  return buildUniswapQuoteSnapshot({
    chainId: input.chainId,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    charge,
    quoted: {
      route: { version: "v2", path: [input.tokenIn.address, input.tokenOut.address], amountOut: input.approvedAmountOutRaw },
      amountOut: input.approvedAmountOutRaw,
      minAmountOut: input.approvedMinOutRaw,
      slippageBps: input.slippageBps ?? 50,
    },
    expiresAt: input.expiresAt ?? "2026-08-28T10:00:00.000Z",
  });
}

/** The claim result the store would hand an execute for that snapshot. */
export async function claimedUniswapSnapshot(input: ApprovedSnapshotInput): Promise<{
  readonly ok: true;
  readonly prequoteId: string;
  readonly snapshot: UniswapExecutionSnapshot;
}> {
  return { ok: true, prequoteId: "prequote-test", snapshot: await approvedUniswapSnapshot(input) };
}

/**
 * A `claimUniswapExecutionSnapshot` stand-in that answers with the quote THIS
 * call would have produced: it resolves the params' own legs through the same
 * resolver the handler uses, so a suite that swaps a native leg in and out of
 * its params needs no second fixture.
 *
 * Suites whose subject IS the binding drive the claim explicitly instead.
 */
export function claimStandingInForTheParams(deployment: {
  readonly chainId: number;
  readonly weth: string;
  readonly approvedAmountOutRaw?: bigint;
  readonly approvedMinOutRaw?: bigint;
}) {
  return async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) => {
    const dep = { chainId: deployment.chainId, weth: deployment.weth } as UniswapDeployment;
    const tokenIn = await resolveUniswapToken(dep, String(params.tokenIn));
    const tokenOut = await resolveUniswapToken(dep, String(params.tokenOut));
    return claimedUniswapSnapshot({
      chainId: deployment.chainId,
      tokenIn,
      tokenOut,
      amountInRaw: parseUnits(String(params.amountIn), tokenIn.decimals),
      approvedAmountOutRaw: deployment.approvedAmountOutRaw ?? 10n,
      approvedMinOutRaw: deployment.approvedMinOutRaw ?? 10n,
    });
  };
}
