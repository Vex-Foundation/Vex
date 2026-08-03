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
  isProtocolToolAvailable,
} from "@vex-agent/tools/protocols/catalog.js";
import {
  getGroupedAdvertisedProtocolNavigation,
} from "@vex-agent/tools/protocols/descriptions.js";
import type { ProtocolNamespace, ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import type { BridgeCapabilityView } from "@vex-agent/tools/protocols/khalani/capability-snapshot.js";
import { isProtocolNamespaceAvailable } from "./capability-availability.js";

// ── Auto-generation from manifests ──────────────────────────────

/** How many example toolIds each namespace entry shows (scent, not a menu). */
const EXAMPLE_TOOL_IDS_PER_NAMESPACE = 3;

interface NamespaceSummary {
  /** Tools that pass `isProtocolToolAvailable` RIGHT NOW (env-gated ones drop out). */
  availableCount: number;
  hasMutating: boolean;
  exampleToolIds: string[];
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

function advertisedTools(): readonly ProtocolToolManifest[] {
  return PROTOCOL_TOOLS.filter((tool) =>
    PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(tool.namespace),
  );
}

function buildNamespaceSummaries(): Map<ProtocolNamespace, NamespaceSummary> {
  const byNs = groupByNamespace(advertisedTools());
  const summaries = new Map<ProtocolNamespace, NamespaceSummary>();

  for (const [ns, tools] of byNs) {
    const available = tools.filter(isProtocolToolAvailable);
    summaries.set(ns, {
      availableCount: available.length,
      hasMutating: available.some(t => t.mutating),
      exampleToolIds: available.slice(0, EXAMPLE_TOOL_IDS_PER_NAMESPACE).map(t => t.toolId),
    });
  }

  return summaries;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Cached result, keyed by an AVAILABILITY FINGERPRINT rather than built once
 * per process.
 *
 * `process.env` is NOT stable for the lifetime of the process: unlocking or
 * locking the local secret vault sets and deletes provider keys in-place
 * (`src/lib/local-secret-vault/env.ts`), which flips `isProtocolToolAvailable`
 * for every `requiresEnv` manifest. A process-lifetime cache would keep serving
 * counts from whichever posture happened to render first. The fingerprint is
 * the sorted list of `requiresEnv` names that are PRESENT — env NAMES only,
 * never values, so no secret material reaches this module's state. A mid-session
 * key change rebuilds this layer once (and busts the KV-cache prefix once),
 * which is the correct trade for telling the model the truth.
 */
let cached: { fingerprint: string; text: string } | null = null;

/** Sorted, non-secret list of `requiresEnv` names currently satisfied. */
export function protocolAvailabilityFingerprint(): string {
  const present = new Set<string>();
  for (const tool of advertisedTools()) {
    if (tool.lifecycle !== "active") continue;
    if (!tool.requiresEnv) continue;
    if (!process.env[tool.requiresEnv]?.trim()) continue;
    present.add(tool.requiresEnv);
  }
  return [...present].sort().join(",");
}

export function buildProtocolsPrompt(): string {
  const fingerprint = protocolAvailabilityFingerprint();
  if (cached && cached.fingerprint === fingerprint) return cached.text;

  const summaries = buildNamespaceSummaries();
  const totalAvailable = [...summaries.values()].reduce((sum, s) => sum + s.availableCount, 0);
  const lines: string[] = [];

  lines.push("# Available Protocol Namespaces");
  lines.push("");
  lines.push(`Total: ${totalAvailable} protocol actions across ${summaries.size} namespaces.`);
  lines.push(
    "This is a MAP, not a call menu: it tells you which namespace to search. The toolIds below are real, but their parameter schemas are not shown here — call `discover_tools(query=\"...\", namespace=\"...\")` to get the schema you build the call from.",
  );
  lines.push("");

  // Heading discipline (P3 style contract): layer H1 → group H2 → namespace H3.
  // Fixes the former inversion where namespaces (##) outranked their group (###).
  for (const group of getGroupedAdvertisedProtocolNavigation()) {
    lines.push(`## ${group.groupLabel}`);
    lines.push("");

    for (const metadata of group.namespaces) {
      const summary = summaries.get(metadata.namespace);
      // A namespace is PRESERVED even at zero available actions (its absence
      // would read as "this capability does not exist" instead of "a key is
      // missing"); only a namespace with no cataloged tools at all is skipped.
      if (!summary) continue;

      lines.push(`### ${metadata.namespace} — \`${metadata.namespace}.*\` · ${summary.availableCount} actions`);
      lines.push(metadata.summary);
      lines.push(`Use when: ${metadata.whenToUse}`);
      if (metadata.preferInstead) {
        lines.push(`Use instead: ${metadata.preferInstead}`);
      }
      if (summary.availableCount === 0) {
        lines.push("None of these actions are available in this install — a required API key is not configured. Do not call them.");
      } else {
        lines.push(`Examples: ${summary.exampleToolIds.join(", ")}`);
        if (summary.hasMutating) {
          lines.push("Contains mutating tools (may require approval).");
        }
        // P1: the navigation entries already author `facets` (what the
        // namespace actually DOES, in sub-capabilities) and `exampleQueries`
        // (how to reach them through discovery). Both were authored for this
        // layer and then never rendered, so a cold model saw a namespace
        // one-liner and three toolIds and could not tell that e.g. launching a
        // token exists at all. One line per facet, one `Try:` line per
        // namespace — verbatim, deterministic, no counts.
        for (const facet of metadata.facets) {
          lines.push(`- ${facet.label} — ${facet.summary}`);
        }
        if (metadata.exampleQueries.length > 0) {
          lines.push(`Try: ${metadata.exampleQueries.join(" · ")}`);
        }
      }
      lines.push("");
    }
  }

  // ── Swap Venue Routing (Wave 2c) — STATIC swap-venue policy, lands WITH the
  // tools it describes. Imperative rules; no live data (KV-cache safe). The
  // BRIDGE routing section is DYNAMIC (live Khalani `/v1/chains` list) and
  // renders as a per-turn layer via `buildBridgeCapabilityPrompt` — deliberately
  // NOT here, so nothing mutable sits behind this permanent cache (R13/B7).
  lines.push("## Swap Venue Routing");
  lines.push("");
  lines.push("Swap venue by chain:");
  lines.push("- On KyberSwap-supported EVM chains, prefer `kyberswap.*` (aggregated pricing plus honeypot/fee-on-transfer flags).");
  lines.push("- If KyberSwap cannot route a swap (no aggregator support for the chain, a route/token-not-found class failure, or the swap execute transaction reverting on-chain), its failure output tells you a backup venue is now available for this session and how to reach it — do not try to reach it yourself. Only that specific failure output unlocks it, and only as a QUOTE candidate: request a fresh quote from the backup venue before considering execution, and never resubmit the identical failing KyberSwap route. A bad KyberSwap price quote is never a trigger by itself.");
  lines.push("- On Robinhood Chain (4663), `kyberswap.*` is primary (provisional aggregator support). $VEX and other Virtuals agent tokens trade against VIRTUAL there, so route through VIRTUAL (or WETH) as the base pair.");
  lines.push("- Robinhood caution: KyberSwap's indexed reserves can be stale on thin pairs there. A quote whose priceImpact is strongly NEGATIVE (output supposedly worth more than input), or an execute reverting with 'Return amount is not enough', means the quote overestimated the pool — do NOT retry with higher slippage; re-quote, or tell the user KyberSwap's pricing looks unreliable for this pair.");
  lines.push("- Trench exception, Robinhood Chain (4663): a Trench Express token that is still on its bonding curve trades ONLY against ETH on that curve — quote with `trench.trade_quote`, then execute with `trench.trade_execute`. `kyberswap.*` has no route for a curve token, so a failed swap quote there is not evidence the token is untradeable. Once a Trench token GRADUATES it leaves the curve for a WETH-paired pool and the normal venue rules apply again.");
  lines.push("- Quote and execute on the SAME venue: a swap execute runs only against a fresh quote from the exact venue it will broadcast on (same rule for any revealed backup venue, not just `kyberswap`). The runtime enforces this.");
  lines.push("");

  // ── Trench Launch doctrine — the launch path was invisible to a cold model:
  // the tools existed in the catalog but nothing told it the ORDER, that the
  // image comes from the user, or which call spends. Static, imperative, no
  // live data (KV-cache safe).
  lines.push("## Trench Launch");
  lines.push("");
  lines.push("Launching a token on Trench Express (Robinhood Chain, 4663) spends real ETH and cannot be undone. The path is fixed:");
  lines.push("- PLANNING starts at `trench.images`: a launch REQUIRES an image the user pre-staged in the app and you can never supply one. If the locker is empty, do not improvise around it — ask the user to upload an image to the Trench Photos card, then continue.");
  lines.push("- `trench.launch_preview` is this path's preview under the `# Safety Contract`'s fresh-quote rule: it dry-runs the launch and reports the predicted token address, the creation fee, the 25 bps Vex fee (a separate transfer that runs only after the launch confirms), and the gas cost. Preview in the same turn you intend to execute.");
  // HONESTY GATE (updated 2026-08-02, Fala B): the form bullet now describes
  // WIRED behavior. `ProtocolExecutionContext.toolCallId` is threaded by the
  // dispatcher, the handler drafts the intent and parks the run on
  // `paused_user_form`, and `resumeAgentAfterUserForm` appends the outcome as
  // this call's result on every terminal branch — deployed, refused, dismissed,
  // expired (`engine/core/launch-form-resume.ts`). The parking/resume promise is
  // therefore true, and the model must be told, or it will call the tool again
  // while the form is open or narrate a launch that has not happened.
  //
  // THE EXECUTE BULLET STATES THE FULL AUTHORITY MATRIX (owner decrees
  // 2026-08-02). Full-permission chat executes directly — a live session proved
  // the old mission-only doctrine wrong when a full-mode user was refused for
  // lacking mission provenance. Restricted refuses and routes to the FORM,
  // which replaces the approval card there (a launch never produces both).
  // Mission still refuses while a contract carries no host-authored ceilings
  // (the contract editor that authors them is a later wave). Every refusal is
  // SAFE (nothing created, no funds moved); the failure mode to prevent is the
  // model improvising a launch by another route.
  lines.push("- `trench.launch_request_form` is how you hand the launch DECISION to the human: it asks them to fill in the launch form instead of you choosing the token's details. It spends nothing and creates nothing — it drafts the launch and parks the turn. The runtime resumes you with the outcome as this call's result when the user deploys, dismisses the form, or it expires, so do not call it again while the form is open and never assume the launch happened. Never improvise a launch another way.");
  lines.push("- `trench.launch_execute` signs and broadcasts the launch irreversibly, and only under explicit authority. In a FULL-permission chat session that authority is the user's own permission: execute directly, exactly as you would a swap. In a RESTRICTED session it refuses by name — call `trench.launch_request_form` instead, because the launch form is this tool's consent surface and the user's Deploy click is what launches. In a MISSION run the authority is the contract's host-authored launch ceilings; when the contract carries none the tool refuses by name, so report that refusal and tell the user to set the max launch value and max launch count on the contract card. Never look for another way to launch.");
  lines.push("");

  // ── Virtuals Agent Tokens (Wave 3) — static trading doctrine for Virtuals
  // Protocol agent tokens. Imperative rules; no live data (KV-cache safe).
  // `virtuals.*` is read-only research; execution stays on the venue tools.
  lines.push("## Virtuals Agent Tokens");
  lines.push("");
  lines.push("`virtuals.*` is read-only agent-token intelligence — it never executes. Trade through the venue tools:");
  lines.push("- A GRADUATED agent token trades against VIRTUAL on its chain's venue: `swap_quote`/`swap_execute` on EVM chains (Robinhood Chain, Base, Ethereum), `solana.*` on Solana. The `virtuals.get` result's `tradingRoute` hint names the VIRTUAL quote-token address — use it.");
  lines.push("- ANTI-SNIPER: before buying a graduated agent, call `virtuals.get` and check `antiSniper`. NEVER buy while `windowActive` is true — the buy tax starts near 99% at graduation and decays to ~1% over the window. Wait out `remainingSeconds`, or tell the user the token is inside its sniper-protection window.");
  lines.push("- UNDERGRAD means bonding-curve pre-graduation: illiquid, LP not locked, and it may never graduate. Treat UNDERGRAD agents with extreme caution and prefer graduated (AVAILABLE) ones.");
  lines.push("- `isVerified` is an anti-impersonation badge, not a quality or safety signal — never present it as one.");
  lines.push("");

  // ── Fixed Yield (Pendle) (Wave 5) — static doctrine for fixed-yield PT.
  // Imperative rules; no live numbers (KV-cache safe). `pendle.*` spans 11 chains.
  lines.push("## Fixed Yield (Pendle)");
  lines.push("");
  // P8 yield arbiter: "stake" / "earn yield" has no plain staking tool in this
  // install, and the model's fallback was to substitute a swap. Name the two
  // real families instead. The Solana half asks the same availability predicate
  // the dispatcher enforces — recommending `solana.*` without JUPITER_API_KEY
  // sends the model at a refusal.
  const solanaLendingClause = isProtocolNamespaceAvailable("solana")
    ? " and Solana lending/earn is `solana.lend.*`"
    : "";
  lines.push(`There is NO plain staking tool in this install. When the user asks to stake or to earn yield, route by family: term/fixed yield on EVM chains is \`pendle.*\`${solanaLendingClause}. If neither family fits what they asked for, say the capability does not exist — never substitute a swap for a yield position.`);
  lines.push("");
  lines.push("`pendle.*` is fixed-yield across 11 chains (Ethereum, Arbitrum, Base, BSC, and more). A principal token (PT) is a TERM COMMITMENT: buying a PT locks a fixed rate until the market's expiry date. Always pass the `chain` the PT lives on.");
  lines.push("- Buying a PT locks funds until maturity. Exiting EARLY (`pendle.pt.sell`) is market-priced and CAN lose money versus the locked rate — say so before recommending a buy.");
  lines.push("- A MATURED PT redeems ~1:1 to its accounting asset via `pendle.pt.redeem`; value a matured PT at face, never at the underlying spot price.");
  lines.push("- A yield token (YT) is the OPPOSITE leg: `pendle.yt.buy` is VARIABLE, leveraged yield exposure that DECAYS TO ZERO at expiry and is worth nothing after it — NOT fixed yield, and it can lose money. Frame YT as a variable-yield bet, never as a guaranteed or fixed return; `pendle.yt.sell` exits early at the market price.");
  lines.push("- `pendle.claim` sweeps ACCRUED interest and rewards (from held YTs and LP positions) to the wallet WITHOUT closing any position — it moves only income, never principal.");
  lines.push("- `pendle.py.mint` splits ONE token into BOTH an equal PT and YT in a single transaction; `pendle.py.redeem` burns an EQUAL PT+YT pair back to a token BEFORE expiry. Both need a fresh matching `pendle.py.quote`; a MATURED PT (PT only, no YT) uses `pendle.pt.redeem` instead.");
  lines.push("- `pendle.lp.add` provides single-token liquidity (one token → the market's LP), which earns swap fees and rewards; `pendle.lp.remove` burns the LP back to one token. LP is NOT a fixed-rate lock: after expiry it stops earning and only the principal side remains removable. Both need a fresh matching `pendle.lp.quote`; approval-gated.");
  lines.push("- SY is Pendle's standardised-yield form of a yield-bearing asset — the token PT and YT are actually minted from. `pendle.sy.mint` wraps a plain ERC-20 into SY; `pendle.sy.redeem` unwraps SY back to a plain ERC-20. Neither buys a PT (`pendle.pt.buy`) nor mints a PT+YT pair (`pendle.py.mint`) — do not substitute one for the other.");
  lines.push("- `pendle.sy.redeem` is the FALLBACK-SY UNWRAP: when `pendle.pt.redeem` cannot reach Pendle's pricing service it falls back to a direct Router redeem that pays SY, NOT the market's underlying, and reports it as `deliveredAsset`. That exit is NOT finished — pass that `deliveredAsset` to `pendle.sy.redeem` as `sy` to convert it, and tell the user that is what happened rather than reporting the redeem as complete.");
  lines.push("- MOVING A TERM IS ITS OWN ACTION, not a sell followed by a buy. When a user wants to EXTEND a fixed rate, roll a maturing position, chase a better rate, or change maturity, reach for `pendle.pt.rollover` (PT → a later-expiry PT of another market) — it never puts the underlying in the wallet in between, and it reports the implied APY BEFORE and AFTER so you can say whether the roll actually improves the rate. Do not manufacture the same outcome from `pendle.pt.sell` + `pendle.pt.buy`. `pendle.lp.transfer` is the same primitive for liquidity (LP → another market's LP). For all of these the SOURCE may be MATURED — leaving an expired position is exactly the point — but the DESTINATION must be ACTIVE, and a matured destination is refused by name.");
  lines.push("- `pendle.lp.toPt` converts an LP into the SAME market's PT in one step — variable pool exposure traded for that market's fixed rate. There is no underlying to choose: the PT you receive is that market's own, the optional `pt` param is only a CHECK, and a PT from a different underlying is refused rather than silently substituted. It needs an ACTIVE market; a MATURED LP should be withdrawn with `pendle.lp.remove` instead. To reach a DIFFERENT market's PT, use `pendle.lp.transfer` then `pendle.lp.toPt`, or exit and buy.");
  lines.push("- `pendle.lp.removeDual` and `pendle.lp.addKeepYt` each produce TWO instruments where the plain LP tools produce one: removeDual burns the LP into a plain token AND the market's PT, addKeepYt deposits and hands you the LP AND the YT that `pendle.lp.add` would have sold into the pool. Report BOTH legs to the user — describing either as a single-asset result is wrong. Be honest about what does NOT exist: there is NO two-token deposit on Pendle, so addKeepYt is still a SINGLE-token add, and `pendle.lp.transfer` has NO keep-YT variant. Never offer one.");
  lines.push("- The SY, dual-LP and term-mobility tools carry their quote INSIDE the tool instead of a separate `*.quote`: call the SAME toolId first with `dryRun: true`, which prices the route, runs every fund-safety check and records the authorization, then repeat the call with the EXACT same params to broadcast. Without that fresh dry run the broadcast is refused. They are exact-input only — you choose `amountIn` and receive an ESTIMATE out, never a guaranteed output — and they take ERC-20 addresses only, never native currency.");
  lines.push("- Before quoting an unfamiliar market, read it with `pendle.market.get` (by market, PT or YT address): it returns the legs, expiry, the tokens the market ACCEPTS, and Pendle's own current rates — passing a token that is not on those lists is the most common Pendle rejection. It is also the only Pendle read that resolves a MATURED market, which returns no live rates.");
  lines.push("- `pendle.market.history` (implied APY / underlying APY / TVL over time) and `pendle.market.candles` (PT, YT or LP price candles) answer whether today's rate is high or low for that market — a rate is never high or low on its own. `pendle.prices.assets` prices Pendle assets the wallet does not hold; both are display marks, never an executable quote.");
  lines.push("- `pendle.orderbook` shows resting limit orders. Vex quotes and trades through Pendle's AMM ONLY, so that depth is the price quality being forgone and Vex CANNOT fill it — never promise a user a price from it.");
  lines.push("- `pendle.rewards.merkle` reads campaign/incentive rewards accrued to the wallet. Vex can NEVER claim them: Pendle publishes the amount but not the proof a claim needs. Say so and point the user to app.pendle.finance; `pendle.claim` is for the accrued interest and rewards Vex can actually sweep.");
  lines.push("- NEVER present points as yield. A `pointsWarning` on a market means it pays speculative points, not a guaranteed return.");
  lines.push("- Check liquidity before sizing — thin markets mean high price impact on exit. Always preview with `pendle.pt.quote` (or `pendle.yt.quote` for YT) first; PT/YT buy/sell/redeem require a fresh matching quote and are approval-gated.");
  lines.push("");

  // ── Bridge Routing doctrine (STATIC half) — the invariant provider rules
  // that used to be re-sent on every turn inside `buildBridgeCapabilityPrompt`.
  // The LIVE Khalani chain list and the Relay-health-gated Robinhood line stay
  // in that turn layer; nothing mutable belongs behind this cache.
  lines.push("## Bridge Routing");
  lines.push("");
  lines.push("- Between two Khalani-supported chains, bridge with `bridge_quote` then `bridge` (they auto-route to `khalani.*`). The live chain list is in the turn state.");
  lines.push("- Quote and execute on the SAME bridge provider (`khalani` or `relay`). The runtime enforces this.");
  lines.push("- Reads on Robinhood Chain go direct-RPC: `wallet_balances` for balances, `chain_read` for tx receipts / ERC-721 mints (alias `robinhood` / id 4663). `khalani.tokens.balances` does NOT cover it.");
  lines.push("");

  cached = { fingerprint, text: lines.join("\n") };
  return cached.text;
}

/**
 * DYNAMIC bridge-routing turn layer (R13 / B7). The Khalani chain list is a LIVE
 * single-flight snapshot, so this renders per-turn as turn-state — NEVER behind
 * `buildProtocolsPrompt()`'s permanent cache. Pure render: the caller resolves
 * the snapshot view via `getBridgeCapabilityView()` and passes it here.
 *
 * - available: the derived Khalani chain list; a staleness note when the snapshot
 *   is over an hour old.
 * - unavailable (cold start / >24 h): the conservative fallback line only.
 * - the "Robinhood Chain (4663): bridges via Relay only" line appears ONLY when
 *   the Relay `/chains` health gate passed in the snapshot.
 *
 * Relay's general chain catalog is NEVER enumerated here — that would defeat the
 * hidden Relay fallback (dossier §3).
 */
export function buildBridgeCapabilityPrompt(view: BridgeCapabilityView): string {
  const lines: string[] = [];
  // H1: one heading per turn layer (the invariant provider rules moved to the
  // `## Bridge Routing` doctrine section of the static prefix).
  lines.push("# Bridge Routing");
  lines.push("");
  if (view.kind === "available") {
    lines.push(`Bridge-supported chains (Khalani): ${view.chainNames.join(", ")}.`);
    if (view.stale) {
      lines.push(
        "(This bridge chain list may be up to a day old — confirm a route by quoting before relying on it.)",
      );
    }
  } else {
    lines.push("Bridge chain list unavailable — verify by quoting.");
  }
  if (view.kind === "available" && view.robinhoodViaRelay) {
    lines.push("Robinhood Chain (4663): bridges via Relay only.");
    lines.push(
      // P7: this line used to send the model at `relay.*` directly, contradicting
      // the shortcut table in `# Tool Model` (`bridge_quote`/`bridge` auto-route
      // to Relay for 4663). One route, named once.
      "- To fund Robinhood Chain, bridge ETH, USDG, or VIRTUAL in with `bridge_quote` then `bridge` (they auto-route to Relay for this chain), then swap on-chain with `swap_quote`/`swap_execute`; reverse the flow to exit.",
    );
  }
  return lines.join("\n");
}

/** For testing — reset cached prompt. */
export function resetProtocolsPromptCache(): void {
  cached = null;
}
