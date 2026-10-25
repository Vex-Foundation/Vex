/** Canonical archive + live transcript read for Markdown export. */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import {
  MESSAGE_ROW_COLUMNS,
  readerItems,
  toDto,
  type MessageRow,
} from "../messages/mappers.js";
import { withClient, dbError } from "./connection.js";

/**
 * Return the complete transcript in chronological order. `messages_archive`
 * is schema-identical to `messages` (`CREATE TABLE messages_archive (LIKE
 * messages INCLUDING INDEXES)`), and compaction can copy a message into the
 * archive while leaving a placeholder-content row behind in `messages` under
 * the SAME id (see `src/vex-agent/db/repos/sessions-archive.ts
 * forkToolMessageToArchive`) — so when both tables carry the same id, the
 * archived original wins over the live placeholder.
 */
export async function getSessionExportMessages(
  sessionId: string,
): Promise<Result<readonly SessionMessageDto[], VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<MessageRow>(
        `SELECT ${MESSAGE_ROW_COLUMNS}
           FROM messages_archive
          WHERE session_id = $1
         UNION ALL
         SELECT ${MESSAGE_ROW_COLUMNS}
           FROM messages m
          WHERE m.session_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM messages_archive a WHERE a.id = m.id
            )
         ORDER BY created_at ASC, id ASC`,
        [sessionId],
      );
      return ok(readerItems(result.rows, result.rows.map(toDto)));
    } catch (cause) {
      return dbError("getSessionExportMessages failed", cause);
    }
  });
}
