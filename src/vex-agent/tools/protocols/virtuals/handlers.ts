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
 * CLIENT-SIDE here after the fetch — over a BOUNDED, DISCLOSED window of pages
 * (`./list-window.ts`), never over one silent page.
 *
 * Param reading and every refusal live in `./list-params.ts`; the window scan
 * and its disclosure sentence in `./list-window.ts`.
 */

import { getVirtualsClient } from "@tools/virtuals/client.js";
import type { VirtualsAgent, VirtualsPagination } from "@tools/virtuals/types.js";
import { VexError } from "../../../../errors.js";
import logger from "@utils/logger.js";
import { describeFailureForAgent, describeFailureForLog } from "../runtime/errors.js";
import type { ProtocolHandler } from "../types.js";
import { num, ok, fail } from "../handler-helpers.js";
import { virtualsChainSlug } from "./chain-param.js";
import {
  VIRTUALS_LIST_NUMERIC_PARAMS,
  readChain,
  readVirtualsListParams,
  readVirtualsWindow,
  type StatusFilter,
} from "./list-params.js";
import { describeWindow, scanVirtualsPages } from "./list-window.js";
import {
  projectGenesis,
  projectVirtualsDetail,
  projectVirtualsList,
} from "./projectors.js";

/** Client-side status filter (the server ignores `filters[status]`). */
function matchesStatus(status: string | null, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "undergrad") return status === "UNDERGRAD";
  return status === "AVAILABLE"; // graduated
}

/** A graduated agent with a real LP creation time — the graduations feed's row. */
function isGraduation(agent: VirtualsAgent): boolean {
  return agent.status === "AVAILABLE" && agent.lpCreatedAt !== null;
}

/**
 * The declared ceiling of `limit`, read from the ONE place it is stated so the
 * recovery sentence below cannot drift from the bound the boundary enforces.
 */
const GENESIS_LIMIT_MAX = VIRTUALS_LIST_NUMERIC_PARAMS.limit?.max ?? 100;

/** The three provider numbers `page * pageSize < total` needs to mean anything. */
const GENESIS_PAGE_METADATA_KEYS = ["total", "page", "pageSize"] as const;

/**
 * `page_window` continuation for the genesis calendar (parameter-vocabulary.md
 * section 4.1), derived from the PROVIDER's own pagination block and nothing
 * else.
 *
 * `VirtualsPagination` lets each field be null INDEPENDENTLY
 * (`@tools/virtuals/types.ts`), so a present block is not sufficient evidence:
 * `total`, `page` and `pageSize` must EACH be a finite number before the
 * comparison means anything. When any of them is missing the reply omits
 * `hasMore` and `nextPage` entirely and says which number was absent instead.
 * Claiming "that was the last page" from metadata the provider never sent is
 * the one thing this must never do.
 */
function genesisContinuation(pagination: VirtualsPagination | null): Record<string, unknown> {
  const missing = GENESIS_PAGE_METADATA_KEYS.filter((key) => {
    const value = pagination?.[key];
    return typeof value !== "number" || !Number.isFinite(value);
  });
  if (missing.length > 0 || pagination === null) {
    return {
      continuationNote:
        `The provider returned no ${missing.map((key) => `\`${key}\``).join(" and no ")} for this page, so `
        + "whether more genesis events exist beyond it is UNKNOWN - this is NOT a statement that the "
        + "calendar ended here. Request the next `page` to find out: an empty reply is the end.",
    };
  }
  const hasMore = pagination.page! * pagination.pageSize! < pagination.total!;
  return { hasMore, ...(hasMore ? { nextPage: pagination.page! + 1 } : {}) };
}

/**
 * The within-page drop this tool has always performed silently: ONE provider
 * page of `pageSize` rows is fetched and then sliced to `limit`, so with the
 * defaults (limit 20, pageSize 100) eighty fetched rows used to vanish without
 * a word. The rows are recoverable without another provider call shape - they
 * are on the page the agent already paid for - so the note names the knob
 * rather than a continuation.
 */
function genesisTruncationNote(input: {
  readonly returned: number;
  readonly fetched: number;
  readonly limit: number;
  readonly page: number;
}): string {
  const dropped = input.fetched - input.returned;
  // The recovery is phrased from `fetched`, never from the requested
  // `pageSize`: the dropped rows sit on THIS page, and a page keeps its
  // boundaries only while `pageSize` stays the same. Changing `pageSize`
  // renumbers every page, so on page 2 "lower pageSize to limit" would fetch
  // different rows, not the ones that were dropped.
  const recovery = input.fetched <= GENESIS_LIMIT_MAX
    ? `re-read this same \`page\` (${input.page}) with \`limit\` ${input.fetched} and the SAME \`pageSize\``
    : `this page holds more rows than the maximum \`limit\` (${GENESIS_LIMIT_MAX}) can return, so `
      + `restart from \`page\` 1 with \`pageSize\` at most ${input.limit} and walk the pages; changing `
      + "`pageSize` changes where every page starts, which is why the restart begins at page 1";
  return (
    `${dropped} row${dropped === 1 ? "" : "s"} fetched from this provider page were dropped by `
    + `\`limit\` (${input.returned} of ${input.fetched} kept). They are on the page you already fetched, `
    + `not behind a later one: ${recovery}.`
  );
}

