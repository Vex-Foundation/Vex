/**
 * Embedding-text style linter — author-time guardrail.
 *
 * Each manifest's `discovery.embeddingText` is the passage side of dense
 * tool retrieval (EmbeddingGemma 308M, dense-primary discovery).
 * The agent-style refactor moved API/tech jargon out of these passages
 * (it lives in `description`/`aliases`/`params` for power-user lexical
 * exact-match) and standardised passage shape on intent verbs + concrete
 * example queries.
 *
 * This test fails when:
 *   1. A passage contains a forbidden token (technical jargon that
 *      densifies sibling clusters or shifts vector space away from user
 *      intent).
 *   2. A passage is outside the 60–110 word budget (too short = sparse
 *      signal; too long = bloat that pulls embeddings toward chain-list
 *      / boilerplate centroid).
 *
 * **Scope:** the linter ONLY checks `discovery.embeddingText`. Tech
 * vocabulary in `description`, `aliases`, `params` and `canonicalSummary`
 * is NOT checked — those fields feed the lexical fallback lane, where exact
 * matches on terms like "EIP-712 limit order" are valuable.
 */

import { describe, it, expect } from "vitest";
import { PROTOCOL_TOOLS } from "../../../vex-agent/tools/protocols/catalog.js";

interface ForbiddenPattern {
  pattern: RegExp;
  label: string;
  reason: string;
}

const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { pattern: /\bEIP[-]?712\b/i, label: "EIP-712 / EIP712", reason: "off-chain order signing detail — agents say 'gasless limit order'" },
  { pattern: /\bEIP[-]?1271\b/i, label: "EIP-1271", reason: "contract signature standard — not user vocabulary" },
  { pattern: /\btickLower\b/, label: "tickLower", reason: "Uniswap V3 internal — agents say 'liquidity range'" },
  { pattern: /\btickUpper\b/, label: "tickUpper", reason: "Uniswap V3 internal — agents say 'liquidity range'" },
  { pattern: /\bCONTRACT_CALL\b/, label: "CONTRACT_CALL", reason: "deposit method enum — internal" },
  { pattern: /\bPERMIT2\b/, label: "PERMIT2", reason: "approval scheme — internal, not user vocabulary" },
  { pattern: /\bDEX_[A-Z0-9_]+\b/, label: "DEX_* identifier", reason: "ZaaS DEX ID enum (e.g. DEX_UNISWAPV3) — internal" },
  { pattern: /\bmakerAsset\b/, label: "makerAsset", reason: "limit-order internal field — agents say 'sell token'" },
  { pattern: /\btakerAsset\b/, label: "takerAsset", reason: "limit-order internal field — agents say 'buy token'" },
  { pattern: /\brouteId\b/, label: "routeId", reason: "internal ID — not user vocabulary" },
  { pattern: /\bquoteId\b/, label: "quoteId", reason: "internal ID — not user vocabulary" },
  { pattern: /\batomic units\b/i, label: "atomic units", reason: "low-level encoding — agents speak in human-readable amounts" },
  { pattern: /\bcalldata\b/i, label: "calldata", reason: "EVM internal — not user vocabulary" },
  { pattern: /\boperator signatures?\b/i, label: "operator signature(s)", reason: "limit-order off-chain detail — internal" },
  { pattern: /\bco[- ]?sign(ing)?\b/i, label: "co-sign / co-signing", reason: "operator/relay detail — internal" },
  { pattern: /\bfromToken\b/, label: "fromToken", reason: "bridge param name — agents say 'source token'" },
  { pattern: /\btoToken\b/, label: "toToken", reason: "bridge param name — agents say 'destination token'" },
  { pattern: /\btakingAmount\b/, label: "takingAmount", reason: "limit-order internal field — agents say 'amount to take'" },
  { pattern: /\bthresholdAmount\b/, label: "thresholdAmount", reason: "limit-order internal field — agents say 'min acceptable'" },
  { pattern: /\bZaaS\b/, label: "ZaaS", reason: "internal product label — not user vocabulary" },
  // Style rules (in addition to forbidden tech tokens):
  { pattern: /\bDiffers from\b/i, label: "'Differs from' trailer", reason: "sibling differentiator must lead the verb summary, not appear as a trailer (densifies sibling clusters in vector space)" },
  { pattern: /[ąćęłńóśźż]/i, label: "Non-English diacritics", reason: "embeddingText is English-only because tool passages are authored in English" },
];

const WORD_COUNT_MIN = 60;
const WORD_COUNT_MAX = 110;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe("embedding-text style linter", () => {
  const toolsWithEmbedding = PROTOCOL_TOOLS.filter((m) => m.discovery?.embeddingText);

  it("at least one manifest has embeddingText (sanity)", () => {
    expect(toolsWithEmbedding.length).toBeGreaterThan(0);
  });

  for (const manifest of toolsWithEmbedding) {
    const text = manifest.discovery!.embeddingText!;

    it(`${manifest.toolId}: passage contains no forbidden tech tokens`, () => {
      const violations: string[] = [];
      for (const { pattern, label, reason } of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) {
          violations.push(`  - ${label}: ${reason}`);
        }
      }
      expect(
        violations,
        `embeddingText for ${manifest.toolId} contains forbidden tech tokens:\n${violations.join("\n")}\n\nText:\n${text}`,
      ).toEqual([]);
    });

    it(`${manifest.toolId}: passage word count in [${WORD_COUNT_MIN}, ${WORD_COUNT_MAX}]`, () => {
      const wc = countWords(text);
      expect(
        wc,
        `embeddingText for ${manifest.toolId} has ${wc} words (allowed ${WORD_COUNT_MIN}-${WORD_COUNT_MAX}). Text:\n${text}`,
      ).toBeGreaterThanOrEqual(WORD_COUNT_MIN);
      expect(
        wc,
        `embeddingText for ${manifest.toolId} has ${wc} words (allowed ${WORD_COUNT_MIN}-${WORD_COUNT_MAX}). Text:\n${text}`,
      ).toBeLessThanOrEqual(WORD_COUNT_MAX);
    });
  }
});
