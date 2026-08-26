/**
 * THE BOARD SAFETY CLASSIFIER - one pure table, one verdict, every surface.
 *
 * WHY IT IS PURE AND WHY IT LIVES IN `shared/`. The same verdict colours a chip
 * on a grid card, a chip in the spotlight, a counter sentence on the chat card
 * ("3 clean checks - 2 high risk") and a line in the sidebar. Four surfaces
 * deciding "is this token safe" from raw provider flags is four chances to
 * disagree, and the disagreement a reader notices last is the dangerous one: a
 * card saying clean beside a spotlight saying flagged about the same token in
 * the same second. `shared/` is the only tree BOTH the privileged main process
 * and the renderer may import, which is what makes one answer structurally
 * possible rather than a review promise.
 *
 * THE FROZEN SHAPES LIVE HERE AND THE RENDERER RE-EXPORTS THEM. A0 froze this
 * seam and left the body to T4. Declaring the types twice - once in the
 * renderer's board contracts and once here - would be a second source of truth
 * for a security decision, which is precisely what rule 03 forbids, so the
 * renderer's `board-surface-contracts.ts` re-exports this module and its public
 * surface is unchanged.
 *
 * THE MODEL'S PROSE NEVER REACHES THIS FILE, and that is a product invariant.
 * `spec.analysis` is up to 600 characters the model wrote; it is displayed
 * beside the chip and can never move it. A classifier that could be talked into
 * green by fluent wording would be a self-custodial crypto app taking safety
 * direction from a language model.
 *
 * PURE BY CONTRACT: NO CLOCK IS READ IN HERE. Whether the cached evidence is
 * past the provider's own freshness arrives ON the evidence
 * (`lastGoodExpired`), computed from `max-age - age` at the edge by the service
 * that holds the headers. A classifier that read `Date.now()` could not be
 * table-tested, and a staleness rule invented locally is a freshness claim
 * nobody can defend.
 *
 * FIRST MATCH WINS AND THE ORDER IS THE CONTRACT. An identity mismatch outranks
 * a hard flag because the flags belong to a different token. A hard flag
 * outranks staleness because a honeypot does not become safe by being freshly
 * re-read. Each numbered row below has its own fixture and its own test, and
 * the row number travels with the verdict so a fixture that reaches the right
 * answer through the wrong rule fails.
 *
 * NO ROW PRODUCES GREEN ON PARTIAL EVIDENCE. `clear` needs every required check
 * answered, a verified subject, and not one failing or unverified check.
 * Everything else is neutral or caution, and the counters keep the unknown
 * pools COUNTED rather than dropping them out of the board's arithmetic.
 *
 * WHAT THE LIVE PROBES CHANGED (`board-v3-probes/PROBES.md`):
 *  - `security.*` was ABSENT on solana for a live trending pool, so the
 *    `incomplete` row carries real production traffic and its copy is written
 *    for the ordinary case;
 *  - `liquidityLocks` was null on two of four chains, so a missing lock block
 *    is never on its own a reason to withhold `clear`;
 *  - no probe observed a lock share with `unit: "unverified"`, so the
 *    `unverified` row stands as a DEFENSIVE row over every decision figure
 *    (fixture: `quickintel.lpBurnedPct`, the one field the endpoint documents
 *    in that state). It is unit-tested, and honestly recorded as not proven
 *    live on the lock field.
 */

import { AUDIT_SOURCES, HARD_CHECK_IDS, type SafetyCheckSet } from "./safety-checks.js";

/**
 * Every state the safety chip may be in.
 *
 * A closed union with a companion tuple, so a new state cannot be added
 * without the chip table and its exhaustiveness test both failing.
 *
 * Ten states over eleven table rows: A11's rows 7 and 8 are two different
 * product statements (a hard flag, an owner power) that resolve to the same
 * chip.
 */
export const BOARD_SAFETY_STATES = [
  "pending",
  "clear",
  "flagged",
  "conflict",
  "identity-mismatch",
  "unverified",
  "not-indexed",
  "incomplete",
  "unavailable",
  "stale",
] as const;
export type BoardSafetyState = (typeof BOARD_SAFETY_STATES)[number];

