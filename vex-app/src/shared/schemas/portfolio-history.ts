/**
 * Portfolio HISTORY schemas - the wallet total over time, read from the
 * balance snapshots the engine already publishes (`proj_portfolio_snapshots`).
 * The Portfolio page's equity chart is its consumer (plan section 4.6, item
 * 12); this contract is the data alone.
 *
 * ## The wallets are the portfolio read's own scope, not a new one
 *
 * `wallets` IS a `PortfolioReadInput`, the exact discriminated union
 * `vex.portfolio.read` takes, and main resolves it through the SAME resolver
 * (`resolveAddresses` in `main/database/portfolio-db.ts`). Every scope chip on
 * the Portfolio page therefore reads its history the way it reads its
 * figures:
 *
 *  - "All wallets"   `{ scope: "global" }`
 *  - one wallet      `{ scope: "global", walletAddress }`, authorized against
 *                    the configured inventory, refused outside it
 *  - "This chat"     `{ scope: "session", sessionId }`
 *  - "This project"  `{ scope: "project", projectId }`
 *
 * A second scope vocabulary for the same wallets would be a second place to
 * get the allow-list wrong. Reusing the union means the history can never
 * cover a wallet the figures beside it do not, and a new arm added to the read
 * reaches the history without a change here.
 *
 * ## Each point is one COMPLETE snapshot cycle, on the read's own basis
 *
 * A point is one snapshot GROUP (one `fullBalanceSync` cycle) that holds a row
 * for EVERY wallet in the resolved set - the `HAVING COUNT(DISTINCT) = N` rule
 * the read's PnL basis uses, so a cycle that missed a wallet never draws as a
 * dip. `totalUsd` is SETTLED + IN TRANSIT with in transit summed per wallet
 * over exactly that set, which is how `snapshotTotalUsd` is built
 * (`main/database/portfolio/snapshot-basis.ts`). The newest point is therefore
 * the same figure the Portfolio total shows for the same cycle, and money
 * mid-bridge never reads as a loss on the chart either.
 *
 * Consequence worth knowing: cycles taken before a wallet joined the set have
 * no row for it and are not points. A history for a set that changed last week
 * starts last week. Nothing is back-filled or estimated.
 *
 * `partial: true` marks a cycle in which a chain read failed; its value is
 * real but incomplete, exactly as `snapshotPartial` on the read. It is listed,
 * never dropped, so a surface decides how to draw it.
 *
 * ## The answer is bounded, and says when it was thinned
 *
 * The publisher runs every few minutes, so 30 days can hold thousands of
 * cycles and `all` is unbounded. Main returns at most
 * `PORTFOLIO_HISTORY_MAX_POINTS`: when the range holds more, it divides the
 * range's span into that many equal time buckets and keeps the LATEST cycle in
 * each (the bucket's closing value), and the newest cycle is always kept.
 * `groupCount` is every complete cycle in the range, counted before thinning;
 * `sampled` is `groupCount > points.length`. A surface is never handed a
 * thinned series as if it were every reading.
 *
 * ## Read only
 *
 * Nothing here moves, signs or writes. The DTO carries timestamps and USD
 * figures only - no address, no token, no snapshot id. The addresses never
 * leave main.
 */

import { z } from "zod";

import { portfolioReadInputSchema } from "./portfolio.js";

/** The ranges the engine's snapshot history already offers. */
export const PORTFOLIO_HISTORY_RANGES = ["24h", "7d", "30d", "all"] as const;
export const portfolioHistoryRangeSchema = z.enum(PORTFOLIO_HISTORY_RANGES);
export type PortfolioHistoryRange = z.infer<typeof portfolioHistoryRangeSchema>;

/**
 * The bound on `points`. 24 hours at the default five-minute cadence (288
 * cycles) fits whole; longer ranges are thinned to this many buckets.
 */
export const PORTFOLIO_HISTORY_MAX_POINTS = 500;

/**
 * IPC input for `vex.portfolio.readHistory`. `.strict()` refuses a stray key,
 * and `wallets` carries the read's own strict arms, so a malformed scope is
 * refused at the parse and can never widen to the global inventory.
 */
export const portfolioHistoryInputSchema = z
  .object({
    range: portfolioHistoryRangeSchema,
    wallets: portfolioReadInputSchema,
  })
  .strict();
export type PortfolioHistoryInput = z.infer<typeof portfolioHistoryInputSchema>;

/**
 * One complete snapshot cycle. `at` is the cycle's time (the latest
 * `created_at` among its rows). `totalUsd` = `settledUsd` + `inTransitUsd`;
 * the halves are kept apart because settled is measured and in transit is a
 * sum of estimates, as on the read.
 */
export const portfolioHistoryPointDtoSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    totalUsd: z.number(),
    settledUsd: z.number(),
    inTransitUsd: z.number().nonnegative(),
    partial: z.boolean(),
  })
  .strict();
export type PortfolioHistoryPointDto = z.infer<typeof portfolioHistoryPointDtoSchema>;

/**
 * The history for one scope and range, oldest point first.
 *
 *  - `scope`/`range`  - echoed, so a cached answer names what it covers.
 *  - `walletCount`    - resolved addresses in the allow-list. 0 means the
 *                       scope holds no wallet; `points` is then empty and no
 *                       SQL was issued.
 *  - `groupCount`     - complete cycles in the range before thinning.
 *  - `sampled`        - `groupCount > points.length`.
 *  - `points`         - at most `PORTFOLIO_HISTORY_MAX_POINTS`. Empty is a
 *                       real state (no cycle yet, or none in this range),
 *                       never an error.
 */
export const portfolioHistoryDtoSchema = z
  .object({
    scope: z.enum(["global", "session", "project"]),
    range: portfolioHistoryRangeSchema,
    walletCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    sampled: z.boolean(),
    points: z
      .array(portfolioHistoryPointDtoSchema)
      .max(PORTFOLIO_HISTORY_MAX_POINTS),
  })
  .strict();
export type PortfolioHistoryDto = z.infer<typeof portfolioHistoryDtoSchema>;
