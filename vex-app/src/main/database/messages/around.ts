/**
 * `getMessageAround` — a window of rows centered on an anchor message
 * (`before` older + the anchor + `after` newer), in chronological order.
 * A missing anchor resolves to an empty page rather than an error.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import { type MessagePage } from "@shared/schemas/messages.js";
import { withClient, dbError } from "./connection.js";
import {
  MESSAGE_ROW_COLUMNS,
  type MessageRow,
  readerItems,
  toDto,
  toIso,
} from "./mappers.js";

export async function getMessageAround(
  sessionId: string,
  messageId: number,
  before: number,
  after: number,
): Promise<Result<MessagePage, VexError>> {
  return withClient(async (client) => {
    try {
      // Anchor: load the row to learn its `created_at`. If the message
      // doesn't exist (or belongs to another session), we return an
      // empty page rather than an error — the UI surfaces "message not
      // found" without a toast.
      const anchorResult = await client.query<{
        created_at: string | Date;
        id: number;
      }>(
        `SELECT created_at, id
           FROM messages
          WHERE id = $1 AND session_id = $2`,
        [messageId, sessionId],
      );
      const anchor = anchorResult.rows[0];
      if (!anchor) {
        return ok({ items: [], nextCursor: null, hasMore: false });
      }
      const anchorIso = toIso(anchor.created_at);

      const beforeRows = before === 0
        ? { rows: [] as MessageRow[] }
        : await client.query<MessageRow>(
            `SELECT ${MESSAGE_ROW_COLUMNS}
               FROM messages
              WHERE session_id = $1
                AND (created_at, id) < ($2::timestamptz, $3::integer)
              ORDER BY created_at DESC, id DESC
              LIMIT $4`,
            [sessionId, anchorIso, anchor.id, before],
          );
      const anchorRow = await client.query<MessageRow>(
        `SELECT ${MESSAGE_ROW_COLUMNS}
           FROM messages
          WHERE id = $1 AND session_id = $2`,
        [messageId, sessionId],
      );
      const afterRows = after === 0
        ? { rows: [] as MessageRow[] }
        : await client.query<MessageRow>(
            `SELECT ${MESSAGE_ROW_COLUMNS}
               FROM messages
              WHERE session_id = $1
                AND (created_at, id) > ($2::timestamptz, $3::integer)
              ORDER BY created_at ASC, id ASC
              LIMIT $4`,
            [sessionId, anchorIso, anchor.id, after],
          );

      const windowRows = [
        ...beforeRows.rows.slice().reverse(),
        ...anchorRow.rows,
        ...afterRows.rows,
      ];
      const items = readerItems(windowRows, windowRows.map(toDto));
      return ok({ items, nextCursor: null, hasMore: false });
    } catch (cause) {
      return dbError("getMessageAround query failed", cause);
    }
  });
}
