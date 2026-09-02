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

/**
 * The extra deadline a `revive` earns FOR EACH TERMINAL it is asked to restore.
 *
 * A revive spawns up to `TERMINALS_PER_PROJECT_MAX` ptys SEQUENTIALLY, each of
 * which probes an executable and starts a shell. Holding all twelve to the
 * single-request budget made a normal restore on a cold or loaded machine
 * indistinguishable from an unresponsive host: main timed the request out,
 * declared the host unresponsive, released the reservations - and the host went
 * on spawning shells nobody was counting.
 *
 * So the budget is PROPORTIONAL to the work requested. It is not unbounded: the
 * assignment list is capped by the schema, so the deadline is capped with it.
 */
export const TERMINAL_REVIVE_PER_TERMINAL_TIMEOUT_MS = 5_000;

/** Trailing-output flush window before a exiting pty's exit is announced. */
export const TERMINAL_DATA_FLUSH_TIMEOUT_MS = 250;

/**
 * How long a snapshot waits for ONE held terminal's mirror to reach a fixed
 * point before committing anyway.
 *
 * The producer is already stopped when this runs, so the only thing being
 * waited on is xterm's parser finishing what it was handed. The bound exists so
 * that a wedged one cannot convert the snapshot - which is on the quit path -
 * into a hang: a terminal that overruns it is serialized from wherever its
 * mirror got to, and the shortfall is logged rather than paid for by the user's
 * whole workspace.
 */
export const TERMINAL_SNAPSHOT_DRAIN_MS = 1_000;

/** Force-kill backstop for a pty that will not exit on its own. */
export const TERMINAL_MAXIMUM_SHUTDOWN_MS = 5_000;

/**
 * Everything ONE commit costs after its drains have reached a fixed point:
 * serialization, the whole-file reduction loop, the write-then-rename, and the
 * directory-bound sweep.
 *
 * Sized against the work rather than the wire: the reduction loop halves the
 * per-terminal cap until a 16 MiB file fits, and the write is a single
 * `writeFile` plus a `rename` of at most that much.
 */
export const TERMINAL_SNAPSHOT_COMMIT_ALLOWANCE_MS = 2_000;

/**
 * The real bound on ONE commit of ONE project.
 *
 * A project's drains run CONCURRENTLY and each is bounded by
 * `TERMINAL_SNAPSHOT_DRAIN_MS`, so the drain phase costs one drain bound
 * however many terminals the project holds - not one per terminal. It used to
 * cost one per terminal, which is what put the host's real shutdown bound
 * (24 terminals, ~24 s) an order of magnitude past main's flat 5 s deadline.
 */
export const TERMINAL_COMMIT_BOUND_MS =
  TERMINAL_SNAPSHOT_DRAIN_MS + TERMINAL_SNAPSHOT_COMMIT_ALLOWANCE_MS;

/**
 * The deadline main gives a `persistWorkspace`.
 *
 * TWO commit bounds, and the second is not slack. The host serializes commits
 * per project and COALESCES the requests that arrive during one: a persist that
 * lands while a commit is running waits for that commit and then for the single
 * follow-up run that carries its layout. Two is therefore the worst case a
 * correct host produces, and a deadline of one would time out the very
 * serialization that makes overlapping persists safe.
 */
export const TERMINAL_PERSIST_TIMEOUT_MS = 2 * TERMINAL_COMMIT_BOUND_MS;

/** Disposing timers, subscriptions, mirrors and ports once every pty has gone. */
export const TERMINAL_SHUTDOWN_DISPOSE_ALLOWANCE_MS = 1_000;

/**
 * The deadline main gives `shutdownAll`, DERIVED from what the host actually
 * does rather than reused from the flat control-request budget.
 *
 * The flat budget was a durability defect, not a tuning choice: main disposes
 * the host - and KILLS the child - once its deadline passes, so a shutdown
 * whose real bound exceeded it was killed mid-commit and the user lost the very
 * snapshot the orderly shutdown exists to write. The terms are the host's own
 * shutdown steps, in order:
 *
 *  - the commits, per project, run in parallel, each possibly behind one
 *    coalesced in-flight commit: `TERMINAL_PERSIST_TIMEOUT_MS`;
 *  - the ptys, awaited jointly and bounded: `TERMINAL_MAXIMUM_SHUTDOWN_MS`;
 *  - dispose: `TERMINAL_SHUTDOWN_DISPOSE_ALLOWANCE_MS`.
 */
