/**
 * TODAY'S CONVENTION DEBT — every violation the tree currently carries.
 *
 * The linter lands with the whole fleet already out of convention. Rather than
 * ship a red suite (which nobody can act on) or a weak rule (which nobody can
 * tighten later), each existing violation is recorded here ONCE, with the tool
 * that owns it and why it is still here.
 *
 * THE CONTRACT:
 *   - the suite is green while every live violation is listed here;
 *   - a NEW violation is not listed, so it fails immediately;
 *   - a migration wave DELETES the entries it fixes — entries are never added
 *     by a wave, only removed;
 *   - a stale entry (listed but no longer violated) also fails, so the list
 *     cannot rot into a permanent exemption;
 *   - SUBJECT REWRITE, the one operation that is neither an add nor a delete:
 *     a rename wave MAY rewrite an entry's `subject` to the renamed tool's new
 *     canonical name in the same change that renames it, provided the rewrite
 *     is provably 1:1 - the entry count does not change, no `rule` or `detail`
 *     changes, and no new violation appears. Without it the first internal
 *     rename strands every entry keyed on an old name as simultaneously stale
 *     and unfixable, with no legal action available.
 *
 * The length of this table is the fleet's convention debt. It is only allowed
 * to shrink.
 */

import type { ManifestLintIssue, ManifestLintRule } from "./rules.js";

export interface ManifestLintAllowlistEntry {
  /** Tool id, tool name, or repo-relative source path. */
  readonly subject: string;
  readonly rule: ManifestLintRule;
  /** The param key, literal, or source text this entry excuses. */
  readonly detail: string;
  /** Why it is still here — usually the wave that will delete this line. */
  readonly reason: string;
}

/** Stable identity of one violation, shared by the linter and this table. */
export function allowlistKey(issue: ManifestLintIssue | ManifestLintAllowlistEntry): string {
  return `${issue.subject}::${issue.rule}::${issue.detail}`;
}

