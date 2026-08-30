/**
 * VEX STUDIO TERMINALS - the complete cross-process contract (stage B2).
 *
 * Four processes touch a terminal and every one of them is a trust boundary,
 * so every packet defined here is parsed with a `.strict()` Zod schema at BOTH
 * ends of every hop it crosses:
 *
 *   renderer  --(domain method)-->  preload      no packets; domain calls only
 *   preload   --(CH.terminal.*)-->  main         control plane, invoke/Result
 *   main      --(parentPort)---->   pty host     control plane, request/reply
 *   preload  <--(MessagePort)--->   pty host     data plane, fire-and-forget
 *
 * ## Why the planes are split
 *
 * The CONTROL plane carries authority: which window may own which terminal,
 * how many exist, and when the project lifecycle gate says a terminal must
 * close. Main owns that and never delegates it, so `create`, `write`,
 * `resize` and `kill` are main-routed even though a direct port would be one
 * hop shorter. A renderer that could create a pty without main's admission
 * check would hold a capability the threat model does not give it.
 *
 * The DATA plane carries volume: a `yes` loop emits megabytes per second, and
 * routing that through main would make the privileged process the bottleneck
 * for output nobody in it reads. So terminal output travels renderer-ward on a
 * dedicated `MessagePort` minted by main, and the acknowledgements that drive
 * flow control travel back the same way.
 *
 * THE PORT IS NOT AUTHORITY. Its one-shot nonce correlates an acquisition to
 * the window that asked for it and expires in
 * `TERMINAL_PORT_NONCE_TTL_MS`; it proves nothing about any terminal id. The
 * host revalidates `(windowId, terminalId)` ownership on EVERY port packet, so
 * a compromised renderer that guesses another window's terminal id is refused
 * at the host, not merely at a preload it also controls.
 *
 * ## Teardown order (the contract, not an implementation detail)
 *
 * Port:    consumer detaches -> host stops the 5 ms bufferer for that terminal
 *          -> host starts the detach grace timer -> port `close` drops every
 *          subscription the port owned. A closed port never kills a pty; the
 *          grace timer does, and only after it expires.
 * Window:  main releases the window's terminal ids -> host closes admission for
 *          those ids -> each moves to the detached state with the SHORT grace
 *          (`TERMINAL_DETACH_SHORT_GRACE_MS`), because a closed window is a
 *          deliberate user action rather than a reload.
 * Utility: main closes admission -> host serializes buffers and layout ->
 *          commits the snapshot atomically -> shuts every pty down -> disposes.
 *          Exactly one owner runs that order; see `pty-host/host-service.ts`.
 *
 * ## Bounds
 *
 * Every constant below is a CONTRACT VALUE with a named at-bound behavior, and
 * no bound in this system is a silent cut (see the repository's forbidden
 * silent-content-cutting decree): a replay that dropped scrollback rows reports
 * the count, a consumer detached at the emergency ceiling reports the reason,
 * and a refused write is refused by name rather than truncated.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/**
 * Flow control, cloned from VS Code's `FlowControlConstants`.
 *
 * The pty is PAUSED once this many characters have been emitted without
 * acknowledgement. This is the PRIMARY backpressure mechanism: it stops the
 * producer at the source instead of letting an unbounded queue grow anywhere
 * downstream.
 */
export const TERMINAL_FLOW_HIGH_WATERMARK_CHARS = 100_000;

/** The pty RESUMES once unacknowledged characters fall below this. */
export const TERMINAL_FLOW_LOW_WATERMARK_CHARS = 5_000;

/**
 * How many characters a consumer accumulates before sending one ack.
 *
 * MUST be `<= TERMINAL_FLOW_LOW_WATERMARK_CHARS`, or a paused pty can never
 * resume: the consumer would sit below the ack threshold forever while the
 * host waits for an ack that is never sent. VS Code documents this invariant
 * on the constant itself; `terminal-bounds.test.ts` asserts it here.
 */
export const TERMINAL_ACK_CHARS = 5_000;

