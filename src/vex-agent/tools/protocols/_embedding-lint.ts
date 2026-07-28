/**
 * Embedding-passage shape linter (A3).
 *
 * Complements `__tests__/vex-agent/tools/embedding-text-style.test.ts`,
 * which checks forbidden technical jargon and word-count budget. This
 * module focuses on **passage shape** — does the passage carry the
 * structural cues the dense retriever and LLM need to disambiguate
 * during tool discovery:
 *
 *   - **`Use when:` / `Use this when:`** — verb-first imperative anchor.
 *     Without it, passages lapse into descriptive prose and the dense
 *     retriever loses the signal "this passage explains a use case".
 *   - **`Example queries:` / `Example:`** — concrete query examples
 *     diversify intent across paraphrases and keep dense recall grounded in
 *     real agent phrasing.
 *   - **No banned phrases** — `"can be used to"`, `"this tool"`,
 *     `"wrapper around"`, `"helper for"` are passive/meta phrasings
 *     that pull embeddings toward boilerplate centroids.
 *   - **Mutating tools include an action verb in the first sentence** —
 *     keeps passages grounded in execution intent rather than read-only
 *     description (which would mismatch user "swap"/"buy"/"bridge"
 *     intent at retrieval time). The verb list is an OPEN enumeration,
 *     extended as new on-chain actions ship (`Wrap`/`Unwrap` arrived with
 *     Pendle SY, `Roll` with the Pendle maturity roll). Add a genuine action
 *     verb here rather than bending a passage's opener away from the word a
 *     user would actually say.
 *
 * Length bounds (50-800 chars after whitespace collapse) catch passages
 * that are too short to have semantic content or too long for focused
 * embedding.
 *
 * Functions are pure; the test runner iterates every active manifest
 * with `manifest.discovery?.embeddingText` and surfaces violations.
 */

export interface PassageLintIssue {
  toolId: string;
  rule: string;
  message: string;
}

const MIN_LENGTH = 50;
const MAX_LENGTH = 800;

const BANNED_PHRASES: readonly { phrase: string; reason: string }[] = [
  { phrase: "can be used to", reason: "passive — write verb-first imperative ('Swap a token...' not 'Can be used to swap...')" },
  { phrase: "this tool", reason: "meta-talk — describe the action, not the tool wrapper" },
  { phrase: "wrapper around", reason: "implementation detail — describe the user-facing action" },
  { phrase: "helper for", reason: "downplays — name the action directly" },
];

const ACTION_VERB_PATTERN = /\b(Run|Execute|Submit|Bridge|Swap|Buy|Sell|Mint|Send|Place|Cancel|Withdraw|Deposit|Move|Transfer|Borrow|Lend|Stake|Unstake|Claim|Open|Close|Approve|Set|Trade|Purchase|Redeem|Bid|Ask|Add|Remove|Migrate|Convert|Exit|Enter|Rebalance|Repay|Settle|Sign|Issue|Burn|Lock|Unlock|Fill|Take|Make|Post|Create|Update|Delete|Pay|Reward|Vote|Wrap|Unwrap|Roll)\b/i;

function firstSentence(passage: string): string {
  const split = passage.split(/[.!?]/);
  return (split[0] ?? "").trim();
}

export function lintEmbeddingPassage(
  toolId: string,
  passage: string,
  isMutating: boolean,
): PassageLintIssue[] {
  const issues: PassageLintIssue[] = [];

  // ── Length ─────────────────────────────────────────────────
  if (passage.length < MIN_LENGTH) {
    issues.push({
      toolId, rule: "length-min",
      message: `passage length ${passage.length} < ${MIN_LENGTH} (too short for semantic content)`,
    });
  }
  if (passage.length > MAX_LENGTH) {
    issues.push({
      toolId, rule: "length-max",
      message: `passage length ${passage.length} > ${MAX_LENGTH} (too long for focused embedding)`,
    });
  }

  // ── Use when ───────────────────────────────────────────────
  if (!/\bUse (this )?when\b/i.test(passage)) {
    issues.push({
      toolId, rule: "use-when",
      message: "missing 'Use when:' or 'Use this when:' anchor",
    });
  }

  // ── Example queries ────────────────────────────────────────
  if (!/(?:Example queries:|Example:)/i.test(passage)) {
    issues.push({
      toolId, rule: "example-queries",
      message: "missing 'Example queries:' or 'Example:' (concrete queries diversify retrieval intent)",
    });
  }

  // ── Banned phrases ─────────────────────────────────────────
  const lowered = passage.toLowerCase();
  for (const { phrase, reason } of BANNED_PHRASES) {
    if (lowered.includes(phrase)) {
      issues.push({
        toolId, rule: "banned-phrase",
        message: `contains banned phrase "${phrase}" — ${reason}`,
      });
    }
  }

  // ── Mutating tools: action verb in first sentence ─────────
  if (isMutating) {
    const opener = firstSentence(passage);
    if (!ACTION_VERB_PATTERN.test(opener)) {
      issues.push({
        toolId, rule: "mutating-verb-first",
        message: `mutating tool's first sentence must contain an action verb (Run/Execute/Submit/Bridge/Swap/Buy/Sell/Mint/Send/Place/...). First sentence: "${opener.slice(0, 120)}"`,
      });
    }
  }

  return issues;
}
