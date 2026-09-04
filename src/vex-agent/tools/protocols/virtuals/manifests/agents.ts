import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VIRTUALS_CHAIN_SLUGS } from "../chain-param.js";
import { VIRTUALS_AGENTS_DISCOVERY } from "../../embeddings/virtuals/agents.js";

// Virtuals Protocol agent-token intelligence - READ-ONLY. Discovery surface for
// agent tokens on Robinhood (chain 4663), Base, Solana, and Ethereum. Trades
// route through the EXISTING venue tools named by each result's `tradingRoute`
// hint (uniswap on Robinhood; kyberswap on Base/ETH; solana on Solana).
//
// Chain is the API's required filter over a CLOSED four-value set. The manifest
// advertises the canonical lowercase slugs like every other namespace and
// declares them as an `enum`; the provider's UPPERCASE spelling (BASE | SOLANA |
// ROBINHOOD | ETH) is translated inside `../chain-param.ts`, per SPEC §1.1
// ("per-provider translation stays in the adapter, never in the manifest").

/**
 * The `chain` param, shared by the two chain-scoped tools so their accepted
 * value set cannot drift apart.
 */
const VIRTUALS_CHAIN_PARAM: ProtocolParamDef = {
  key: "chain",
  type: "string",
  required: true,
  enum: VIRTUALS_CHAIN_SLUGS,
  description:
    "REQUIRED. The one chain to list - Virtuals indexes exactly four: "
    + `${VIRTUALS_CHAIN_SLUGS.join(", ")}. ${CANONICAL_CHAIN_SENTENCE}`,
};

