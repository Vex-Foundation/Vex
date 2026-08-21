/**
 * English-by-contract boundary check for `MemorySuggest` persisted text
 * (memory-system-v2 §10.4). EmbeddingGemma retrieval is significantly stronger
 * on English, so every text that is persisted AND embedded must be English; a
 * non-English candidate is rejected with steering guidance to rewrite it.
 *
 * Zero-dependency heuristic, two metrics:
 *   A. non-ASCII-letter fraction — letters outside [A-Za-z] over total letters
 *      (deliberately NOT Unicode-script classes: Latin-Extended diacritics like
 *      ą/é/ü must count as non-ASCII). Applies regardless of word count; a
 *      small tolerance lets occasional "naïve"/"café" tokens through prose.
 *   B. English function-word fraction — unambiguous English stopwords over
 *      `\b\w+\b` tokens, applied only when the prose has at least
 *      MIN_WORDS_FOR_STOPWORD_CHECK words. The stopword set EXCLUDES tokens
 *      that are also common Polish/Romance words ("to", "i", "a", "on", "by",
 *      "no", "ma", "do", "my", "me") so foreign text never scores accidental
 *      hits; thresholds are calibrated against BENCHMARK_PAIRS
 *      (scripts/cross-lingual-benchmark-dataset.ts): every English row passes,
 *      pl/fr/zh/vi rows and diacritic-stripped Polish fail.
 *
 * Surfaces (per §10.4):
 *   - title + summary aggregate → metric A + B ("prose").
 *   - content_md → fenced code blocks, inline code spans, and URLs are stripped
 *     first, then metric A + B on the remaining prose ("prose").
 *   - entities/tags → per-string non-ASCII-letter COUNT only ("entities_tags").
 *     Labels are short, so the prose fraction tolerance would let a single
 *     diacritic through ("preferencja użytkownika" is ~4.5% non-ASCII); one
 *     non-ASCII letter in a label is already decisive, hence a zero-tolerance
 *     count (ENTITY_NON_ASCII_LETTER_MAX). Tickers/ids/slugs always pass.
 *   - kind is exempt — the schema already enforces ASCII snake_case.
 *
 * False-positive stance (same doctrine as exclusion-rules.ts): rejecting a
 * borderline-English candidate is cheap — the agent reformulates and
 * re-suggests. False negatives are the expensive failure because non-English
 * text pollutes pgvector recall quality permanently.
 *
 * KNOWN LIMITATION: ASCII-only non-English descriptors in entities/tags slip
 * through metric A (e.g. "preferencja uzytkownika" with diacritics already
 * stripped) — short labels carry too little signal for a stopword check.
 *
 * Pure module: no DB, no embeddings, no I/O. Result fields are bounded enums
 * (memLog-safe), never free text.
 */

// ── Named thresholds (boundary-tested) ───────────────────────────

/**
 * Metric A (prose): max tolerated fraction of non-ASCII letters. Strictly
 * greater rejects. 0.05 lets occasional diacritic loanwords ("naïve", "café")
 * pass inside normal English prose while dense-diacritic text (vi, zh, most
 * pl/fr sentences) fails outright.
 */
export const NON_ASCII_LETTER_MAX_FRACTION = 0.05;

/**
 * Metric B applies only at/above this many `\b\w+\b` tokens — shorter prose
 * (terse titles like "Kyber quote timeout pattern") carries too little signal
 * for a stopword fraction to mean anything.
 */
export const MIN_WORDS_FOR_STOPWORD_CHECK = 8;

/**
 * Metric B: minimum English function-word fraction. Strictly below rejects.
 * 0.04 ≈ one unambiguous English function word per 25 tokens — calibrated on
 * the tersest English benchmark row (en-balance: 1 hit / 24 tokens ≈ 0.042)
 * while every pl/fr native row and diacritic-stripped Polish scores 0.
 */
export const ENGLISH_STOPWORD_MIN_FRACTION = 0.04;

/**
 * Entities/tags: max non-ASCII LETTERS allowed per string (count, not
 * fraction — see module header for why short labels get zero tolerance).
 */
export const ENTITY_NON_ASCII_LETTER_MAX = 0;

// ── Bounded result (memLog-safe enums, never free text) ──────────

export interface EnglishCheckResult {
  rejected: boolean;
  reason: "non_ascii_letters" | "low_english_stopwords" | null;
  field: "prose" | "entities_tags" | null;
}