/**
 * The chip's colour family. `positive` is reachable from ONE state (`clear`);
 * every partial, conflicting or unanswered state is neutral or caution, which
 * is the rule that stops a half-covered chain from reading as audited.
 */
export type BoardSafetyTone =
  | "pending"
  | "positive"
  | "caution"
  | "danger"
  | "neutral";

/**
 * Which figure of the chat card's summary a pool lands in.
 *
 * THREE buckets, not two. Every pool is counted somewhere: a pool whose checks
 * never answered is `unchecked`, which is a fact the reader is told, not a pool
 * that quietly leaves the tally.
 */
export type BoardSafetyBucket = "clean" | "high-risk" | "unchecked";

/** One provider check that answered. Provider-spelled id and source. */
export interface BoardSafetyCheck {
  readonly id: string;
  readonly verdict: "pass" | "fail" | "unverified";
  readonly source: string;
}

/**
 * What the details read actually returned about this pair's base token.
 *
 * The two identity fields are opaque comparable strings built by
 * `safety-checks.ts`; `unansweredCheckIds` is kept apart from a `fail` because
 * silence is not a verdict, and a chain the provider simply does not index must
 * not be painted as risky.
 */
export type BoardSafetyDetails = SafetyCheckSet;

/** Why a details read produced nothing usable. */
export type BoardSafetyFailure = "transport" | "timeout" | "aborted" | "not-indexed";

/**
 * How the MOST RECENT read ended. An EVENT, kept apart from the evidence below.
 */
export type BoardSafetyAttempt =
  | { readonly status: "in-flight" }
  | { readonly status: "ok"; readonly atMs: number }
  | {
      readonly status: "failed";
      readonly atMs: number;
      readonly reason: BoardSafetyFailure;
    };

/** The newest bundle that actually arrived, and the clock it arrived on. */
export interface BoardSafetyLastGood {
  readonly bundle: BoardSafetyDetails;
  readonly fetchedAtMs: number;
}

/**
 * Everything the classifier may look at: TWO INDEPENDENT FACTS.
 *
 * `lastGood` is the cached evidence and its clock; `lastAttempt` is what the
 * latest read did. Only both together distinguish:
 *
 *  - `stale`: `lastGood` exists, is past the provider's own freshness, and the
 *    refresh FAILED. The surface still renders the cached figures under an
 *    honest "as of" clock and a chip that says they are out of date;
 *  - `unavailable`: no usable cached evidence at all. Nothing to render.
 *
 * A single outcome plus a `stale` flag cannot express the first without lying
 * about the second.
 */
export interface BoardSafetyEvidence {
  readonly lastGood: BoardSafetyLastGood | null;
  readonly lastAttempt: BoardSafetyAttempt;
  /**
   * Is `lastGood` past the provider's own `max-age - age`?
   *
   * The provider's claim, never a local guess, and false whenever `lastGood`
   * is null.
   */
  readonly lastGoodExpired: boolean;
}

/** What one surface renders for one pool's safety. */
export interface BoardSafetyVerdict {
  readonly state: BoardSafetyState;
  readonly label: string;
  readonly tone: BoardSafetyTone;
  readonly bucket: BoardSafetyBucket;
}

/** The classifier's signature. Pure: same evidence, same verdict. */
export type ClassifyBoardSafety = (
  evidence: BoardSafetyEvidence,
) => BoardSafetyVerdict;

/**
 * The frozen chip presentation, one row per state.
 *
 * Copy rule behind the neutral rows: a provider that did not answer has not
 * proven the chain is unsupported, so the words say what happened to THIS
 * response and claim nothing about coverage.
 */
export const BOARD_SAFETY_CHIP: Readonly<
  Record<BoardSafetyState, Omit<BoardSafetyVerdict, "state">>
> = {
  pending: { label: "Checking", tone: "pending", bucket: "unchecked" },
  clear: { label: "Clean checks", tone: "positive", bucket: "clean" },
  flagged: { label: "High risk", tone: "danger", bucket: "high-risk" },
  conflict: { label: "Sources disagree", tone: "caution", bucket: "high-risk" },
  "identity-mismatch": {
    label: "Checks describe another token",
    tone: "caution",
    bucket: "high-risk",
  },
  unverified: { label: "Unverified", tone: "caution", bucket: "unchecked" },
  "not-indexed": {
    label: "Not indexed by the checks provider",
    tone: "neutral",
    bucket: "unchecked",
  },
  incomplete: { label: "Partial checks", tone: "caution", bucket: "unchecked" },
  unavailable: {
    label: "Checks unavailable in this response",
    tone: "neutral",
    bucket: "unchecked",
  },
  stale: { label: "Checks out of date", tone: "neutral", bucket: "unchecked" },
};

