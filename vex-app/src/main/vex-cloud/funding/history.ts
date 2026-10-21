/**
 * Vex Cloud history reads: activity, usage and deposits, one page at a time
 * (plan 15.2). Newest first; the backend's `next_cursor` is round-tripped
 * opaque and `null` says there is nothing more, so the screen's "Load more"
 * reports exactly what exists. Pure mapping from the backend's snake case to
 * the shared DTOs; nothing is dropped or reworded.
 */

import type {
  VexCloudActivityResult,
  VexCloudDepositsResult,
  VexCloudPageInput,
  VexCloudUsageResult,
} from "@shared/schemas/vex-cloud-funding.js";
import { VEX_CLOUD_PAGE_DEFAULT } from "@shared/schemas/vex-cloud-funding.js";
import type { PageQuery, VexCloudApi } from "../api-client.js";
import type { VexCloudOutcome } from "../outcome.js";
import { withBearer, type SessionPort } from "./backend-call.js";

export interface HistoryDeps extends SessionPort {
  readonly api: Pick<VexCloudApi, "listActivity" | "listUsage" | "listDeposits">;
}

function pageQuery(input: VexCloudPageInput): PageQuery {
  return { cursor: input.cursor, limit: input.limit ?? VEX_CLOUD_PAGE_DEFAULT };
}

export async function readActivity(
  deps: HistoryDeps,
  input: VexCloudPageInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudActivityResult>> {
  const page = await withBearer(deps, (bearer) => deps.api.listActivity(bearer, pageQuery(input), signal));
  if (!page.ok) return page;
  return {
    ok: true,
    value: {
      items: page.value.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        amountWei: item.amount_wei,
        status: item.status,
        txHash: item.tx_hash,
        createdAt: item.created_at,
      })),
      nextCursor: page.value.next_cursor,
    },
  };
}

export async function readUsage(
  deps: HistoryDeps,
  input: VexCloudPageInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudUsageResult>> {
  const page = await withBearer(deps, (bearer) => deps.api.listUsage(bearer, pageQuery(input), signal));
  if (!page.ok) return page;
  return {
    ok: true,
    value: {
      items: page.value.items.map((item) => ({
        requestId: item.request_id,
        model: item.model,
        effort: item.effort,
        status: item.status,
        upstreamCostMicroUsd: item.upstream_cost_micro_usd,
        chargedWei: item.charged_wei,
        clampReason: item.clamp_reason,
        createdAt: item.created_at,
      })),
      nextCursor: page.value.next_cursor,
    },
  };
}

export async function readDeposits(
  deps: HistoryDeps,
  input: VexCloudPageInput,
  signal: AbortSignal,
): Promise<VexCloudOutcome<VexCloudDepositsResult>> {
  const page = await withBearer(deps, (bearer) => deps.api.listDeposits(bearer, pageQuery(input), signal));
  if (!page.ok) return page;
  return {
    ok: true,
    value: {
      items: page.value.items.map((item) => ({
        id: item.id,
        txHash: item.tx_hash,
        logIndex: item.log_index,
        from: item.from,
        amountWei: item.amount_wei,
        status: item.status,
        spendableNowWei: item.spendable_now_wei,
        observedAt: item.observed_at,
        finalizedAt: item.finalized_at,
      })),
      nextCursor: page.value.next_cursor,
    },
  };
}
