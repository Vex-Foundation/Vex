/**
 * The session's own model pick (`sessions.model_*`, migration 182, F06),
 * read for the host's displays: `sessions.getModel` and the context gauge.
 * The ENGINE writes the pick (under the session lease, when a chat turn
 * carries one) and reads it through its own repo; this is the same row, read
 * on the app's pool and scoped to app sessions.
 *
 * A stored backend this build does not know reads as no pick, the same rule
 * as the engine repo (`src/vex-agent/db/repos/session-model.ts`).
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import { VEX_APP_SESSION_SCOPE } from "@shared/schemas/sessions.js";
import { providerNameSchema, type ProviderName } from "@shared/schemas/provider.js";
import { withClient, dbError } from "./connection.js";

export interface SessionModelPickRow {
  readonly provider: ProviderName;
  readonly modelId: string;
  /** ISO timestamp of the operator's last pick. */
  readonly updatedAt: string;
}

export async function getSessionModelPick(
  sessionId: string,
): Promise<Result<SessionModelPickRow | null, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<{
        model_provider: string | null;
        model_id: string | null;
        model_updated_at: Date | string | null;
      }>(
        `SELECT model_provider, model_id, model_updated_at
           FROM sessions
          WHERE id = $1 AND scope = $2 AND deleted_at IS NULL`,
        [sessionId, VEX_APP_SESSION_SCOPE],
      );
      const row = result.rows[0];
      if (row === undefined) return ok(null);
      const provider = providerNameSchema.safeParse(row.model_provider);
      if (!provider.success || row.model_id === null || row.model_id.length === 0) return ok(null);
      if (row.model_updated_at === null) return ok(null);
      return ok({
        provider: provider.data,
        modelId: row.model_id,
        updatedAt:
          row.model_updated_at instanceof Date
            ? row.model_updated_at.toISOString()
            : new Date(row.model_updated_at).toISOString(),
      });
    } catch (cause) {
      return dbError("getSessionModelPick failed", cause);
    }
  });
}