/**
 * The EMERGENCY ceiling on bytes queued for one terminal's consumer.
 *
 * Flow control above is what normally keeps this from being reached. When it
 * is reached anyway - a consumer that stopped acking without detaching, a
 * renderer wedged mid-frame - the host DETACHES that consumer and marks the
 * terminal resync-required rather than dropping bytes from the live ordered
 * stream. Dropping would make the mirror and the consumer disagree with no way
 * to discover it; a resync is a fresh full serialization of the authoritative
 * mirror, which is always correct.
 */
export const TERMINAL_PENDING_CEILING_BYTES = 8 * 1024 * 1024;

/** One write packet. A larger one is refused `write_too_large`, never cut. */
export const TERMINAL_WRITE_MAX_BYTES = 256 * 1024;

/**
 * One replay chunk on the wire. Replay content is SERIALIZED FROM THE MIRROR,
 * so every chunk boundary lands between complete VT sequences by construction;
 * the size of a replay is governed by scrollback ROWS, never by cutting bytes.
 */
export const TERMINAL_REPLAY_CHUNK_MAX_BYTES = 256 * 1024;

/** Live terminals per project. Refused `limit_project_terminals`. */
export const TERMINALS_PER_PROJECT_MAX = 12;

/** Live terminals across every project and window. Refused `limit_global_terminals`. */
export const TERMINALS_GLOBAL_MAX = 24;

/**
 * Scrollback rows retained in the authoritative mirror.
 *
 * Rows beyond this are dropped by xterm itself as new content arrives, which
 * is why `droppedRows` travels with every replay: the renderer shows a visible
 * counter rather than pretending the history was complete.
 */
export const TERMINAL_SCROLLBACK_ROWS = 1000;

/** Serialized bytes for one terminal in a snapshot. Enforced by row reduction. */
export const TERMINAL_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** One project's snapshot file. Terminals are row-reduced; layout is never trimmed. */
export const WORKSPACE_SNAPSHOT_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** The snapshot directory. The oldest INACTIVE project is evicted, with a notice. */
export const SNAPSHOT_DIR_MAX_BYTES = 64 * 1024 * 1024;

/** How long a detached terminal survives a reload before its pty is killed. */
export const TERMINAL_DETACH_GRACE_MS = 60_000;

/** The same, for a deliberate close (window gone) rather than a reload. */
export const TERMINAL_DETACH_SHORT_GRACE_MS = 6_000;

/** A port nonce is one-shot and expires this fast. Refused `port_unavailable`. */
export const TERMINAL_PORT_NONCE_TTL_MS = 10_000;

/** How long main waits for the host to answer `create` before calling it unresponsive. */
export const TERMINAL_CREATE_TIMEOUT_MS = 5_000;

/** Trailing-output flush window before a exiting pty's exit is announced. */
export const TERMINAL_DATA_FLUSH_TIMEOUT_MS = 250;

/** Force-kill backstop for a pty that will not exit on its own. */
export const TERMINAL_MAXIMUM_SHUTDOWN_MS = 5_000;

/** The 5 ms coalescing window on outbound terminal data. */
export const TERMINAL_DATA_BUFFER_MS = 5;

/** Title poll interval (title only - never cwd). */
export const TERMINAL_TITLE_POLL_MS = 200;

/** Column resizes are debounced this long once the buffer is tall. */
export const TERMINAL_COLS_RESIZE_DEBOUNCE_MS = 100;

/** Buffer rows past which column resizes debounce instead of applying at once. */
export const TERMINAL_COLS_RESIZE_DEBOUNCE_ROW_THRESHOLD = 200;

/** Utility-process restarts permitted before the subsystem is declared unavailable. */
export const TERMINAL_HOST_MAX_RESTARTS = 5;

/** Heartbeat cadence and the two-stage unresponsiveness ladder. */
export const TERMINAL_HOST_BEAT_INTERVAL_MS = 5_000;
export const TERMINAL_HOST_CONNECTING_BEAT_INTERVAL_MS = 20_000;
export const TERMINAL_HOST_FIRST_WAIT_MULTIPLIER = 1.2;
export const TERMINAL_HOST_SECOND_WAIT_MULTIPLIER = 1;

