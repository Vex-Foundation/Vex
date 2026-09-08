import { describe, expect, it, vi } from "vitest";
import { readPendingProjectCleanups } from "../pending-cleanups.js";
const query = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/connection.js", () => ({
  withClient: (work: (client: { query: typeof query }) => unknown) => work({ query }),
  dbError: () => ({ ok: false }),
}));

describe("durable pending cleanup read", () => {
  it("exposes the persisted refusal after restart without exposing legacy error payloads", async () => {
    query.mockResolvedValue({ rows: [
      { id: "id-1", name: "Example", slug: "example", cleanup_state: "trash_pending", cleanup_attempts: 2, cleanup_last_error: "trash:aborted" },
      { id: "id-2", name: "Other", slug: "other", cleanup_state: "pending", cleanup_attempts: 1, cleanup_last_error: "secret native payload" },
    ] });
    const result = await readPendingProjectCleanups(0);
    expect(result).toEqual({ ok: true, data: { items: [
      { projectId: "id-1", name: "Example", folder: "example", trashRequested: true, attempts: 2, trashFailure: "aborted" },
      { projectId: "id-2", name: "Other", folder: "other", trashRequested: false, attempts: 1, trashFailure: null },
    ], nextOffset: null } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("reports a next page instead of silently dropping unfinished deletes", async () => {
    query.mockResolvedValue({ rows: Array.from({ length: 51 }, (_, index) => ({
      id: String(index), name: "Example", slug: "example", cleanup_state: "pending", cleanup_attempts: 0, cleanup_last_error: null,
    })) });
    const result = await readPendingProjectCleanups(50);
    expect(result.ok && result.data.items.length).toBe(50);
    expect(result.ok && result.data.nextOffset).toBe(100);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("OFFSET $1"), [50]);
  });
});