// ── English function words (unambiguous subset) ──────────────────
//
// Deliberately EXCLUDED because they are also common Polish/Romance words and
// would give foreign text accidental hits: "to" (pl this/it), "i" (pl and),
// "a" (pl but), "on" (pl he / fr one), "by" (pl conditional particle), "no"
// (pl well), "ma" (pl has), "do" (pl to/into), "my" (pl we), "me" (fr me).
const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "with", "for", "and", "or", "not", "an", "as",
  "this", "that", "these", "those",
  "when", "while", "if", "then", "than", "from",
  "has", "have", "had", "having",
  "will", "would", "should", "could", "must", "might", "shall",
  "never", "always", "often", "usually", "before", "after", "during",
  "between", "because", "but", "into", "in", "at", "it", "its",
  "off", "out", "up", "down", "over", "under", "through", "across",
  "despite", "against", "without", "within", "about",
  "again", "once", "only", "also", "just", "still", "yet", "until",
  "each", "every", "any", "some", "all", "both", "few",
  "more", "most", "other", "such", "same", "so", "too", "very",
  "can", "cannot", "did", "does", "done", "doing",
  "where", "which", "who", "whom", "whose", "what", "why", "how",
  "there", "here", "they", "them", "their", "theirs",
  "we", "us", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers",
]);

const WORD_RE = /\b\w+\b/g;
const ASCII_LETTER_RE = /[A-Za-z]/g;
const ANY_LETTER_RE = /\p{L}/gu;

// ── Internal metrics ──────────────────────────────────────────────

function countLetters(text: string): { total: number; nonAscii: number } {
  const total = (text.match(ANY_LETTER_RE) ?? []).length;
  const ascii = (text.match(ASCII_LETTER_RE) ?? []).length;
  return { total, nonAscii: total - ascii };
}

/** Metric A fraction; 0 when the text has no letters at all. */
function nonAsciiLetterFraction(text: string): number {
  const { total, nonAscii } = countLetters(text);
  return total === 0 ? 0 : nonAscii / total;
}

/** Metric B stats over `\b\w+\b` tokens (case-insensitive set lookup). */
function englishStopwordStats(text: string): { words: number; fraction: number } {
  const tokens = text.match(WORD_RE) ?? [];
  if (tokens.length === 0) return { words: 0, fraction: 0 };
  let hits = 0;
  for (const token of tokens) {
    if (ENGLISH_FUNCTION_WORDS.has(token.toLowerCase())) hits += 1;
  }
  return { words: tokens.length, fraction: hits / tokens.length };
}

/**
 * Strip the content_md parts that legitimately carry non-prose text before the
 * language metrics run: fenced code blocks, inline code spans, and URLs.
 */
function stripCodeAndUrls(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/** Metric A then metric B on one prose surface; null when the surface passes. */
function checkProseSurface(text: string): EnglishCheckResult | null {
  if (nonAsciiLetterFraction(text) > NON_ASCII_LETTER_MAX_FRACTION) {
    return { rejected: true, reason: "non_ascii_letters", field: "prose" };
  }
  const { words, fraction } = englishStopwordStats(text);
  if (words >= MIN_WORDS_FOR_STOPWORD_CHECK && fraction < ENGLISH_STOPWORD_MIN_FRACTION) {
    return { rejected: true, reason: "low_english_stopwords", field: "prose" };
  }
  return null;
}

// ── Entry point ───────────────────────────────────────────────────

export interface LongMemorySuggestEnglishInput {
  title: string;
  summary: string;
  contentMd: string;
  entities: readonly string[];
  tags: readonly string[];
}

/**
 * Check the persisted/embedded text of one `MemorySuggest` call against
 * the English-by-contract rule (§10.4). Runs on the REDACTED values. The first
 * failing surface wins; a passing input yields `{ rejected: false }` with null
 * reason/field.
 */
export function checkLongMemorySuggestEnglish(
  input: LongMemorySuggestEnglishInput,
): EnglishCheckResult {
  // Surface 1 — title + summary aggregate (the embedding input).
  const titleSummary = checkProseSurface(`${input.title} ${input.summary}`);
  if (titleSummary !== null) return titleSummary;

  // Surface 2 — content_md prose (code blocks / inline code / URLs exempt).
  const content = checkProseSurface(stripCodeAndUrls(input.contentMd));
  if (content !== null) return content;

  // Surface 3 — entities/tags, per-string non-ASCII letter count only.
  for (const label of [...input.entities, ...input.tags]) {
    const { nonAscii } = countLetters(label);
    if (nonAscii > ENTITY_NON_ASCII_LETTER_MAX) {
      return { rejected: true, reason: "non_ascii_letters", field: "entities_tags" };
    }
  }

  return { rejected: false, reason: null, field: null };
}