/** The persisted snapshot format version. A mismatch discards the file WHOLE. */
export const TERMINAL_SNAPSHOT_VERSION = 1;

/**
 * UTF-8 byte length, computed with `TextEncoder` rather than `Buffer`.
 *
 * This module is shared code: it is bundled into the RENDERER, where `Buffer`
 * does not exist. `TextEncoder` is a standard global in every runtime that
 * touches this contract - renderer, sandboxed preload, main and the pty host -
 * so the same bound is computed identically at each of the four gates rather
 * than being enforced at three of them and throwing at the fourth.
 */
const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

/**
 * The UTF-8 size of ONE code point, computed arithmetically.
 *
 * Chunking walks a string a code point at a time, and measuring each one by
 * encoding a one-character slice allocates two objects per character - on a
 * half-megabyte paste that is a million allocations, and it turns the chunking
 * loop into a visible stall. The arithmetic is the same rule the encoder applies.
 */
export function utf8CodePointSize(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Split a string into chunks of at most `maxBytes` UTF-8 bytes, never splitting
 * a surrogate pair.
 *
 * CHUNKING, NOT TRUNCATION: every byte of the input appears in exactly one
 * chunk, in order. Splitting mid-character would produce a lone surrogate that
 * survives structured clone and then renders as a replacement glyph - a silent
 * corruption of content whose whole purpose is fidelity.
 *
 * ONE definition, used by the preload write path and by the host's replay
 * chunker, because two copies of a boundary rule drift.
 */
export function chunkByUtf8Bytes(value: string, maxBytes: number): string[] {
  if (value.length === 0) return [];
  if (utf8ByteLength(value) <= maxBytes) return [value];

  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const size = utf8CodePointSize(codePoint);
    if (bytes + size > maxBytes && index > start) {
      chunks.push(value.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += width;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

/* ------------------------------------------------------------------ *
 * Identity and errors
 * ------------------------------------------------------------------ */

/** A terminal id: minted by MAIN, opaque everywhere else. */
export const terminalIdSchema = z.string().min(1).max(64);
export type TerminalId = z.infer<typeof terminalIdSchema>;

/** A window id: Electron's `webContents.id`, stringified at the boundary. */
export const terminalWindowIdSchema = z.string().min(1).max(32);

/**
 * Every refusal this subsystem can produce, as CODES.
 *
 * No prose crosses a process boundary: a launch failure's real message names
 * filesystem paths and provider text, and the renderer's remedy is identical
 * for every member of a class. Main logs the sentence; the wire carries the
 * code, exactly as `schemas/studio.ts` does for host status.
 */
export const terminalErrorCodeSchema = z.enum([
  /** The starting directory does not exist. */
  "launch_cwd_missing",
  /** The starting directory exists but is not a directory. */
  "launch_cwd_not_directory",
  /** The shell executable could not be resolved on PATH or as a path. */
  "launch_executable_missing",
  /** The resolved executable is neither a file nor a symlink. */
  "launch_executable_not_file",
  /** node-pty threw during spawn. */
  "launch_spawn_failed",
  /** The host did not answer `create` inside `TERMINAL_CREATE_TIMEOUT_MS`. */
  "create_timeout",
  /** The pty host is not running and cannot be started (restart cap reached). */
  "host_unavailable",
  /** No terminal with that id exists. */
  "unknown_terminal",
  /** The terminal exists but belongs to another window. */
  "foreign_terminal",
  /** The write packet exceeds `TERMINAL_WRITE_MAX_BYTES`. */
  "write_too_large",
  /** `TERMINALS_PER_PROJECT_MAX` reached. The UI prompts to close one. */
  "limit_project_terminals",
  /** `TERMINALS_GLOBAL_MAX` reached. The UI prompts to close one. */
  "limit_global_terminals",
  /** No port could be minted, or the nonce expired unused. */
  "port_unavailable",
  /** The project's lifecycle gate has closed admission (a delete is running). */
  "project_deleting",
  /** A packet failed its schema at a process boundary. */
  "invalid_packet",
  /** The snapshot could not be read or written. */
  "snapshot_unavailable",
]);
export type TerminalErrorCode = z.infer<typeof terminalErrorCodeSchema>;

/**
 * The host's answer to a control request: a discriminated outcome, never a
 * thrown error across the boundary.
 */
export function terminalOutcomeSchema<T extends z.ZodTypeAny>(
  value: T,
): z.ZodType<
  { readonly ok: true; readonly value: z.infer<T> }
  | { readonly ok: false; readonly code: TerminalErrorCode }
> {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), code: terminalErrorCodeSchema }).strict(),
  ]) as unknown as z.ZodType<
    { readonly ok: true; readonly value: z.infer<T> }
    | { readonly ok: false; readonly code: TerminalErrorCode }
  >;
}