export const TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS =
  TERMINAL_PERSIST_TIMEOUT_MS
  + TERMINAL_MAXIMUM_SHUTDOWN_MS
  + TERMINAL_SHUTDOWN_DISPOSE_ALLOWANCE_MS;

/**
 * How long the host waits for a killed pty to actually EXIT before replying.
 *
 * A kill settles on the exit, not on the signal: main keeps the terminal's
 * record and its project lease until the process is genuinely gone, or a create
 * could slip into the capacity of a pty that is still shutting down, and a
 * project delete could complete while one of its shells was still running.
 *
 * MUST be strictly less than `TERMINAL_CREATE_TIMEOUT_MS`, which bounds every
 * control request: a settle window at or above it would make a slow-but-normal
 * kill indistinguishable from an unresponsive host, and main would declare the
 * host unresponsive for doing exactly what it was asked. `terminal-bounds`
 * pins the relation.
 */
export const TERMINAL_KILL_SETTLE_MS = 3_000;

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
 * One old-to-new terminal id assignment for a revive.
 *
 * A REVIVED SHELL IS A NEW SHELL. The old process died with the previous
 * session and nothing can bring it back, so the honest thing - and VS Code's
 * own model - is to spawn a fresh one, restore the SCREEN it left behind into
 * the mirror, and give it a new identity. Reusing the old id would make a fresh
 * process indistinguishable from a survivor, and every stale reference the
 * renderer still held would silently bind to it.
 *
 * Ids are minted by MAIN, here as everywhere else, because main owns admission:
 * a revive consumes exactly the same per-project and global capacity a create
 * does, and a host that minted its own ids could exceed a bound main is
 * accounting for.
 *
 * Declared here rather than beside the other revive shapes because the control
 * plane below references it, and a `const` used before its initializer runs is
 * a module-load crash rather than a type error.
 */
export const terminalReviveAssignmentSchema = z
  .object({ from: terminalIdSchema, to: terminalIdSchema })
  .strict();
export type TerminalReviveAssignment = z.infer<typeof terminalReviveAssignmentSchema>;

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
  /**
   * The requested shell is in the catalogue but is NOT INSTALLED on this
   * machine, as main re-checked at the moment of the spawn.
   *
   * Distinct from `launch_executable_missing`, which is the host reporting that
   * a binary main told it to run could not be resolved. This one is main's own
   * answer, and the difference matters to the person reading it: this says
   * "install fish, or pick another shell", the other says "the shell Vex chose
   * for you is broken". A shell uninstalled between the moment the picker was
   * filled and the moment the user pressed the button lands here, which is why
   * availability is re-checked at spawn and not trusted from the catalogue the
   * renderer is holding.
   */
  "launch_shell_unavailable",
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
 * `displayCwd` is TRIGGER-BASED, never polled: polling `/proc/<pid>/cwd` or
 * `lsof` every 200 ms would spawn a subprocess per terminal per tick on macOS.
 * It is read after a probable directory change (an Enter keystroke, debounced),
 * on ready, and on exit.
 *
 * IT IS A LABEL, NOT A PATH, and the name says so on purpose. The host reads a
 * real absolute path and derives this value before it is emitted
 * (`pty-host/display-cwd.ts`), so the raw path never reaches the port and never
 * reaches the renderer: inside the project it is the project-relative path, at
 * the root it is the project's own label, and anywhere else it is an abstract
 * phrase that names no directory. Nothing accepts this value BACK - there is no
 * handler anywhere that takes a `displayCwd` - which is what keeps it text
 * rather than a filesystem capability leaking out of a privileged process.
 */
