/**
 * `toDto` board projection. The `metadata -> 'board'` JSONB projection is
 * untrusted at this boundary: ONLY assistant rows expose a board, a valid spec
 * passes through unchanged, and anything malformed / oversize / wrong-typed /
 * written by a future writer collapses to `null` WITHOUT throwing (one bad row
 * must not poison a page).
 *
 * The board deliberately does NOT copy `explorerRefs`' empty-value collapse:
 * there is no arithmetic here that can turn a real board into "there was none".
 */

import { describe, expect, it } from "vitest";
import { boardSpecFixture } from "@shared/schemas/__tests__/board-spec-fixture.js";
import { boardProjectionSchema } from "@shared/schemas/messages.js";
import {
  BOARD_SPEC_MAX_BYTES,
  checkBoardSpecByteBudget,
} from "@vex-lib/board/index.js";
import {
  MESSAGE_ROW_COLUMNS,
  toDto,
  type MessageRow,
} from "../messages/mappers.js";

const BASE: Omit<MessageRow, "role" | "board"> = {
  id: 12,
  session_id: "00000000-0000-4000-8000-00000000abcd",
  content: "Liquidity is thinner than it looks; see the board.",
  tool_call_id: null,
  tool_calls: null,
  created_at: "2026-08-25T10:00:00.000Z",
  source: "agent",
  message_type: "chat",
  explorer_refs: null,
  reasoning: null,
  duration_ms: null,
  success: null,
  display_status: null,
};

function row(role: string, board: unknown): MessageRow {
  return { ...BASE, role, board };
}