export const MANIFEST_LINT_ALLOWLIST: readonly ManifestLintAllowlistEntry[] = [
  // ── amount-bps-shape (7) ──
  // amount/bps shape — an amount typed number, or a key with no In/Out/Raw suffix, or a bps param missing type number + unit "bps".
  { subject: "BridgeExecuteRelay", rule: "amount-bps-shape", detail: "slippageBps", reason: "pre-convention amount/bps declaration; deleted by W3/W5" },
  { subject: "BridgeQuoteRelay", rule: "amount-bps-shape", detail: "slippageBps", reason: "pre-convention amount/bps declaration; deleted by W3/W5" },
  { subject: "solana.predict.buy", rule: "amount-bps-shape", detail: "amountUsdc", reason: "pre-convention amount/bps declaration; deleted by W3/W5" },
  { subject: "SwapExecute", rule: "amount-bps-shape", detail: "slippageBps", reason: "pre-convention amount/bps declaration; deleted by W3/W5" },
  { subject: "SwapExecuteUniswap", rule: "amount-bps-shape", detail: "slippageBps", reason: "pre-convention amount/bps declaration; deleted by W3/W5" },
  { subject: "SwapQuote", rule: "amount-bps-shape", detail: "slippageBps", reason: "pre-convention amount/bps declaration; deleted by W3/W5" },
  { subject: "SwapQuoteUniswap", rule: "amount-bps-shape", detail: "slippageBps", reason: "pre-convention amount/bps declaration; deleted by W3/W5" },

  // ── chain-doc-parity (55) ──
  // chain-doc parity — the param does not carry CANONICAL_CHAIN_SENTENCE, so the alias lane and the protocol lane document different accepted formats.
  { subject: "BridgeExecute", rule: "chain-doc-parity", detail: "fromChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeExecute", rule: "chain-doc-parity", detail: "toChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeExecuteRelay", rule: "chain-doc-parity", detail: "fromChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeExecuteRelay", rule: "chain-doc-parity", detail: "toChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeQuote", rule: "chain-doc-parity", detail: "fromChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeQuote", rule: "chain-doc-parity", detail: "toChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeQuoteRelay", rule: "chain-doc-parity", detail: "fromChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeQuoteRelay", rule: "chain-doc-parity", detail: "toChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeStatus", rule: "chain-doc-parity", detail: "fromChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "BridgeStatus", rule: "chain-doc-parity", detail: "toChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "khalani.bridge", rule: "chain-doc-parity", detail: "fromChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "khalani.bridge", rule: "chain-doc-parity", detail: "toChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "khalani.orders.list", rule: "chain-doc-parity", detail: "fromChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "khalani.orders.list", rule: "chain-doc-parity", detail: "toChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "khalani.quote.get", rule: "chain-doc-parity", detail: "fromChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "khalani.quote.get", rule: "chain-doc-parity", detail: "toChain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "kyberswap.swap.execute", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "kyberswap.swap.quote", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "kyberswap.tokens.check", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.claim", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.lp.add", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.lp.addKeepYt", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.lp.quote", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.lp.remove", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.lp.removeDual", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.lp.toPt", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.lp.transfer", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.market.candles", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.market.get", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.market.history", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.orderbook", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.prices.assets", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.pt.buy", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.pt.quote", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.pt.redeem", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.pt.rollover", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.pt.sell", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.py.mint", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.py.quote", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.py.redeem", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.rewards.merkle", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.sy.mint", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.sy.redeem", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.yt.buy", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.yt.quote", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "pendle.yt.sell", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "SwapExecute", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "SwapExecuteUniswap", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "SwapQuote", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "SwapQuoteUniswap", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "TokenCheck", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "trench.trade_execute", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "trench.trade_quote", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "WalletSendPrepare", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },
  { subject: "WalletTrackToken", rule: "chain-doc-parity", detail: "chain", reason: "chain description predates CANONICAL_CHAIN_SENTENCE; deleted by W8" },

  // ── enum-declaration (27) ──
  // enum declaration — the accepted values are listed in prose only; ProtocolParamDef.enum does not exist yet.
  { subject: "kyberswap.swap.execute", rule: "enum-declaration", detail: "slippageBps", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "kyberswap.swap.quote", rule: "enum-declaration", detail: "slippageBps", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.claim", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.lp.add", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.lp.addKeepYt", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.lp.quote", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.lp.remove", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.lp.removeDual", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.lp.toPt", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.lp.transfer", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.market.get", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.market.get", rule: "enum-declaration", detail: "market", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.pt.buy", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.pt.quote", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.pt.redeem", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.pt.rollover", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.pt.sell", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.py.mint", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.py.quote", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.py.redeem", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.sy.mint", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.sy.redeem", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.yt.buy", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.yt.quote", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "pendle.yt.sell", rule: "enum-declaration", detail: "chain", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "uniswap.swap.execute", rule: "enum-declaration", detail: "slippageBps", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },
  { subject: "uniswap.swap.quote", rule: "enum-declaration", detail: "slippageBps", reason: "ProtocolParamDef.enum does not exist yet; deleted by W7" },

  // ── exclusive-param-groups (5) ──
  // XOR declaration — the exclusion is prose only; ProtocolToolManifest.exclusiveParamGroups does not exist yet.
  { subject: "pendle.market.get", rule: "exclusive-param-groups", detail: "market", reason: "exclusiveParamGroups does not exist yet; deleted by W7" },
  { subject: "solana.swap.execute", rule: "exclusive-param-groups", detail: "dexes", reason: "exclusiveParamGroups does not exist yet; deleted by W7" },
  { subject: "solana.swap.execute", rule: "exclusive-param-groups", detail: "excludeDexes", reason: "exclusiveParamGroups does not exist yet; deleted by W7" },
  { subject: "solana.swap.quote", rule: "exclusive-param-groups", detail: "dexes", reason: "exclusiveParamGroups does not exist yet; deleted by W7" },
  { subject: "solana.swap.quote", rule: "exclusive-param-groups", detail: "excludeDexes", reason: "exclusiveParamGroups does not exist yet; deleted by W7" },

  // ── generic-error-literal (4) ──
  // generic error literals — agent-facing text that says nothing the agent can act on.
  { subject: "src/vex-agent/tools/protocols/pendle/handlers/read-shared.ts", rule: "generic-error-literal", detail: "unexpected error", reason: "generic agent-facing literal; deleted by the error-contract waves (W1/W2)" },
  { subject: "src/vex-agent/tools/protocols/pendle/handlers/shared.ts", rule: "generic-error-literal", detail: "unexpected error", reason: "generic agent-facing literal; deleted by the error-contract waves (W1/W2)" },
  { subject: "src/vex-agent/tools/protocols/trench/handlers/failure.ts", rule: "generic-error-literal", detail: "unexpected error", reason: "generic agent-facing literal; deleted by the error-contract waves (W1/W2)" },
  { subject: "src/vex-agent/tools/protocols/virtuals/handlers.ts", rule: "generic-error-literal", detail: "unexpected error", reason: "generic agent-facing literal; deleted by the error-contract waves (W1/W2)" },

  // ── param-description (26) ──
  // param descriptions — under the 25-char minimum, or missing a unit anchor / decimals source.
  { subject: "BridgeExecute", rule: "param-description", detail: "fromToken", reason: "param description predates the description template; deleted by W8" },
  { subject: "BridgeQuote", rule: "param-description", detail: "fromToken", reason: "param description predates the description template; deleted by W8" },
  { subject: "BridgeStatus", rule: "param-description", detail: "fromChain", reason: "param description predates the description template; deleted by W8" },
  { subject: "BridgeStatus", rule: "param-description", detail: "limit", reason: "param description predates the description template; deleted by W8" },
  { subject: "BridgeStatus", rule: "param-description", detail: "toChain", reason: "param description predates the description template; deleted by W8" },
  { subject: "khalani.bridge", rule: "param-description", detail: "fromToken", reason: "param description predates the description template; deleted by W8" },
  { subject: "khalani.orders.get", rule: "param-description", detail: "orderId", reason: "param description predates the description template; deleted by W8" },
  { subject: "khalani.orders.list", rule: "param-description", detail: "fromChain", reason: "param description predates the description template; deleted by W8" },
  { subject: "khalani.orders.list", rule: "param-description", detail: "toChain", reason: "param description predates the description template; deleted by W8" },
  { subject: "khalani.quote.get", rule: "param-description", detail: "fromToken", reason: "param description predates the description template; deleted by W8" },
  { subject: "khalani.tokens.autocomplete", rule: "param-description", detail: "keyword", reason: "param description predates the description template; deleted by W8" },
  { subject: "kyberswap.swap.execute", rule: "param-description", detail: "chain", reason: "param description predates the description template; deleted by W8" },
  { subject: "kyberswap.swap.quote", rule: "param-description", detail: "chain", reason: "param description predates the description template; deleted by W8" },
  { subject: "kyberswap.tokens.check", rule: "param-description", detail: "chain", reason: "param description predates the description template; deleted by W8" },
  { subject: "solana.predict.buy", rule: "param-description", detail: "side", reason: "param description predates the description template; deleted by W8" },
  { subject: "solana.predict.leaderboards", rule: "param-description", detail: "limit", reason: "param description predates the description template; deleted by W8" },
  { subject: "solana.predict.orderbook", rule: "param-description", detail: "marketId", reason: "param description predates the description template; deleted by W8" },
  { subject: "SwapExecuteUniswap", rule: "param-description", detail: "chain", reason: "param description predates the description template; deleted by W8" },
  { subject: "SwapQuoteUniswap", rule: "param-description", detail: "chain", reason: "param description predates the description template; deleted by W8" },
  { subject: "trench.trade_execute", rule: "param-description", detail: "chain", reason: "param description predates the description template; deleted by W8" },
  { subject: "trench.trade_quote", rule: "param-description", detail: "chain", reason: "param description predates the description template; deleted by W8" },
  { subject: "WalletSendConfirm", rule: "param-description", detail: "intentId", reason: "param description predates the description template; deleted by W8" },
  { subject: "WalletSendPrepare", rule: "param-description", detail: "to", reason: "param description predates the description template; deleted by W8" },
  { subject: "WalletTrackToken", rule: "param-description", detail: "chain", reason: "param description predates the description template; deleted by W8" },

  // ── param-key (0) ──
  // param keys - either a BANNED spelling or a key not yet in CANONICAL_PARAM_KEYS.
  //
  // EMPTY since owner decision D15 (2026-08-22): the 141 keys that had no
  // canonical target were RATIFIED into CANONICAL_PARAM_KEYS (325 rows), and the
  // four rows whose key was a BANNED spelling were RENAMED on their tools, all
  // six of them reads carrying an input alias for the retired spelling
  // (`ProtocolParamDef.aliases`). The heading stays so the next `param-key`
  // violation is visibly a NEW one rather than a re-opened backlog.
  // pools.fun (2026-08-18). These six keys are the FLEET's existing screening
  // spellings, carried here on purpose: `sortBy` has 14 rows above, `query` 5,
  // `minMarketCapUsd` 5, `maxMarketCapUsd` 4, `cursor` 2, `order` 1. Spelling a
  // new tool differently would have avoided six rows at the cost of making the
  // list vocabulary inconsistent for the agent, and canonicalizing them would
  // have silently retired a fleet-wide rename. They are deleted by the SAME
  // rename wave as their siblings, not separately. Every other pools param key
  // is new vocabulary and lives in CANONICAL_PARAM_KEYS instead.
  // The launch FIELD vocabulary, shared verbatim with the trench launch tools
  // (`name`, `symbol`, `prebuy` already carry rows there). Spelling a pools
  // launch form differently from the trench one would make the desktop lane
  // translate between two vocabularies for the same fields.

  // ── slippage-default-home (0) ──
  // EMPTY, and it must stay that way: W4b moved every per-venue copy onto
  // `slippage-policy.ts` (`VEX_DEFAULT_SLIPPAGE_BPS`) and flipped it 50 → 100.
  // `src/tools/**` functions take an explicit bps parameter and hold no default.

  // ── tool-description (157) ──
  // tool descriptions — under the 120-char minimum, or missing a when-to-use / returns / spends anchor.
];
