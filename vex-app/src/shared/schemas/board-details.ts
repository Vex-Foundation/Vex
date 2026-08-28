/**
 * BOARD DETAILS - the IPC contract for the contract-safety, holder and
 * liquidity-lock read behind a board card's chip and the spotlight's bottom row.
 *
 * WHAT THIS CARRIES AND WHY IT IS A POSITIVE PICK. The provider's pair-details
 * document is large, deeply nested and full of blocks whose shape has never
 * been measured. Forwarding it would put an unbounded, unmeasured payload
 * through the renderer boundary and make every downstream reader parse safety
 * data for itself. This schema instead names, field by field, the evidence the
 * safety classifier decides on and the figures the surfaces render. A provider
 * field that is not written down here does not cross.
 *
 * FOUR MEASURED FACTS FROM THE LIVE PROBES (`board-v3-probes/PROBES.md`, P1,
 * four chains) that this shape exists to represent honestly:
 *
 *  1. `security.*` was ABSENT on solana for a live trending pool. Absence is
 *     the ORDINARY answer on some chains, not an edge case, so a missing block
 *     is a typed absence with a coverage entry, never an empty object that
 *     reads as "nothing wrong".
 *  2. `liquidityLocks` was null on two of the four chains. Same rule.
 *  3. `holderCount` was present on all four, from two different sources
 *     (`goplus` and `dexscreener`), so the SOURCE travels with the count.
 *  4. Percentage units are per-source and differ by 100x (`share.unit` is
 *     `fraction` on GoPlus rows and `percent` on native ones). Every percent
 *     therefore travels as `{raw, normalizedPct, unit}` and only
 *     `normalizedPct` is ever rendered. Nothing sums two percents whose units
 *     differ, and a `unit: "unverified"` value is never rendered as a number.
 *
 * NOTHING HERE IS AUTHORED. There is no model prose on this channel and no
 * field a renderer could use to name a host, a route or a deadline: the
 * renderer sends a chain slug and a pool address, and main owns everything
 * else.
 */

import { z } from "zod";
import { BOARD_MAX_POOLS, boardPoolInputSchema } from "@vex-lib/board/index.js";

/**
 * The pool this read is about: the same POSITIVE PICK the live channel takes,
 * for the same reason. Identity crosses; the pool document does not.
 */
export const boardDetailsSubjectSchema = boardPoolInputSchema
  .pick({ chain: true, pairAddress: true })
  .strict();
export type BoardDetailsSubject = z.infer<typeof boardDetailsSubjectSchema>;

/**
 * How a percentage was reported, verbatim from the endpoint's own vocabulary
 * (`src/tools/dexscreener/endpoints/pair-details.ts`, `PercentUnit`).
 *
 * `unverified` means the provider gave a value whose scale could not be
 * established. It is a DECISION-BEARING state, not a formatting detail: a
 * decision field in this state renders as "n/a - unverified" and drives the
 * classifier's `unverified` row, because a lock share that might be 89 or
 * 0.89 is not evidence of anything.
 */
export const boardPercentUnits = ["fraction", "percent", "unverified"] as const;

export const boardPercentSchema = z
  .object({
    /** The provider's own spelling, kept so a reader can see what was sent. */
    raw: z.string().max(64),
    /** The value normalized to percent, or null when it could not be. */
    normalizedPct: z.number().nullable(),
    unit: z.enum(boardPercentUnits),
  })
  .strict();
export type BoardPercent = z.infer<typeof boardPercentSchema>;

/** Who reported a figure. Two audit providers plus DexScreener's own index. */
export const boardDetailsSources = ["goplus", "quickintel", "dexscreener"] as const;
export type BoardDetailsSource = (typeof boardDetailsSources)[number];

/**
 * The holder count, with its source and the unit its shares are in.
 *
 * `count` null with a source present means the source answered and reported no
 * count; `source` null means nothing answered. The two are different facts and
 * the surface says which.
 */
export const boardHoldersSchema = z
  .object({
    count: z.number().int().min(0).nullable(),
    source: z.enum(boardDetailsSources).nullable(),
    /** The unit of the per-holder shares this source reports. */
    shareUnit: z.enum(boardPercentUnits).nullable(),
  })
  .strict();
export type BoardHolders = z.infer<typeof boardHoldersSchema>;

