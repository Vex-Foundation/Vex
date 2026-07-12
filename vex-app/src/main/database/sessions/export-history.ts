/** Canonical archive + live transcript read for Markdown export. */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import {
  MESSAGE_ROW_COLUMNS,
  toDto,
  type MessageRow,
} from "../messages/mappers.js";
import { withClient, dbError } from "./connection.js";

/**
 * Return the complete transcript in chronological order. When compaction has
 * copied a message into `messages_archive`, the archived original wins over
 * the live placeholder with the same id.
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
      return ok(result.rows.map(toDto));
    } catch (cause) {
      return dbError("getSessionExportMessages failed", cause);
    }
  });
}