/** Assemble the verdict for a state from the frozen table. */
export function boardSafetyVerdict(state: BoardSafetyState): BoardSafetyVerdict {
  return { state, ...BOARD_SAFETY_CHIP[state] };
}

/**
 * A verdict plus the table row that produced it.
 *
 * `row` is not decoration: it is what makes a first-match-wins table
 * falsifiable. A structural superset of {@link BoardSafetyVerdict}, so this
 * function still satisfies {@link ClassifyBoardSafety}.
 */
export interface BoardSafetyClassification extends BoardSafetyVerdict {
  /** 1 to 11, matching the A11 decision table. */
  readonly row: number;
  /** The check ids that decided it, for the surfaces that list them. */
  readonly reasons: readonly string[];
}

function decided(
  state: BoardSafetyState,
  row: number,
  reasons: readonly string[] = [],
): BoardSafetyClassification {
  return { ...boardSafetyVerdict(state), row, reasons };
}

/**
 * The two auditors CONTRADICTING each other on a hard check.
 *
 * Both must have answered - one provider's silence is not a disagreement - and
 * the two answers must be a pass against a fail. Nothing here decides which
 * side is right; the disagreement is the answer.
 */
function hardConflicts(bundle: BoardSafetyDetails): readonly string[] {
  const byId = new Map<string, Set<string>>();
  for (const check of bundle.checks) {
    if (!HARD_CHECK_IDS.has(check.id)) continue;
    if (check.verdict === "unverified") continue;
    const seen = byId.get(check.id) ?? new Set<string>();
    seen.add(check.verdict);
    byId.set(check.id, seen);
  }
  const found: string[] = [];
  for (const [id, verdicts] of byId) {
    if (verdicts.has("pass") && verdicts.has("fail")) found.push(id);
  }
  return found;
}

/**
 * Classify one pool's safety from the evidence held about it.
 *
 * Pure and TOTAL: every combination of inputs reaches exactly one row.
 */
