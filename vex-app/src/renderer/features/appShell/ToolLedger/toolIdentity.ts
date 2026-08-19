/**
 * PROTOCOL IDENTITY for a registered tool act (contract C5).
 *
 * Answers two questions a friendly tool card must answer honestly: WHO did
 * this act deal with (a protocol key `resolveProtocolMark` can turn into a
 * mark) and WHAT was it (a human title instead of a raw snake_case symbol).
 *
 * Three signals, in priority order:
 *
 *  0. The tool NAME is itself a dotted protocol `toolId`. Main canonicalizes an
 *     injected protocol call (`kyberswap__swap__quote`) to `kyberswap.swap.quote`
 *     before the DTO is built, so that id — the same grammar `execute_tool`
 *     carries in its args — is the strongest signal there is, and it is read
 *     BEFORE the prefix rules so `khalani.bridge` is not eaten by
 *     `startsWith("khalani_")`. A name that still carries `__` is one the live
 *     catalog could NOT resolve; it is refused a venue outright rather than
 *     falling through to a prefix match.
 *  1. The TOOL NAME prefix map. The engine's tool vocabulary is a closed set
 *     written by us (`swap_*`, `bridge_*`, `khalani_*`, `wallet_*`,
 *     `chain_read`, `*memory*`, `web_research`…), so a prefix match is proof,
 *     not a guess.
 *  2. For the GENERIC wrappers (`execute_tool`, `discover_tools`,
 *     `describe_tools`) the
 *     tool name says nothing — the venue lives in the `toolId` inside the
 *     args. Those args are the SANITIZED, pre-serialized JSON string from the
 *     DTO, capped at 2000 chars, so a large call is TRUNCATED and
 *     `JSON.parse` throws. That is the whole point of the fail-closed
 *     contract below: a truncated / malformed / non-object / non-string-toolId
 *     payload yields NO protocol at all rather than a half-read namespace.
 *     Same doctrine as `isConfirmedWalletTransfer` — untrusted text may only
 *     ever confirm an identity, never be repaired into one.
 *
 * A protocol we cannot prove resolves to `null`, and the card then shows the
 * category glyph with no mark — never a borrowed brand (see the provenance
 * law in `lib/protocol-marks.ts`).
 *
 * Pure: no React, no IO, trivially unit-testable.
 */

import {
  isCuratedProtocol,
  resolveProtocolMark,
} from "../../../lib/protocol-marks.js";

/** Coarse act category — drives the glyph and the leg-line eligibility. */
export type ToolCategory =
  | "swap"
  | "bridge"
  | "wallet"
  | "memory"
  | "web"
  | "market"
  | "discovery"
  | "tool";

export interface ToolIdentity {
  /** Curated/parsed venue key for `resolveProtocolMark`; null when unproven. */
  readonly protocol: string | null;
  /** Human card title, e.g. "Swap · KyberSwap", "Memory recall". */
  readonly title: string;
  readonly category: ToolCategory;
}

/** Venue tokens a `swap_*` / `bridge_*` tool name may name outright. */
const VENUE_TOKENS: readonly string[] = [
  "kyberswap",
  "uniswap",
  "jupiter",
  "relay",
  "khalani",
  "pendle",
  "solana",
  "virtuals",
  "dexscreener",
];

/** Longest venue token appearing as a whole `_`-segment of the tool name. */
function venueInToolName(name: string): string | null {
  const segments = name.split("_");
  for (const venue of VENUE_TOKENS) {
    if (segments.includes(venue)) return venue;
  }
  return null;
}

/** Proper venue label for a title, via the curated matrix (never invented). */
function venueLabel(protocol: string | null): string | null {
  const mark = resolveProtocolMark(protocol);
  return mark === null ? null : mark.label;
}

/** "Swap" / "Swap · KyberSwap" — the venue suffix only when we can prove it. */
function withVenue(base: string, protocol: string | null): string {
  const label = venueLabel(protocol);
  return label === null ? base : `${base} · ${label}`;
}

/**
 * Exact-name titles for the tools whose friendly name is not derivable from
 * their category alone. Everything else falls through to the category title
 * or the humanizer, so this map stays small on purpose.
 */