export const terminalPropertySchema = z.discriminatedUnion("property", [
  z.object({ property: z.literal("title"), value: z.string().max(512) }).strict(),
  z
    .object({ property: z.literal("displayCwd"), value: z.string().max(4096) })
    .strict(),
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
 * Shell catalogue (main -> renderer, and the renderer's choice back)
 * ------------------------------------------------------------------ */

/**
 * THE SHELLS VEX CAN LAUNCH, as a CLOSED SET OF IDENTIFIERS.
 *
 * ## Why an enum and not a path
 *
 * The renderer must be able to say "open a zsh". It must NOT be able to say
 * "open `/tmp/x`". Those are the same sentence if the wire carries a string
 * that main turns into an executable, so the wire carries neither a path nor a
 * free-form name: it carries a member of this enum, and main holds the mapping
 * from a member to a binary. A renderer that has been taken over can therefore
 * ask for a different SHELL and nothing else, which is a capability the threat
 * model is willing to grant. This is VS Code's own split - the renderer picks a
 * profile by name, `platform/terminal/node/terminalProfiles.ts` decides what
 * that name resolves to and whether it exists - reduced to a closed set,
 * because Vex has no extension API that could contribute a profile and so has
 * no reason to accept an open one.
 *
 * The set is deliberately SMALL and cross-platform-shaped. It is not a promise
 * that every member exists on the current machine: `available` on
 * `terminalShellOptionSchema` says that, per machine, and main re-checks it at
 * spawn rather than trusting a catalogue the renderer has been holding.
 *
 * `system_default` is the user's OWN shell (`$SHELL`, or `ComSpec` on Windows)
 * and is the only member that is always present. It is what a terminal opens
 * with unless the user picks otherwise, and it is a distinct member rather than
 * an absent value so that "whatever you normally use" stays sayable after the
 * user has picked something else once.
 */
export const terminalShellIdSchema = z.enum([
  "system_default",
  "bash",
  "zsh",
  "fish",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
]);
export type TerminalShellId = z.infer<typeof terminalShellIdSchema>;

/**
 * One row of the picker.
 *
 * `available` is main's answer for THIS machine, and it is advisory: the picker
 * uses it to show a shell as not installed rather than to enforce anything. The
 * enforcement is main re-resolving the id at spawn time, because a shell can be
 * uninstalled while the picker is open, and a renderer can send any member of
 * the enum whether its row said available or not.
 *
 * NO PATH. The resolved binary stays in main. The label is text main chose.
 */
export const terminalShellOptionSchema = z
  .object({
    id: terminalShellIdSchema,
    label: z.string().min(1).max(64),
    available: z.boolean(),
  })
  .strict();
export type TerminalShellOption = z.infer<typeof terminalShellOptionSchema>;

/**
 * What the picker renders, and which row is preselected.
 *
 * ONE OWNER decides the default, in main: `defaultShellId` is part of this
 * answer rather than something the renderer works out from the rows, so there
 * is no second place where "which shell do we open by default" is decided.
 */
export const terminalShellCatalogueSchema = z
  .object({
    shells: z.array(terminalShellOptionSchema).min(1).max(16),
    defaultShellId: terminalShellIdSchema,
  })
  .strict();
export type TerminalShellCatalogue = z.infer<typeof terminalShellCatalogueSchema>;

/* ------------------------------------------------------------------ *
 * Control plane: main <-> host, over the utility process parent port
 * ------------------------------------------------------------------ */

/** The shell to launch. Main resolves this; the renderer never names a binary. */
export const terminalLaunchSchema = z
  .object({
    executable: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64),
    /**
     * Where the shell starts, and BY CONTRACT the project's directory: main's
     * `resolveProjectLocation` is the only producer, and it returns
     * `resolveProjectDirectory`'s answer or nothing. The host relies on that
     * equality to derive `displayCwd` relative to this value, which is why it
     * is stated here rather than duplicated as a second `projectRoot` field two
     * writers could let drift apart.
     */
    cwd: z.string().min(1).max(4096),
    /**
     * What this project is CALLED on screen, decided by main.
     *
     * The host renders it when the shell sits at the project root, so the
     * header reads `vex-core` rather than `.`. The host is not allowed to
     * invent it from the directory's basename: the name a project is displayed
     * under is main's authority (it comes from the projects table), and a host
     * that derived it from the path would be a second, disagreeing source for
     * the same fact.
     */
    projectLabel: z.string().min(1).max(128),
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
      /**
       * A MONOTONIC per-project counter, minted by main.
       *
       * Serialization at the host orders the commits it runs; it cannot order
       * the requests that reach it. Renderer persistence is fire-and-forget and
       * the host dispatches control messages concurrently, so nothing else in
       * the system stops an older layout from being applied after a newer one
       * and committed over it. The host keeps the highest version it has seen
       * per project and refuses anything below it.
       */
      layoutVersion: z.number().int().nonnegative(),
      /**
       * THE LAST COMMIT of an explicitly closed workspace.
       *
       * A close persists the full buffer-bearing snapshot and then kills the
       * ptys. The host retains the layout of every project it has been fed, so
       * it was left holding that layout with no terminal behind it - and
       * `runShutdown` commits EVERY retained layout on its own initiative,
       * reconciled against whatever is still live. A quit after a close
       * therefore overwrote the buffer-bearing file with an EMPTY one, and the
       * revive the close had just promised was gone.
       *
       * So a final persist tells the host this layout has no successor: commit
       * it, then STOP HOLDING it. The file is not touched - a reopen while this
       * host is still running reads it back through `readWorkspace` - and the
       * autonomous shutdown commit simply has nothing left to overwrite.
       *
       * Background (debounced) persists never set it.
       */
      final: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("readWorkspace"), projectId: z.string().min(1).max(64) })
    .strict(),
  /**
   * FORGET a project's layout. Sent when the project's tombstone has committed.
   *
   * Main drops its own copy of a deleted project's topology, but the host keeps
   * the copy every `persistWorkspace` fed it - and `runShutdown` commits EVERY
   * key still in that map. So a graceful quit after a delete RECREATED
   * `<snapshots>/<projectId>.json` for a project Vex had already told the user
   * was gone, on the host's OWN initiative, past every check main had added on
   * the persist route. This is what closes that: the host stops holding a
   * layout it may never write again.
   *
   * The host does NOT touch the file. Removing it belongs to the delete's
   * cleanup, which owns it and has already run or is about to; the host's whole
   * obligation is to never write it a second time.
   *
   * IDEMPOTENT, and answers `ok` for a project it never held - "there is
   * nothing to forget" is the same outcome as "forgotten".
   */
  z
    .object({ kind: z.literal("forgetWorkspace"), projectId: z.string().min(1).max(64) })
    .strict(),
  /**
   * Bring a project's persisted terminals back as NEW ptys under NEW ids.
   *
   * The host reads the serialized buffers from its OWN store rather than being
   * handed them: it wrote that file, it is the only process that needs the
   * bytes, and a round trip through main would move megabytes of scrollback
   * across two process boundaries so that main could pass them straight back.
   * Main supplies the assignments, because ids and admission are main's.
   */
  z
    .object({
      kind: z.literal("revive"),
      projectId: z.string().min(1).max(64),
      windowId: terminalWindowIdSchema,
      /**
       * The project's on-screen name, for the same reason `terminalLaunchSchema`
       * carries one: a revived terminal's `displayCwd` is derived against the
       * project it belongs to, and the SNAPSHOT deliberately does not hold the
       * label. A snapshot that carried it would be a stale copy of a name main
       * can rename between sessions, and the host would render the old one.
       */
      projectLabel: z.string().min(1).max(128),
      assignments: z
        .array(terminalReviveAssignmentSchema)
        .min(1)
        .max(TERMINALS_PER_PROJECT_MAX),
    })
    .strict(),
  /**
   * ASK THE HOST WHERE THESE SHELLS ARE NOW.
   *
   * THE HOST IS THE ONLY AUTHORITY for a live terminal's `displayCwd`. It
   * watches the pty and derives the label on every directory change; main never
   * observes the property stream at all, because properties travel host -> port
   * -> preload -> renderer and main is not on that path.
   *
   * That is why a reattach has to ask. A renderer reload or a project
   * switch-back is answered from main's LIVE records, and those records are
   * written when a terminal is admitted - so a field frozen there would show a
   * `cd`-ed shell's SPAWN directory as though it were current. Reading the
   * value from the host at answer time is the only way the restore's seed can
   * be true at the moment it is sent. (The revive path needs no request: the
   * host has just spawned those ptys and reports their labels in the revive
   * result itself.)
   *
   * READ-ONLY and IDEMPOTENT. It changes nothing, holds nothing and takes no
   * lease. Ids the host does not hold are OMITTED from the answer rather than
   * refused: a terminal that exited between main's record and this question is
   * an unknown directory, not a failed open.
   */
  z
    .object({
      kind: z.literal("describeTerminals"),
      terminalIds: z.array(terminalIdSchema).max(TERMINALS_PER_PROJECT_MAX),
    })
    .strict(),
  /**
   * ABANDON an earlier request: main stopped waiting for it, and whatever it
   * creates must not survive as an untracked pty.
   *
   * Main's `send` bounds every request. When that bound fires, main releases the
   * capacity reservation and the project lease it was holding and answers the
   * caller `create_timeout` - but the HOST never heard about any of that, so a
   * slow `create` or `revive` went on to register live ptys that main had just
   * stopped believing in and no window would ever attach. This request is what
   * closes that gap: the host records the abandonment, and the terminals the
   * abandoned request produces are killed by the host itself rather than
   * reconciled by a main that has no way to learn their ids.
   *
   * NEVER answered with a reply - main is no longer listening for one.
   */
  z
    .object({
      kind: z.literal("abandonRequest"),
      requestId: z.string().min(1).max(64),
    })
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
    /**
     * LAUNCH METADATA, so a revive can start a shell rather than an empty pane.
     *
     * These are a HINT, never an authority. On revive the host re-runs the same
     * `LaunchProbe` gate a first-time create runs - the cwd must exist and be a
     * directory, the executable must resolve and be a file or symlink - so a
     * snapshot file edited between sessions cannot name a binary that would not
     * have been spawnable through the ordinary path either. The environment is
     * NEVER persisted (see below) and is recomputed from the host's scrubbed
     * base every time.
     *
     * `cwdAtSpawn` is a RAW ABSOLUTE PATH and stays one. This is a DURABLE
     * format read and written only by the pty host, in the user's own config
     * directory, to respawn a shell where it was - a use that needs the real
     * path and cannot be served by a label. It is not a wire field: no schema
     * that reaches the renderer carries it, and the renderer-facing value is
     * `displayCwd`, derived at the moment the property is emitted.
     */
    executable: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64),
    cwdAtSpawn: z.string().max(4096),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    /**
     * The serialized mirror, bounded BY BYTES here and not only by the row
     * reduction that produces it.
     *
     * The reduction loop is the mechanism; this refinement is the contract. A
     * file whose entry exceeds the per-terminal cap is off-contract however it
     * came to be - a hand-edited file, a future build with a larger cap, a
     * reduction that failed to converge - and is discarded whole rather than
     * read back into a mirror.
     */
    serialized: z
      .string()
      .refine((value) => utf8ByteLength(value) <= TERMINAL_SNAPSHOT_MAX_BYTES, {
        message: "serialized exceeds TERMINAL_SNAPSHOT_MAX_BYTES",
      }),
    /** Scrollback rows the live 1000-row bound had already discarded. */
    droppedRows: z.number().int().nonnegative(),
    /**
     * Rows given up to the byte caps: the CROSS-SESSION BASELINE this terminal
     * inherited when it was revived, PLUS what THIS save gave up.
     *
     * It is not a sum over every save. `serializeWithinNow(cap).reducedRows` is
     * a TOTAL measured from the whole mirror, so a second save of the same
     * session REPLACES the session's figure rather than adding to it - adding
     * is what once turned a real loss of 875 rows into a reported 2125. Only
     * the baseline a revive carried in from the previous session is ever added,
     * which is why the field is persisted rather than recomputed: nothing in a
     * fresh session can rediscover what an earlier one discarded.
     */
    reducedRows: z.number().int().nonnegative(),
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

/**
 * A group is one tab: an ordered set of panes split along one axis.
 *
 * THE INVARIANTS ARE IN THE SCHEMA, not in the consumer. A group with no panes
 * renders as a tab with nothing in it, and an `activePaneIndex` past the end
 * names a pane that does not exist - both are states the UI cannot draw, and a
 * layout that can express them is a layout every consumer has to re-check. The
 * cost of checking here is one pass over at most twelve panes at parse time.
 */
export const terminalGroupLayoutSchema = z
  .object({
    groupId: z.string().min(1).max(64),
    orientation: z.enum(["horizontal", "vertical"]),
    panes: z.array(terminalPaneLayoutSchema).min(1).max(TERMINALS_PER_PROJECT_MAX),
    activePaneIndex: z.number().int().nonnegative(),
  })
  .strict()
  .refine((group) => group.activePaneIndex < group.panes.length, {
    message: "activePaneIndex names a pane that does not exist",
  })
  .refine(
    (group) =>
      new Set(group.panes.map((pane) => pane.terminalId)).size === group.panes.length,
    { message: "a terminal appears in two panes of one group" },
  );
export type TerminalGroupLayout = z.infer<typeof terminalGroupLayoutSchema>;

export const terminalWorkspaceLayoutSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    groups: z.array(terminalGroupLayoutSchema).max(TERMINALS_PER_PROJECT_MAX),
    activeGroupIndex: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (layout) =>
      layout.groups.length === 0
        ? layout.activeGroupIndex === 0
        : layout.activeGroupIndex < layout.groups.length,
    { message: "activeGroupIndex names a group that does not exist" },
  )
  .refine(
    (layout) =>
      new Set(layout.groups.map((group) => group.groupId)).size === layout.groups.length,
    { message: "two groups share a groupId" },
  )
  .refine((layout) => {
    // ONE TERMINAL, ONE PANE, workspace-wide. Preload allows a single subscriber
    // per (terminalId, event kind), so a terminal named by two panes gives one
    // pty two consumers and the second silently steals the first's output.
    const ids = layout.groups.flatMap((group) =>
      group.panes.map((pane) => pane.terminalId),
    );
    return new Set(ids).size === ids.length;
  }, { message: "a terminal appears in two panes of the workspace" });
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
  .strict()
  .refine(
    (snapshot) =>
      new Set(snapshot.terminals.map((entry) => entry.terminalId)).size
      === snapshot.terminals.length,
    { message: "two snapshot entries share a terminalId" },
  )
  .refine(
    (snapshot) => {
      // EVERY PANE NAMES AN ENTRY THAT EXISTS. A layout referencing a terminal
      // the file does not carry restores a pane with no buffer, no launch and
      // nothing to revive from - which the revive then drops, silently, after
      // the user has already been shown the tab.
      const entries = new Set(snapshot.terminals.map((entry) => entry.terminalId));
      return snapshot.layout.groups.every((group) =>
        group.panes.every((pane) => entries.has(pane.terminalId)),
      );
    },
    { message: "a pane names a terminal the snapshot does not carry" },
  )
  .refine(
    (snapshot) => {
      // AND EVERY ENTRY IS NAMED BY A PANE. The other direction is the one that
      // produced an INVISIBLE REVIVED SHELL: a terminal closed while a persist
      // was in flight left its entry in the file with no pane referencing it,
      // and the next open spawned a pty for it that no pane could ever show and
      // no user could ever close. Paired with the pane-uniqueness refinement on
      // the layout, this makes the two halves of the file a bijection.
      const referenced = new Set(
        snapshot.layout.groups.flatMap((group) =>
          group.panes.map((pane) => pane.terminalId),
        ),
      );
      return snapshot.terminals.every((entry) => referenced.has(entry.terminalId));
    },
    { message: "a terminal entry is not referenced by any pane" },
  )
  .refine((snapshot) => snapshot.layout.projectId === snapshot.projectId, {
    // The file names one project. A layout inside it that names another is a
    // file whose two halves describe different workspaces, and reviving it
    // would open one project's shells under another project's name.
    message: "layout.projectId does not match the snapshot's projectId",
  });
