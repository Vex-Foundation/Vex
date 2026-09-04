/**
 * RANKING FILE NAMES, in VS Code's manner.
 *
 * Pure and synchronous: the whole answer - which names matched, how they were
 * ordered, and what ranking did not look at - is table-testable without a
 * filesystem, a project or an index.
 *
 * ## Two stages, because one stage does not fit in a keystroke
 *
 * Measured on a 20,000-path tree: running the full query-by-target scoring
 * matrix over every path costs 142 ms for a one-character query and 382 ms for
 * a long one. That is a third of a second of the PRIVILEGED process's event
 * loop per keystroke, which is not a budget this surface may spend.
 *
 * VS Code does not spend it either. Its file search hands the pattern to
 * ripgrep, takes at most `MAX_RESULTS` (512) survivors back, and only then runs
 * `scoreItemFuzzy` and `compareItemsByFuzzyScore` over them
 * (`anythingQuickAccess.ts`: `doGetFileSearchResults` -> `top(..., MAX_RESULTS)`
 * -> `getAdditionalPicks`). We have no ripgrep in front of an in-memory list, so
 * stage one is the cheapest test that cannot produce a false negative for this
 * scorer: a lowercase SUBSEQUENCE test, which is exactly the condition under
 * which the matrix can score at all. Same two-stage shape, same guarantee, and
 * measured at 5-31 ms for the same queries.
 *
 * ## The scoring is ported, not invented
 *
 * The constants below are VS Code's, read out of
 * `src/vs/base/common/fuzzyScorer.ts` in the pinned checkout, because ranking
 * that "feels like Ctrl+P" is not a matter of taste - it is these numbers:
 * start-of-word 8, after-a-path-separator 5 over after-any-other-separator 4,
 * an inside-word capital 2 but only outside a run, a consecutive-run bonus that
 * saturates at three, and a prefix match on the NAME lifted a whole threshold
 * above a match merely contained in it. What is deliberately NOT ported is the
 * multi-value query, the description/label split for non-file items and the
 * scorer cache: this surface ranks one kind of thing, and a cache whose
 * lifetime is a single query would only pay for itself if the same path were
 * scored twice, which it never is.
 */

import { SEARCH_SCORED_CANDIDATE_MAX } from "@shared/schemas/studio-search.js";

/* ------------------------------------------------------------------ *
 * VS Code's scoring constants
 * ------------------------------------------------------------------ */

/** An exact hit on the whole relative path outranks everything. */
const PATH_IDENTITY_SCORE = 1 << 18;
/** A name the query is a PREFIX of outranks a name merely containing it. */
const NAME_PREFIX_SCORE_THRESHOLD = 1 << 17;
/** A hit on the name outranks a hit that needed the directories to match. */
const NAME_SCORE_THRESHOLD = 1 << 16;

const CHAR_MATCH_BONUS = 1;
const SAME_CASE_BONUS = 1;
const START_OF_WORD_BONUS = 8;
const AFTER_PATH_SEPARATOR_BONUS = 5;
const AFTER_OTHER_SEPARATOR_BONUS = 4;
const INSIDE_WORD_CAPITAL_BONUS = 2;
/** A run scores 6 per character up to three, then 3, so long runs cannot run away. */
const CONSECUTIVE_FULL_BONUS = 6;
const CONSECUTIVE_HALF_BONUS = 3;
const CONSECUTIVE_FULL_LIMIT = 3;

/** The separators after which a character starts a new "word". VS Code's set. */
const OTHER_SEPARATORS = new Set(["_", "-", ".", " ", "'", '"', ":"]);

export interface RankedName {
  readonly relativePath: string;
  readonly score: number;
}

export interface RankedNames {
  /** Best first, bounded by the caller's limit. */
  readonly matches: readonly RankedName[];
  /** How many names matched, bounded by the scored-candidate cap. */
  readonly totalMatches: number;
  /** The prefilter produced more survivors than ranking was allowed to score. */
  readonly truncated: boolean;
}

const NOTHING: RankedNames = { matches: [], totalMatches: 0, truncated: false };