export const VIRTUALS_AGENTS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "virtuals.list",
    publicName: "virtuals__agents_discover",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Screen Virtuals Protocol agent tokens on ONE chain (base, solana, robinhood, or ethereum). Use this when the user wants to find or compare agent tokens rather than read one they can already name. Returns `agents` alongside chain, status, sort, matched, totalOnChain, count, `window` and a `windowNote`. Each row carries id, name, symbol, status (UNDERGRAD bonding-curve vs graduated AVAILABLE, with a warning flag on UNDERGRAD), token/preToken/LP addresses, holderCount, top10HolderPercentage, mcapInVirtual (denominated in the VIRTUAL token, NOT USD), volume24h, priceChangePercent24h, isVerified (anti-impersonation badge only), the anti-sniper buy-tax window, ageDays, and verified socials. Filter status client-side (undergrad|graduated|all) and order with sortBy: mcap, volume, newest, or recentGraduation (sort is accepted as an alias). WINDOWED: a chain holds tens of thousands of agents, so this reads a BOUNDED slice - up to 5 pages of pageSize rows from page - and every reply carries a windowNote naming the exact slice searched. CONTINUATION IS PROSE PLUS NUMBERS, not a cursor: `window` carries firstPage, lastPage, pagesFetched, pageSize, rowsScanned, total and `exhausted`, and `windowNote` says the same thing in words. `exhausted: true` means the provider had no further rows, which is the only end-of-list signal here; otherwise continue by calling again with page set to window.lastPage + 1, exactly as the windowNote states. An empty result is a statement about that window, never about the chain. Because status is filtered after the fetch, a status the sort buries needs the matching sort or a later page: UNDERGRAD agents have low market caps and do not appear near the top of an mcap sort - use sortBy: newest. Every unrecognised value (status, sortBy, limit, page, pageSize) is REJECTED by name rather than clamped. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      VIRTUALS_CHAIN_PARAM,
      { key: "status", type: "string", enum: ["undergrad", "graduated", "all"], description: "Client-side status filter applied to the fetched window: undergrad (bonding curve), graduated (AVAILABLE), or all (default). An unrecognised value is rejected, not ignored." },
      { key: "sortBy", type: "string", enum: ["mcap", "volume", "newest", "recentGraduation"], description: "Sort order, always descending: mcap (default), volume, newest, or recentGraduation. It decides WHICH rows the window contains, so pair it with status - sortBy: newest is what surfaces UNDERGRAD agents. An unrecognised value is rejected, not folded to mcap." },
      { key: "sort", type: "string", enum: ["mcap", "volume", "newest", "recentGraduation"], description: "Alias of sortBy, accepted for compatibility. Same values. Send ONE of the two, never both - a silently dropped spelling is indistinguishable from one that was honoured." },
      { key: "limit", type: "number", description: "Max agents to return after filtering (default 20, max 100). Paging stops once this many rows match. Out of range is rejected, not clamped." },
      { key: "page", type: "number", description: "1-based FIRST provider page of the window (default 1). The reply's windowNote names the next page to continue from." },
      { key: "pageSize", type: "number", description: "Rows fetched per provider page (default 100, max 200 - the provider's proven ceiling). Up to 5 pages are scanned per call, so pageSize x 5 bounds how deep one call reads." },
    ],
    // `sortBy` and `sort` are the SAME knob under two spellings. Accepting both
    // and letting one win is the silent-drop pattern this wave removes
    // everywhere else in the tool; declared here so the model reads the rule
    // before the call instead of guessing which spelling took effect.
    atMostOne: [["sortBy", "sort"]],
    exampleParams: { chain: "robinhood", status: "graduated", sortBy: "mcap", limit: 20 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.list"],
  },
  {
    toolId: "virtuals.get",
    publicName: "virtuals__agent_get",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Read ONE Virtuals agent token's full profile by its numeric id. Returns `agent`, which carries every field the screening row does and adds: factory, category, fdvInVirtual, liquidityUsd, graduation state, launchInfo, a bounded tokenomics summary, a sanitized short description excerpt, and a tradingRoute hint {venue, namespace, quoteToken} naming the EXACT existing tool that trades it (uniswap/kyberswap/solana, quoted in VIRTUAL). ALWAYS call this before buying a graduated agent to read the anti-sniper window - never buy while windowActive. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "id", type: "number", required: true, description: "Numeric Virtuals agent id, exactly as virtuals__agents_discover returns it (e.g. 96200 for VEX). The string spelling \"96200\" is accepted too." },
    ],
    exampleParams: { id: 96200 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.get"],
  },
  {
    toolId: "virtuals.graduations",
    publicName: "virtuals__graduations_list",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "The 'what just graduated' feed: recently graduated (AVAILABLE) Virtuals agent tokens on ONE chain (base, solana, robinhood, or ethereum), newest first by graduation time. Use this when the user asks what just graduated or wants to catch a fresh graduation before buying, because a graduation is exactly when the anti-sniper buy tax is at its worst. Returns `agents` alongside chain, matched, totalOnChain, count, `window` and a `windowNote`; each row carries the same fields virtuals__agents_discover returns, including the live antiSniper block (windowActive, remainingSeconds, estBuyTaxPct) - never buy while windowActive is true. WINDOWED the same way: up to 5 pages of pageSize rows from page, with the windowNote naming the exact slice searched and the page to continue from, so an empty result is a statement about that window and never about the chain. Continuation is the same prose-plus-numbers pair, not a cursor: `window` carries firstPage, lastPage, pagesFetched, pageSize, rowsScanned, total and `exhausted`, and `windowNote` says it in words. `exhausted: true` is the only end-of-list signal; otherwise call again with page set to window.lastPage + 1. Out-of-range limit, page or pageSize is REJECTED by name, not clamped. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      VIRTUALS_CHAIN_PARAM,
      { key: "limit", type: "number", description: "Max graduations to return (default 20, max 100). Out of range is rejected, not clamped." },
      { key: "page", type: "number", description: "1-based FIRST provider page of the window (default 1). The reply's windowNote names the next page to continue from." },
      { key: "pageSize", type: "number", description: "Rows fetched per provider page (default 100, max 200). Up to 5 pages are scanned per call." },
    ],
    exampleParams: { chain: "robinhood", limit: 10 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.graduations"],
  },
  {
    toolId: "virtuals.geneses",
    publicName: "virtuals__genesis_launches_list",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Browse the Virtuals GENESIS calendar - the points-sale events that precede an agent-token launch, mostly on Base, newest first. Use this when the user asks what is launching soon on Virtuals, or wants the history of a sale; a token that already trades is virtuals__agents_discover instead. Returns `geneses` alongside count, total, page and pageSize, one row per event: id, genesisId, status, startsAt, endsAt, totalParticipants, totalVirtuals, and the linked `agent` (id, name, symbol, chain, status, tokenAddress, isVerified) or null when none is linked. Unlike the agent feeds this reads ONE provider page per call and reports it back as page/pageSize with no window scan, so ask for an older page explicitly. CONTINUATION COMES IN TWO PARTS. Within the page: `returned` (rows you got), `fetched` (rows the provider page actually held) and `truncated`, true when `limit` dropped rows off the page that was already fetched - with the defaults (limit 20, pageSize 100) that is 80 rows - and a `truncationNote` then names the knob that brings them back. Across pages: `hasMore` with `nextPage`, present only when hasMore is true; pass nextPage back rather than computing it. The exception worth knowing: the provider may omit its own total, page or pageSize, and without all three there is no honest hasMore, so the reply OMITS hasMore and nextPage and carries a `continuationNote` naming the missing number instead. Read that as UNKNOWN, never as the end of the calendar - request the next page to find out. `filtersApplied` is always `{}`: this read has no filters. Read a suspicious far-future date as spam rather than as a scheduled launch. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "limit", type: "number", description: "Max geneses to return (default 20, max 100). Out of range is rejected, not clamped." },
      { key: "page", type: "number", description: "1-based page for older genesis events (default 1)." },
      { key: "pageSize", type: "number", description: "Rows fetched from the provider for this page (default 100, max 200)." },
    ],
    exampleParams: { limit: 20 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.geneses"],
  },
];
