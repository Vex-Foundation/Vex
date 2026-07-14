/**
 * PR-11 — `tool_output_read` handler coverage.
 *
 * Tested:
 *   - Zod format guard on blob_key,
 *   - session-scope enforcement (cross-session rejected),
 *   - missing / expired blob → clean error + fires cleanupExpired lazily,
 *   - happy path returns bounded slices + paging metadata.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadBlob = vi.fn();
const mockCleanupExpired = vi.fn();

vi.mock("@vex-agent/db/repos/tool-output-blobs.js", () => ({
  readBlob: (...a: unknown[]) => mockReadBlob(...a),
  cleanupExpired: (...a: unknown[]) => mockCleanupExpired(...a),
}));

const { handleToolOutputRead, MAX_READ_BYTES } = await import(
  "../../../../vex-agent/tools/internal/tool-output-read.js"
);

function makeCtx(sessionId = "s1") {
  return {
    sessionId,
    loadedDocuments: new Map<string, string>(),
    sessionPermission: "restricted" as const,
    approved: false,
    role: "parent" as const,
    missionRunId: null,
    missionId: null,
    sessionKind: "mission" as const,
    contextUsageBand: "normal" as const,
  };
}

const validKey = "tob-20260420-0123456789abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  mockCleanupExpired.mockResolvedValue(0);
});

describe("tool_output_read handler", () => {
  it("returns a bounded first slice + metadata on hit", async () => {
    const fullOutput = "a".repeat(20_000);
    mockReadBlob.mockResolvedValue({
      blobKey: validKey,
      sessionId: "s1",
      payload: {
        fullOutput,
        shapeKind: "json",
        sizeBytes: Buffer.byteLength(fullOutput, "utf8"),
        primaryPath: "$.data",
        fieldHints: ["tx_hash", "balance"],
      },
      expiresAt: "2026-04-20T13:00:00.000Z",
      createdAt: "2026-04-20T12:45:00.000Z",
    });

    const result = await handleToolOutputRead({ blob_key: validKey }, makeCtx("s1"));

    expect(result.success).toBe(true);
    expect(result.output).toContain("bytes_returned=8192");
    expect(result.output).toContain("next_offset=8192");
    expect(result.output).toContain("truncated=true");
    expect(result.output).toContain("a".repeat(100));
    // P0-6: hints from the blob payload are echoed into the header string,
    // since the structured `data` is dropped before the model.
    expect(result.output).toContain("primary_path=$.data");
    expect(result.output).toContain("field_hints=[tx_hash,balance]");
    expect(result.data).toEqual(expect.objectContaining({
      blob_key: validKey,
      shape_kind: "json",
      size_bytes: 20000,
      offset: 0,
      bytes_returned: 8192,
      next_offset: 8192,
      truncated: true,
      primary_path: "$.data",
      field_hints: ["tx_hash", "balance"],
      expires_at: "2026-04-20T13:00:00.000Z",
    }));
  });

  it("uses offset and max_bytes to page through a payload", async () => {
    mockReadBlob.mockResolvedValue({
      blobKey: validKey,
      sessionId: "s1",
      payload: { fullOutput: "0123456789", shapeKind: "text", sizeBytes: 10 },
      expiresAt: "2026-04-20T13:00:00.000Z",
      createdAt: "2026-04-20T12:45:00.000Z",
    });

    const result = await handleToolOutputRead(
      { blob_key: validKey, offset: 3, max_bytes: 4 },
      makeCtx("s1"),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("offset=3");
    expect(result.output).toContain("bytes_returned=4");
    expect(result.output).toContain("next_offset=7");
    expect(result.output).toMatch(/\n3456$/);
    // P0-6: no hints on the payload ⇒ header carries none.
    expect(result.output).not.toContain("primary_path=");
    expect(result.output).not.toContain("field_hints=");
    expect(result.data).toEqual(expect.objectContaining({
      offset: 3,
      bytes_returned: 4,
      next_offset: 7,
      truncated: true,
    }));
  });

  it("caps max_bytes below the overflow threshold", async () => {
    const fullOutput = "b".repeat(20_000);
    mockReadBlob.mockResolvedValue({
      blobKey: validKey,
      sessionId: "s1",
      payload: { fullOutput, shapeKind: "text", sizeBytes: 20_000 },
      expiresAt: "2026-04-20T13:00:00.000Z",
      createdAt: "2026-04-20T12:45:00.000Z",
    });

    const result = await handleToolOutputRead(
      { blob_key: validKey, max_bytes: 100_000 },
      makeCtx("s1"),
    );

    expect(result.success).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThan(16 * 1024);
    expect(result.data).toEqual(expect.objectContaining({
      bytes_returned: 12_288,
      next_offset: 12_288,
      truncated: true,
    }));
  });

  it("rejects offsets beyond the payload size", async () => {
    mockReadBlob.mockResolvedValue({
      blobKey: validKey,
      sessionId: "s1",
      payload: { fullOutput: "short", shapeKind: "text", sizeBytes: 5 },
      expiresAt: "2026-04-20T13:00:00.000Z",
      createdAt: "2026-04-20T12:45:00.000Z",
    });

    const result = await handleToolOutputRead(
      { blob_key: validKey, offset: 6 },
      makeCtx("s1"),
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/beyond payload size/);
  });

  it("rejects a malformed blob_key at the Zod boundary", async () => {
    const result = await handleToolOutputRead({ blob_key: "not-a-blob-key" }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/blob_key/);
    expect(mockReadBlob).not.toHaveBeenCalled();
  });

  it("returns an error + fires cleanupExpired on missing / expired blob", async () => {
    mockReadBlob.mockResolvedValue(null);
    const result = await handleToolOutputRead({ blob_key: validKey }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not found or expired/);
    expect(mockCleanupExpired).toHaveBeenCalled();
  });

  it("rejects cross-session reads (defense in depth)", async () => {
    mockReadBlob.mockResolvedValue({
      blobKey: validKey,
      sessionId: "other-session",
      payload: { fullOutput: "secret", shapeKind: "text", sizeBytes: 6 },
      expiresAt: "2026-04-20T13:00:00.000Z",
      createdAt: "2026-04-20T12:45:00.000Z",
    });

    const result = await handleToolOutputRead({ blob_key: validKey }, makeCtx("s1"));

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not readable from this session/);
  });

  it("rejects empty blob_key", async () => {
    const result = await handleToolOutputRead({ blob_key: "" }, makeCtx());
    expect(result.success).toBe(false);
    expect(mockReadBlob).not.toHaveBeenCalled();
  });
});

// ── E8: search + path/query modes over overflowed blobs ──────────

/**
 * CASHCAT incident fixture — a Hyperliquid-style markets JSON with a
 * `meta.universe` of `size` entries. The target coin sits near the end so a
 * byte-mode first slice (first ~12 KiB) never sees it, modelling the
 * production incident where the model concluded the market did not exist.
 */
