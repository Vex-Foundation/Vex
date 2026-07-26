/**
 * `bridge.ts` shared support: agent-grade result shaping, the explorer-link
 * + route-jargon helpers, and the never-signed-leg abort/in-flight/order-
 * lookup primitives — split out (Card C5, move-only) once the parent file
 * crossed the repo's 500-line cap. See `bridge.ts`'s own module doc for the
 * full staged-execute contract these helpers serve. Shared by both
 * `bridge-execute.ts` (the main handler) and `bridge-poll.ts` (in-turn order
 * poll interpretation).
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import { getChainExplorerUrl } from "@tools/khalani/chains.js";
import type { KhalaniChain } from "@tools/khalani/types.js";
import type { BridgeFeeDisclosure } from "@tools/bridge-fee/index.js";
import { abortPlannedEvents, type AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import type { ToolResult } from "../../../types.js";
import logger from "@utils/logger.js";

/** The ONE entry point for provider-error text reaching an output/log/reason (scrub boundary). */
export function khalaniFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}

/** Build a `.../tx/<hash>` explorer link from the Khalani chain registry, or undefined. */
export function txExplorerUrl(chainId: number, chains: KhalaniChain[], txHash: string): string | undefined {
  const base = getChainExplorerUrl(chainId, chains);
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/tx/${txHash}`;
}

/** Map filler/route jargon to plain words for the agent-facing summary. */
export function humanizeRouteType(type: string): string {
  return type
    .replace(/native-filler/gi, "direct filler")
    .replace(/external-intent-router/gi, "intent router");
}

export interface RecordedLeg {
  readonly role: string;
  readonly chain: string;
  readonly txHash: string | null;
  readonly explorerUrl?: string;
  readonly status: string;
}

export interface AmountView {
  readonly token: string;
  readonly symbol?: string;
  readonly amountHuman?: string;
  readonly amountRaw: string;
  readonly usdEst?: string;
}

/** What happened to the Vex fee transfer, kept separate from the bridge's own outcome. */
export interface VexFeeCollection {
  /**
   * `not_charged` (no fee applies) | `not_attempted` | `confirmed` |
   * `confirmed_unrecorded` | `unconfirmed` | `reverted`. NEVER folded into the
   * bridge's `status`: a bridge that went through is a bridge that went
   * through, whether or not Vex managed to collect.
   */
  readonly collection: string;
  readonly collectionNote: string;
}

/** The fee as the agent sees it: what was disclosed, plus whether it was collected. */
export interface BridgeVexFeeView extends VexFeeCollection {
  readonly disclosure: BridgeFeeDisclosure;
}

/**
 * Build the agent-grade result. OWNER RULE: never truncated — every leg, hash,
 * amount, and USD estimate is projected as a structured field. USD is always
 * marked as an estimate. `success` is FALSE for any not-yet-verified outcome
 * (pending/settling/filled-unverified/failed/refunded) — success-shaped
 * ambiguity is forbidden (R2/Q2); only the W4 sweep's verified confirm is a
 * success, and it seeds balances then (C3).
 */
export function bridgeResult(input: {
  success: boolean;
  status: string;
  message: string;
  executionId: number;
  fromChainName: string;
  toChainName: string;
  routeType: string;
  etaSeconds: number;
  amountIn: AmountView;
  amountOut: AmountView;
  vexFee: BridgeVexFeeView;
  /**
   * Every wei of NATIVE currency the plan's legs send, attributed to a proven
   * cost component (`@tools/evm-chains/native-value-authorization`). Distinct
   * from `vexFee` (which is denominated in the bridged token) and from gas
   * (which is not part of any `tx.value` at all). Already JSON-safe.
   */
  nativeCost: Record<string, unknown>;
  legs: readonly RecordedLeg[];
  orderId?: string;
  depositTxHash?: string;
}): ToolResult {
  const inLabel = input.amountIn.amountHuman ?? `${input.amountIn.amountRaw} (smallest units)`;
  const inSym = input.amountIn.symbol ?? input.amountIn.token;
  const summary =
    `Bridging ${inLabel} ${inSym} from ${input.fromChainName} to ${input.toChainName} via Khalani `
    + `(route: ${humanizeRouteType(input.routeType)}, ~${input.etaSeconds}s expected).`;
  const data = {
    summary,
    status: input.status,
    message: input.message,
    fromChain: input.fromChainName,
    toChain: input.toChainName,
    route: humanizeRouteType(input.routeType),
    etaSeconds: input.etaSeconds,
    amountIn: {
      token: input.amountIn.symbol ?? input.amountIn.token,
      tokenAddress: input.amountIn.token,
      amountHuman: input.amountIn.amountHuman ?? null,
      amountRaw: input.amountIn.amountRaw,
      usdEstimate: input.amountIn.usdEst ?? null,
    },
    amountOut: {
      token: input.amountOut.symbol ?? input.amountOut.token,
      tokenAddress: input.amountOut.token,
      amountHuman: input.amountOut.amountHuman ?? null,
      amountRaw: input.amountOut.amountRaw,
      usdEstimate: input.amountOut.usdEst ?? null,
    },
    usdNote: "USD figures are estimates from a Khalani token-price lookup, not provider-quoted values.",
    // Disclosure + collection outcome in ONE field. `collection` is about
    // Vex's revenue, never about whether the user's bridge worked.
    vexFee: {
      ...input.vexFee.disclosure,
      collection: input.vexFee.collection,
      collectionNote: input.vexFee.collectionNote,
    },
    nativeCost: input.nativeCost,
    legs: input.legs,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.depositTxHash ? { depositTxHash: input.depositTxHash } : {}),
    _executionId: input.executionId,
  };
  return { success: input.success, output: JSON.stringify(data), data };
}

/**
 * Best-effort abort of never-signed downstream rows — a throw is logged, never
 * propagated. `toIndexExclusive` (when set) bounds the abort to
 * `event_index < toIndexExclusive`, so an ambiguous DEPOSIT can abort its
 * never-signed sibling legs while leaving the logical `bridge_fill_expected` row
 * (the highest index) pending for W4 recovery (blocker 1).
 */
export async function abortRemaining(executionId: number, fromIndex: number, reason: string, toIndexExclusive?: number): Promise<void> {
  try {
    if (toIndexExclusive === undefined) {
      await abortPlannedEvents(executionId, fromIndex, reason);
    } else {
      await abortPlannedEvents(executionId, fromIndex, reason, toIndexExclusive);
    }
  } catch (err) {
    logger.warn("khalani.bridge.abort_planned_events_failed", {
      executionId,
      fromIndex,
      error: khalaniFailureMessage(err),
    });
  }
}

export function inFlightResult(toolId: string, existing: AgentActivityEvent | null): ToolResult {
  const detail = existing ? ` (execution ${existing.protocolExecutionId}, status ${existing.status})` : "";
  return {
    success: false,
    output: `${toolId}: a bridge for this route is already in flight${detail} — wait for it to settle before starting another.`,
  };
}

/** Fetch an existing order id for a submitted deposit hash (DuplicateRecord recovery). */
export async function fetchExistingOrderId(address: string, depositTxHash: string): Promise<string | null> {
  try {
    const orders = await getKhalaniClient().getOrders(address, { txHashSearch: depositTxHash, limit: 1 });
    const match = orders.data.find((o) => o.depositTxHash === depositTxHash) ?? orders.data[0];
    return match ? match.id : null;
  } catch (err) {
    logger.warn("khalani.bridge.fetch_existing_order_failed", { error: summarizeProtocolError(err).message });
    return null;
  }
}
