/** Compacted transcript paging against the real messages and archive tables. */

import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
}));

vi.mock("../db-config.js", () => ({
  buildPoolConfig: () => {
    const value = process.env.VEX_DB_URL;
    if (value === undefined || value === "") return Promise.resolve(null);
    const url = new URL(value);
    return Promise.resolve({
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.replace(/^\//, ""),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
  },
}));

import { execute, query } from "@vex-agent/db/client.js";
import {
  archivePrefix,
  createSession,
  forkToolMessageToArchive,
} from "@vex-agent/db/repos/sessions.js";
import { listMessages } from "../messages/list.js";

async function resetDb(): Promise<void> {
  const rows = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('schema_version', 'lighter_schema_marker')`,
  );
  if (rows.length === 0) return;
  const tables = rows.map(({ tablename }) => `"${tablename}"`).join(", ");
  await execute(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

async function makeSession(): Promise<string> {
  const id = randomUUID();
  await createSession(id);
  return id;
}

async function insertMessage(
  sessionId: string,
  role: "user" | "assistant" | "tool" | "system",
  content: string,
  options: { timestamp: string; toolCallId?: string; messageType?: string },
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO messages (session_id, role, content, tool_call_id, created_at, message_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      sessionId,
      role,
      content,
      options.toolCallId ?? null,
      options.timestamp,
      options.messageType ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("message insert returned no id");
  await execute(
    "UPDATE sessions SET message_count = message_count + 1 WHERE id = $1",
    [sessionId],
  );
  return id;
}

beforeEach(resetDb);

describe("compacted transcript history", () => {
  it("pages from live messages into the archived prefix without skipping or repeating rows", async () => {
    const sessionId = await makeSession();
    const otherSessionId = await makeSession();
    const ids: number[] = [];
    for (let index = 1; index <= 3; index += 1) {
      ids.push(await insertMessage(sessionId, "user", `message ${index}`, {
        timestamp: `2026-04-17T00:00:0${index}Z`,
      }));
    }
    await insertMessage(otherSessionId, "user", "another session", {
      timestamp: "2026-04-17T00:00:03Z",
    });
    await archivePrefix(sessionId, ids[2]!, 2);
    await insertMessage(
      sessionId,
      "system",
      "Conversation compacted into memory",
      {
        timestamp: "2026-04-17T00:00:04Z",
        messageType: "compaction_committed",
      },
    );
    await insertMessage(sessionId, "user", "message 5", {
      timestamp: "2026-04-17T00:00:05Z",
    });

    const first = await listMessages(sessionId, null, 2);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items.map((item) => item.content)).toEqual([
      "Conversation compacted into memory",
      "message 5",
    ]);
    expect(first.data.items[0]?.kind).toBe("compaction");
    const second = await listMessages(sessionId, first.data.nextCursor, 2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.items.map((item) => item.content)).toEqual([
      "message 2",
      "message 3",
    ]);
    const third = await listMessages(sessionId, second.data.nextCursor, 2);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.data.items.map((item) => item.content)).toEqual(["message 1"]);
    expect(third.data.hasMore).toBe(false);
  });

  it("shows an archived original once instead of its live giant-tool placeholder", async () => {
    const sessionId = await makeSession();
    const giantId = await insertMessage(sessionId, "tool", "original tool result", {
      toolCallId: "tool-big",
      timestamp: "2026-04-17T00:00:01Z",
    });
    await insertMessage(sessionId, "assistant", "later reply", {
      timestamp: "2026-04-17T00:00:02Z",
    });
    await forkToolMessageToArchive(sessionId, giantId, "[placeholder]");

    const page = await listMessages(sessionId, null, 2);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.items.map((item) => item.content)).toEqual([
      "original tool result",
      "later reply",
    ]);
    expect(page.data.hasMore).toBe(false);
  });
});