export type TerminalOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: TerminalErrorCode };

/* ------------------------------------------------------------------ *
 * Terminal properties (host -> consumer, change-only)
 * ------------------------------------------------------------------ */

/**
 * A property CHANGE. Emitted only when the value actually changed, so a 200 ms
 * title poll that observes the same title emits nothing.
 *
 * `cwd` is TRIGGER-BASED, never polled: polling `/proc/<pid>/cwd` or `lsof`
 * every 200 ms would spawn a subprocess per terminal per tick on macOS. It is
 * read after a probable directory change (an Enter keystroke, debounced), on
 * ready, and on exit.
 */
export const terminalPropertySchema = z.discriminatedUnion("property", [
  z.object({ property: z.literal("title"), value: z.string().max(512) }).strict(),
  z.object({ property: z.literal("cwd"), value: z.string().max(4096) }).strict(),
  z.object({ property: z.literal("pid"), value: z.number().int().nonnegative() }).strict(),
]);
export type TerminalProperty = z.infer<typeof terminalPropertySchema>;

/** Why a consumer must throw its screen away and take a fresh serialization. */
export const terminalResyncReasonSchema = z.enum([
  /** The pending ceiling was hit; the consumer was detached to protect the host. */
  "pending_ceiling",
  /** The consumer reattached after a detach (reload, or a new port). */
  "reattached",
]);
export type TerminalResyncReason = z.infer<typeof terminalResyncReasonSchema>;

/* ------------------------------------------------------------------ *
 * Data plane: preload <-> host, over the MessagePort
 * ------------------------------------------------------------------ */

/** Consumer -> host. */
export const terminalPortRequestSchema = z.discriminatedUnion("kind", [
  /**
   * Claim the live stream for this terminal. The host answers with a `replay`
   * carrying the full serialized mirror, then resumes live data.
   */
  z.object({ kind: z.literal("attach"), terminalId: terminalIdSchema }).strict(),
  /**
   * Acknowledge consumed characters. Sent once per `TERMINAL_ACK_CHARS`
   * accumulated; this is what un-pauses a flow-controlled pty.
   */
  z
    .object({
      kind: z.literal("ack"),
      terminalId: terminalIdSchema,
      charCount: z.number().int().positive().max(TERMINAL_PENDING_CEILING_BYTES),
    })
    .strict(),
  /** Give up the live stream. Starts the detach grace timer. */
  z.object({ kind: z.literal("detach"), terminalId: terminalIdSchema }).strict(),
  /** Ask for a fresh full serialization (after a `resyncRequired`). */
  z.object({ kind: z.literal("resync"), terminalId: terminalIdSchema }).strict(),
]);
export type TerminalPortRequest = z.infer<typeof terminalPortRequestSchema>;