export function classifyBoardSafety(
  evidence: BoardSafetyEvidence,
): BoardSafetyClassification {
  const { lastGood, lastAttempt } = evidence;

  // ROW 1 - a first read is in flight and nothing has ever landed.
  if (lastAttempt.status === "in-flight" && lastGood === null) {
    return decided("pending", 1);
  }

  if (lastGood === null) {
    if (lastAttempt.status === "failed") {
      // ROW 3 - the provider's settled answer that it does not know this pair.
      // Checked BEFORE row 2 because it is a more specific fact about the same
      // failure, and it is not a transport problem the reader could retry away.
      if (lastAttempt.reason === "not-indexed") return decided("not-indexed", 3);
      // ROW 2 - nothing was learned and nothing was ever held. This is NOT a
      // statement that the chain is unsupported, which is why the copy says
      // what happened to this response and claims nothing about coverage.
      return decided("unavailable", 2);
    }
    // No evidence and no failure: the read has not been made yet. Not a table
    // row - it is the state BEFORE the table has an input - and it renders
    // exactly as row 1 does.
    return decided("pending", 1);
  }

  const bundle = lastGood.bundle;

  // ROW 4 - the document exists but nothing a verdict could rest on is in it:
  // every analysis block empty, or NO AUDIT PROVIDER answered for this chain.
  // Measured as the ORDINARY solana answer, not an edge case.
  //
  // The test is "no audit source answered", not "no check answered": a solana
  // document can carry chain-authority flags with neither auditor present, and
  // three passing mint-authority flags are not a contract audit. Requiring the
  // audit here rather than requiring every REQUIRED id is deliberate too - a
  // honeypot that only one auditor answered about must still read as high
  // risk, so partial coverage is caught at the END of the table (below), after
  // the flags, and never above them.
  if (!bundle.checks.some((check) => AUDIT_SOURCES.has(check.source))) {
    return decided("incomplete", 4, bundle.unansweredCheckIds);
  }

  // ROW 5 - the audit is about a DIFFERENT token. Everything below would be a
  // true statement about the wrong contract, so it outranks every flag.
  if (
    bundle.auditedTokenAddress !== null &&
    bundle.subjectTokenAddress !== null &&
    bundle.auditedTokenAddress !== bundle.subjectTokenAddress
  ) {
    return decided("identity-mismatch", 5, ["auditedToken"]);
  }

  // ROW 6 - the two providers contradict each other on a hard check.
  const conflicts = hardConflicts(bundle);
  if (conflicts.length > 0) return decided("conflict", 6, conflicts);

  // ROWS 7 AND 8 - a failing check. The two A11 rows (a hard flag, an owner
  // power) are two product statements with one chip, and the failing ids
  // travel so a surface can say which.
  const failing = bundle.checks
    .filter((check) => check.verdict === "fail")
    .map((check) => `${check.source}.${check.id}`);
  if (failing.length > 0) return decided("flagged", 7, failing);

  // ROW 9 - a decision figure whose scale nothing could establish, or a
  // provider that never stated which token it analysed. Both are the same
  // fact: the evidence for a clean verdict is not there. Deliberately not
  // green, and deliberately not red either.
  const unverified = bundle.checks
    .filter((check) => check.verdict === "unverified")
    .map((check) => `${check.source}.${check.id}`);
  if (bundle.auditedTokenAddress === null || bundle.subjectTokenAddress === null) {
    unverified.push("auditedToken");
  }
  if (unverified.length > 0) return decided("unverified", 9, unverified);

  // ROW 10 - the figures on screen are past the provider's own freshness and
  // the refresh failed. BELOW the flag rows on purpose: a honeypot does not
  // become safe by being freshly re-read, and a clean read does not become
  // dangerous by being a minute old.
  if (evidence.lastGoodExpired && lastAttempt.status === "failed") {
    return decided("stale", 10);
  }

  // ROW 11 - every required check answered, subject verified, nothing failing
  // and nothing unverified. The only row that produces green.
  if (bundle.unansweredCheckIds.length === 0) return decided("clear", 11);

  // A REQUIRED CHECK WENT UNANSWERED while everything that DID answer was
  // clean. That is a real and common shape (5 to 7 of 11 blocks answered on
  // every probed chain), and it is not green: an absent block is unknown,
  // never clean.
  return decided("incomplete", 4, bundle.unansweredCheckIds);
}

/* ------------------------------------------------------------------ */
/* Counting - the chat card's one-sentence conclusion                  */
/* ------------------------------------------------------------------ */

/** The three buckets the chat card's sentence is built from. */
export interface BoardSafetyCounts {
  readonly clean: number;
  readonly highRisk: number;
  readonly unchecked: number;
  /** Always the sum of the three, and always the board's pool count. */
  readonly total: number;
}

/** Tally the verdicts of one board. Every pool lands in exactly one bucket. */
export function countBoardSafety(
  states: readonly BoardSafetyState[],
): BoardSafetyCounts {
  let clean = 0;
  let highRisk = 0;
  let unchecked = 0;
  for (const state of states) {
    const bucket = BOARD_SAFETY_CHIP[state].bucket;
    if (bucket === "clean") clean += 1;
    else if (bucket === "high-risk") highRisk += 1;
    else unchecked += 1;
  }
  return { clean, highRisk, unchecked, total: states.length };
}

/**
 * The chat card's sentence. Empty buckets are omitted from the WORDS; nothing
 * is ever omitted from the arithmetic.
 *
 * Null for an empty board rather than an empty string, so a caller decides what
 * an absent conclusion looks like instead of rendering a blank.
 */
export function describeBoardSafetyCounts(counts: BoardSafetyCounts): string | null {
  if (counts.total === 0) return null;
  const parts: string[] = [];
  if (counts.clean > 0) {
    parts.push(`${counts.clean} clean check${counts.clean === 1 ? "" : "s"}`);
  }
  if (counts.highRisk > 0) parts.push(`${counts.highRisk} high risk`);
  if (counts.unchecked > 0) parts.push(`${counts.unchecked} unchecked`);
  return parts.join(" - ");
}