function buildMarketsJson(opts: { size: number; targetIndex: number; noteRepeat: number }): string {
  const universe = Array.from({ length: opts.size }, (_, i) => ({
    name: i === opts.targetIndex ? "CASHCAT" : `COIN${i}`,
    szDecimals: 2,
    maxLeverage: 10,
    openInterest: i,
    note: `market ${i} `.repeat(opts.noteRepeat),
  }));
  return JSON.stringify({
    meta: { universe },
    contexts: [{ dayNtlVlm: "1" }, { dayNtlVlm: "2" }],
  });
}

function mockJsonBlob(fullOutput: string, sessionId = "s1") {
  mockReadBlob.mockResolvedValue({
    blobKey: validKey,
    sessionId,
    payload: { fullOutput, shapeKind: "json", sizeBytes: Buffer.byteLength(fullOutput, "utf8") },
    expiresAt: "2026-04-20T13:00:00.000Z",
    createdAt: "2026-04-20T12:45:00.000Z",
  });
}

describe("tool_output_read — search mode (E8)", () => {
  it("finds a needle ~90 KB deep in a JSON blob and returns byte offset + context", async () => {
    const fullOutput = buildMarketsJson({ size: 250, targetIndex: 231, noteRepeat: 28 });
    expect(Buffer.byteLength(fullOutput, "utf8")).toBeGreaterThan(80_000);
    mockJsonBlob(fullOutput);

    const result = await handleToolOutputRead(
      { blob_key: validKey, search: "CASHCAT" },
      makeCtx("s1"),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("mode=search");
    expect(result.output).toContain("CASHCAT");
    // Only one occurrence in the fixture.
    expect(result.output).toMatch(/matched=1\b/);
    // The needle is deep — well past the byte-mode first slice.
    const offset = (result.data as { matches?: Array<{ offset: number }> }).matches?.[0]?.offset ?? 0;
    expect(offset).toBeGreaterThan(50_000);
  });

  it("is case-insensitive", async () => {
    mockJsonBlob(JSON.stringify({ meta: { note: "The CashCat market" } }));
    const result = await handleToolOutputRead(
      { blob_key: validKey, search: "cashcat" },
      makeCtx("s1"),
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/matched=1\b/);
  });

  it("treats the query as a literal substring, not a regex", async () => {
    mockJsonBlob(JSON.stringify({ a: "abc123", b: "xyz789" }));
    // A regex-metachar query matches nothing literally; a plain substring does.
    const asRegex = await handleToolOutputRead(
      { blob_key: validKey, search: "[0-9]{3}" },
      makeCtx("s1"),
    );
    expect(asRegex.success).toBe(true);
    expect(asRegex.output).toMatch(/matched=0\b/);

    const literal = await handleToolOutputRead(
      { blob_key: validKey, search: "123" },
      makeCtx("s1"),
    );
    expect(literal.success).toBe(true);
    expect(literal.output).toMatch(/matched=1\b/);
  });
});

describe("tool_output_read — path/query mode (E8)", () => {
  it("path + where(contains) returns exactly the matching row with matchedCount", async () => {
    const fullOutput = buildMarketsJson({ size: 250, targetIndex: 231, noteRepeat: 5 });
    mockJsonBlob(fullOutput);

    const result = await handleToolOutputRead(
      {
        blob_key: validKey,
        path: "meta.universe",
        where: { field: "name", contains: "cash" },
      },
      makeCtx("s1"),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("mode=query");
    expect(result.output).toContain("CASHCAT");
    const data = result.data as { matchedCount?: number; returnedCount?: number };
    expect(data.matchedCount).toBe(1);
    expect(data.returnedCount).toBe(1);
  });

  it("path + sort_by desc + limit returns the top-N with returned/matched counts", async () => {
    const fullOutput = buildMarketsJson({ size: 250, targetIndex: 231, noteRepeat: 3 });
    mockJsonBlob(fullOutput);

    const result = await handleToolOutputRead(
      {
        blob_key: validKey,
        path: "meta.universe",
        sort_by: "openInterest",
        order: "desc",
        limit: 20,
      },
      makeCtx("s1"),
    );

    expect(result.success).toBe(true);
    const data = result.data as { returnedCount?: number; matchedCount?: number; items?: Array<{ openInterest: number }> };
    expect(data.returnedCount).toBe(20);
    expect(data.matchedCount).toBe(250);
    // openInterest === index, so desc top item is 249.
    expect(data.items?.[0]?.openInterest).toBe(249);
  });

  it("resolves a scalar sub-value via a bracket/dot path", async () => {
    mockJsonBlob(JSON.stringify({ meta: { universe: [{ name: "A" }, { name: "B" }] } }));
    const result = await handleToolOutputRead(
      { blob_key: validKey, path: "meta.universe[1].name" },
      makeCtx("s1"),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("mode=path");
    expect(result.output).toContain("B");
  });

  it("orders mixed-type / null values LAST regardless of direction, stably", async () => {
    const rows = [
      { id: 0, v: 10 },
      { id: 1, v: null },
      { id: 2, v: 5 },
      { id: 3, v: "str" }, // mixed type ⇒ trailing
      { id: 4, v: 20 },
    ];
    mockJsonBlob(JSON.stringify({ rows }));

    const result = await handleToolOutputRead(
      { blob_key: validKey, path: "rows", sort_by: "v", order: "desc" },
      makeCtx("s1"),
    );
    expect(result.success).toBe(true);
    const items = (result.data as { items: Array<{ id: number }> }).items;
    // Numeric desc: 20,10,5 then trailing (null, "str") in original index order.
    expect(items.map((r) => r.id)).toEqual([4, 0, 2, 1, 3]);
  });

  it("bounds an oversized query result under MAX_READ_BYTES with a truncation marker", async () => {
    // Heavy items so a 50-row page would exceed the read cap by itself.
    const universe = Array.from({ length: 250 }, (_, i) => ({
      name: `COIN${i}`,
      openInterest: i,
      blob: "z".repeat(1024),
    }));
    const fullOutput = JSON.stringify({ meta: { universe } });
    mockJsonBlob(fullOutput);

    const result = await handleToolOutputRead(
      { blob_key: validKey, path: "meta.universe", sort_by: "openInterest", order: "desc", limit: 50 },
      makeCtx("s1"),
    );

    expect(result.success).toBe(true);
    // Stays under the read cap by construction — never re-overflows.
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThan(MAX_READ_BYTES);
    expect(result.output).toMatch(/showing|truncat/i);
    const data = result.data as { matchedCount?: number; returnedCount?: number; truncated?: boolean };
    // Post-filter total is visible even though the page was byte-bounded.
    expect(data.matchedCount).toBe(250);
    expect(data.truncated).toBe(true);
    expect((data.returnedCount ?? 999)).toBeLessThan(50);
  });

  it("fails cleanly on a bad path, listing the top-level keys", async () => {
    mockJsonBlob(JSON.stringify({ meta: { universe: [] }, contexts: [] }));
    const result = await handleToolOutputRead(
      { blob_key: validKey, path: "meta.nope.deep" },
      makeCtx("s1"),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("meta");
    expect(result.output).toContain("contexts");
  });

  it("rejects prototype-chain keys (own-property guard)", async () => {
    mockJsonBlob(JSON.stringify({ meta: { universe: [] } }));
    const result = await handleToolOutputRead(
      { blob_key: validKey, path: "meta.__proto__" },
      makeCtx("s1"),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/own key|__proto__/i);
  });

  it("rejects a path that exceeds the segment cap", async () => {
    mockJsonBlob(JSON.stringify({ a: 1 }));
    const deepPath = Array.from({ length: 12 }, (_, i) => `k${i}`).join(".");
    const result = await handleToolOutputRead(
      { blob_key: validKey, path: deepPath },
      makeCtx("s1"),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/too-deep|segments|malformed/i);
  });

  it("fails cleanly when where targets a non-array path", async () => {
    mockJsonBlob(JSON.stringify({ meta: { universe: [] } }));
    const result = await handleToolOutputRead(
      { blob_key: validKey, path: "meta", where: { field: "x", contains: "y" } },
      makeCtx("s1"),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/array/i);
  });

  it("fails cleanly when where/sort_by target a non-scalar field", async () => {
    mockJsonBlob(JSON.stringify({ rows: [{ id: 1, nested: { deep: true } }] }));

    const whereResult = await handleToolOutputRead(
      { blob_key: validKey, path: "rows", where: { field: "nested", contains: "x" } },
      makeCtx("s1"),
    );
    expect(whereResult.success).toBe(false);
    expect(whereResult.output).toMatch(/non-scalar|scalar/i);

    const sortResult = await handleToolOutputRead(
      { blob_key: validKey, path: "rows", sort_by: "nested" },
      makeCtx("s1"),
    );
    expect(sortResult.success).toBe(false);
    expect(sortResult.output).toMatch(/non-scalar|scalar/i);
  });

  it("rejects a where clause with both contains and equals", async () => {
    mockJsonBlob(JSON.stringify({ rows: [{ name: "a" }] }));
    const result = await handleToolOutputRead(
      { blob_key: validKey, path: "rows", where: { field: "name", contains: "a", equals: "a" } },
      makeCtx("s1"),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/exactly one/i);
  });

  it("fails cleanly on a non-JSON blob when a path is requested", async () => {
    mockReadBlob.mockResolvedValue({
      blobKey: validKey,
      sessionId: "s1",
      payload: { fullOutput: "just plain text", shapeKind: "text", sizeBytes: 15 },
      expiresAt: "2026-04-20T13:00:00.000Z",
      createdAt: "2026-04-20T12:45:00.000Z",
    });
    const result = await handleToolOutputRead(
      { blob_key: validKey, path: "meta.universe" },
      makeCtx("s1"),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/json/i);
  });
});
