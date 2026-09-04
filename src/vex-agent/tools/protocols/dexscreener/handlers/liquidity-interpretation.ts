/**
 * What a pool's USD liquidity figure can and cannot establish.
 *
 * One owner for one claim, because the claim is a causal one and the payload
 * that carried the number said nothing about it. MEASURED FAILURE, live agent
 * session 2026-08-30: a pool's `liquidityUsd` was re-read as 210K then 223K
 * over an interval in which the pair price rose about 10.7 percent, and the
 * answer that reached the user was "someone added to the pool, which is mildly
 * constructive". On a two-sided pool the USD figure is a MARK of the reserves
 * at the current price, so it moves with price alone; a 10.7 percent price move
 * on an unchanged position moves the reported dollar value by roughly the same
 * order as the 6 percent that was read as a deposit.
 *
 * The remedy is structural rather than prose. `liquidityUsd` never travels to
 * the model again without a sibling block that names its basis, states in a
 * field rather than a sentence that a deposit or a withdrawal is NOT derivable
 * from it, carries the per-side reserve amounts when they were read, and names
 * the tool that CAN answer the question.
 */

/** The token amounts on each side of the pool, when the caller read them. */
export interface ReserveAmounts {
  readonly baseTokens: number | null;
  readonly quoteTokens: number | null;
}

/**
 * What the block qualifies.
 *
 * `this_pair` is a single-pool answer, where the figure itself is echoed so a
 * reader can see the block and the number are about the same thing.
 * `every_row_in_this_answer` is a comparative ranking of many rows: the claim
 * is about what the FIELD means and does not vary per row, so the block sits
 * once at the envelope rather than being copied onto every row.
 */
export type LiquidityInterpretationScope =
  | "this_pair"
  | "every_row_in_this_answer";

export interface LiquidityInterpretationInput {
  readonly appliesTo?: LiquidityInterpretationScope;
  /**
   * The mark-to-market figure this block qualifies. Omitted on a many-row
   * answer, where there is no single figure to echo.
   */
  readonly liquidityUsd?: number | null;
  /**
   * The per-side reserves, or null when the caller did not request the
   * `reserves` field group. Null is "not asked for", not "the pool has none".
   */
  readonly reserves: ReserveAmounts | null;
  /** Why there is no USD figure at all, when the row declared one. */
  readonly notApplicableReason?: string;
}

/** The tool that can actually establish an add or a remove. */
export const LIQUIDITY_EVENT_SOURCE = {
  tool: "dexscreener__trades_list",
  params: { eventType: "liquidity" },
  note: "eventType liquidity returns the pool's own add and remove events, each with its token amounts. Those events are the only evidence in this surface that liquidity was deposited or withdrawn.",
} as const;

const NOT_DERIVABLE_REASON =
  "liquidityUsd is the CURRENT PRICE mark of the reserves, not a deposit ledger. On a two-sided pool it moves whenever the price moves, with the reserves unchanged, so a rise or a fall in it establishes nothing about whether liquidity was added or removed. Two reads of this field are not a flow measurement.";

const RESERVES_NOT_REQUESTED =
  "Not read on this call. Ask for the reserves field group (fields includes reserves) to get the per-side token amounts, which DO change when liquidity is deposited or withdrawn and do not change on a price move alone.";

const RESERVES_NOT_REPORTED =
  "The reserves field group was requested and the provider reported no per-side amounts for this pool. Unavailable, not zero.";

/**
 * Build the block that must accompany every `liquidityUsd` sent to the model.
 *
 * Always present, including when the figure itself is null: a reader that sees
 * no number still needs to know that the number would not have answered the
 * question they are asking.
 */
export function liquidityInterpretation(
  input: LiquidityInterpretationInput
): Record<string, unknown> {
  const reserves = input.reserves;
  const reserved =
    reserves !== null
    && (reserves.baseTokens !== null || reserves.quoteTokens !== null);
  const appliesTo = input.appliesTo ?? "this_pair";
  return {
    appliesTo,
    ...(appliesTo === "this_pair"
      ? { liquidityUsd: input.liquidityUsd ?? null }
      : {
          perRowNote:
            "Every liquidityUsd on every row of this answer, and every ordering, filter or share computed from one. The statement below is about what the FIELD is and does not vary per row, so it is stated once here rather than copied onto each row.",
        }),
    basis: "mark_to_market_usd",
    /*
     * THE REFUSAL IS A FIELD, NOT A SENTENCE. A boolean the reader can test is
     * what a paragraph next to a number was measured failing to be.
     */
    establishesLiquidityAddedOrRemoved: false,
    movesWithPriceAlone: true,
    reason: NOT_DERIVABLE_REASON,
    ...(input.notApplicableReason === undefined
      ? {}
      : { notApplicableReason: input.notApplicableReason }),
    reserveAmounts: reserved
      ? {
          status: "read",
          baseTokens: reserves?.baseTokens ?? null,
          quoteTokens: reserves?.quoteTokens ?? null,
          note: "The pool's two sides in TOKENS, at the same observation as liquidityUsd. A deposit or a withdrawal changes these; a price move does not. Comparing them across two reads is the only comparison on this row that speaks to flow, and even then it cannot attribute the change to a particular actor.",
        }
      : {
          status: reserves === null ? "not_requested" : "not_reported",
          baseTokens: null,
          quoteTokens: null,
          note: reserves === null ? RESERVES_NOT_REQUESTED : RESERVES_NOT_REPORTED,
        },
    answeredBy: LIQUIDITY_EVENT_SOURCE,
  };
}
