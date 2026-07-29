/**
 * PROTOCOL IDENTITY for a registered tool act (contract C5).
 *
 * Answers two questions a friendly tool card must answer honestly: WHO did
 * this act deal with (a protocol key `resolveProtocolMark` can turn into a
 * mark) and WHAT was it (a human title instead of a raw snake_case symbol).
 *
 * Two signals, in priority order:
 *
 *  1. The TOOL NAME prefix map. The engine's tool vocabulary is a closed set
 *     written by us (`swap_*`, `bridge_*`, `khalani_*`, `wallet_*`,
 *     `chain_read`, `*memory*`, `web_research`…), so a prefix match is proof,
 *     not a guess.
 *  2. For the two GENERIC wrappers (`execute_tool` / `discover_tools`) the
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
};

/** snake_case / colon symbol → "Sentence case words" (bounded, lossless-ish). */
function humanizeToolName(name: string): string {
  const words = name.replace(/[_:.]+/g, " ").trim();
  if (words.length === 0) return "Tool call";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Parse the sanitized args JSON and return the `toolId` NAMESPACE (the segment
 * before the first "."). Fail-closed at every step: a truncated payload (the
 * 2000-char DTO cap), an array, a primitive, a missing/empty/non-string
 * `toolId`, or a namespace that is not a plain lower-case identifier all
 * return `null`, so a generic wrapper simply shows no venue.
 */
export function parseToolIdNamespace(toolArgs: string | null): string | null {
  if (toolArgs === null || toolArgs.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolArgs);
  } catch {
    return null; // truncated or malformed — never guess the tail
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const toolId = (parsed as Record<string, unknown>)["toolId"];
  if (typeof toolId !== "string" || toolId.length === 0) return null;
  const namespace = toolId.split(".")[0] ?? "";
  return /^[a-z][a-z0-9_]*$/.test(namespace) ? namespace : null;
}

/** Action words of a `toolId` after its namespace, humanized ("Swap quote"). */
function toolIdAction(toolArgs: string | null): string | null {
  if (toolArgs === null) return null;
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
  if (typeof toolId !== "string") return null;
  const rest = toolId.split(".").slice(1).join(" ");
  return rest.length === 0 ? null : humanizeToolName(rest);
}

/**
 * Identity for the `execute_tool` / `discover_tools` generic wrappers.
 *
 * The namespace comes from UNTRUSTED args text, so it is admitted ONLY when
 * `isCuratedProtocol` recognises it (Codex review round 2 finding 1). Syntactic
 * validity is not provenance: `{"toolId":"kyberswapp.swap"}` would otherwise
 * have earned a "Kyberswapp ·" title and a venue-looking monogram ring, which
 * is a lie about who the agent dealt with. An unknown namespace falls through
 * to the wrapper's own honest generic presentation.
 */
function genericWrapperIdentity(
  toolName: string,
  toolArgs: string | null,
): ToolIdentity {
  const parsedNamespace = parseToolIdNamespace(toolArgs);
  const protocol = isCuratedProtocol(parsedNamespace) ? parsedNamespace : null;
  const label = venueLabel(protocol);
  const action = toolIdAction(toolArgs);
  const category: ToolCategory =
    toolName === "discover_tools" ? "discovery" : "tool";
  if (label === null) {
    // Fail-closed: no proven venue → the wrapper's own honest name.
    return {
      protocol: null,
      title: EXACT_TITLES[toolName] ?? humanizeToolName(toolName),
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
  const name = toolName.toLowerCase();

  if (name === "execute_tool" || name === "discover_tools") {
    return genericWrapperIdentity(name, toolArgs);
  }

  if (name.startsWith("swap_")) {
    const protocol = venueInToolName(name);
    return { protocol, title: withVenue("Swap", protocol), category: "swap" };
  }
  if (name.startsWith("bridge_")) {
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
