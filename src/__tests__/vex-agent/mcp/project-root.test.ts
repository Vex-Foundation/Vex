/**
 * `resolveProjectRootPath` - the boundary a model-supplied `imagePath` is
 * contained to, read per use from the row the privileged app owns.
 *
 * Three properties, each of which is a real way this could go wrong:
 *
 *  1. A SOFT-DELETED project answers `unknown_project`, never its old root.
 *     The user's deletion is a decision; handing the path back would let an
 *     agent keep reading a project they removed.
 *  2. A DATABASE OUTAGE PROPAGATES. It is neither "unknown" nor "no root", and
 *     laundering it into either sends the caller down a wrong remedy - it
 *     would tell a user their project was gone when the database merely blinked.
 *  3. The project id travels as a BOUND PARAMETER. It is an opaque identifier
 *     that arrives over a wire, and a SQL string built around it is an unsafe
 *     sink (rule 07).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => query(sql, params),
}));

const { resolveProjectRootPath } = await import("@vex-agent/mcp/project-root.js");

const PROJECT_ID = "proj_0123456789abcdef";
const ROOT = "/home/example/code/my-project";

beforeEach(() => {
  query.mockReset();
});

describe("an ordinary project", () => {
  it("returns the recorded root", async () => {
    query.mockResolvedValue([{ root_path: ROOT, deleted_at: null }]);

    await expect(resolveProjectRootPath(PROJECT_ID)).resolves.toEqual({
      kind: "ok",
      rootPath: ROOT,
    });
  });

  it("trims a root that was stored with surrounding whitespace", async () => {
    query.mockResolvedValue([{ root_path: `  ${ROOT}  `, deleted_at: null }]);

    await expect(resolveProjectRootPath(PROJECT_ID)).resolves.toEqual({
      kind: "ok",
      rootPath: ROOT,
    });
  });
});

describe("a project the user deleted", () => {
  // The user's deletion is a DECISION. Handing the old root back would let an
  // agent keep reading a project they removed.
  it.each([
    ["a timestamp", new Date("2026-08-01T10:00:00.000Z")],
    ["a string timestamp", "2026-08-01T10:00:00.000Z"],
  ])("answers unknown_project for a soft-deleted row carrying %s, never its old root", async (
    _label,
    deletedAt,
  ) => {
    query.mockResolvedValue([{ root_path: ROOT, deleted_at: deletedAt }]);

    const result = await resolveProjectRootPath(PROJECT_ID);

    expect(result).toEqual({ kind: "unknown_project" });
    expect(JSON.stringify(result)).not.toContain(ROOT);
  });
});

describe("a project that is not there", () => {
  it("answers unknown_project for no row at all", async () => {
    query.mockResolvedValue([]);

    await expect(resolveProjectRootPath(PROJECT_ID)).resolves.toEqual({ kind: "unknown_project" });
  });
});

describe("a half-created project", () => {
  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace only", "   "],
    ["a non-string", 42],
  ])("answers no_root_recorded when root_path is %s", async (_label, rootPath) => {
    query.mockResolvedValue([{ root_path: rootPath, deleted_at: null }]);

    await expect(resolveProjectRootPath(PROJECT_ID)).resolves.toEqual({ kind: "no_root_recorded" });
  });

  it("is a DIFFERENT answer from unknown_project: the remedies differ", async () => {
    query.mockResolvedValue([{ root_path: null, deleted_at: null }]);
    const noRoot = await resolveProjectRootPath(PROJECT_ID);
    query.mockResolvedValue([]);
    const unknown = await resolveProjectRootPath(PROJECT_ID);

    expect(noRoot).not.toEqual(unknown);
  });
});

describe("a database that is down", () => {
  // Neither "unknown" nor "no root" describes an outage, and answering either
  // would tell the caller the project is gone when it is not.
  it("PROPAGATES the failure rather than laundering it into an answer", async () => {
    const failure = new Error("connection refused");
    query.mockRejectedValue(failure);

    await expect(resolveProjectRootPath(PROJECT_ID)).rejects.toBe(failure);
  });
});

describe("the query itself", () => {
  it("selects the row by id and passes the project id as a BOUND parameter", async () => {
    query.mockResolvedValue([{ root_path: ROOT, deleted_at: null }]);

    await resolveProjectRootPath(PROJECT_ID);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM projects/i);
    expect(sql).toMatch(/WHERE id = \$1/i);
    // The id is never interpolated into the statement.
    expect(sql).not.toContain(PROJECT_ID);
    expect(params).toEqual([PROJECT_ID]);
  });

  it("reads the deletion marker in the same statement, so no second read can race it", async () => {
    query.mockResolvedValue([{ root_path: ROOT, deleted_at: null }]);

    await resolveProjectRootPath(PROJECT_ID);

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toMatch(/deleted_at/);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