/** Host -> consumer. */
export const terminalPortEventSchema = z.discriminatedUnion("kind", [
  /** Live output. Coalesced over a 5 ms window; never reordered, never dropped. */
  z
    .object({
      kind: z.literal("data"),
      terminalId: terminalIdSchema,
      data: z.string(),
    })
    .strict(),
  /**
   * A full serialization of the authoritative mirror, in order, chunked at
   * `TERMINAL_REPLAY_CHUNK_MAX_BYTES`. `last` marks the final chunk;
   * `droppedRows` is how many scrollback rows the 1000-row bound has already
   * discarded, so the renderer can show a counter instead of implying the
   * history is complete.
   */
  z
    .object({
      kind: z.literal("replay"),
      terminalId: terminalIdSchema,
      data: z.string(),
      last: z.boolean(),
      droppedRows: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("property"),
      terminalId: terminalIdSchema,
      change: terminalPropertySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("exit"),
      terminalId: terminalIdSchema,
      exitCode: z.number().int(),
      signal: z.number().int().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resyncRequired"),
      terminalId: terminalIdSchema,
      reason: terminalResyncReasonSchema,
    })
    .strict(),
  /** A port packet was refused. Carries the code and, when known, the id. */
  z
    .object({
      kind: z.literal("refused"),
      terminalId: terminalIdSchema.nullable(),
      code: terminalErrorCodeSchema,
    })
    .strict(),
]);
export type TerminalPortEvent = z.infer<typeof terminalPortEventSchema>;

/* ------------------------------------------------------------------ *
 * Control plane: main <-> host, over the utility process parent port
 * ------------------------------------------------------------------ */

/** The shell to launch. Main resolves this; the renderer never names a binary. */
export const terminalLaunchSchema = z
  .object({
    executable: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64),
    cwd: z.string().min(1).max(4096),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    /**
     * Environment OVERLAY, applied over the host's scrubbed base environment.
     * `null` DELETES a variable; a missing key leaves the base value alone.
     * The base itself is captured once at host boot and never persisted.
     */
    env: z.record(z.string().max(256), z.string().max(32_768).nullable()),
  })
  .strict();
export type TerminalLaunch = z.infer<typeof terminalLaunchSchema>;

export const terminalHostRequestSchema = z.discriminatedUnion("kind", [
  /** Associate a freshly transferred port with a window. Sent with the transfer. */
  z
    .object({
      kind: z.literal("attachWindow"),
      windowId: terminalWindowIdSchema,
      nonce: z.string().min(16).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create"),
      terminalId: terminalIdSchema,
      windowId: terminalWindowIdSchema,
      projectId: z.string().min(1).max(64),
      launch: terminalLaunchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("write"),
      terminalId: terminalIdSchema,
      windowId: terminalWindowIdSchema,
      data: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resize"),
      terminalId: terminalIdSchema,
      windowId: terminalWindowIdSchema,
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("kill"),
      terminalId: terminalIdSchema,
      windowId: terminalWindowIdSchema,
    })
    .strict(),
  /** A window went away. Its terminals detach on the SHORT grace. */
  z
    .object({ kind: z.literal("releaseWindow"), windowId: terminalWindowIdSchema })
    .strict(),
  /** Persist this project's layout topology alongside its serialized buffers. */
  z
    .object({
      kind: z.literal("persistWorkspace"),
      projectId: z.string().min(1).max(64),
      layout: z.unknown(),
    })
    .strict(),
  z
    .object({ kind: z.literal("readWorkspace"), projectId: z.string().min(1).max(64) })
    .strict(),
  /** The ordered shutdown. Serializes, commits, kills, disposes - in that order. */
  z.object({ kind: z.literal("shutdownAll") }).strict(),
]);
export type TerminalHostRequest = z.infer<typeof terminalHostRequestSchema>;

/** Envelope for a control request awaiting a reply. */
export const terminalHostEnvelopeSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    request: terminalHostRequestSchema,
  })
  .strict();
export type TerminalHostEnvelope = z.infer<typeof terminalHostEnvelopeSchema>;

/**
 * Host -> main. A `reply` answers exactly one envelope; everything else is an
 * unsolicited event main needs in order to keep its own state honest (lease
 * release on exit, the operator log, the heartbeat ladder).
 */