/**
 * One row of the provider's liquidity-lock index, with its TAG kept.
 *
 * THE TAG IS THE POINT, and it is a measured decision (probe C2). On both
 * chains that answered, the only lock row was tagged `Burned`, and
 * `lockedPct` was exactly that burn. Excluding burn rows would report "0
 * percent locked" for a pool whose LP is permanently burned, which is the more
 * dangerous of the two readings. So the rows are rendered verbatim with their
 * provider tags exposed ("Locked 99.99% - Burned") and nothing is dropped.
 *
 * The rule A5 states survives in its original sense: `quickintel.lpBurnedPct`
 * is NEVER substituted for a lock share. That is a different field on a
 * different provider, and it is the one field measured arriving with
 * `unit: "unverified"`.
 */
export const boardLockRowSchema = z
  .object({
    tag: z.string().max(120).nullable(),
    share: boardPercentSchema.nullable(),
  })
  .strict();
export type BoardLockRow = z.infer<typeof boardLockRowSchema>;

/**
 * The liquidity-lock block, or null when the provider has no lock index for
 * this chain (measured null on 2 of 4 chains).
 *
 * `lockedPct` is the endpoint's projected total share. The plan called this
 * field `totalShare`; the endpoint module spells it `totalShare` and the
 * agent-facing tool envelope spells it `lockedPct`, and this contract takes the
 * envelope's name because that is the name the probe archive records and the
 * name the surfaces already use.
 */
export const boardLiquidityLocksSchema = z
  .object({
    lockedPct: boardPercentSchema.nullable(),
    rows: z.array(boardLockRowSchema).max(50),
  })
  .strict();
export type BoardLiquidityLocks = z.infer<typeof boardLiquidityLocksSchema>;

/**
 * Coverage: which analysis blocks the provider actually answered.
 *
 * Derived from the response, never from a catalog. An absent block is UNKNOWN,
 * never clean, and `not_indexed` is the provider answering 200 with every
 * block empty - a well-formed document that says nothing.
 */
export const boardCoverageStates = ["complete", "partial", "not_indexed"] as const;

export const boardCoverageSchema = z
  .object({
    state: z.enum(boardCoverageStates),
    presentBlocks: z.array(z.string().max(64)).max(32),
    absentBlocks: z.array(z.string().max(64)).max(32),
  })
  .strict();
export type BoardCoverage = z.infer<typeof boardCoverageSchema>;

/** A nullable boolean flag as a provider reported it. Null is "did not say". */
const flag = z.boolean().nullable();

/**
 * The GoPlus flags the classifier decides on, and only those.
 *
 * Named one by one rather than passed through, so adding a provider field to
 * the decision is a deliberate edit here and in the classifier table together.
 */
export const boardGoPlusFlagsSchema = z
  .object({
    isHoneypot: flag,
    isOpenSource: flag,
    isProxy: flag,
    isMintable: flag,
    isBlacklisted: flag,
    transferPausable: flag,
    hiddenOwner: flag,
    canTakeBackOwnership: flag,
    cannotSellAll: flag,
    slippageModifiable: flag,
    buyTaxPct: boardPercentSchema.nullable(),
    sellTaxPct: boardPercentSchema.nullable(),
    ownerShare: boardPercentSchema.nullable(),
    creatorShare: boardPercentSchema.nullable(),
  })
  .strict();
export type BoardGoPlusFlags = z.infer<typeof boardGoPlusFlagsSchema>;

/** The QuickIntel flags the classifier decides on, and only those. */
export const boardQuickIntelFlagsSchema = z
  .object({
    contractVerified: flag,
    isScam: flag,
    isHoneypot: flag,
    isProxy: flag,
    hiddenOwner: flag,
    canMint: flag,
    canBlacklist: flag,
    canPauseTrading: flag,
    hasFeeWarning: flag,
    hasExternalContractRisk: flag,
    hasGeneralVulnerabilities: flag,
    hasObfuscatedAddressRisk: flag,
    buyTaxPct: boardPercentSchema.nullable(),
    sellTaxPct: boardPercentSchema.nullable(),
    transferTaxPct: boardPercentSchema.nullable(),
    /**
     * The burned share of the LP as QuickIntel reports it.
     *
     * CARRIED FOR HONESTY, NEVER SUBSTITUTED. It is displayed nowhere as a
     * lock share and never stands in for `liquidityLocks.lockedPct`. It is
     * here because it is the one field measured arriving with
     * `unit: "unverified"`, which is the state the classifier's defensive
     * `unverified` row exists for (probe C3).
     */
    lpBurnedPct: boardPercentSchema.nullable(),
  })
  .strict();
