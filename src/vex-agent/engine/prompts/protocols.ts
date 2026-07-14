/**
 * Protocol prompt — constant layer, always present.
 *
 * Auto-generated from protocol manifests plus shared navigation metadata.
 * The prompt intentionally exposes product groups and "when to use" guidance
 * instead of heuristic toolId families.
 */

import {
  PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST,
  PROTOCOL_TOOLS,
} from "@vex-agent/tools/protocols/catalog.js";
import {
  getGroupedAdvertisedProtocolNavigation,
} from "@vex-agent/tools/protocols/descriptions.js";
import type { ProtocolNamespace, ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import {
  getVisibleHypervexingAliasTools,
} from "@vex-agent/tools/hypervexing-aliases.js";
import { isHlWorkspaceModeActive } from "../../../lib/hyperliquid-workspace-mode.js";
import { resolveHlPolicy, type HlPolicyScope } from "../../../lib/hyperliquid-policy.js";
import type { ToolVisibilityContext } from "@vex-agent/tools/registry.js";

// ── Auto-generation from manifests ──────────────────────────────

interface NamespaceSummary {
  toolCount: number;
  hasMutating: boolean;
}

function groupByNamespace(
  tools: readonly ProtocolToolManifest[],
): Map<ProtocolNamespace, ProtocolToolManifest[]> {
  const map = new Map<ProtocolNamespace, ProtocolToolManifest[]>();
  for (const t of tools) {
    const arr = map.get(t.namespace) ?? [];
    arr.push(t);
    map.set(t.namespace, arr);
  }
  return map;
}

function buildNamespaceSummaries(): Map<ProtocolNamespace, NamespaceSummary> {
  const byNs = groupByNamespace(
    PROTOCOL_TOOLS.filter((tool) => PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(tool.namespace)),
  );
  const summaries = new Map<ProtocolNamespace, NamespaceSummary>();

  for (const [ns, tools] of byNs) {
    summaries.set(ns, {
      toolCount: tools.length,
      hasMutating: tools.some(t => t.mutating),
    });
  }

  return summaries;
}

// ── Public API ──────────────────────────────────────────────────

/** Cached result — built once per process. */
let cached: string | null = null;

/**
 * Per-turn Hypervexing state. Its aliases come from the same session +
 * pressure projection as the Tool Map, so prompt text never advertises a
 * release-gated or pressure-filtered capability.
 */
export function buildHypervexingTurnStatePrompt(
  visibility: ToolVisibilityContext,
  policyScope: HlPolicyScope = {},
): string {
  if (!isHlWorkspaceModeActive(visibility.sessionId)) {
    return "Hypervexing workspace: not active. Offer `hyperliquid_enter` when the user wants to trade Hyperliquid perps; do not push it otherwise.";
  }

  const aliases = getVisibleHypervexingAliasTools(
    visibility.sessionId,
    visibility.contextUsageBand,
  );
  const lines = [
    "Hypervexing workspace: ACTIVE for this session.",
    "",
    "## Hypervexing compact Hyperliquid index",
    "",
    aliases.length > 0
      ? `Currently callable direct aliases: ${aliases.map((tool) => tool.name).join(", ")}.`
      : "No Hypervexing direct aliases are currently callable.",
    "For any other Hyperliquid capability, discover with `discover_tools(namespace=\"hyperliquid\")` before execution. Aliases do not bypass any gate.",
    "In this workspace a bare token or ticker mention (\"cashcat?\", \"co z BTC?\") means the HYPERLIQUID market by default — analyze the HL perp (book/candles/funding), not a same-name token on another chain or protocol; leave HL context only when the user explicitly names another chain, protocol, or spot venue.",
    "To check one market, call `perp.markets` with `query=<ticker>` (or `hl_book`) — never conclude a market doesn't exist from a truncated full listing.",
    "These aliases are for YOU, not the user — never list or tabulate them in a reply; after entering the workspace, orient the user in one sentence (account state or what you can now do) and ask what they want.",
  ];

  const policy = resolveHlPolicy(policyScope);
  if (policy.kind === "available") {
    const { leverageCapDefault, requireStopLoss, perOrderNotionalPct, totalNotionalPct } = policy.snapshot.policy;
    lines.push(
      `Active Hyperliquid policy: leverage cap ${leverageCapDefault}x; requireStopLoss=${requireStopLoss}; per-order notional <=${perOrderNotionalPct}%; total notional <=${totalNotionalPct}%.`,
    );
  }

  return lines.join("\n");
}

export function buildProtocolsPrompt(): string {
  if (cached) return cached;

  const advertisedTools = PROTOCOL_TOOLS.filter((tool) =>
    PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(tool.namespace),
  );
  const summaries = buildNamespaceSummaries();
  const lines: string[] = [];

  lines.push("# Available Protocol Namespaces");
  lines.push("");
  lines.push(`Total: ${advertisedTools.length} tools across ${summaries.size} namespaces.`);
  lines.push("Use discover_tools(namespace=...) to explore any namespace.");
  lines.push("");

  // Heading discipline (P3 style contract): layer H1 → group H2 → namespace H3.
  // Fixes the former inversion where namespaces (##) outranked their group (###).
  for (const group of getGroupedAdvertisedProtocolNavigation()) {
    lines.push(`## ${group.groupLabel}`);
    lines.push("");

    for (const metadata of group.namespaces) {
      const summary = summaries.get(metadata.namespace);
      if (!summary || summary.toolCount === 0) continue;

      lines.push(`### ${metadata.namespace}`);
      lines.push(metadata.summary);
      lines.push(`Use when: ${metadata.whenToUse}`);
      if (metadata.preferInstead) {
        lines.push(`Use instead: ${metadata.preferInstead}`);
      }
      lines.push(`Tools: ${summary.toolCount} cataloged.`);
      if (summary.hasMutating) {
        lines.push("Contains mutating tools (may require approval).");
      }
      if (metadata.facets.length > 0) {
        lines.push("Paths:");
        for (const facet of metadata.facets) {
          lines.push(`- ${facet.label}: ${facet.summary}`);
        }
      }
      if (metadata.exampleQueries.length > 0) {
        lines.push("Examples:");
        for (const example of metadata.exampleQueries) {
          lines.push(`  ${example}`);
        }
      }
      lines.push("");
    }
  }

  // ── Venue & Bridge Routing (Wave 2c) — static routing policy, lands WITH the
  // tools it describes. Imperative rules; no live data (KV-cache safe). Mirrors
  // the venue-router policy modules so guidance and code stay aligned.
  lines.push("## Venue & Bridge Routing");
  lines.push("");
  lines.push("Swap venue by chain:");
  lines.push("- On KyberSwap-supported EVM chains, prefer `kyberswap.*` (aggregated pricing plus honeypot/fee-on-transfer flags).");
  lines.push("- If KyberSwap fails or lacks the chain, fall back to `uniswap.*` (best route across Uniswap V2 and V3).");
  lines.push("- On Robinhood Chain (4663), `kyberswap.*` is primary (provisional aggregator support) with `uniswap.*` as the fallback — same rule as other KyberSwap chains. $VEX and other Virtuals agent tokens trade against VIRTUAL there, so route through VIRTUAL (or WETH) as the base pair.");
  lines.push("- Robinhood caution: KyberSwap's indexed reserves can be stale on thin pairs there. A quote whose priceImpact is strongly NEGATIVE (output supposedly worth more than input) or an execute reverting with 'Return amount is not enough' means the quote overestimated the pool — do NOT retry with higher slippage; switch to the `uniswap.*` fallback immediately.");
  lines.push("- Quote and execute on the SAME venue: a `kyberswap` quote authorizes only a `kyberswap` execute, and a `uniswap` quote only a `uniswap` execute. The runtime enforces this.");
  lines.push("");
  lines.push("Bridge venue by chain:");
  lines.push("- Between Khalani-supported chains, use `khalani.*`.");
  lines.push("- Khalani does NOT cover Robinhood Chain — to or from it, use `relay.*`.");
  lines.push("- To fund Robinhood Chain, bridge ETH, USDG, or VIRTUAL in with `relay.*`, then swap on-chain with `kyberswap.*` (fallback `uniswap.*`); reverse the flow to exit.");
  lines.push("- Quote and execute on the SAME bridge provider (`khalani` or `relay`). The runtime enforces this.");
  lines.push("");
  lines.push("Balance reads on Robinhood Chain: `wallet_balances` scans it direct-RPC (alias `robinhood` / id 4663). `khalani_tokens_balances` does NOT cover it.");
  lines.push("");

  // ── Virtuals Agent Tokens (Wave 3) — static trading doctrine for Virtuals
  // Protocol agent tokens. Imperative rules; no live data (KV-cache safe).
  // `virtuals.*` is read-only research; execution stays on the venue tools.
  lines.push("## Virtuals Agent Tokens");
  lines.push("");
  lines.push("`virtuals.*` is read-only agent-token intelligence — it never executes. Trade through the venue tools:");
  lines.push("- A GRADUATED agent token trades on its chain's venue quoted in VIRTUAL: `uniswap.*` on Robinhood Chain, `kyberswap.*` on Base/Ethereum, `solana.*` on Solana. The `virtuals.get` result's `tradingRoute` hint names the exact venue and the VIRTUAL quote-token address — use it.");
  lines.push("- ANTI-SNIPER: before buying a graduated agent, call `virtuals.get` and check `antiSniper`. NEVER buy while `windowActive` is true — the buy tax starts near 99% at graduation and decays to ~1% over the window. Wait out `remainingSeconds`, or tell the user the token is inside its sniper-protection window.");
  lines.push("- UNDERGRAD means bonding-curve pre-graduation: illiquid, LP not locked, and it may never graduate. Treat UNDERGRAD agents with extreme caution and prefer graduated (AVAILABLE) ones.");
  lines.push("- `isVerified` is an anti-impersonation badge, not a quality or safety signal — never present it as one.");
  lines.push("");

  // ── Fixed Yield (Pendle) (Wave 5) — static doctrine for fixed-yield PT.
  // Imperative rules; no live numbers (KV-cache safe). `pendle.*` spans 11 chains.
  lines.push("## Fixed Yield (Pendle)");
  lines.push("");
  lines.push("`pendle.*` is fixed-yield across 11 chains (Ethereum, Arbitrum, Base, BSC, and more). A principal token (PT) is a TERM COMMITMENT: buying a PT locks a fixed rate until the market's expiry date. Always pass the `chain` the PT lives on.");
  lines.push("- Buying a PT locks funds until maturity. Exiting EARLY (`pendle.pt.sell`) is market-priced and CAN lose money versus the locked rate — say so before recommending a buy.");
  lines.push("- A MATURED PT redeems ~1:1 to its accounting asset via `pendle.pt.redeem`; value a matured PT at face, never at the underlying spot price.");
  lines.push("- A yield token (YT) is the OPPOSITE leg: `pendle.yt.buy` is VARIABLE, leveraged yield exposure that DECAYS TO ZERO at expiry and is worth nothing after it — NOT fixed yield, and it can lose money. Frame YT as a variable-yield bet, never as a guaranteed or fixed return; `pendle.yt.sell` exits early at the market price.");
  lines.push("- `pendle.claim` sweeps ACCRUED interest and rewards (from held YTs and LP positions) to the wallet WITHOUT closing any position — it moves only income, never principal.");
  lines.push("- `pendle.py.mint` splits ONE token into BOTH an equal PT and YT in a single transaction; `pendle.py.redeem` burns an EQUAL PT+YT pair back to a token BEFORE expiry. Both need a fresh matching `pendle.py.quote`; a MATURED PT (PT only, no YT) uses `pendle.pt.redeem` instead.");
  lines.push("- `pendle.lp.add` provides single-token liquidity (one token → the market's LP), which earns swap fees and rewards; `pendle.lp.remove` burns the LP back to one token. LP is NOT a fixed-rate lock: after expiry it stops earning and only the principal side remains removable. Both need a fresh matching `pendle.lp.quote`; approval-gated.");
  lines.push("- NEVER present points as yield. A `pointsWarning` on a market means it pays speculative points, not a guaranteed return.");
  lines.push("- Check liquidity before sizing — thin markets mean high price impact on exit. Always preview with `pendle.pt.quote` (or `pendle.yt.quote` for YT) first; PT/YT buy/sell/redeem require a fresh matching quote and are approval-gated.");
  lines.push("");

  lines.push("## Hyperliquid Core Perpetuals");
  lines.push("");
  lines.push("`hyperliquid.*` signs exchange actions with the selected EVM master key; it never creates an agent wallet. Read markets, L2 depth, account margin, positions, orders, and funding before proposing a trade.");
  lines.push("- With the default policy, every perp entry has an atomic reduce-only stop-loss child and later a server-side full-position stop. A stop loss is not a guaranteed fill: gaps, liquidation, and venue conditions can still cause losses.");
  lines.push("- If the user explicitly disabled stop-loss protection in settings, warn them that the resulting entry is unprotected before using `perp.open`; the model cannot make or change that setting. A supplied stop always remains protected even under that opt-out.");
  lines.push("- Treat leverage as liquidation risk, not buying power. Stay within the user policy and market maximum, account for funding, and do not cancel the sole protective stop. TWAP scale-ins need a standing full-position stop.");
  lines.push("- When a Hyperliquid position reports `CONSOLIDATING`, use `perp.setTpsl` to consolidate its full-position stop before any other Hyperliquid action.");
  lines.push("- If the user explicitly asks for Hypervexing mode (for example: ‘hypervexing’, ‘uruchom HL’, or ‘enter HL mode’), call `hyperliquid_enter` in THAT turn. Do not merely describe the mode or ask a confirmation question.");
  lines.push("- Before any external Hyperliquid withdrawal or send, show the recipient and amount. First-entry acknowledgment discloses the 0.025% builder fee on filled notional; order flow seeks the venue allowance best-effort and omits the builder field if it is unavailable.");
  lines.push("");

  cached = lines.join("\n");
  return cached;
}

/** For testing — reset cached prompt. */
export function resetProtocolsPromptCache(): void {
  cached = null;
}