export const terminalHostMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reply"),
      requestId: z.string().min(1).max(64),
      outcome: terminalOutcomeSchema(z.unknown()),
    })
    .strict(),
  z.object({ kind: z.literal("heartbeat") }).strict(),
  z
    .object({
      kind: z.literal("terminalExit"),
      terminalId: terminalIdSchema,
      exitCode: z.number().int(),
      signal: z.number().int().nullable(),
    })
    .strict(),
  /**
   * Something bounded happened and the user or the operator must be able to
   * find out. Codes only, for the same reason the error enum carries codes.
   */
  z
    .object({
      kind: z.literal("notice"),
      code: z.enum([
        "consumer_detached_pending_ceiling",
        "snapshot_discarded_corrupt",
        "snapshot_discarded_version",
        "snapshot_rows_reduced",
        "snapshot_evicted_oldest_project",
      ]),
      terminalId: terminalIdSchema.nullable(),
      projectId: z.string().min(1).max(64).nullable(),
      count: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type TerminalHostMessage = z.infer<typeof terminalHostMessageSchema>;

/* ------------------------------------------------------------------ *
 * Persistence: revive snapshots
 * ------------------------------------------------------------------ */

/**
 * One persisted terminal.
 *
 * `env` IS NEVER PERSISTED. It is recomputed on restore from the host's
 * scrubbed base plus the project's overlay, because a captured environment is
 * a snapshot of credentials, tokens and paths that has no business sitting in
 * a plaintext file for the life of a project.
 *
 * `droppedRows` is stored OUTSIDE `serialized` so the accounting can never be
 * mistaken for control data written into a terminal on restore.
 */
export const terminalSnapshotEntrySchema = z
  .object({
    terminalId: terminalIdSchema,
    title: z.string().max(512),
    shellName: z.string().max(256),
    cwdAtSpawn: z.string().max(4096),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    serialized: z.string(),
    droppedRows: z.number().int().nonnegative(),
  })
  .strict();
export type TerminalSnapshotEntry = z.infer<typeof terminalSnapshotEntrySchema>;

/** A pane inside a group: one terminal plus its share of the split. */
export const terminalPaneLayoutSchema = z
  .object({
    terminalId: terminalIdSchema,
    /** Share of the group's axis, 0..1. Relative so a restore fits any window. */
    relativeSize: z.number().min(0).max(1),
  })
  .strict();

/** A group is one tab: an ordered set of panes split along one axis. */
export const terminalGroupLayoutSchema = z
  .object({
    groupId: z.string().min(1).max(64),
    orientation: z.enum(["horizontal", "vertical"]),
    panes: z.array(terminalPaneLayoutSchema).max(TERMINALS_PER_PROJECT_MAX),
    activePaneIndex: z.number().int().nonnegative(),
  })
  .strict();
export type TerminalGroupLayout = z.infer<typeof terminalGroupLayoutSchema>;

export const terminalWorkspaceLayoutSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    groups: z.array(terminalGroupLayoutSchema).max(TERMINALS_PER_PROJECT_MAX),
    activeGroupIndex: z.number().int().nonnegative(),
  })
  .strict();
export type TerminalWorkspaceLayout = z.infer<typeof terminalWorkspaceLayoutSchema>;

/**
 * The persisted file. A version mismatch or a parse failure discards the file
 * WHOLE and reports a notice - never a partial restore, because a half-restored
 * workspace is a workspace whose missing half nobody can name.
 */
export const terminalWorkspaceSnapshotSchema = z
  .object({
    version: z.literal(TERMINAL_SNAPSHOT_VERSION),
    projectId: z.string().min(1).max(64),
    savedAt: z.number().int().nonnegative(),
    layout: terminalWorkspaceLayoutSchema,
    terminals: z.array(terminalSnapshotEntrySchema).max(TERMINALS_PER_PROJECT_MAX),
  })
  .strict();
export type TerminalWorkspaceSnapshot = z.infer<
  typeof terminalWorkspaceSnapshotSchema
>;

/* ------------------------------------------------------------------ *
 * Control plane: preload <-> main (IPC payloads)
 * ------------------------------------------------------------------ */