export type BoardQuickIntelFlags = z.infer<typeof boardQuickIntelFlagsSchema>;

/**
 * Solana's own authority flags, which live outside both audit providers.
 *
 * They are gated behind the provider's `supply` field group, which is a trap
 * the endpoint's coverage map makes visible rather than hides.
 */
export const boardTokenAuthoritySchema = z
  .object({
    solanaMintable: flag,
    solanaFreezable: flag,
    solanaBridgeMintOnly: flag,
  })
  .strict();
export type BoardTokenAuthority = z.infer<typeof boardTokenAuthoritySchema>;

/**
 * One hard disagreement between the two audit providers on a comparable flag.
 *
 * Only fields both answered are compared: one provider's silence is not a
 * disagreement, and nothing here decides which side is right. A conflict on a
 * HARD flag is its own classifier state, because "one of our two auditors says
 * this is a honeypot" is not a clean result and is not a flagged one either.
 */
export const boardSafetyConflictSchema = z
  .object({
    field: z.string().max(64),
    goplus: flag,
    quickintel: flag,
    /** Whether this field is one of the hard flags. */
    hard: z.boolean(),
  })
  .strict();
export type BoardSafetyConflict = z.infer<typeof boardSafetyConflictSchema>;

/**
 * The audit provider's OWN statement of which token it analysed, checked
 * against the token this card is about.
 *
 * `mismatch` true means every flag below belongs to a different token, so no
 * green may be shown on the strength of them. `addressesAgree` and
 * `symbolsAgree` null mean the provider stated no subject, which is an
 * UNVERIFIED subject rather than a verified one.
 */
export const boardAuditedTokenCheckSchema = z
  .object({
    /** The token the AUDIT says it analysed, as the provider spelled it. */
    auditedTokenAddress: z.string().max(128).nullable(),
    auditedTokenSymbol: z.string().max(512).nullable(),
    addressesAgree: z.boolean().nullable(),
    symbolsAgree: z.boolean().nullable(),
    mismatch: z.boolean(),
  })
  .strict();
export type BoardAuditedTokenCheck = z.infer<typeof boardAuditedTokenCheckSchema>;

export const boardSafetySchema = z
  .object({
    coverage: boardCoverageSchema,
    goplus: boardGoPlusFlagsSchema.nullable(),
    quickintel: boardQuickIntelFlagsSchema.nullable(),
    tokenAuthority: boardTokenAuthoritySchema.nullable(),
    conflicts: z.array(boardSafetyConflictSchema).max(32),
  })
  .strict();
export type BoardSafety = z.infer<typeof boardSafetySchema>;

/**
 * The provider's cache window as its own headers stated it.
 *
 * `cacheMaxAgeSeconds` was 60 on all four probed chains; `cacheAgeSeconds` was
 * ABSENT on ethereum. An unknown age is not a fresh one, which is why the
 * service's expiry rule has a floor rather than a full window (probe C4), and
 * why both fields cross rather than a single pre-computed freshness number: the
 * surface states the age it actually knows.
 */
export const boardProviderWindowSchema = z
  .object({
    cacheMaxAgeSeconds: z.number().int().min(0).nullable(),
    cacheAgeSeconds: z.number().int().min(0).nullable(),
  })
  .strict();
export type BoardProviderWindow = z.infer<typeof boardProviderWindowSchema>;

/** The typed bundle every board surface reads. One read, four consumers. */
export const boardDetailsBundleSchema = z
  .object({
    subject: boardDetailsSubjectSchema,
    /** The base token as the PAIR reports it, for the identity cross-check. */
    baseTokenAddress: z.string().max(128).nullable(),
    baseTokenSymbol: z.string().max(512).nullable(),
    holders: boardHoldersSchema,
    liquidityLocks: boardLiquidityLocksSchema.nullable(),
    safety: boardSafetySchema,
    auditedTokenCheck: boardAuditedTokenCheckSchema,
    providerWindow: boardProviderWindowSchema,
    /** When main read it, and when the entry stops being served from cache. */
    fetchedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
    /**
     * The narrative ids the provider's CMS profile carries for this token.
     *
     * The JOIN KEY, and it is here because the profile block is on this same
     * document: `profile.metaIds` holds the opaque ids `narratives_list`
     * publishes, demonstrated end to end in probe P6. An EMPTY array is the
     * common case (both P1 memecoin subjects returned `[]`) and renders as a
     * designed "no narrative" state, never as a missing element.
     */
    metaIds: z.array(z.string().max(64)).max(32),
  })
  .strict();