describe("toDto - board projection (metadata -> 'board')", () => {
  it("selects ONLY the metadata sub-key, never raw metadata", () => {
    expect(MESSAGE_ROW_COLUMNS).toContain("metadata -> 'board' AS board");
    expect(MESSAGE_ROW_COLUMNS).not.toMatch(/(^|,\s*)metadata(\s*,|\s*$)/);
  });

  it("projects a valid spec on an assistant row, unchanged", () => {
    const spec = boardSpecFixture();
    const dto = toDto(row("assistant", spec));
    expect(dto.board).toEqual(spec);
  });

  it("normalizes a legacy v1 row without iconId to iconId: null instead of dropping the board", () => {
    // Durable rows written before the iconId expand-contract lack the key
    // entirely. The read schema must keep parsing them (a required field here
    // would make every pre-expansion board vanish from the transcript) and
    // normalize the missing key to null, the same value current writers emit
    // for a pool with no provider profile.
    const base = boardSpecFixture();
    const templateRow = base.hydration.rows[0];
    if (templateRow === undefined) {
      throw new Error("board fixture hydration row 0 missing");
    }
    const { iconId: _dropped, ...legacyRow } = templateRow;
    const legacySpec = {
      ...base,
      hydration: { ...base.hydration, rows: [legacyRow] },
    };
    const dto = toDto(row("assistant", legacySpec));
    expect(dto.board).not.toBeNull();
    expect(dto.board?.hydration.rows[0]?.iconId).toBeNull();
  });

  it("normalizes a legacy v1 row without `description` to null instead of dropping the board", () => {
    // The description field is the SAME expand-and-contract as iconId above,
    // added later still, so a durable row can be missing iconId, description,
    // or both. Each absence must parse and land as null; a required key here
    // would make every board written before this field vanish from a
    // transcript the user can still scroll to.
    const base = boardSpecFixture();
    const templateRow = base.hydration.rows[0];
    if (templateRow === undefined) {
      throw new Error("board fixture hydration row 0 missing");
    }
    const { description: _noDescription, ...withoutDescription } = templateRow;
    const { iconId: _noIcon, ...withoutEither } = withoutDescription;
    for (const legacyRow of [withoutDescription, withoutEither]) {
      const dto = toDto(
        row("assistant", { ...base, hydration: { ...base.hydration, rows: [legacyRow] } }),
      );
      expect(dto.board).not.toBeNull();
      expect(dto.board?.hydration.rows[0]?.description).toBeNull();
    }
  });

  it("keeps the provider's real blurb on a hydrated row, whole", () => {
    // The live shape, quoted from `board-v4-probes/description-vex.json`: the
    // provider served 546 code points of `cmsProfile.description` for VEX on
    // robinhood. It is UNTRUSTED text and it round-trips as TEXT, uncut.
    const blurb =
      "VEX is a self custodial AI agent runtime for onchain finance. AI "
      + "proposes strategies, but VEX controls what actually executes through "
      + "wallet permissions, mission rules, position limits, protocol checks, "
      + "and local signing.";
    const base = boardSpecFixture();
    const templateRow = base.hydration.rows[0];
    if (templateRow === undefined) {
      throw new Error("board fixture hydration row 0 missing");
    }
    const dto = toDto(
      row("assistant", {
        ...base,
        hydration: {
          ...base.hydration,
          rows: [{ ...templateRow, description: blurb }],
        },
      }),
    );
    expect(dto.board?.hydration.rows[0]?.description).toBe(blurb);
  });

  it("normalizes a legacy pool without `analysis` to null instead of dropping the board", () => {
    // The same expand-and-contract, one level up: durable pools written before
    // the assessment field existed carry no key at all. A required field here
    // would make every pre-expansion board vanish from a transcript the user
    // can still scroll to, and the surface would show a missing element rather
    // than the designed "No saved analysis" state.
    const base = boardSpecFixture();
    const templatePool = base.pools[0];
    if (templatePool === undefined) {
      throw new Error("board fixture pool 0 missing");
    }
    const { analysis: _dropped, ...legacyPool } = templatePool;
    const dto = toDto(row("assistant", { ...base, pools: [legacyPool] }));
    expect(dto.board).not.toBeNull();
    expect(dto.board?.pools[0]?.analysis).toBeNull();
    // The rest of the pool survives untouched: this is a normalization, not a
    // rebuild.
    expect(dto.board?.pools[0]?.caption).toBe(templatePool.caption);
  });

  it("round-trips a stored assessment verbatim, line breaks included", () => {
    const base = boardSpecFixture();
    const templatePool = base.pools[0];
    if (templatePool === undefined) {
      throw new Error("board fixture pool 0 missing");
    }
    const analysis = "Safety checks are clean.\nLiquidity thinned after 14:00.";
    const dto = toDto(
      row("assistant", { ...base, pools: [{ ...templatePool, analysis }] }),
    );
    expect(dto.board?.pools[0]?.analysis).toBe(analysis);
  });

  it("keeps the row an ordinary assistant row - the board is not a new kind", () => {
    const dto = toDto(row("assistant", boardSpecFixture()));
    expect(dto.kind).toBe("text");
    expect(dto.role).toBe("assistant");
    expect(dto.content).toBe(BASE.content);
  });

  it("returns null on every non-assistant row, even with a valid spec", () => {
    const spec = boardSpecFixture();
    for (const role of ["tool", "user", "system"]) {
      expect(toDto(row(role, spec)).board).toBeNull();
    }
  });

  it("returns null for a legacy row that predates the projection", () => {
    expect(toDto(row("assistant", null)).board).toBeNull();
    expect(toDto(row("assistant", undefined)).board).toBeNull();
  });

  it("returns null (never throws) for malformed / wrong-typed JSONB", () => {
    const bad = (board: unknown) => () => toDto(row("assistant", board));
    for (const board of [
      "not-an-object",
      42,
      [],
      {},
      { version: 1 },
      { ...boardSpecFixture(), version: 2 },
    ]) {
      expect(bad(board)).not.toThrow();
      expect(toDto(row("assistant", board)).board).toBeNull();
    }
  });

  it("rejects an unknown extra key rather than shipping it to the renderer", () => {
    const smuggled = { ...boardSpecFixture(), imageUrl: "https://evil.example" };
    expect(toDto(row("assistant", smuggled)).board).toBeNull();
  });

  it("rejects a spec whose hydration rows do not pair with its pools", () => {
    const spec = boardSpecFixture();
    const twoPools = {
      ...spec,
      pools: [...spec.pools, { chain: "base", pairAddress: "0xdeadBEEF01" }],
    };
    expect(toDto(row("assistant", twoPools)).board).toBeNull();
  });

  it("rejects text carrying a forbidden code-point class", () => {
    // Built with `fromCodePoint`, never authored as a raw literal: a bidi
    // override pasted into a source file is invisible to every reviewer and
    // makes the file read as binary to grep.
    const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
    const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
    for (const forbidden of [RIGHT_TO_LEFT_OVERRIDE, ZERO_WIDTH_SPACE]) {
      const spec = boardSpecFixture({ title: `SOL${forbidden}check` });
      expect(toDto(row("assistant", spec)).board).toBeNull();
    }
  });

  it("rejects a structurally valid board that is over the byte budget", () => {
    // The field bounds alone still admit a board past 256 KiB - eight maximal
    // assessments in FOUR-byte emoji-dense prose (8 x 10,000 code points at 4
    // bytes each is 320,000 bytes of analysis on its own) - and this mapper
    // reads a DURABLE row that some other writer may have produced. The budget
    // is therefore rechecked here with the same function `BoardCompose`
    // refuses with, so a page cannot carry a board the contract caps out. The
    // weight is grown on the AUTHORED text, which is where a real oversize
    // board comes from; the candle schema is durable and stays exactly at its
    // own bound.
    const base = boardSpecFixture();
    const templateRow = base.hydration.rows[0];
    if (templateRow === undefined) {
      throw new Error("board fixture hydration row 0 missing");
    }
    const oversize = {
      ...base,
      notes: Array.from({ length: 12 }, () => "n".repeat(600)),
      pools: Array.from({ length: 8 }, (_, i) => ({
        chain: "solana",
        pairAddress: `Pool${i}`,
        caption: "c".repeat(140),
        analysis: "\u{1F680}".repeat(10_000),
      })),
      chart: { poolIndex: 0, resolution: "1h" as const },
      hydration: {
        ...base.hydration,
        rows: Array.from({ length: 8 }, () => ({
          ...templateRow,
          baseTokenSymbol: "S".repeat(512),
          baseTokenName: "N".repeat(512),
          quoteTokenSymbol: "Q".repeat(512),
        })),
        unmatchedMarkerAtMs: [],
        candles: {
          bars: Array.from({ length: 200 }, (_, i) => ({
            tMs: 1_756_000_000_000 + i * 3_600_000,
            o: `1.${"9".repeat(38)}`,
            h: `2.${"9".repeat(38)}`,
            l: `0.${"9".repeat(38)}`,
            c: `1.${"8".repeat(38)}`,
          })),
          lastBarPartial: false,
          coveredRange: { fromMs: 1_756_000_000_000, toMs: 1_756_716_400_000 },
          resolution: "1h" as const,
          truncated: true,
        },
      },
    };
    // It really is a valid document; only its SIZE disqualifies it.
    expect(boardProjectionSchema.safeParse(oversize).success).toBe(true);
    expect(
      checkBoardSpecByteBudget(oversize).byteLength,
    ).toBeGreaterThan(BOARD_SPEC_MAX_BYTES);

    expect(toDto(row("assistant", oversize)).board).toBeNull();
  });

  it("keeps a board that sits inside the budget", () => {
    const spec = boardSpecFixture();
    expect(checkBoardSpecByteBudget(spec).withinBudget).toBe(true);
    expect(toDto(row("assistant", spec)).board).toEqual(spec);
  });

  it("does not disturb the sibling projections", () => {
    const dto = toDto(row("assistant", boardSpecFixture()));
    expect(dto.explorerRefs).toBeNull();
    expect(dto.reasoning).toBeNull();
    expect(dto.durationMs).toBeNull();
    expect(dto.success).toBeNull();
    expect(dto.displayStatus).toBeNull();
  });
});
