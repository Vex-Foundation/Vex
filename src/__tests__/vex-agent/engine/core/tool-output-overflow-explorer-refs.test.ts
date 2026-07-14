/**
 * Stage 2 — `persistToolResultWithOverflow` carries `explorerRefs` under
 * `metadata.payload` on BOTH the inline path and the overflow-stub path.
 *
 * `metadata.payload` is the only part of MessageMetadata persisted into the
 * `messages.metadata` JSONB column (db/repos/messages/write.ts), so the desktop
 * app reads these as `metadata -> 'explorerRefs'`. We mock the transcript
 * append + blob repo and assert the payload the persist helper hands to
 * `appendMessage`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendMessage = vi.fn();
const mockWriteBlob = vi.fn();
const mockGenerateBlobKey = vi.fn().mockReturnValue("tob-20260713-0000000000000001");

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
}));

vi.mock("@vex-agent/db/repos/tool-output-blobs.js", () => ({
  writeBlob: (...a: unknown[]) => mockWriteBlob(...a),
  generateBlobKey: (...a: unknown[]) => mockGenerateBlobKey(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { persistToolResultWithOverflow } = await import(
  "@vex-agent/engine/core/tool-output-overflow.js"
);

const REFS = [{ chain: "base", txRef: "0xabc" }] as const;

/** Metadata handed to `appendMessage` by the first (only) persist call. */
function firstPersistedMetadata(): { payload?: Record<string, unknown> } {
  const call = mockAppendMessage.mock.calls[0]!;
  return call[2] as { payload?: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteBlob.mockResolvedValue(undefined);
});

describe("persistToolResultWithOverflow — explorerRefs", () => {
  it("attaches explorerRefs to payload on the inline (small) path", async () => {
    await persistToolResultWithOverflow("s1", "tc-1", "kyberswap:swap", "{}", true, REFS);

    expect(mockWriteBlob).not.toHaveBeenCalled();
    const meta = firstPersistedMetadata();
    expect(meta.payload).toMatchObject({ success: true, explorerRefs: REFS });
  });

  it("attaches explorerRefs to payload on the overflow-stub path", async () => {
    const big = "x".repeat(20_000); // > 16 KiB → overflow
    await persistToolResultWithOverflow("s1", "tc-1", "kyberswap:swap", big, true, REFS);

    expect(mockWriteBlob).toHaveBeenCalledTimes(1);
    const call = mockAppendMessage.mock.calls[0]!;
    expect((call[1] as { content: string }).content).toContain("tool_output_overflow");
    const meta = call[2] as { payload?: Record<string, unknown> };
    expect(meta.payload).toMatchObject({
      success: true,
      overflow: true,
      explorerRefs: REFS,
    });
  });

  it("attaches explorerRefs on the blob-write-failure inline fallback", async () => {
    mockWriteBlob.mockRejectedValueOnce(new Error("db down"));
    const big = "y".repeat(20_000);
    await persistToolResultWithOverflow("s1", "tc-1", "kyberswap:swap", big, true, REFS);

    const call = mockAppendMessage.mock.calls[0]!;
    // Full output persisted inline (no stub) but refs still ride along.
    expect((call[1] as { content: string }).content).toBe(big);
    const meta = call[2] as { payload?: Record<string, unknown> };
    expect(meta.payload).toMatchObject({ success: true, explorerRefs: REFS });
  });

  it("omits explorerRefs from payload when there are none", async () => {
    await persistToolResultWithOverflow("s1", "tc-1", "web_research", "{}", true, []);

    const meta = firstPersistedMetadata();
    expect(meta.payload).toEqual({ success: true });
    expect(meta.payload).not.toHaveProperty("explorerRefs");
  });

  it("defaults to no refs when the arg is omitted (back-compat)", async () => {
    await persistToolResultWithOverflow("s1", "tc-1", "web_research", "{}", false);

    const meta = firstPersistedMetadata();
    expect(meta.payload).toEqual({ success: false });
  });
});
