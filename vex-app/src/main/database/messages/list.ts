/**
 * `listMessages` — cursor-paginated page across a session's live and compacted
 * messages (older-above scroll). An archived giant-tool original wins over
 * its live placeholder when both carry the same id. Re-parses the cursor
 * before composing SQL: a malformed cursor resolves to "treat as no cursor"
 * rather than poisoning the query.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  MESSAGES_TAIL_DEFAULT_LIMIT,
  messageCursorSchema,
  type MessageCursor,
  type MessagePage,
} from "@shared/schemas/messages.js";
import { withClient, dbError } from "./connection.js";
import {
  MESSAGE_ROW_COLUMNS,
  type MessageRow,
  nextCursorFor,
  toDto,
} from "./mappers.js";

export async function listMessages(
  sessionId: string,
  cursor: MessageCursor | null,
  limit: number = MESSAGES_TAIL_DEFAULT_LIMIT,
): Promise<Result<MessagePage, VexError>> {
  // Defense-in-depth: even though shared schema validated this already,
  // re-parse the cursor before composing SQL. A malformed cursor must
  // resolve to "treat as no cursor" rather than poisoning the query.
  let safeCursor: MessageCursor | null = null;
  if (cursor !== null) {
    const parsed = messageCursorSchema.safeParse(cursor);
    safeCursor = parsed.success ? parsed.data : null;
  }
  return withClient(async (client) => {
    try {
      const result = await client.query<MessageRow>(
        `SELECT ${MESSAGE_ROW_COLUMNS}
           FROM messages_archive a
          WHERE a.session_id = $1
            AND a.rewind_checkpoint_id IS NULL
            AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2, $3::integer))
         UNION ALL
         SELECT ${MESSAGE_ROW_COLUMNS}
           FROM messages m
          WHERE m.session_id = $1
            AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2, $3::integer))
            AND NOT EXISTS (
              SELECT 1 FROM messages_archive a
               WHERE a.id = m.id AND a.session_id = m.session_id
                 AND a.rewind_checkpoint_id IS NULL
            )
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [sessionId, safeCursor?.createdAt ?? null, safeCursor?.id ?? null, limit + 1],
      );
      const rows = result.rows.map(toDto);
      const overflow = rows.length > limit;
      const trimmed = overflow ? rows.slice(0, limit) : rows;
      const items = trimmed.slice().reverse();
      const nextCursor = overflow ? nextCursorFor(trimmed) : null;
      return ok({
        items,
        nextCursor,
        hasMore: overflow,
      });
    } catch (cause) {
      return dbError("listMessages query failed", cause);
    }
  });
}