export const terminalCreateInputSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();
export type TerminalCreateInput = z.infer<typeof terminalCreateInputSchema>;

export const terminalCreateResultSchema = terminalOutcomeSchema(
  z
    .object({
      terminalId: terminalIdSchema,
      pid: z.number().int().nonnegative(),
      shellName: z.string().max(256),
      cwd: z.string().max(4096),
    })
    .strict(),
);
export type TerminalCreateResult = z.infer<typeof terminalCreateResultSchema>;

export const terminalWriteInputSchema = z
  .object({
    terminalId: terminalIdSchema,
    /**
     * Bounded by BYTES, not characters: the ceiling exists to bound the IPC
     * payload, and a UTF-8 character is up to four of them. Preload chunks
     * anything larger rather than sending it and being refused.
     */
    data: z.string().refine(
      (value) => utf8ByteLength(value) <= TERMINAL_WRITE_MAX_BYTES,
      { message: "write exceeds TERMINAL_WRITE_MAX_BYTES" },
    ),
  })
  .strict();
export type TerminalWriteInput = z.infer<typeof terminalWriteInputSchema>;

export const terminalResizeInputSchema = z
  .object({
    terminalId: terminalIdSchema,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();
export type TerminalResizeInput = z.infer<typeof terminalResizeInputSchema>;

export const terminalIdInputSchema = z
  .object({ terminalId: terminalIdSchema })
  .strict();

export const terminalAckResultSchema = terminalOutcomeSchema(z.null());
export type TerminalAckResult = z.infer<typeof terminalAckResultSchema>;

export const terminalPortTicketSchema = terminalOutcomeSchema(
  z.object({ nonce: z.string().min(16).max(128) }).strict(),
);
export type TerminalPortTicket = z.infer<typeof terminalPortTicketSchema>;

/**
 * The subsystem's own availability, as a durable read.
 *
 * This is a SEPARATE surface from `studio.getHostStatus`, which describes the
 * MCP host - a different process with a different failure mode. Collapsing the
 * two would make "the terminal subsystem gave up after six restarts" render as
 * an MCP problem the user cannot act on.
 */
export const terminalHostAvailabilitySchema = z
  .object({
    state: z.enum(["stopped", "starting", "running", "unavailable"]),
    /** Restarts consumed. At `TERMINAL_HOST_MAX_RESTARTS + 1` the state is `unavailable`. */
    restartCount: z.number().int().nonnegative(),
    /** Whether the host answered its last heartbeat inside the ladder. */
    responsive: z.boolean(),
  })
  .strict();
export type TerminalHostAvailability = z.infer<
  typeof terminalHostAvailabilitySchema
>;

/* ------------------------------------------------------------------ *
 * The pty host's boot environment - one definition, two processes
 * ------------------------------------------------------------------ */

/**
 * Every environment variable main sets on the fork and the host deletes after
 * reading.
 *
 * It lives in the SHARED contract rather than in either process because both
 * halves must agree exactly: a key main sets that the host does not delete is a
 * key exported into every shell the user opens, and a key the host reads that
 * main never sets is a silent fallback nobody chose.
 */
export const PTY_HOST_CONFIG_KEYS = [
  "VEX_PTY_SNAPSHOT_DIR",
  "VEX_PTY_GRACE_MS",
  "VEX_PTY_SHORT_GRACE_MS",
  "VEX_PTY_SCROLLBACK",
] as const;

/** The environment main builds for the fork. */
export function ptyHostEnvironment(snapshotDir: string): Record<string, string> {
  return {
    VEX_PTY_SNAPSHOT_DIR: snapshotDir,
    VEX_PTY_GRACE_MS: String(TERMINAL_DETACH_GRACE_MS),
    VEX_PTY_SHORT_GRACE_MS: String(TERMINAL_DETACH_SHORT_GRACE_MS),
    VEX_PTY_SCROLLBACK: String(TERMINAL_SCROLLBACK_ROWS),
  };
}