/**
 * Model-facing failure detail — the REAL cause, scrubbed and BOUNDED.
 *
 * Owner decree (2026-08-02, rules/04): a tool error surfaced to the agent
 * carries the ACTUAL cause, never a bare "unexpected error". The canonical
 * summarizer removes secrets, HTML and JSON bodies, URLs, auth headers and long
 * hex blobs, and hard-caps the result. It does NOT neutralise instruction-shaped
 * prose — a pseudo-role tag or an imperative sentence survives scrubbing
 * unchanged, and the mitigation for THAT is the Safety Contract, which teaches
 * the model that tool output is data, never instruction.
 *
 * The VexError fast path stays ahead of it: our own code + authored hint is more
 * actionable than the sentence behind it. As of W2f the client no longer throws
 * the upstream body away, so there is now a real provider sentence behind it to
 * describe. The full error still goes to the logger as bounded metadata.
 */
function failureDetail(toolId: string, err: unknown): string {
  logger.warn("virtuals.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: describeFailureForLog(err),
  });
  return describeFailureForAgent(err);
}

// ── Handler map ─────────────────────────────────────────────────────

export const VIRTUALS_HANDLERS: Record<string, ProtocolHandler> = {
  "virtuals.list": async (p) => {
    const read = readVirtualsListParams(p);
    if (!read.ok) return fail(read.reason);
    const { chain, statusFilter, sortKeyword, sort, limit, page, pageSize } = read.value;
    const chainSlug = virtualsChainSlug(chain);

    try {
      const client = getVirtualsClient();
      const { matched, scan } = await scanVirtualsPages({
        startPage: page,
        pageSize,
        limit,
        fetchPage: (pageNumber) => client.listVirtuals({ chain, sort, page: pageNumber, pageSize }),
        matches: (agent) => matchesStatus(agent.status, statusFilter),
      });
      const projected = projectVirtualsList(matched).slice(0, limit);
      return ok({
        // Echoed as the canonical slug the manifest advertises, not the
        // provider's UPPERCASE value — the reply must spell the chain the way
        // the next call has to spell it.
        chain: chainSlug,
        status: statusFilter,
        sort: sortKeyword,
        matched: matched.length,
        totalOnChain: scan.total,
        count: projected.length,
        window: scan,
        windowNote: describeWindow({
          scan,
          chainSlug,
          sortKeyword,
          matchedCount: matched.length,
          filterLabel: statusFilter,
        }),
        agents: projected,
      });
    } catch (err) {
      return fail(`Virtuals list unavailable (${failureDetail("virtuals__agents_discover", err)})`);
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
      return fail(`Virtuals detail unavailable for id ${id} (${failureDetail("virtuals__agent_get", err)})`);
    }
  },

  "virtuals.graduations": async (p) => {
    const chainRead = readChain(p);
    if (!chainRead.ok) return fail(chainRead.reason);
    const windowRead = readVirtualsWindow(p);
    if (!windowRead.ok) return fail(windowRead.reason);
    const chain = chainRead.value;
    const chainSlug = virtualsChainSlug(chain);
    const { limit, page, pageSize } = windowRead.value;

    try {
      const client = getVirtualsClient();
      // Newest graduations first: sort by lpCreatedAt desc, keep AVAILABLE only
      // (UNDERGRAD rows have null lpCreatedAt and sort in behind graduated ones).
      const { matched, scan } = await scanVirtualsPages({
        startPage: page,
        pageSize,
        limit,
        fetchPage: (pageNumber) =>
          client.listVirtuals({ chain, sort: "lpCreatedAt", page: pageNumber, pageSize }),
        matches: isGraduation,
      });
      const projected = projectVirtualsList(matched).slice(0, limit);
      return ok({
        chain: chainSlug,
        matched: matched.length,
        totalOnChain: scan.total,
        count: projected.length,
        window: scan,
        windowNote: describeWindow({
          scan,
          chainSlug,
          sortKeyword: "recentGraduation",
          matchedCount: matched.length,
          filterLabel: "graduated",
        }),
        agents: projected,
      });
    } catch (err) {
      return fail(`Virtuals graduations unavailable (${failureDetail("virtuals__graduations_list", err)})`);
    }
  },

  "virtuals.geneses": async (p) => {
    const windowRead = readVirtualsWindow(p);
    if (!windowRead.ok) return fail(windowRead.reason);
    const { limit, page, pageSize } = windowRead.value;
    try {
      const client = getVirtualsClient();
      const result = await client.listGeneses({ page, pageSize });
      const fetched = result.geneses.length;
      const projected = result.geneses.map(projectGenesis).slice(0, limit);
      const dropped = fetched - projected.length;
      return ok({
        count: projected.length,
        total: result.pagination?.total ?? null,
        page,
        pageSize,
        // `returned` and `fetched` are different numbers on this tool and both
        // matter: `fetched` is what the provider page held, `returned` is what
        // survived `limit`.
        returned: projected.length,
        fetched,
        truncated: dropped > 0,
        ...(dropped > 0
          ? { truncationNote: genesisTruncationNote({ returned: projected.length, fetched, limit, page }) }
          : {}),
        // `page`/`pageSize` above echo the REQUEST; the continuation below is
        // computed from the provider's own pagination block only.
        ...genesisContinuation(result.pagination ?? null),
        // The page_window class echoes the filters that ran; this read has none,
        // so the honest value is the empty object, never an invented filter.
        filtersApplied: {},
        geneses: projected,
      });
    } catch (err) {
      return fail(`Virtuals geneses unavailable (${failureDetail("virtuals__genesis_launches_list", err)})`);
    }
  },
};
