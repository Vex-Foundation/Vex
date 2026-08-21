/**
 * Live-state exclusion rules for memory chunking.
 *
 * Purpose: prevent the chunker LLM from encoding values that mutate at every
 * tool call into long-term embedded memory. Wallet balances, current prices,
 * gas, pending intent IDs, and other "now"-state belong in tool calls
 * (`WalletBalances`, quote tools) and structured DB tables
 * (`proj_*`, `mission_runs`, `approval_queue`) — chunks that snapshot them
 * become stale within minutes and crowd out durable signal at recall time.
 *
 * Two-stage check:
 *   1. Scan for known live-state patterns (regex-based) — each match is a
 *      "live-state word".
 *   2. Compute fraction = live_state_word_count / total_word_count.
 *      If fraction ≥ EXCLUSION_REJECT_THRESHOLD, the chunk is rejected.
 *
 * False positives are acceptable here — the chunker can re-emit a chunk
 * reformulated to focus on patterns/decisions/lessons rather than snapshots.
 * False negatives (live state slipping into a chunk) are the more expensive
 * failure mode because they pollute pgvector with stale data.
 */

import { EXCLUSION_REJECT_THRESHOLD } from "./session-memory-policy.js";

export interface ExclusionScanResult {
  liveStateMatches: number;
  totalWords: number;
  /** matches / max(1, totalWords) */
  liveFraction: number;
  /** True iff fraction ≥ EXCLUSION_REJECT_THRESHOLD. */
  rejected: boolean;
  /** Categories that fired, for telemetry. Empty when nothing matched. */
  categories: Record<string, number>;
}

// ── Patterns ─────────────────────────────────────────────────────

interface LivePattern {
  category: string;
  re: RegExp;
}

const PATTERNS: readonly LivePattern[] = [
  // Token balance with units: "1.2 SOL", "5,000 USDC", "0.05 ETH"
  {
    category: "balance_amount",
    re: /\b\d+(?:[.,]\d+)?\s*(?:SOL|ETH|MATIC|BNB|AVAX|USDC|USDT|DAI|WETH|WBTC|BTC|BONK|WIF|POPCAT|MOG|PEPE|SHIB|DOGE)\b/gi,
  },
  // Dollar/Euro/etc prices: "$0.0042", "$1,234.56", "€500"
  {
    category: "fiat_price",
    re: /(?:[$€£¥₿])\s*\d+(?:[.,]\d+)?(?:[kKmMbB])?/g,
  },
  // Gas in gwei / wei: "5 gwei", "1.2 gwei", "100 wei"
  {
    category: "gas_amount",
    re: /\b\d+(?:[.,]\d+)?\s*(?:gwei|wei|gas)\b/gi,
  },
  // Price impact / slippage percent in a quote context: "0.15% impact", "5% slippage"
  {
    category: "slippage_pct",
    re: /\b\d+(?:[.,]\d+)?\s*%\s*(?:impact|slippage|fee|price\s*impact)\b/gi,
  },
  // Block/slot/height numbers: "block 18293821", "slot 195832184"
  {
    category: "chain_height",
    re: /\b(?:block|slot|height)\s+#?\d{4,}/gi,
  },
  // Intent IDs / pending tx hashes (post-mask): "Tx 0xabcd…1234 pending"
  {
    category: "pending_tx",
    re: /\b(?:tx|transaction|intent)\s+(?:id\s+)?[0-9a-fA-FxX…]{4,}/g,
  },
  // Explicit "balance is/=" / "current price"
  {
    category: "literal_state",
    re: /\b(?:balance|holdings|position\s+size|current\s+price|current\s+balance|now\s+at|current\s+value|present\s+value)\s+(?:is|=|:)\s*\S+/gi,
  },
  // Timestamps as "now"-anchored: "as of 14:32Z", "now 2026-05-17T..."
  {
    category: "now_timestamp",
    re: /\b(?:as\s+of|now|currently|at)\s+\d{1,2}:\d{2}(?::\d{2})?(?:Z|UTC)?/gi,
  },
];

const WORD_RE = /\b\w+\b/g;

// ── API ──────────────────────────────────────────────────────────

/**
 * Scan `text` for live-state patterns and return both the raw match counts
 * and the rejection decision based on `EXCLUSION_REJECT_THRESHOLD`.
 *
 * Total word count uses a simple `\b\w+\b` tokenizer — good enough for the
 * threshold heuristic, not a tokenizer for billing.
 */
export function scanLiveState(text: string): ExclusionScanResult {
  if (typeof text !== "string" || text.length === 0) {
    return {
      liveStateMatches: 0,
      totalWords: 0,
      liveFraction: 0,
      rejected: false,
      categories: {},
    };
  }

  const categories: Record<string, number> = {};
  let liveWordsCovered = 0;
  for (const { category, re } of PATTERNS) {
    // RegExp with `g` flag is stateful — re-create before each scan.
    const local = new RegExp(re.source, re.flags);
    const matches = text.match(local);
    if (matches && matches.length > 0) {
      categories[category] = matches.length;
      // Count words inside each match — a multi-word pattern ("5 gwei",
      // "0.15% impact", "tx 0xabcd…1234") contributes more to the fraction
      // than a single-word match, which matches our intent: the metric is
      // "what fraction of the chunk is live state", not "how many distinct
      // patterns fired".
      for (const m of matches) {
        const wordsInMatch = (m.match(WORD_RE) ?? []).length;
        liveWordsCovered += wordsInMatch;
      }
    }
  }

  const wordTokens = text.match(WORD_RE) ?? [];
  const totalWords = wordTokens.length;
  // Clamp so overlapping matches do not produce >100% live fraction.
  const liveFraction = totalWords === 0
    ? 0
    : Math.min(1, liveWordsCovered / totalWords);

  return {
    liveStateMatches: liveWordsCovered,
    totalWords,
    liveFraction,
    rejected: liveFraction >= EXCLUSION_REJECT_THRESHOLD,
    categories,
  };
}

/**
 * Convenience: scan and return only the rejection boolean. Use the full
 * `scanLiveState` when telemetry needs to surface category breakdown.
 */
export function shouldRejectChunk(text: string): boolean {
  return scanLiveState(text).rejected;
}
