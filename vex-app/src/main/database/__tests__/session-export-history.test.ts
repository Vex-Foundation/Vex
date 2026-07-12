import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("pg", () => ({
  Client: function MockClient() {
    return { query: mocks.query, connect: mocks.connect, end: mocks.end };
  },
}));
vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("../../logger/index.js", () => ({
  log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { getSessionExportMessages } = await import(
  "../sessions/export-history.js"
);

const SESSION = "00000000-0000-4000-8000-0000000000e1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});

describe("session export history", () => {
  it("reads archive first, suppresses duplicate live ids, and orders chronologically", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: 8,
          session_id: SESSION,
          role: "user",
          content: "archived original",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-07-12T10:00:00.000Z",
          source: "user",
          message_type: "chat",
        },
        {
          id: 9,
          session_id: SESSION,
          role: "assistant",
          content: "live answer",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-07-12T10:01:00.000Z",
          source: "agent",
          message_type: "chat",
        },
      ],
    });

    const result = await getSessionExportMessages(SESSION);
    expect(result).toEqual({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({ id: 8, content: "archived original" }),
        expect.objectContaining({ id: 9, content: "live answer" }),
      ]),
    });
    const [sql, params] = mocks.query.mock.calls[0]!;
    expect(sql).toContain("FROM messages_archive");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("a.id = m.id");
    expect(sql).toContain("ORDER BY created_at ASC, id ASC");
    expect(params).toEqual([SESSION]);
  });
});
