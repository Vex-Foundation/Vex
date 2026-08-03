/**
 * Merging the fee report into a CONFIRMED swap's result.
 *
 * `success` is NEVER touched: the swap already happened, and a fee that did not
 * land is missed Vex revenue and nothing more. The disclosure is added to the
 * same JSON the swap already returns (or appended to its prose when the
 * settlement was undecodable), so the agent reads one object.
 */

import type { ToolResult } from "../../../../../types.js";
import type { UniswapFeeDisclosure } from "@tools/uniswap/fee/index.js";
import type { UniswapFeeCollection } from "./run.js";

export function withFeeDisclosure(input: {
  readonly result: ToolResult;
  readonly outputPayload: Record<string, unknown> | null;
  readonly collection: UniswapFeeCollection;
  readonly disclosure: UniswapFeeDisclosure;
}): ToolResult {
  const vexFee = { ...input.collection, disclosure: input.disclosure };
  const data = { ...(input.result.data ?? {}), vexFee };
  return {
    ...input.result,
    output: input.outputPayload === null
      ? `${input.result.output} ${input.collection.collectionNote}`
      : JSON.stringify({ ...input.outputPayload, vexFee }, null, 2),
    data,
  };
}
