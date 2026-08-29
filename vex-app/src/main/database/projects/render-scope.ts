/**
 * The LATEST COMMITTED SCOPE of one project, read at the moment a render job
 * actually executes.
 *
 * This is the module that makes "two updates committing in order can never
 * render in reverse order" true. A render job does NOT carry the scope its
 * caller had; it carries a project id, and when the queue lets it run it comes
 * here and reads whatever is committed NOW. Combined with the guarded marker
 * update in `installer-provenance.ts` (which advances only when the version it
 * rendered is still the current one), a stale render can neither write the
 * wrong files nor claim to have rendered a version it did not.
 *
 * Separate from `read.ts` on purpose: `read.ts` builds the full DTO, which the
 * installer enriches with file status, and having the installer import it would
 * close a cycle. This reads exactly the columns a render needs and nothing more.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import type { StudioAgentId } from "@shared/schemas/projects.js";
import { studioAgentIdSchema } from "@shared/schemas/projects.js";
import { dbError, withClient } from "../sessions/connection.js";

/** Everything a render needs to know about a project, as committed right now. */
export interface ProjectRenderScope {
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  readonly permission: SessionPermission;
  readonly agents: readonly StudioAgentId[];
  readonly scopeVersion: number;
  readonly wallets: readonly { readonly family: "evm" | "solana"; readonly address: string }[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ScopeRow {
  id: string;
  name: string;
  slug: string;
  permission: SessionPermission;
  agents: string[] | null;
  scope_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  /** Aggregated in the SAME statement, so it belongs to the same snapshot. */
  wallets: WalletRow[];
}

interface WalletRow {
  family: "evm" | "solana";
  address: string | null;
}

/** `null` when the project no longer exists (deleted between queue and run). */
export async function readProjectRenderScope(
  projectId: string,
): Promise<Result<ProjectRenderScope | null, VexError>> {
  return withClient(async (client) => {
    try {
      // ONE STATEMENT, so the row and its wallets are ONE SNAPSHOT.
      //
      // These used to be two `client.query` calls. Under READ COMMITTED - the
      // Postgres default, and what this connection runs at - each statement
      // takes its OWN snapshot, so a scope edit committing between them was
      // rendered as version N's permission with version N+1's wallets: a
      // combination that never existed in the database and that no reviewer of
      // either commit ever approved. On the money path that is the whole
      // question, because `permission` decides whether a mutation waits for an
      // approval card and the wallets decide whose funds it moves.
      //
      // A lateral aggregate is preferred over `BEGIN ISOLATION LEVEL REPEATABLE
      // READ` because it needs no transaction lifecycle on a pooled connection
      // (no BEGIN/COMMIT to leak on an early return or a throw) and it is one
      // round trip instead of three. `ORDER BY family` moves inside the
      // aggregate so the wallet order is still deterministic.
      const rows = await client.query<ScopeRow>(
        `SELECT p.id, p.name, p.slug, p.permission, p.agents, p.scope_version,
                p.created_at, p.updated_at,
                COALESCE(w.wallets, '[]'::json) AS wallets
           FROM projects p
           LEFT JOIN LATERAL (
             SELECT json_agg(
                      json_build_object('family', pw.family, 'address', pw.address)
                      ORDER BY pw.family
                    ) AS wallets
               FROM project_wallets pw
              WHERE pw.project_id = p.id
           ) w ON TRUE
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [projectId],
      );
      const row = rows.rows[0];
      if (row === undefined) return ok(null);

      return ok<ProjectRenderScope>({
        projectId: row.id,
        name: row.name,
        slug: row.slug,
        permission: row.permission,
        // An id retired from the roster since the selection was stored is
        // dropped rather than reaching the registry lookup, exactly as the DTO
        // projection does. One policy, both readers.
        agents: (row.agents ?? []).flatMap((id) => {
          const parsed = studioAgentIdSchema.safeParse(id);
          return parsed.success ? [parsed.data] : [];
        }),
        scopeVersion: row.scope_version,
        wallets: row.wallets.flatMap((wallet) =>
          wallet.address === null ? [] : [{ family: wallet.family, address: wallet.address }],
        ),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      });
    } catch (cause) {
      return dbError("readProjectRenderScope failed", cause);
    }
  });
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