export type BoardDetailsBundle = z.infer<typeof boardDetailsBundleSchema>;

/**
 * One read's outcome. Three families, deliberately not collapsed, matching the
 * board icon service's own vocabulary.
 *
 *  - `details`     the provider answered and this is what it said;
 *  - `absent`      settled: asking again now would answer the same way;
 *  - `unavailable` unknown: nothing was learned, and asking again may work.
 *
 * `not_indexed` is an ABSENCE rather than a failure, and it is the single most
 * important distinction on this channel: the provider answered successfully
 * with every analysis block empty. It must never render as a clean result.
 */
export const boardDetailsOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("details"), bundle: boardDetailsBundleSchema }).strict(),
  z
    .object({
      kind: z.literal("absent"),
      /**
       * The provider does not know this identity on this chain (HTTP 404).
       *
       * The OTHER kind of "nothing here" - a 200 whose analysis blocks are all
       * empty - is NOT an absence and does not appear on this branch: it is a
       * real document that says nothing, so it crosses as a bundle whose
       * coverage state is `not_indexed`, keeps its clocks, and reaches the
       * classifier as evidence rather than as a missing answer.
       */
      reason: z.literal("unknown_pair"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum(["transport", "provider", "busy", "not_mounted", "cancelled"]),
    })
    .strict(),
]);
export type BoardDetailsOutcome = z.infer<typeof boardDetailsOutcomeSchema>;

export const boardDetailsReadInputSchema = z
  .object({ subject: boardDetailsSubjectSchema })
  .strict();
export type BoardDetailsReadInput = z.infer<typeof boardDetailsReadInputSchema>;

export const boardDetailsReadResultSchema = z
  .object({
    subject: boardDetailsSubjectSchema,
    outcome: boardDetailsOutcomeSchema,
  })
  .strict();
export type BoardDetailsReadResult = z.infer<typeof boardDetailsReadResultSchema>;

/**
 * The PREFETCH request: every pool of one board in one call.
 *
 * WHY IT EXISTS AT ALL. The chat card states "3 clean checks - 2 high risk"
 * BEFORE anything opens the modal, and those counts are the classifier's
 * verdict over every pool. Without a board-wide entry point the card would
 * have to open eight IPC conversations of its own, or the counts would have to
 * wait for a modal the reader may never open. Pools that could not be read are
 * still COUNTED - as `unchecked` - so the sentence always accounts for the
 * whole board.
 */
export const boardDetailsPrefetchInputSchema = z
  .object({
    pools: z.array(boardDetailsSubjectSchema).min(1).max(BOARD_MAX_POOLS),
  })
  .strict();
export type BoardDetailsPrefetchInput = z.infer<
  typeof boardDetailsPrefetchInputSchema
>;

/**
 * One entry per requested pool, in the order asked, keyed by identity anyway.
 *
 * Keyed AND ordered because the two protect against different mistakes: the
 * order makes the answer readable, and the key is what a consumer pairs on, so
 * a reordering can never put one pool's verdict on another pool's card.
 */
export const boardDetailsPrefetchEntrySchema = z
  .object({
    key: z.string().min(3).max(200),
    subject: boardDetailsSubjectSchema,
    outcome: boardDetailsOutcomeSchema,
  })
  .strict();
export type BoardDetailsPrefetchEntry = z.infer<
  typeof boardDetailsPrefetchEntrySchema
>;

export const boardDetailsPrefetchResultSchema = z
  .object({
    entries: z.array(boardDetailsPrefetchEntrySchema).min(1).max(BOARD_MAX_POOLS),
  })
  .strict();
export type BoardDetailsPrefetchResult = z.infer<
  typeof boardDetailsPrefetchResultSchema
>;

/** The identity two sides pair a pool on. Lowercased: providers vary case. */
export function boardPoolKey(subject: BoardDetailsSubject): string {
  return `${subject.chain}:${subject.pairAddress}`.toLowerCase();
}
