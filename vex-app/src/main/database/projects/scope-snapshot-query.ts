/**
 * The ONE statement that reads a Vex Studio project's authorization scope.
 *
 * Split out of `scope-snapshot.ts` for exactly one reason: the property this
 * statement has to hold is a property of PostgreSQL under concurrency, so the
 * test that proves it runs on two live connections in the root integration lane
 * (`src/__tests__/integration/engine/studio-scope-snapshot-race.int.test.ts`).
 * That lane cannot load the app's IO module (Electron logger, `@shared`
 * aliases), and re-typing the SQL into the test would prove a copy rather than
 * the statement production runs. So the SQL and its row shape live here, with
 * NO imports at all, and both sides use this one text.
 *
 * Do not add an import to this file. Its portability is the point.
 */

/**
 * `projects` joined to `project_wallets` in ONE statement.
 *
 * The atomicity is the whole reason it is one statement. `updateProjectScope`
 * commits the permission bump, the wallet rewrite and the `scope_version`
 * increment in a single transaction; two separate SELECTs on one connection are
 * two snapshots and can legally pair version N's permission with version N+1's
 * wallets. A single statement is evaluated under a single snapshot, so the
 * permission, the version and the wallets a Studio call runs under always come
 * from the same committed version.
 *
 * `FILTER (WHERE w.family IS NOT NULL)` keeps a project with NO wallet rows
 * from aggregating one all-null element, so "no rows at all" (a corrupt
 * project) stays distinguishable from "a family with no selection".
 *
 * `$1` is the project id.
 */
export const SCOPE_SNAPSHOT_SQL = `
  SELECT p.id,
         p.permission,
         p.backing_session_id,
         p.scope_version,
         COALESCE(
           json_agg(
             json_build_object(
               'family', w.family,
               'wallet_id', w.wallet_id,
               'address', w.address
             )
           ) FILTER (WHERE w.family IS NOT NULL),
           '[]'::json
         ) AS wallets
    FROM projects p
    LEFT JOIN project_wallets w ON w.project_id = p.id
   WHERE p.id = $1
   GROUP BY p.id
`;

/**
 * Exactly the columns the scope needs. Nothing here is for display.
 *
 * The wallet elements are typed `unknown` because they arrive as parsed JSON
 * from `json_agg`: the driver guarantees the shape of the ROW, never the shape
 * of a JSON value inside it, so every field is narrowed before it is used.
 */
export interface ScopeSnapshotRow {
  id: string;
  permission: string;
  backing_session_id: string;
  scope_version: number;
  wallets: ReadonlyArray<{
    family: unknown;
    wallet_id: unknown;
    address: unknown;
  }>;
}
