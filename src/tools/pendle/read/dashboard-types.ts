/**
 * WALLET-SCOPED read shapes from `GET /v1/dashboard/positions/database/{user}`.
 *
 * Split from `./types.ts` (which holds the MARKET-scoped shapes) because they
 * change for different reasons: market shapes move when Pendle's catalogue moves,
 * these move when the dashboard's per-wallet accounting moves.
 *
 * WHAT THIS EXISTS FOR. The frozen money-path validator
 * (`../validation.ts:validatePositions`) keeps `chainId` + `openPositions{marketId,
 * pt, yt, lp}` and drops everything else on the floor. The dropped fields are not
 * decoration — they are the entire reason a user's portfolio reads wrong today:
 *
 *   `yt.balance`          — validated then never projected, so a YT position the
 *                           agent can open is one it can never see or exit (G-16).
 *   `claimTokenAmounts[]` — the real accrued amounts, so a claim preview shows
 *                           no numbers at all (G-17).
 *   `syPositions[]`       — SY holdings are invisible (G-17).
 *   `crossPtPositions[]`  — cross-chain PT legs vanish (G-17).
 *   `activeBalance`       — the staked-vs-wallet LP split (G-17).
 *   `updatedAt`           — a probed wallet was 364 days stale and nothing said so.
 *
 * Same contract as the rest of the read shelf: display fields tolerant, identity
 * and raw amounts strict, and NOTHING here is consumed financially. Every
 * `*Raw` value is base units with NO decimals attached — this endpoint does not
 * carry them, so a consumer must resolve decimals from the chain's asset
 * catalogue before rendering (rules/90).
 */

/** One accrued, unclaimed reward or interest amount on a position leg. */
export interface PendleReadDashboardClaimable {
  /** Reward token contract, bare lowercase 0x. */
  token: string;
  /** Base-unit amount, decimal digits only. */
  amountRaw: string;
}

/**
 * One leg (PT, YT or LP) of a market position.
 *
 * `activeBalanceRaw` is LP-only and is routinely a FRACTION of `balanceRaw` —
 * it is the share currently staked for boosted rewards, not a second balance.
 * Presenting the two as if they were alternatives would misreport the position.
 */
export interface PendleReadDashboardLeg {
  /** Base-unit balance, decimal digits only. */
  balanceRaw: string;
  /** Provider's USD mark. Display only. */
  valuationUsd: number | null;
  /** LP only: the staked share of `balanceRaw`. Null when the provider omits it. */
  activeBalanceRaw: string | null;
  /**
   * Accrued but unclaimed amounts. The provider CACHES these for up to 24 hours
   * and says so; a consumer must pair them with the chain's `updatedAt`.
   */
  claimable: PendleReadDashboardClaimable[];
}

/**
 * A PT held on a spoke chain against a hub market.
 *
 * NO NON-EMPTY LIVE SAMPLE EXISTS. This array was empty on all 326 wallets
 * probed on 2026-07-27, consistent with Pendle listing zero spoke markets today.
 * The field is validated rather than dropped so a holding can never go missing
 * silently, but any consumer must treat its row shape as UNPROVEN.
 */
export interface PendleReadDashboardCrossPt {
  /** Spoke PT contract, bare lowercase 0x. */
  spokePt: string;
  /** Chain the spoke PT lives on, when the id composite carries it. */
  chainId: number | null;
  balanceRaw: string;
}

/** One market's position, all legs together. */
export interface PendleReadDashboardMarketPosition {
  /** Market (LP) contract the legs belong to, bare lowercase 0x. */
  market: string;
  pt: PendleReadDashboardLeg | null;
  yt: PendleReadDashboardLeg | null;
  lp: PendleReadDashboardLeg | null;
  /** Live shape note: this is a key on the POSITION entry, not the chain entry. */
  crossPt: PendleReadDashboardCrossPt[];
}

/** A standalone SY holding, outside any market position. */
export interface PendleReadDashboardSyPosition {
  /** SY contract, bare lowercase 0x. */
  sy: string;
  balanceRaw: string;
  claimable: PendleReadDashboardClaimable[];
}

export interface PendleReadDashboardChain {
  chainId: number;
  /**
   * When the provider last recomputed this chain's positions. Probed wallets
   * came back 56 and 364 days stale, so this is load-bearing, not metadata.
   */
  updatedAt: string | null;
  /** The provider's own counts, kept so our row count can be checked against them. */
  totalOpen: number | null;
  totalClosed: number | null;
  totalSy: number | null;
  open: PendleReadDashboardMarketPosition[];
  sy: PendleReadDashboardSyPosition[];
}

export interface PendleReadDashboardPositions {
  chains: PendleReadDashboardChain[];
}
