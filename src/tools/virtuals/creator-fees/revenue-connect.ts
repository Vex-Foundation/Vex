/**
 * `api2.virtuals.io/api/revenue-connect-metrics/virtuals/{id}?metric=summary` -
 * the provider's OWN revenue number for an agent, read as a claim and labelled
 * as one.
 *
 * WHY THIS IS A SIDE READ AND NOT THE ANSWER. This endpoint is Virtuals'
 * "revenue connect" surface: what an agent reports earning from sources
 * Virtuals connects to it. It is NOT the bonding-curve trading tax that
 * AgentTaxV2 holds, it is not denominated in a token this module can name, and
 * measured on 2026-09-04 it returned `{totalRevenue: 0, totalTokenAccumulated:
 * 0, totalTokenAccumulatedUsd: 0}` for EVERY agent probed - CULTOS (135655),
 * BLOOPA (133649), VEX (96200) and the three largest agents on Base by market
 * cap: TIBBIR (18820), HALO (130418) and AIXBT (1199). Six agents, six all-zero
 * summaries, including ones with thousands of VIRTUAL of real accrued tax on
 * chain at the same moment.
 *
 * So the chain is the answer and this is a labelled provider claim beside it. A
 * zero here says NOTHING about the creator's trading fees, and the tool's own
 * note says exactly that rather than letting a reader subtract one from the
 * other.
 *
 * THE SILENT-IGNORE TRAP APPLIES HERE TOO, which is the second reason this stays
 * a side read. `metric=bogusMetricXyz` answered HTTP 200 with `{"data":[]}` -
 * indistinguishable from a real empty series - exactly the behaviour
 * `Virtuals.md` documents for the main API. Only `metric=summary` is sent, it is
 * a literal in this file, and the shape is validated before anything is
 * believed.
 *
 * FAILURE IS ALWAYS NULL, NEVER AN ERROR. This endpoint is undocumented and
 * unauthenticated; a creator asking what they have earned must still get the
 * on-chain answer when api2 is down. Every failure path returns `null` with the
 * reason, and the handler reports that the provider claim was NOT MEASURED.
 */

import { z } from "zod";

import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import logger from "../../../utils/logger.js";

const API2_BASE = "https://api2.virtuals.io";
const USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";
const TIMEOUT_MS = 15_000;

/**
 * Tolerant on purpose (rule 90: a DISPLAY-ONLY provider field may be nullable).
 * Nothing here reaches a financial decision - the numbers are echoed under a
 * label saying whose claim they are - so a missing or non-numeric field becomes
 * null instead of failing the whole read.
 */
const SUMMARY_SCHEMA = z.object({
  data: z
    .object({
      totalRevenue: z.number().finite().nullable().catch(null),
      totalTokenAccumulated: z.number().finite().nullable().catch(null),
      totalTokenAccumulatedUsd: z.number().finite().nullable().catch(null),
    })
    .partial()
    .passthrough(),
});

/** The provider's own summary, exactly as it reported it. */
export interface VirtualsRevenueConnectSummary {
  readonly totalRevenue: number | null;
  readonly totalTokenAccumulated: number | null;
  readonly totalTokenAccumulatedUsd: number | null;
}

export type ReadRevenueConnectResult =
  | { readonly measured: true; readonly summary: VirtualsRevenueConnectSummary }
  | { readonly measured: false; readonly reason: string };

/**
 * Read one agent's revenue-connect summary by NUMERIC AGENT ID.
 *
 * The endpoint is keyed by the agent id, not by a token address, so a caller
 * that only has an address cannot ask it - and the tool reports that as "not
 * measured, no agent id was resolved" rather than as a zero.
 */
export async function readVirtualsRevenueConnectSummary(
  agentId: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ReadRevenueConnectResult> {
  if (!Number.isInteger(agentId) || agentId <= 0) {
    return { measured: false, reason: `"${agentId}" is not a Virtuals agent id` };
  }
  const url = `${API2_BASE}/api/revenue-connect-metrics/virtuals/${agentId}?metric=summary`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      timeoutMs: TIMEOUT_MS,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    logger.warn("virtuals.revenue_connect.transport", {
      agentId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { measured: false, reason: "api2.virtuals.io did not answer" };
  }
  if (!response.ok) {
    return { measured: false, reason: `api2.virtuals.io answered HTTP ${response.status}` };
  }
  const body = await readJson(response);
  const parsed = SUMMARY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    // The measured shape for an unknown metric is `{"data": []}`; an array where
    // the summary object belongs means the provider did not recognise the ask.
    return {
      measured: false,
      reason: "api2.virtuals.io answered with a body that is not a revenue summary",
    };
  }
  const data = parsed.data.data;
  return {
    measured: true,
    summary: {
      totalRevenue: data.totalRevenue ?? null,
      totalTokenAccumulated: data.totalTokenAccumulated ?? null,
      totalTokenAccumulatedUsd: data.totalTokenAccumulatedUsd ?? null,
    },
  };
}