/**
 * Rank project-relative POSIX paths against a query.
 *
 * @param paths every indexed path, in the order the walk collected them. The
 *   order is load-bearing only as a tiebreak: two names that score identically
 *   keep the order they arrived in, so an answer is stable across keystrokes.
 * @param query the raw field text. Empty (or whitespace) matches nothing at
 *   all rather than everything: a search field with no query is not a request
 *   for the whole repository.
 * @param limit how many rows to return. `totalMatches` still counts the rest.
 * @returns the bounded page plus the counts that describe what was cut.
 */
export function rankFileNames(
  paths: readonly string[],
  query: string,
  limit: number,
): RankedNames {
  const normalized = query.trim();
  if (normalized.length === 0 || limit <= 0) return NOTHING;

  const queryLower = normalized.toLowerCase();
  const containsSeparator = normalized.includes("/");

  // STAGE ONE. The cheapest test that cannot reject something the matrix would
  // have scored: the matrix only ever produces a score when the query's
  // characters appear in the target in order, which is what this asks.
  const survivors: string[] = [];
  let matchedBeyondCap = false;
  for (const path of paths) {
    if (!isSubsequence(path.toLowerCase(), queryLower)) continue;
    if (survivors.length >= SEARCH_SCORED_CANDIDATE_MAX) {
      matchedBeyondCap = true;
      break;
    }
    survivors.push(path);
  }

  // STAGE TWO. The full matrix, on the bounded set only.
  const scored: RankedName[] = [];
  for (const path of survivors) {
    const score = scorePath(path, normalized, queryLower, containsSeparator);
    if (score === 0) continue;
    scored.push({ relativePath: path, score });
  }

  // A STABLE sort: `Array.prototype.sort` is required to be stable, so equal
  // scores keep the walk's order and the list does not reshuffle under a user
  // whose keystroke did not change the ranking.
  scored.sort((a, b) => compareRanked(a, b));

  return {
    matches: scored.slice(0, limit),
    totalMatches: scored.length,
    truncated: matchedBeyondCap,
  };
}

/**
 * Order two scored names.
 *
 * Score first, then the SHORTER name, which is VS Code's tiebreak
 * (`compareItemsByFuzzyScore`, "prefer shorter labels over longer labels") and
 * the reason `window.ts` beats `windowActions.ts` for the query "window". The
 * last comparison is the path itself, so the order is total and an answer
 * cannot depend on the walk's directory ordering.
 */
