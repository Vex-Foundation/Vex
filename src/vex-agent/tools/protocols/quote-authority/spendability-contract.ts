/**
 * The vocabulary of SPENDABILITY: can the wallet that asked for this quote
 * actually pay for the swap the quote describes.
 *
 * Runtime-free on purpose. `eligibility.ts` owns the verdict union and imports
 * these shapes; the venue adapters (WP2-E0/K/U/J) produce the observations; the
 * prequote recorder persists the preview and the execute-time gate restores it.
 * Keeping the vocabulary in its own module is what lets all four cross the
 * process and persistence boundaries without importing a venue.
 *
 * TWO THINGS THIS MODULE IS NOT.
 *
 * It is not a wallet cache. `SourceBalanceObservation` is ONE narrow read of
 * ONE asset at ONE block tag at ONE instant, and it is stamped with all four so
 * a later reader cannot mistake it for current truth (contract C2.4). MetaMask
 * keeps a background balance controller and STILL gates spending on a fresh RPC
 * read (`transaction-pay-controller/src/utils/token.ts:56` advisory versus
 * `:326` gating); we do the same.
 *
 * It is not sign-time authority. A `SpendabilityPreview` restored from a
 * prequote row states what was true when the quote was taken. The authoritative
 * debit read belongs to the pre-sign window, and the card line says so in
 * words.
 */

/**
 * A money figure that must survive a wallet with no token metadata.
 *
 * The triple Required / Current / Missing is MetaMask's
 * (`transaction-pay-controller/src/utils/validation.ts:150-171`), and so is the
 * degradation: when the token's decimals and symbol are unknown, the RAW atomic
 * value is shown and nothing is guessed (`utils/validation.ts:187-189`). Vex
 * binds that as contract C1.2/C2 - never assume 18 decimals, never invent a
 * symbol.
 *
 * `raw` is an EXACT base-10 integer string of atomic units. It is the field
 * every comparison is made from; `human` exists only so a person can read the
 * card, and is `null` whenever `decimals` is not a usable token scale.
 */
export interface Shortfall {
  /** Exact atomic units, base-10 integer string. Never hex, never a float. */
  readonly raw: string;
  /** `raw` scaled by `decimals`, full precision. `null` when not derivable. */
  readonly human: string | null;
  /** The token scale used for `human`, or `null` when it was not usable. */
  readonly decimals: number | null;
  /** The token's own symbol, or `null` when metadata was unavailable. */
  readonly symbol: string | null;
}

/**
 * Which asset a spendability statement is about.
 *
 * Chain-scoped by construction: the same address on two chains is two assets,
 * and a balance statement that lost its chain is a statement about nothing.
 * That is also why the chain is carried HERE rather than beside the asset on
 * every enclosing shape - one copy cannot disagree with itself.
 */
export interface AssetRef {
  readonly chainId: number;
  /**
   * The asset's on-chain identity as the venue's own lane writes it: an EVM
   * contract address, an EVM native sentinel, or a Solana mint. Never
   * normalized here - this module does not own asset identity.
   */
  readonly address: string;
  /** The token's symbol when the lane could read it, else `null` (never guessed). */
  readonly symbol: string | null;
}

/**
 * The block tag a balance was read at.
 *
 * `pending` is the only tag that subtracts a wallet's own in-flight
 * transactions, which is the whole point of reading before a swap. `latest`
 * therefore is NOT an equivalent (contract C2.4): it may show funds an
 * unconfirmed transfer has already spent. It appears in this union because a
 * `latest` value is worth RETAINING as advisory evidence when `pending` fails,
 * never because a `latest` read may authorize a swap.
 *
 * MetaMask's own helper falls back from `pending` to `latest` and treats the
 * result as authoritative (`utils/token.ts:381-390`). That is the one decision
 * from that reference we deliberately did not adopt.
 */
export type BalanceBlockTag = "pending" | "latest";

/**
 * One narrow chain read of one asset for one wallet.
 *
 * Every field is here so that a consumer can judge the read rather than trust
 * it: WHO (`wallet`), WHAT (`asset`, which carries the chain), AT WHICH
 * CONSISTENCY (`blockTag`), HOW MUCH (`balanceRaw` exact, `balance` for humans
 * only), and WHEN (`observedAt`).
 */
export interface SourceBalanceObservation {
  /** The address whose balance was read, as the venue's lane spells it. */
  readonly wallet: string;
  readonly asset: AssetRef;
  readonly blockTag: BalanceBlockTag;
  /** Exact atomic units, base-10 integer string. */
  readonly balanceRaw: string;
  /** The token scale, or `null` when it was not a usable one (C1.2). */
  readonly decimals: number | null;
  /** `balanceRaw` scaled by `decimals`, or `null` when not derivable. */
  readonly balance: string | null;
  /** ISO-8601 instant the read was taken. */
  readonly observedAt: string;
}

/**
 * The outcome of trying to observe a balance.
 *
 * A failure is a FIRST-CLASS state carrying its own reason, not a zero and not
 * an absent field - rule 04's refusal to collapse unavailable, denied and
 * empty. `advisoryLatest` is the `latest` value when the `pending` read failed:
 * it is retained because it is genuine evidence for a human reading a refusal,
 * and it can never become the verdict.
 */
export type SourceBalanceRead =
  | { readonly ok: true; readonly observation: SourceBalanceObservation }
  | {
      readonly ok: false;
      readonly asset: AssetRef;
      /**
       * A BOUNDED structural cause class, never raw provider or RPC text. The
       * producer picks it from its own closed vocabulary; this module only
       * requires that it be short and free of provider payload.
       */
      readonly cause: string;
      readonly advisoryLatest?: SourceBalanceObservation;
    };

/**
 * One leg of the spendability statement: what the swap needs from an asset and
 * what the wallet held when the quote was taken.
 *
 * There are exactly two legs on every EVM swap and they are not the same
 * question. The SOURCE leg asks whether the principal can be sent. The NATIVE
 * leg asks whether every fee the swap will incur - reset-allowance gas,
 * allowance gas, swap gas, L1 data fee, tip, and the follow-up reserve - can be
 * paid, which is why an ERC-20 swap still has a native leg (contract C2.5).
 */
export interface SpendabilityLeg {
  readonly asset: AssetRef;
  readonly wallet: string;
  readonly blockTag: BalanceBlockTag;
  readonly observedAt: string;
  /** What the swap debits from this asset. */
  readonly required: Shortfall;
  /** What the wallet held at `observedAt`. */
  readonly current: Shortfall;
}

/**
 * What the approval card states about spendability, restored from the matched
 * prequote row.
 *
 * QUOTE-TIME FACTS ONLY. The card version rides inside the rendered line for
 * the same reason the quote-binding line carries one: a card written by an
 * older build must be textually different from one written by this build, so
 * the whole-card comparison at confirm time refuses it instead of confirming a
 * line whose meaning changed underneath the person who read it.
 */
export interface SpendabilityPreview {
  readonly cardVersion: string;
  readonly source: SpendabilityLeg;
  readonly native: SpendabilityLeg;
}

/** The version tag rendered at the head of the spendability card line. */
export const SPENDABILITY_CARD_VERSION = "spendability-v1";
