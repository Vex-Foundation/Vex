/**
 * Unit: `mapRow` is a BOUNDARY, not a cast.
 *
 * DB rows are untrusted input. The two JSONB columns in particular can carry a
 * snapshot written by a different build, and `chunks_frozen_output` feeds
 * straight into the memory insert path — a half-understood object there lands
 * malformed rows in `session_memories` with no way to tell afterwards. So the
 * mapper parses and throws; it never casts.
 *
 * Also pinned here: pg `numeric` arrives as a STRING. Both cost columns must go
 * through `Number.parseFloat`, a trap the sibling compact-jobs mapper already
 * carries once and this table doubles.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FROZEN_CHUNKS_SNAPSHOT_VERSION,
  mapRow,
  type CompactionPreparationRow,
} from "@vex-agent/db/repos/compaction-preparations/index.js";

function frozenOutput(): unknown {
  return {
    snapshotVersion: FROZEN_CHUNKS_SNAPSHOT_VERSION,
    chunks: [
      {
        theme: "kyber_quote_timeout",
        themeSource: "chunker",
        entities: [],
        protocols: [],
        errorClasses: [],
        chains: [],
        tasks: [],
        happenedMd: "h",
        didMd: "d",
        triedMd: "t",
        outstandingItems: [
          {
            id: randomUUID(),
            text: "follow up",
            createdAt: "2026-07-29T00:00:00.000Z",
            resolvedAt: null,
            resolutionNote: null,
            resolutionSource: null,
          },
        ],
        bodyMd: "# body",
        bodyMdHash: "a".repeat(64),
        bodyMdSchemaVersion: "v1",
        contentHash: "b".repeat(64),
      },
    ],
  };
}

function baseRow(overrides: Partial<CompactionPreparationRow> = {}): CompactionPreparationRow {
  return {
    id: 7,
    session_id: "session-1",
    status: "preparing",
    watermark_message_id: 42,
    base_checkpoint_generation: 0,
    target_checkpoint_generation: 1,
    frozen_session_summary: null,
    corpus_text: "corpus",
    corpus_sha256: "c".repeat(64),
    corpus_format_version: 1,
    corpus_message_count: 12,
    corpus_bytes: 6,
    corpus_redaction_hard: 0,
    corpus_redaction_mask: 0,
    corpus_pruned_at: null,
    summary_status: "pending",
    summary_attempt_count: 0,
    summary_max_attempts: 3,
    summary_next_attempt_at: "2026-07-29T00:00:00.000Z",
    summary_locked_at: null,
    summary_locked_by: null,
    summary_heartbeat_at: null,
    summary_last_error: null,
    summary_output: null,
    summary_prompt_version: null,
    summary_provider: null,
    summary_model: null,
    summary_completed_at: null,
    summary_cost_usd: null,
    chunks_status: "pending",
    chunks_attempt_count: 0,
    chunks_max_attempts: 3,
    chunks_next_attempt_at: "2026-07-29T00:00:00.000Z",
    chunks_locked_at: null,
    chunks_locked_by: null,
    chunks_heartbeat_at: null,
    chunks_last_error: null,
    chunks_frozen_output: null,
    chunks_frozen_output_sha256: null,
    chunks_frozen_at: null,
    chunks_rejected_by_exclusion_at_freeze: 0,
    chunks_rejected_by_redaction_at_freeze: 0,
    chunks_inserted: 0,
    chunks_deduped: 0,
    chunks_landed_after_supersession: false,
    chunks_provider: null,
    chunks_model: null,
    chunks_completed_at: null,
    chunks_cost_usd: null,
    apply_source: null,
    apply_requested_at: null,
    apply_started_at: null,
    apply_locked_by: null,
    apply_heartbeat_at: null,
    apply_attempt_count: 0,
    money_gate_bypass_reasons: null,
    applied_generation: null,
    applied_at: null,
    superseded_by_id: null,
    last_error: null,
    created_at: "2026-07-29T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

describe("mapRow — numeric costs", () => {
  it("converts both pg numeric strings to numbers", () => {
    const mapped = mapRow(baseRow({ summary_cost_usd: "0.0123", chunks_cost_usd: "1.5000" }));
    expect(mapped.summaryCostUsd).toBeCloseTo(0.0123, 6);
    expect(mapped.chunksCostUsd).toBeCloseTo(1.5, 6);
  });

  it("keeps unreported costs null rather than coercing to 0", () => {
    const mapped = mapRow(baseRow());
    expect(mapped.summaryCostUsd).toBeNull();
    expect(mapped.chunksCostUsd).toBeNull();
  });
});

describe("mapRow — JSONB boundary validation", () => {
  it("round-trips a valid frozen snapshot", () => {
    const output = frozenOutput();
    const mapped = mapRow(baseRow({ chunks_frozen_output: output }));
    expect(mapped.chunksFrozenOutput).toEqual(output);
  });

  it("rejects a snapshot from an incompatible version instead of casting it", () => {
    const stale = { ...(frozenOutput() as Record<string, unknown>), snapshotVersion: 99 };
    expect(() => mapRow(baseRow({ chunks_frozen_output: stale }))).toThrow(
      /chunks_frozen_output failed validation/,
    );
  });

  it("rejects a snapshot missing the materialized render fields", () => {
    // A snapshot of only the model's texts is the exact mistake this schema
    // exists to prevent: the generated ids and the rendered body are what make
    // an insert retry deterministic.
    const textsOnly = {
      snapshotVersion: FROZEN_CHUNKS_SNAPSHOT_VERSION,
      chunks: [
        {
          theme: "t",
          entities: [],
          protocols: [],
          errorClasses: [],
          chains: [],
          tasks: [],
          happenedMd: "",
          didMd: "",
          triedMd: "",
          outstandingItems: [],
        },
      ],
    };
    expect(() => mapRow(baseRow({ chunks_frozen_output: textsOnly }))).toThrow(
      /chunks_frozen_output failed validation/,
    );
  });

  it("rejects a snapshot with no theme provenance", () => {
    // Provenance is only knowable at snapshot-build time (a fallback theme
    // validates by construction), so an unlabelled chunk cannot be repaired
    // downstream and must not be accepted here.
    const output = frozenOutput() as { chunks: Record<string, unknown>[] };
    delete output.chunks[0].themeSource;
    expect(() => mapRow(baseRow({ chunks_frozen_output: output }))).toThrow(
      /chunks_frozen_output failed validation/,
    );
  });

  it("rejects a theme source outside the two Branch B can produce", () => {
    const output = frozenOutput() as { chunks: Record<string, unknown>[] };
    // `handoff` is a legitimate `session_memories.theme_source` value, but it
    // belongs to the handoff path — Branch B cannot produce it.
    output.chunks[0].themeSource = "handoff";
    expect(() => mapRow(baseRow({ chunks_frozen_output: output }))).toThrow(
      /chunks_frozen_output failed validation/,
    );
  });

  it("rejects a money-gate bypass record that is not an array of strings", () => {
    expect(() => mapRow(baseRow({ money_gate_bypass_reasons: [{ why: "x" }] }))).toThrow(
      /money_gate_bypass_reasons failed validation/,
    );
  });

  it("accepts a recorded bypass array", () => {
    const mapped = mapRow(baseRow({ money_gate_bypass_reasons: ["wallet_pending"] }));
    expect(mapped.moneyGateBypassReasons).toEqual(["wallet_pending"]);
  });
});

describe("mapRow — unknown vocabulary is loud", () => {
  it("throws on an unknown row status", () => {
    expect(() => mapRow(baseRow({ status: "half_applied" }))).toThrow(/unknown status/);
  });

  it("throws on an unknown branch status", () => {
    expect(() => mapRow(baseRow({ summary_status: "frozen" }))).toThrow(
      /unknown summary_status/,
    );
    expect(() => mapRow(baseRow({ chunks_status: "wat" }))).toThrow(/unknown chunks_status/);
  });

  it("throws on an apply_source outside the frozen vocabulary", () => {
    expect(() => mapRow(baseRow({ apply_source: "apply_requested" }))).toThrow(
      /unknown apply_source/,
    );
  });

  it("accepts `frozen` on the chunks branch only", () => {
    const mapped = mapRow(
      baseRow({ chunks_status: "frozen", chunks_frozen_output: frozenOutput() }),
    );
    expect(mapped.chunksStatus).toBe("frozen");
  });
});

describe("mapRow — the two chunk-accounting phases stay distinct", () => {
  it("maps freeze-time rejections and insert-time dedup to separate fields", () => {
    const mapped = mapRow(
      baseRow({
        chunks_rejected_by_exclusion_at_freeze: 4,
        chunks_rejected_by_redaction_at_freeze: 2,
        chunks_inserted: 3,
        chunks_deduped: 1,
      }),
    );
    // Six chunks never made it into the snapshot; of the four that did, three
    // became new rows and one collapsed onto an existing memory. Conflating the
    // two phases would misattribute where the memories went.
    expect(mapped.chunksRejectedByExclusionAtFreeze).toBe(4);
    expect(mapped.chunksRejectedByRedactionAtFreeze).toBe(2);
    expect(mapped.chunksInserted).toBe(3);
    expect(mapped.chunksDeduped).toBe(1);
  });
});

describe("mapRow — pruned corpus", () => {
  it("surfaces a pruned corpus as null with its prune timestamp and intact audit", () => {
    const mapped = mapRow(
      baseRow({ corpus_text: null, corpus_pruned_at: "2026-07-29T01:00:00.000Z" }),
    );
    expect(mapped.corpusText).toBeNull();
    expect(mapped.corpusPrunedAt).toBe("2026-07-29T01:00:00.000Z");
    expect(mapped.corpusSha256).toBe("c".repeat(64));
    expect(mapped.corpusMessageCount).toBe(12);
  });
});