export type TerminalWorkspaceSnapshot = z.infer<
  typeof terminalWorkspaceSnapshotSchema
>;

/**
 * The snapshot file name for a project, or `null` when the id cannot name one.
 *
 * SHARED because two processes resolve it: the pty host writes and reads these
 * files, and main DELETES them when a project is deleted - a cleanup that runs
 * whether or not a host is alive, so it cannot be a request to one. Two copies
 * of a path rule whose whole job is to refuse traversal is exactly the kind of
 * duplication that ends with one copy fixed and the other shipped.
 *
 * Project ids are opaque to this subsystem, so anything that is not a plain
 * name is refused rather than escaped.
 */
export function terminalSnapshotFileName(projectId: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(projectId)) return null;
  if (projectId === "." || projectId === "..") return null;
  return `${projectId}.json`;
}

/* ------------------------------------------------------------------ *
 * Revive
 * ------------------------------------------------------------------ */

/** What a revive produced, per requested terminal. */
export const terminalReviveResultSchema = z
  .object({
    revived: z
      .array(
        z
          .object({
            from: terminalIdSchema,
            to: terminalIdSchema,
            pid: z.number().int().nonnegative(),
            shellName: z.string().max(256),
            /** The LABEL, on the same contract as `terminalPropertySchema`'s. */
            displayCwd: z.string().max(4096),
            title: z.string().max(512),
            droppedRows: z.number().int().nonnegative(),
            reducedRows: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(TERMINALS_PER_PROJECT_MAX),
    /**
     * The ones that did not come back, BY NAME and with the reason.
     *
     * A revive is partial by nature - a project whose directory was deleted
     * between sessions cannot spawn there - and a caller that only learned the
     * successes would leave the failures as panes attached to nothing.
     */
    failed: z
      .array(
        z.object({ from: terminalIdSchema, code: terminalErrorCodeSchema }).strict(),
      )
      .max(TERMINALS_PER_PROJECT_MAX),
    /**
     * The persisted layout, rewritten onto the ids that actually came back.
     *
     * Returned by the host rather than recomputed by main so the remap has ONE
     * implementation. The host has to do it anyway - the layout it holds for
     * this project is what a shutdown would commit, and a layout of dead ids
     * committed beside live terminals would cost the whole workspace on the
     * next launch - and a second copy in main would be a second rule about
     * which panes survive a partial revive.
     */
    layout: terminalWorkspaceLayoutSchema,
  })
  .strict();
export type TerminalReviveResult = z.infer<typeof terminalReviveResultSchema>;

/**
 * What `describeTerminals` answered: the CURRENT label of every requested
 * terminal the host still holds.
 *
 * PARTIAL BY CONSTRUCTION. A requested id the host does not hold is simply
 * absent, which is how "this terminal is gone, or was never here" is said
 * without inventing a directory for it. Main turns an absence into the restore
 * row's `null`.
 */
export const terminalDescribeResultSchema = z
  .object({
    terminals: z
      .array(
        z
          .object({
            terminalId: terminalIdSchema,
            /** The LABEL, on the same contract as `terminalPropertySchema`'s. */
            displayCwd: z.string().max(4096),
          })
          .strict(),
      )
      .max(TERMINALS_PER_PROJECT_MAX),
  })
  .strict();
export type TerminalDescribeResult = z.infer<typeof terminalDescribeResultSchema>;

/**
 * What main hands the renderer when a workspace is opened.
 *
 * The SERIALIZED BUFFERS ARE NOT HERE. They stay in the pty host, which wrote
 * them into the revived terminals' mirrors; the renderer receives them the same
 * way it receives every other screen it has not seen, as a replay on attach.
 * Routing up to 24 MiB of scrollback through main into the renderer so it could
 * be thrown away would make the privileged process a courier for bytes nobody
 * in it reads.
 */
export const terminalWorkspaceRestoreSchema = z
  .object({
    layout: terminalWorkspaceLayoutSchema,
    terminals: z
      .array(
        z
          .object({
            terminalId: terminalIdSchema,
            title: z.string().max(512),
            shellName: z.string().max(256),
            /**
             * WHERE THIS SHELL IS NOW, on the same contract and the same bound
             * as `terminalPropertySchema`'s `displayCwd`.
             *
             * `null` is the HONEST UNKNOWN and is a real state, not an error:
             * the host is the only process that knows a live shell's directory
             * (it watches the pty, main does not), so a terminal the host could
             * not describe at this instant - one whose record main holds while
             * the host has already lost it, or a whole answer that failed -
             * arrives with no value and the panel keeps saying the directory is
             * not known yet. Seeding a remembered spawn directory instead would
             * put a `cd`-ed shell's ORIGINAL path on screen as if it were
             * current, which is confidently wrong rather than honestly silent.
             *
             * Seeded ONCE, at restore, and superseded by the first `displayCwd`
             * property event the reattached terminal emits.
             */
            displayCwd: z.string().max(4096).nullable(),
            droppedRows: z.number().int().nonnegative(),
            reducedRows: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(TERMINALS_PER_PROJECT_MAX),
    /** Old id -> new id, for every terminal that came back. */
    idMap: z.array(terminalReviveAssignmentSchema).max(TERMINALS_PER_PROJECT_MAX),
  })
  .strict();
export type TerminalWorkspaceRestore = z.infer<typeof terminalWorkspaceRestoreSchema>;

/* ------------------------------------------------------------------ *
 * Control plane: preload <-> main (IPC payloads)
 * ------------------------------------------------------------------ */

export const terminalCreateInputSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    /**
     * WHICH SHELL, as an id from the closed catalogue.
     *
     * REQUIRED, and `system_default` is how a caller says "the user's own
     * shell". An optional field would put the default in this schema and again
     * in whatever handler filled it in, which is two owners for one decision;
     * main's catalogue names the default and the renderer sends what it was
     * given. Anything outside the enum is refused by this schema at the preload
     * and main boundaries before a handler ever sees it.
     */
    shellId: terminalShellIdSchema,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();
export type TerminalCreateInput = z.infer<typeof terminalCreateInputSchema>;

/**
 * What a successful `create` produced.
 *
 * NAMED separately from the outcome wrapper because main parses it too: the
 * host answers `create` with an `unknown` value, and main records the
 * terminal's `shellName` so that a later open can describe a live terminal it
 * did not revive. Two spellings of this shape would be two chances for main's
 * record and the renderer's to disagree about the same terminal.
 */
export const terminalCreateValueSchema = z
  .object({
    terminalId: terminalIdSchema,
    pid: z.number().int().nonnegative(),
    shellName: z.string().max(256),
    /** The LABEL, on the same contract as `terminalPropertySchema`'s. */
    displayCwd: z.string().max(4096),
  })
  .strict();
export type TerminalCreateValue = z.infer<typeof terminalCreateValueSchema>;

export const terminalCreateResultSchema = terminalOutcomeSchema(
  terminalCreateValueSchema,
);
export type TerminalCreateResult = z.infer<typeof terminalCreateResultSchema>;

/**
 * What a CALLER hands `vex.terminal.write`, before preload chunks it.
 *
 * Identical to the wire shape except that `data` carries no byte bound: a paste
 * larger than one packet is legitimate and is sent whole, in packets that fit.
 * It exists so the preload gate can PARSE BEFORE IT CHUNKS - chunking first
 * meant a caller that passed a non-string reached `chunkByUtf8Bytes`, which is
 * a byte walk over a value it was never given, and the boundary threw instead
 * of answering the typed refusal every other local failure on this surface
 * answers with.
 */
export const terminalWriteRequestSchema = z
  .object({
    terminalId: terminalIdSchema,
    data: z.string(),
  })
  .strict();
export type TerminalWriteRequest = z.infer<typeof terminalWriteRequestSchema>;

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

/**
 * A project's layout, as the renderer hands it to main.
 *
 * Named separately from the layout itself because the preload gate validates
 * the PAYLOAD it is given, not the field inside it, and a gate that parses only
 * part of its input is a gate with a hole in the shape of the rest.
 */
/**
 * A renderer's request to commit its project layout.
 *
 * `final` marks the LAST commit of an explicitly closed workspace, and the host
 * drops the project's retained layout once it has committed it (see the
 * `persistWorkspace` host request). TRUST POSTURE, because this field comes
 * from the renderer and main forwards it: a hostile renderer that sets `final`
 * on a background persist costs that project the host's AUTONOMOUS shutdown
 * commit - the very latest unsaved layout delta - and nothing else. The file
 * already on disk is never touched, the commit this request asks for still
 * runs, and main's own authority check (the project lease plus the tombstone
 * read in `TerminalDomain.persistWorkspace`) runs unchanged before the flag is
 * forwarded. It can therefore cost availability of one delta, never integrity
 * of the committed snapshot.
 */
export const terminalPersistWorkspaceInputSchema = z
  .object({ layout: terminalWorkspaceLayoutSchema, final: z.boolean().optional() })
  .strict();

export const terminalProjectInputSchema = z
  .object({ projectId: z.string().min(1).max(64) })
  .strict();

/**
 * The terminals that died with an unexpectedly terminated pty host.
 *
 * Broadcast rather than replied to, because nobody asked: the renderer is
 * holding tabs for shells that no longer exist and cannot learn that any other
 * way - their exits died with the port that would have carried them.
 */
export const terminalsLostSchema = z
  .object({
    terminalIds: z.array(terminalIdSchema).max(TERMINALS_GLOBAL_MAX),
  })
  .strict();
export type TerminalsLost = z.infer<typeof terminalsLostSchema>;

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
