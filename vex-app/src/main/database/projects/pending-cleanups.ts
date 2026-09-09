import { ok, type Result } from "@shared/ipc/result.js";
import { parseStoredTrashFailure, type ProjectPendingCleanups } from "@shared/schemas/project-cleanup.js";
import { dbError, withClient } from "../sessions/connection.js";

/** Read durable obligations, including old rows whose cause was not classified. */
export async function readPendingProjectCleanups(offset: number): Promise<Result<ProjectPendingCleanups>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<{
        id: string; name: string; slug: string; cleanup_state: string;
        cleanup_attempts: number; cleanup_last_error: string | null;
      }>(`SELECT id, name, slug, cleanup_state, cleanup_attempts, cleanup_last_error
          FROM projects WHERE deleted_at IS NOT NULL
          AND cleanup_state IN ('pending', 'trash_pending')
          ORDER BY deleted_at ASC, id ASC LIMIT 51 OFFSET $1`, [offset]);
      const page = result.rows.slice(0, 50);
      return ok({
        items: page.map((row) => {
          // No legacy native error text crosses IPC, even if a prior writer stored it.
          return {
            projectId: row.id, name: row.name, folder: row.slug,
            trashRequested: row.cleanup_state === "trash_pending",
            attempts: row.cleanup_attempts,
            trashFailure: parseStoredTrashFailure(row.cleanup_last_error),
          };
        }),
        nextOffset: result.rows.length > 50 ? offset + 50 : null,
      });
    } catch (cause) {
      return dbError("readPendingProjectCleanups query failed", cause);
    }
  });
}
