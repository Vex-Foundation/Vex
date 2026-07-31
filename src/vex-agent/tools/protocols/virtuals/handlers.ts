/**
 * Virtuals Protocol handlers — direct TS client calls, all READ-ONLY.
 *
 * No wallet, no signing, no mutations: these tools surface agent-token
 * intelligence (list / detail / recent graduations / genesis calendar) that the
 * model uses to decide, then executes trades through the EXISTING venue tools
 * (uniswap on Robinhood, kyberswap on Base/ETH, solana on Solana) named by the
 * projected `tradingRoute` hint.
 *
 * The Virtuals API is undocumented, so every handler degrades cleanly on error
 * (returns a readable failure) rather than throwing through the namespace.
 * `filters[status]` is ignored server-side, so status filtering is applied
 * CLIENT-SIDE here after the fetch.
 */

import { getVirtualsClient } from "@tools/virtuals/client.js";
import { VIRTUALS_CHAINS, type VirtualsChain, type VirtualsSortField } from "@tools/virtuals/types.js";
import { VexError } from "../../../../errors.js";
import logger from "@utils/logger.js";
import type { ProtocolHandler } from "../types.js";
import { str, num, ok, fail } from "../handler-helpers.js";
import {
  projectGenesis,
  projectVirtualsDetail,
  projectVirtualsList,
} from "./projectors.js";

// ── Tuning ──────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** One full page fetched, then filtered client-side + sliced to `limit`. */
const FETCH_PAGE_SIZE = 50;

/** Agent-facing sort keyword → API sort field. */
const SORT_MAP: Record<string, VirtualsSortField> = {
  mcap: "mcapInVirtual",
  volume: "volume24h",
  newest: "createdAt",
  recentGraduation: "lpCreatedAt",
};

type StatusFilter = "undergrad" | "graduated" | "all";

// ── Param helpers ───────────────────────────────────────────────────

function clampLimit(requested: number | undefined): number {
  if (requested !== undefined && requested > 0) {
    return Math.min(Math.floor(requested), MAX_LIMIT);
  }
  return DEFAULT_LIMIT;
}

/** Normalize + validate the chain enum (case-insensitive). Null when invalid. */
function resolveChain(raw: string): VirtualsChain | null {
  const upper = raw.trim().toUpperCase();
  return (VIRTUALS_CHAINS as readonly string[]).includes(upper) ? (upper as VirtualsChain) : null;
}

const CHAIN_LIST = VIRTUALS_CHAINS.join(", ");

function resolveStatusFilter(raw: string): StatusFilter {
  const v = raw.trim().toLowerCase();
  if (v === "undergrad" || v === "graduated" || v === "all") return v;
  return "all";
}

/** Client-side status filter (the server ignores `filters[status]`). */
function matchesStatus(status: string | null, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "undergrad") return status === "UNDERGRAD";
  return status === "AVAILABLE"; // graduated
}

/**
 * Model-facing failure detail — code-keyed and BOUNDED, never upstream text.
 *
 * Error `message` fields can carry upstream-influenced strings (the Virtuals
 * API is hostile input), so the model-facing failure is built ONLY from our
 * own static vocabulary: the VexError code + its static hint. The real error
 * goes to the logger as metadata (bounded) for debugging.
 */
function failureDetail(toolId: string, err: unknown): string {
  logger.warn("virtuals.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  });
  if (err instanceof VexError) {
    return err.hint ? `${err.code}: ${err.hint}` : err.code;
  }
  return "unexpected error";
}

// ── Handler map ─────────────────────────────────────────────────────

export const VIRTUALS_HANDLERS: Record<string, ProtocolHandler> = {
  "virtuals.list": async (p) => {
    const chainRaw = str(p, "chain");
    if (!chainRaw) return fail(`Missing required: chain (one of ${CHAIN_LIST})`);
    const chain = resolveChain(chainRaw);
    if (!chain) return fail(`Invalid chain "${chainRaw}". Must be one of ${CHAIN_LIST}.`);

    const statusFilter = resolveStatusFilter(str(p, "status"));
    // `sortBy` is the documented param; `sort` stays accepted as its alias.
    const sortKeyword = str(p, "sortBy") || str(p, "sort");
    const sort = SORT_MAP[sortKeyword] ?? SORT_MAP.mcap;
    const limit = clampLimit(num(p, "limit"));

    try {
      const client = getVirtualsClient();
      const result = await client.listVirtuals({ chain, sort, pageSize: FETCH_PAGE_SIZE });
      const filtered = result.agents.filter((a) => matchesStatus(a.status, statusFilter));
      const projected = projectVirtualsList(filtered).slice(0, limit);
      return ok({
        chain,
        status: statusFilter,
        sort: sortKeyword && SORT_MAP[sortKeyword] ? sortKeyword : "mcap",
        matched: filtered.length,
        totalOnChain: result.pagination?.total ?? null,
        count: projected.length,
        agents: projected,
      });
    } catch (err) {
      return fail(`Virtuals list unavailable (${failureDetail("virtuals.list", err)})`);
    }
  },

  "virtuals.get": async (p) => {
    // Declared `type: "number"`, so the sanctioned lossless string->number
    // coercion admits both `96200` and `"96200"` before this runs. The API path
    // itself is stringly-typed, hence the String() at the client seam.
    const idNumber = num(p, "id");
    if (idNumber === undefined) return fail("Missing required: id (numeric Virtuals agent id).");
    const id = String(idNumber);
    try {
      const client = getVirtualsClient();
      const agent = await client.getVirtual(id);
      if (!agent) return fail(`No Virtuals agent found for id ${id}.`);
      return ok({ agent: projectVirtualsDetail(agent) });
    } catch (err) {
      return fail(`Virtuals detail unavailable for id ${id} (${failureDetail("virtuals.get", err)})`);
    }
  },

  "virtuals.graduations": async (p) => {
    const chainRaw = str(p, "chain");
    if (!chainRaw) return fail(`Missing required: chain (one of ${CHAIN_LIST})`);
    const chain = resolveChain(chainRaw);
    if (!chain) return fail(`Invalid chain "${chainRaw}". Must be one of ${CHAIN_LIST}.`);
    const limit = clampLimit(num(p, "limit"));

    try {
      const client = getVirtualsClient();
      // Newest graduations first: sort by lpCreatedAt desc, keep AVAILABLE only
      // (UNDERGRAD rows have null lpCreatedAt and sort in behind graduated ones).
      const result = await client.listVirtuals({ chain, sort: "lpCreatedAt", pageSize: FETCH_PAGE_SIZE });
      const graduated = result.agents.filter((a) => a.status === "AVAILABLE" && a.lpCreatedAt !== null);
      const projected = projectVirtualsList(graduated).slice(0, limit);
      return ok({ chain, count: projected.length, agents: projected });
    } catch (err) {
      return fail(`Virtuals graduations unavailable (${failureDetail("virtuals.graduations", err)})`);
    }
  },

  "virtuals.geneses": async (p) => {
    const limit = clampLimit(num(p, "limit"));
    const page = num(p, "page");
    try {
      const client = getVirtualsClient();
      const result = await client.listGeneses({ page, pageSize: FETCH_PAGE_SIZE });
      const projected = result.geneses.map(projectGenesis).slice(0, limit);
      return ok({
        count: projected.length,
        total: result.pagination?.total ?? null,
        geneses: projected,
      });
    } catch (err) {
      return fail(`Virtuals geneses unavailable (${failureDetail("virtuals.geneses", err)})`);
    }
  },
};
