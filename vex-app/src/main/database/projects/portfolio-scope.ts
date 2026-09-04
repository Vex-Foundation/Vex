/**
 * The wallet allow-list a PROJECT-scoped portfolio read runs against (B0).
 *
 * ## Why this is not `getSessionWalletScope`
 *
 * Two independent reasons, either of which would be disqualifying:
 *
 *   1. It filters `scope = 'vex_app'`. A project's backing session carries
 *      `scope = 'vex_studio'`, so that function does not fail for a project -
 *      it returns the EMPTY scope, and the portfolio would render as "you hold
 *      nothing" rather than as an error. Silently showing an empty portfolio
 *      for a funded project is the worst available outcome, and it is what
 *      reuse would have produced.
 *   2. It reads the session's four wallet columns, which are a compatibility
 *      MIRROR. `project_wallets` is authoritative (migration 085,
 *      `projects/scope.ts`), and a drifted mirror must never decide which key's
 *      balances a user is shown.
 *
 * ## Fails closed, and distinguishes its failures
 *
 * A missing OR TOMBSTONED project is `projects.not_found`. A stored selection
 * that no longer matches the inventory is `projects.wallet_drift`, never an
 * empty list: the drift policy is owned once, by `projectWallets` in
 * `mappers.ts`, and this path deliberately reuses it rather than re-deriving a
 * second answer to "is this selection still real".
 *
 * A project with no wallet selected at all is NOT an error - it resolves to an
 * empty address list, which the caller renders as an empty portfolio. That is a
 * different state from "unknown project" and from "drift", and rule 04 forbids
 * collapsing the three.
 *
 * ## Why it lives here rather than in `portfolio-db.ts`
 *
 * It is a `projects` read, owned by the projects repository, and keeping it
 * behind its own module means the portfolio resolver reaches it through a seam
 * it can be tested against - the same shape `getSessionWalletScope` already has
 * for the session arm.
 *
 * ## Why it reports an OUTCOME rather than a `VexError`
 *
 * Every helper in `studio/project-errors.ts` requires a `correlationId`, and
 * `registerHandler` overwrites (and warns about) any correlationId a handler
 * attaches that is not the request's own. `portfolio-db.ts` therefore builds
 * its errors WITHOUT one on purpose, and documents that choice. So this module
 * reports what it found and the portfolio resolver names it in the portfolio
 * domain's own vocabulary - neither file has to adopt the other's convention.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import type { ProjectWallets } from "@shared/schemas/projects.js";
import { log } from "../../logger/index.js";
import { dbError, withClient } from "../sessions/connection.js";
import { projectWallets, type ProjectWalletRow } from "./mappers.js";

/**
 * What the project's wallet selection turned out to be.
 *
 * `not_found` covers a missing AND a tombstoned project; `drift` and
 * `missing_family` come straight from the shared projection, so the drift
 * policy has exactly one owner. `unavailable` is an infrastructure failure and
 * is deliberately distinct from all three.
 */
export type ProjectPortfolioScope =
  | { readonly kind: "ok"; readonly wallets: ProjectWallets }
  | { readonly kind: "not_found" }
  | { readonly kind: "drift"; readonly family: "evm" | "solana" }
  | { readonly kind: "missing_family"; readonly family: "evm" | "solana" }
  | { readonly kind: "unavailable" };

export async function readProjectPortfolioScope(
  projectId: string,
): Promise<ProjectPortfolioScope> {
  // `withClient` is typed to carry a `Result`, so the outcome travels inside
  // one and is unwrapped here. A connection failure becomes `unavailable`,
  // which is the same thing this function reports for a failed query.
  const carried: Result<ProjectPortfolioScope, VexError> = await withClient(
    async (client): Promise<Result<ProjectPortfolioScope, VexError>> => {
    try {
      // ONE STATEMENT, so the tombstone predicate and the wallet rows come from
      // ONE SNAPSHOT - the same reason `render-scope.ts` and
      // `scope-snapshot-query.ts` are written this way.
      //
      // These used to be two `client.query` calls: an active-project check, then
      // a `project_wallets` read. Under READ COMMITTED - the Postgres default,
      // and what this pooled connection runs at - each statement takes its OWN
      // snapshot, and a soft delete committing between them PRESERVES the
      // `project_wallets` rows. So the first statement said "active" and the
      // second happily returned the tombstone's wallets, and the user was shown
      // balances for a project Vex had already declared gone. Joining them makes
      // "is it active" and "whose addresses" the same observation: a delete that
      // commits before this statement yields zero rows (`not_found`), and one
      // that commits after it cannot affect a snapshot already taken.
      // A LEFT JOIN LATERAL rather than an inner join, so the two states stay
      // distinguishable in one statement: no row at all means "no such ACTIVE
      // project" (`not_found`), while a row with an empty wallet array means an
      // active project whose `project_wallets` rows are absent - a write-around
      // the create path cannot produce, reported as `missing_family`. An inner
      // join would collapse those two into the same zero-row answer, which rule
      // 04 forbids. Same construction as `render-scope.ts`, for the same reason.
      const rows = await client.query<{ wallets: ProjectWalletRow[] }>(
        `SELECT COALESCE(w.wallets, '[]'::json) AS wallets
           FROM projects p
           LEFT JOIN LATERAL (
             SELECT json_agg(
                      json_build_object(
                        'project_id', pw.project_id,
                        'family', pw.family,
                        'wallet_id', pw.wallet_id,
                        'address', pw.address
                      )
                      ORDER BY pw.family
                    ) AS wallets
               FROM project_wallets pw
              WHERE pw.project_id = p.id
           ) w ON TRUE
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [projectId],
      );
      const row = rows.rows[0];
      if (row === undefined) return ok({ kind: "not_found" });

      const projection = projectWallets(row.wallets);
      if (projection.kind === "drift") {
        return ok({ kind: "drift", family: projection.family });
      }
      if (projection.kind === "missing_family") {
        // The create path always writes both family rows, so an absent one
        // means something wrote around the repository. Not a user-actionable
        // state, and not an empty selection either.
        log.error(
          `[projects-db] project_wallets missing ${projection.family} row `
            + `projectId=${projectId}`,
        );
        return ok({ kind: "missing_family", family: projection.family });
      }
      return ok({ kind: "ok", wallets: projection.wallets });
    } catch (cause) {
      log.error("[projects-db] readProjectPortfolioScope query failed", cause);
      return dbError("readProjectPortfolioScope query failed", cause);
    }
    },
  );
  return carried.ok ? carried.data : { kind: "unavailable" };
}
