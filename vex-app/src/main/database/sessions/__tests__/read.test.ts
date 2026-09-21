import { describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../connection.js", () => ({
  withClient: async (work: (client: { query: typeof query }) => unknown) => work({ query }),
  dbError: vi.fn(),
}));

import { listSessions } from "../read.js";

describe("listSessions workspace bounds", () => {
  it("bounds each workspace before the renderer filters rows", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await listSessions();

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("ROW_NUMBER() OVER");
    expect(sql).toContain("PARTITION BY COALESCE(workspace, 'agent')");
    expect(sql).toContain("WHERE workspace_row <= $2");
    expect(sql).not.toContain("ORDER BY pinned_at DESC NULLS LAST, started_at DESC\n         LIMIT $2");
    expect(query.mock.calls[0]?.[1]).toEqual(["vex_app", 100]);
  });
});
