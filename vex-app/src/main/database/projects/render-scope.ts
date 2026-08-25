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
      const rows = await client.query<ScopeRow>(
        `SELECT id, name, slug, permission, agents, scope_version, created_at, updated_at
           FROM projects WHERE id = $1`,
        [projectId],
      );
      const row = rows.rows[0];
      if (row === undefined) return ok(null);

      const walletRows = await client.query<WalletRow>(
        "SELECT family, address FROM project_wallets WHERE project_id = $1 ORDER BY family",
        [projectId],
      );

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
        wallets: walletRows.rows.flatMap((wallet) =>
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