const EXACT_TITLES: Readonly<Record<string, string>> = {
  chain_read: "Chain read",
  wallet_balances: "Wallet balances",
  wallet_send_prepare: "Transfer · prepare",
  wallet_send_confirm: "Transfer · confirm",
  wallet_track_token: "Track token",
  web_research: "Web research",
  discover_tools: "Tool discovery",
  describe_tools: "Tool manifests",
};

/** snake_case / colon symbol → "Sentence case words" (bounded, lossless-ish). */
function humanizeToolName(name: string): string {
  const words = name.replace(/[_:.]+/g, " ").trim();
  if (words.length === 0) return "Tool call";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The `toolId`'s NAMESPACE (the segment before the first "."), or `null` when
 * it is not a plain lower-case identifier — so an id whose shape we do not
 * recognise simply shows no venue.
 */
function namespaceOfToolId(toolId: string | null): string | null {
  if (toolId === null) return null;
  const namespace = toolId.split(".")[0] ?? "";
  return /^[a-z][a-z0-9_]*$/.test(namespace) ? namespace : null;
}

/**
 * Is this string a dotted protocol `toolId` (`kyberswap.swap.quote`)?
 *
 * CASE-SENSITIVE on purpose: `dexscreener.tokenPairs` is a real id, and
 * lower-casing it before the lookup would lose 14 camelCase manifests. Owned
 * here, beside the resolvers that consume it, and imported by `toolOperation.ts`
 * — one domain helper, not a second copy.
 */
export function isDottedProtocolToolId(name: string): boolean {
  if (!name.includes(".") || /\s/.test(name)) return false;
  return name.split(".").every((segment) => segment.length > 0);
}

/** The `toolId` string inside the sanitized args, or null at any failure. */
function parseToolId(toolArgs: string | null): string | null {
  if (toolArgs === null || toolArgs.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolArgs);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const toolId = (parsed as Record<string, unknown>)["toolId"];
  return typeof toolId === "string" && toolId.length > 0 ? toolId : null;
}

/** Action words of a `toolId` after its namespace, humanized ("Swap quote"). */
function toolIdAction(toolId: string | null): string | null {
  if (toolId === null) return null;
  const rest = toolId.split(".").slice(1).join(" ");
  return rest.length === 0 ? null : humanizeToolName(rest);
}

/**
 * Curated titles and categories for the protocol acts whose friendly name and
 * money category the humanizer cannot derive (Trench Express, plus the swap and
 * bridge acts, whose CATEGORY is what drives the leg line and the glyph).
 * The humanizer would spell these as "Launch request form" / "My launches";
 * these read the way the rest of the card voice does ("Swap" vs "Swap quote",
 * "Transfer · prepare"). Consulted only AFTER `isCuratedProtocol` has proven
 * the namespace, so untrusted text can still never name a venue.
 */
interface ToolIdPresentation {
  readonly action: string;
  readonly category: ToolCategory;
}

const TOOL_ID_PRESENTATION: Readonly<Record<string, ToolIdPresentation>> = {
  "trench.tokens": { action: "Token list", category: "market" },
  "trench.search": { action: "Token search", category: "market" },
  "trench.trades": { action: "Trade tape", category: "market" },
  "trench.trade_quote": { action: "Trade quote", category: "swap" },
  "trench.trade_execute": { action: "Trade", category: "swap" },
  "trench.launch_preview": { action: "Launch preview", category: "tool" },
  "trench.launch_request_form": { action: "Launch form", category: "tool" },
  "trench.launch_execute": { action: "Launch", category: "tool" },
  "trench.my_launches": { action: "My launches", category: "tool" },
  "trench.images": { action: "Image locker", category: "tool" },

  // pools.fun (`tools/protocols/pools/manifests/`). The reads are market data;
  // `my_launches`, the launch family and the fee claim mirror their Trench
  // counterparts and are filed as plain tools rather than market data.
  "pools.tokens": { action: "Token list", category: "market" },
  "pools.search": { action: "Token search", category: "market" },
  "pools.candles": { action: "Candles", category: "market" },
  "pools.token": { action: "Token detail", category: "market" },
  "pools.my_launches": { action: "My launches", category: "tool" },
  "pools.launch_preview": { action: "Launch preview", category: "tool" },
  "pools.launch_request_form": { action: "Launch form", category: "tool" },
  "pools.launch_execute": { action: "Launch", category: "tool" },
  "pools.claim_fees": { action: "Claim fees", category: "tool" },

  // Swap and bridge acts. There is deliberately no `relay.bridge.quote` /
  // `relay.bridge.execute`: Relay's mutating tool is the two-segment
  // `relay.bridge` and its quote is `relay.quote.get` — same for Khalani.
  "kyberswap.swap.quote": { action: "Swap quote", category: "swap" },
  "kyberswap.swap.execute": { action: "Swap", category: "swap" },
  "uniswap.swap.quote": { action: "Swap quote", category: "swap" },
  "uniswap.swap.execute": { action: "Swap", category: "swap" },
  "solana.swap.quote": { action: "Swap quote", category: "swap" },
  "solana.swap.execute": { action: "Swap", category: "swap" },
  "relay.quote.get": { action: "Bridge quote", category: "bridge" },
  "relay.bridge": { action: "Bridge", category: "bridge" },
  "khalani.quote.get": { action: "Bridge quote", category: "bridge" },
  "khalani.bridge": { action: "Bridge", category: "bridge" },

  // Morpho's sixteen acts - the nine reads, then the money acts. The
  // humanizer would spell them "Markets discover" / "Vault withdraw"; these
  // read the way the rest of the card voice does. The market and vault reads
  // are `market` (research), the two wallet-scoped reads are `wallet`, and the
  // vault and Blue-market money acts stay `tool` on purpose: none is a swap or
  // a bridge, and borrowing either of those categories would hand a lending act
  // the leg-line styling of a trade.
  "morpho.markets.discover": { action: "Market list", category: "market" },
  "morpho.market.get": { action: "Market detail", category: "market" },
  "morpho.markets.activity": { action: "Market activity", category: "market" },
  "morpho.vaults.discover": { action: "Vault list", category: "market" },
  "morpho.vault.get": { action: "Vault detail", category: "market" },
  "morpho.rewards.get": { action: "Rewards", category: "market" },
  "morpho.positions.get": { action: "Positions", category: "wallet" },
  "morpho.wallet.balance": { action: "Wallet balance", category: "wallet" },
  "morpho.vault.quote": { action: "Vault quote", category: "tool" },
  "morpho.vault.deposit": { action: "Vault deposit", category: "tool" },
  "morpho.vault.withdraw": { action: "Vault withdrawal", category: "tool" },

  // Morpho BLUE market acts. `morpho.market.quote` previews a market
  // operation and is the market-side twin of `morpho.vault.quote`, so it takes
  // the same `tool` category rather than the `market` (research) one that
  // `morpho.market.get` uses: it is a money act's preview, not a market read.
  // The four executes each move exactly ONE token in one direction, which is
  // why they render a single leg rather than a pair (see `toolLegs.ts`).
  "morpho.market.quote": { action: "Market preview", category: "tool" },
  "morpho.market.supplyCollateral": { action: "Supply collateral", category: "tool" },
  "morpho.market.withdrawCollateral": { action: "Withdraw collateral", category: "tool" },
  "morpho.market.borrow": { action: "Borrow", category: "tool" },
  "morpho.market.repay": { action: "Repay", category: "tool" },
};

/**
 * Identity for a PROTOCOL act, addressed by its dotted `toolId` — whether that
 * id arrived as the canonicalized tool NAME or inside an `execute_tool`
 * wrapper's args.
 *
 * The namespace may come from UNTRUSTED args text, so it is admitted ONLY when
 * `isCuratedProtocol` recognises it (Codex review round 2 finding 1). Syntactic
 * validity is not provenance: `{"toolId":"kyberswapp.swap"}` would otherwise
 * have earned a "Kyberswapp ·" title and a venue-looking monogram ring, which
 * is a lie about who the agent dealt with. An unknown namespace falls through
 * to the caller's own honest generic presentation (`fallbackName`).
 */
function protocolIdentity(
  toolId: string | null,
  fallbackName: string,
  isDiscovery: boolean,
): ToolIdentity {
  const parsedNamespace = namespaceOfToolId(toolId);
  const protocol = isCuratedProtocol(parsedNamespace) ? parsedNamespace : null;
  const label = venueLabel(protocol);
  const curated = toolId === null ? undefined : TOOL_ID_PRESENTATION[toolId];
  const action = curated?.action ?? toolIdAction(toolId);
  const category: ToolCategory = isDiscovery
    ? "discovery"
    : (curated?.category ?? "tool");
  if (label === null) {
    // Fail-closed: no proven venue → the caller's own honest name.
    return {
      protocol: null,
      title: EXACT_TITLES[fallbackName] ?? humanizeToolName(fallbackName),
      category,
    };
  }
  return {
    protocol,
    title: action === null ? label : `${label} · ${action}`,
    category,
  };
}

/**
 * Resolve the card identity for one act. `toolArgs` is consulted ONLY for the
 * generic wrappers — a named tool's identity never depends on untrusted
 * payload text.
 */
export function resolveToolIdentity(
  toolName: string,
  toolArgs: string | null,
): ToolIdentity {
  // A dotted name IS a protocol toolId (main canonicalizes the injected wire
  // name there; `execute_tool` still carries its target in the args). Read
  // BEFORE the lower-casing below: `dexscreener.tokenPairs` is a real id and
  // lower-casing it would lose the map.
  if (isDottedProtocolToolId(toolName)) {
    return protocolIdentity(toolName, toolName, false);
  }

  // A name that STILL carries `__` after main-side canonicalization is, by
  // definition, one the live catalog could not resolve — an evicted, stale or
  // hallucinated id. It must NOT fall through to the legacy prefix rules below,
  // which would hand `khalani__unknown` the Khalani mark and
  // `dexscreener__unknown` the DexScreener one on the strength of a prefix
  // alone. Unknown tool, honest generic presentation.
  if (toolName.includes("__")) {
    return { protocol: null, title: humanizeToolName(toolName), category: "tool" };
  }

  const name = toolName.toLowerCase();

  // `describe_tools` fetches the FULL manifests for ids a ranked discovery
  // already returned, so it is the same act family as `discover_tools` and is
  // filed under DISCOVERY rather than as a generic tool. Like the others it
  // names no venue: its args carry a LIST of toolIds, potentially spanning
  // several namespaces, and one borrowed logo would misreport the rest.
  if (
    name === "execute_tool" ||
    name === "discover_tools" ||
    name === "describe_tools"
  ) {
    const isDiscovery = name === "discover_tools" || name === "describe_tools";
    return protocolIdentity(parseToolId(toolArgs), name, isDiscovery);
  }

  if (name.startsWith("swap_")) {
    const protocol = venueInToolName(name);
    return { protocol, title: withVenue("Swap", protocol), category: "swap" };
  }
  // `bridge` — the PRIMARY mutating bridge alias — carries no `bridge_`
  // prefix (see `action-aliases.ts`), so the exact name is matched too.
  if (name === "bridge" || name.startsWith("bridge_")) {
    const protocol = venueInToolName(name);
    return { protocol, title: withVenue("Bridge", protocol), category: "bridge" };
  }
  if (name.startsWith("khalani_")) {
    return {
      protocol: "khalani",
      title: `Khalani · ${humanizeToolName(name.slice("khalani_".length)).toLowerCase()}`,
      category: "market",
    };
  }
  if (name.startsWith("dexscreener")) {
    return { protocol: "dexscreener", title: "Market data · DexScreener", category: "market" };
  }
  if (name.startsWith("wallet_") || name === "chain_read") {
    return {
      protocol: null,
      title: EXACT_TITLES[name] ?? humanizeToolName(name),
      category: "wallet",
    };
  }
  if (/memory|recall|knowledge/.test(name)) {
    return { protocol: null, title: "Memory recall", category: "memory" };
  }
  if (/web|browse|search|research/.test(name)) {
    return {
      protocol: null,
      title: EXACT_TITLES[name] ?? humanizeToolName(name),
      category: "web",
    };
  }
  return {
    protocol: null,
    title: EXACT_TITLES[name] ?? humanizeToolName(toolName),
    category: "tool",
  };
}