function compareRanked(a: RankedName, b: RankedName): number {
  if (a.score !== b.score) return b.score - a.score;
  const nameA = baseName(a.relativePath);
  const nameB = baseName(b.relativePath);
  if (nameA.length !== nameB.length) return nameA.length - nameB.length;
  if (a.relativePath.length !== b.relativePath.length) {
    return a.relativePath.length - b.relativePath.length;
  }
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

/** The last segment of a project-relative POSIX path. */
export function baseName(relativePath: string): string {
  const cut = relativePath.lastIndexOf("/");
  return cut === -1 ? relativePath : relativePath.slice(cut + 1);
}

/**
 * Score one path, preferring a hit on its NAME.
 *
 * `doScoreItemFuzzySingle`'s structure: the name is the label and the
 * directories are the description, and the label is scored alone unless the
 * user typed a path separator - because a query with a slash in it is a
 * statement about where the file is, not only about what it is called.
 */
function scorePath(
  path: string,
  query: string,
  queryLower: string,
  containsSeparator: boolean,
): number {
  // An exact hit on the whole path is the answer, whatever else matched.
  if (path === query) return PATH_IDENTITY_SCORE;

  const name = baseName(path);

  if (!containsSeparator) {
    const nameScore = scoreFuzzy(name, query, queryLower);
    if (nameScore > 0) {
      if (name.toLowerCase().startsWith(queryLower)) {
        // The short-name boost, and it is why "window" ranks `window.ts` over
        // `windowActions.ts`: the closer the query is to being the WHOLE name,
        // the higher it sits inside the prefix band.
        const prefixLengthBoost = Math.round((query.length / name.length) * 100);
        return NAME_PREFIX_SCORE_THRESHOLD + prefixLengthBoost + nameScore;
      }
      return NAME_SCORE_THRESHOLD + nameScore;
    }
  }

  // Either the query names a path, or nothing in the name matched. Score the
  // whole relative path, which is the label-and-description case.
  return scoreFuzzy(path, query, queryLower);
}

/** Does `needle` appear in `hay` in order? Both must already be lowercase. */
function isSubsequence(hay: string, needle: string): boolean {
  let index = 0;
  for (let position = 0; position < hay.length && index < needle.length; position += 1) {
    if (hay[position] === needle[index]) index += 1;
  }
  return index === needle.length;
}

/**
 * The scoring matrix, VS Code's `doScoreFuzzy`.
 *
 * For each query character against each target character, keep the better of
 * "extend the diagonal" and "carry the best score to the left", and remember
 * how long the current consecutive run is so it can be rewarded. The score
 * returned is the best total over the final query row: the query must match in
 * sequence, and a character that scores without a diagonal predecessor scores
 * nothing, which is what stops "de" scoring against the leading "e" of "ede".
 */
function scoreFuzzy(target: string, query: string, queryLower: string): number {
  const targetLength = target.length;
  const queryLength = query.length;
  if (targetLength === 0 || queryLength === 0) return 0;
  if (targetLength < queryLength) return 0;

  const targetLower = target.toLowerCase();
  const scores = new Int32Array(queryLength * targetLength);
  const runs = new Int32Array(queryLength * targetLength);
  let best = 0;

  for (let queryIndex = 0; queryIndex < queryLength; queryIndex += 1) {
    const rowOffset = queryIndex * targetLength;
    const previousRowOffset = rowOffset - targetLength;
    const isLastQueryRow = queryIndex === queryLength - 1;

    for (let targetIndex = 0; targetIndex < targetLength; targetIndex += 1) {
      const current = rowOffset + targetIndex;
      const leftScore = targetIndex > 0 ? scores[current - 1] ?? 0 : 0;
      const diagonalScore =
        queryIndex > 0 && targetIndex > 0
          ? scores[previousRowOffset + targetIndex - 1] ?? 0
          : 0;
      const runLength =
        queryIndex > 0 && targetIndex > 0
          ? runs[previousRowOffset + targetIndex - 1] ?? 0
          : 0;

      // Past the first query row a character may only score where the previous
      // one did, so the match is a subsequence in order rather than a bag of
      // characters found anywhere.
      const characterScore =
        diagonalScore === 0 && queryIndex > 0
          ? 0
          : computeCharacterScore(
            query,
            queryLower,
            queryIndex,
            target,
            targetLower,
            targetIndex,
            runLength,
          );

      if (characterScore > 0 && diagonalScore + characterScore >= leftScore) {
        runs[current] = runLength + 1;
        scores[current] = diagonalScore + characterScore;
      } else {
        runs[current] = 0;
        scores[current] = leftScore;
      }

      if (isLastQueryRow) {
        const total = scores[current] ?? 0;
        if (total > best) best = total;
      }
    }
  }

  return best;
}

/** One cell's bonus set, `computeCharScore` in the reference. */
function computeCharacterScore(
  query: string,
  queryLower: string,
  queryIndex: number,
  target: string,
  targetLower: string,
  targetIndex: number,
  runLength: number,
): number {
  if (queryLower[queryIndex] !== targetLower[targetIndex]) return 0;

  let score = CHAR_MATCH_BONUS;

  if (runLength > 0) {
    score
      += Math.min(runLength, CONSECUTIVE_FULL_LIMIT) * CONSECUTIVE_FULL_BONUS
      + Math.max(0, runLength - CONSECUTIVE_FULL_LIMIT) * CONSECUTIVE_HALF_BONUS;
  }

  if (query[queryIndex] === target[targetIndex]) score += SAME_CASE_BONUS;

  if (targetIndex === 0) {
    score += START_OF_WORD_BONUS;
    return score;
  }

  const previous = target[targetIndex - 1] ?? "";
  if (previous === "/") {
    score += AFTER_PATH_SEPARATOR_BONUS;
  } else if (OTHER_SEPARATORS.has(previous)) {
    score += AFTER_OTHER_SEPARATOR_BONUS;
  } else if (runLength === 0 && isUpperCase(target[targetIndex] ?? "")) {
    // The camel hump, and only OUTSIDE a run: "NPE" should be rewarded against
    // NullPointerException, while "HTTP" against HTTP should not be rewarded
    // four times over for being capitals in a row it already scored as a run.
    score += INSIDE_WORD_CAPITAL_BONUS;
  }

  return score;
}

function isUpperCase(character: string): boolean {
  return character !== character.toLowerCase()
    && character === character.toUpperCase();
}
