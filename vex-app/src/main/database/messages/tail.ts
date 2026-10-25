/**
 * `getMessageTail` — most-recent page for a session, returned in
 * chronological order (oldest → newest) so the virtual list mounts at the
 * bottom and the next page is "older above".
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  MESSAGES_TAIL_DEFAULT_LIMIT,
  type MessagePage,
} from "@shared/schemas/messages.js";
import { withClient, dbError } from "./connection.js";
import {
  MESSAGE_ROW_COLUMNS,
  type MessageRow,
  nextCursorFor,
  readerItems,
  toDto,
} from "./mappers.js";

export async function getMessageTail(
  sessionId: string,
  limit: number = MESSAGES_TAIL_DEFAULT_LIMIT,
): Promise<Result<MessagePage, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<MessageRow>(
        `SELECT ${MESSAGE_ROW_COLUMNS}
           FROM messages
          WHERE session_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [sessionId, limit + 1],
      );
      const rows = result.rows.map(toDto);
      // Renderer renders bottom-to-top with TanStack virtual list — we
      // return tail in chronological order (oldest → newest) so the
      // list mounts at the bottom and the next page is "older above".
      const overflow = rows.length > limit;
      const trimmed = overflow ? rows.slice(0, limit) : rows;
      const items = readerItems(result.rows, trimmed).reverse();
      const nextCursor = overflow ? nextCursorFor(trimmed) : null;
      return ok({
        items,
        nextCursor,
        hasMore: overflow,
      });
    } catch (cause) {
      return dbError("getMessageTail query failed", cause);
    }
  });
}
