/**
 * Tests for src/vex-agent/scripts/_preflight.ts.
 *
 * Coverage focus (R2 Fix 1):
 *   - assertExplicitDbUrl exits with code 2 + actionable error when
 *     VEX_DB_URL is unset / empty / whitespace-only
 *   - assertExplicitDbUrl is a no-op when set
 *   - assertSchemaUpToDate exits with code 2 + wipe instruction when
 *     knowledge_entries.content_hash column is missing (stale schema)
 *   - assertSchemaUpToDate is a no-op when the column exists
 *   - assertSchemaUpToDate handles a null query result (defensive)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQueryOne = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  query: vi.fn(),
  execute: vi.fn(),
  closePool: vi.fn(),
  getPool: vi.fn(),
}));

const { assertExplicitDbUrl, assertSchemaUpToDate } = await import(
  "@vex-agent/scripts/_preflight.js"
);

describe("assertExplicitDbUrl", () => {
  const originalEnv = process.env.VEX_DB_URL;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VEX_DB_URL;
    } else {
      process.env.VEX_DB_URL = originalEnv;
    }
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits with code 2 when VEX_DB_URL is unset", () => {
    delete process.env.VEX_DB_URL;
    expect(() => assertExplicitDbUrl("test-cmd")).toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(2);
    const stderrCall = stderrSpy.mock.calls[0]?.[0] as string;
    expect(stderrCall).toContain("test-cmd");
    expect(stderrCall).toContain("VEX_DB_URL is required");
    expect(stderrCall).toContain("vex_test"); // mentions the dev fallback by name
  });

  it("exits with code 2 when VEX_DB_URL is empty string", () => {
    process.env.VEX_DB_URL = "";
    expect(() => assertExplicitDbUrl("test-cmd")).toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("exits with code 2 when VEX_DB_URL is whitespace-only", () => {
    process.env.VEX_DB_URL = "   ";
    expect(() => assertExplicitDbUrl("test-cmd")).toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("is a no-op when VEX_DB_URL is set", () => {
    process.env.VEX_DB_URL = "postgresql://x:y@localhost:5777/vex_agent";
    expect(() => assertExplicitDbUrl("test-cmd")).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("error message names the command for context", () => {
    delete process.env.VEX_DB_URL;
    expect(() => assertExplicitDbUrl("knowledge-export")).toThrow("__exit__");
    const stderrCall = stderrSpy.mock.calls[0]?.[0] as string;
    expect(stderrCall.startsWith("knowledge-export:")).toBe(true);
  });
});

describe("assertSchemaUpToDate", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("is a no-op when supersedes_id column exists", async () => {
    mockQueryOne.mockResolvedValueOnce({ exists: true });
    await expect(assertSchemaUpToDate()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("exits with code 2 + points at 006 when supersedes_id column is missing", async () => {
    mockQueryOne.mockResolvedValueOnce({ exists: false });
    await expect(assertSchemaUpToDate()).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(2);
    const stderrCall = stderrSpy.mock.calls[0]?.[0] as string;
    expect(stderrCall).toContain("knowledge_entries.supersedes_id column missing");
    expect(stderrCall).toContain("006_knowledge_lifecycle.sql");
    // Wipe instructions are still included as a last-resort fallback, and
    // name the app's own reset rather than a Docker stack.
    expect(stderrCall).toContain("Settings -> Local runtime -> Reset local data");
    expect(stderrCall).not.toContain("docker");
  });

  it("exits with code 2 when query returns null (defensive)", async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(assertSchemaUpToDate()).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("queries information_schema for the column", async () => {
    mockQueryOne.mockResolvedValueOnce({ exists: true });
    await assertSchemaUpToDate();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    const sql = mockQueryOne.mock.calls[0]?.[0] as string;
    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("knowledge_entries");
    expect(sql).toContain("supersedes_id");
  });
});
