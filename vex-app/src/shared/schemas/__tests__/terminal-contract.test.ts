/**
 * THE CONTRACT ITSELF: the bounds' relationships, and the strictness that keeps
 * an off-contract packet from crossing a process boundary.
 *
 * The first test is the one worth reading. `CharCountAckSize <= LowWatermark`
 * is an invariant VS Code writes on the constant in prose, and violating it
 * produces a terminal that pauses once and never resumes - with no error, no
 * log and no crash. Prose cannot fail a build; this can.
 */

import { describe, expect, it } from "vitest";
import {
  PTY_HOST_CONFIG_KEYS,
  SNAPSHOT_DIR_MAX_BYTES,
  TERMINALS_GLOBAL_MAX,
  TERMINALS_PER_PROJECT_MAX,
  TERMINAL_ACK_CHARS,
  TERMINAL_DETACH_GRACE_MS,
  TERMINAL_DETACH_SHORT_GRACE_MS,
  TERMINAL_FLOW_HIGH_WATERMARK_CHARS,
  TERMINAL_FLOW_LOW_WATERMARK_CHARS,
  TERMINAL_PENDING_CEILING_BYTES,
  TERMINAL_SNAPSHOT_MAX_BYTES,
  TERMINAL_WRITE_MAX_BYTES,
  WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
  ptyHostEnvironment,
  terminalHostEnvelopeSchema,
  terminalPortEventSchema,
  terminalPortRequestSchema,
  terminalWorkspaceSnapshotSchema,
  terminalWriteInputSchema,
  utf8ByteLength,
} from "../terminal.js";

describe("bound relationships", () => {
  it("keeps the ack unit at or below the low watermark, or a paused pty never resumes", () => {
    expect(TERMINAL_ACK_CHARS).toBeLessThanOrEqual(TERMINAL_FLOW_LOW_WATERMARK_CHARS);
  });

  it("keeps the low watermark below the high one", () => {
    expect(TERMINAL_FLOW_LOW_WATERMARK_CHARS).toBeLessThan(
      TERMINAL_FLOW_HIGH_WATERMARK_CHARS,
    );
  });

  it("keeps flow control reachable well before the emergency ceiling", () => {
    // The ceiling is the LAST resort. If the high watermark could hold more
    // bytes than the ceiling, the ceiling would be the primary mechanism and
    // every busy terminal would be detached instead of paced.
    expect(TERMINAL_FLOW_HIGH_WATERMARK_CHARS * 4).toBeLessThan(
      TERMINAL_PENDING_CEILING_BYTES,
    );
  });

  it("keeps a single terminal's snapshot smaller than a project's file", () => {
    expect(TERMINAL_SNAPSHOT_MAX_BYTES * TERMINALS_PER_PROJECT_MAX).toBeGreaterThan(
      WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
    );
    expect(TERMINAL_SNAPSHOT_MAX_BYTES).toBeLessThan(
      WORKSPACE_SNAPSHOT_FILE_MAX_BYTES,
    );
  });

  it("keeps a project's snapshot file smaller than the directory bound", () => {
    expect(WORKSPACE_SNAPSHOT_FILE_MAX_BYTES).toBeLessThan(SNAPSHOT_DIR_MAX_BYTES);
  });

  it("keeps the global terminal bound at or above one project's", () => {
    expect(TERMINALS_GLOBAL_MAX).toBeGreaterThanOrEqual(TERMINALS_PER_PROJECT_MAX);
  });

  it("keeps the deliberate-close grace shorter than the reload grace", () => {
    // A user who closed the window meant it; holding their shells for a full
    // minute afterwards leaks processes they believe they ended.
    expect(TERMINAL_DETACH_SHORT_GRACE_MS).toBeLessThan(TERMINAL_DETACH_GRACE_MS);
  });
});

describe("the pty host's boot environment", () => {
  it("sets exactly the keys the host deletes - no more, no fewer", () => {
    // A key main sets that the host does not delete is a key exported into
    // every shell the user opens. A key the host reads that main never sets is
    // a silent fallback nobody chose.
    expect(Object.keys(ptyHostEnvironment("/tmp/x")).sort()).toEqual(
      [...PTY_HOST_CONFIG_KEYS].sort(),
    );
  });
});

describe("write bound", () => {
  it("measures BYTES, not characters", () => {
    // A four-byte character is one `.length` unit, so a chars-only bound would
    // let a payload four times the intended size through.
    const wide = "\u{1F600}".repeat(TERMINAL_WRITE_MAX_BYTES / 4);
    expect(utf8ByteLength(wide)).toBe(TERMINAL_WRITE_MAX_BYTES);
    expect(
      terminalWriteInputSchema.safeParse({ terminalId: "t1", data: wide }).success,
    ).toBe(true);
    expect(
      terminalWriteInputSchema.safeParse({
        terminalId: "t1",
        data: `${wide}\u{1F600}`,
      }).success,
    ).toBe(false);
  });
});

describe("strictness at the process boundaries", () => {
  it.each([
    ["a port request with an extra key", terminalPortRequestSchema, {
      kind: "ack",
      terminalId: "t1",
      charCount: 10,
      shellCommand: "rm -rf /",
    }],
    ["a port request with an unknown kind", terminalPortRequestSchema, {
      kind: "spawn",
      terminalId: "t1",
    }],
    ["a port event with an extra key", terminalPortEventSchema, {
      kind: "data",
      terminalId: "t1",
      data: "x",
      cwd: "/etc",
    }],
    ["a control envelope with an extra key", terminalHostEnvelopeSchema, {
      requestId: "r1",
      request: { kind: "shutdownAll" },
      privileged: true,
    }],
    ["a control request that smuggles an executable", terminalHostEnvelopeSchema, {
      requestId: "r1",
      request: { kind: "kill", terminalId: "t1", windowId: "w1", signal: "KILL" },
    }],
  ])("REJECTS %s", (_label, schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it("accepts the well-formed shapes it is meant to", () => {
    expect(
      terminalPortRequestSchema.safeParse({ kind: "attach", terminalId: "t1" }).success,
    ).toBe(true);
    expect(
      terminalHostEnvelopeSchema.safeParse({
        requestId: "r1",
        request: { kind: "kill", terminalId: "t1", windowId: "w1" },
      }).success,
    ).toBe(true);
  });

  it("rejects a snapshot whose version this build does not understand", () => {
    const parsed = terminalWorkspaceSnapshotSchema.safeParse({
      version: 99,
      projectId: "p1",
      savedAt: 0,
      layout: { projectId: "p1", groups: [], activeGroupIndex: 0 },
      terminals: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("never lets an environment ride a persisted snapshot", () => {
    // Environments carry credentials. Recomputing on restore is the contract;
    // `.strict()` is what enforces it against a future writer that forgets.
    const parsed = terminalWorkspaceSnapshotSchema.safeParse({
      version: 1,
      projectId: "p1",
      savedAt: 0,
      layout: { projectId: "p1", groups: [], activeGroupIndex: 0 },
      terminals: [
        {
          terminalId: "t1",
          title: "bash",
          shellName: "bash",
          cwdAtSpawn: "/p",
          cols: 80,
          rows: 24,
          serialized: "",
          droppedRows: 0,
          env: { GITHUB_TOKEN: "ghp_secret" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
