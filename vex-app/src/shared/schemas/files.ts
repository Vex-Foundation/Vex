/**
 * VEX STUDIO FILES - the cross-process contract for the project tree, the file
 * viewer and the filesystem watcher (stage B3a).
 *
 * Three processes touch this surface and two of them are trust boundaries, so
 * every packet defined here is parsed with a `.strict()` Zod schema at BOTH
 * ends of every hop:
 *
 *   renderer --(domain method)--> preload   no packets; domain calls only
 *   preload  --(CH.files.*)-----> main      request/response, invoke/Result
 *   main     --(EV.files.changed)-> preload  push, validated before the callback
 *
 * ## The renderer never names a path
 *
 * Every request addresses a `FileNodeId`: an OPAQUE, main-minted token that
 * binds a project id, a project-relative path and the project's current node
 * EPOCH under a process-local HMAC. The renderer cannot mint one, cannot read
 * one, and cannot edit one into a different path - the signature fails and the
 * request is refused by name. Main re-derives the absolute path from the token
 * on EVERY call, realpaths the project directory, and re-checks containment
 * before it opens anything. A token is therefore a NAME, never an authority:
 * the authority is re-established from the database (which serves ACTIVE
 * projects only) and the lifecycle gate on each request.
 *
 * The epoch is what makes a token expire. A project delete bumps it, so every
 * token that project ever issued stops verifying at that instant, and a
 * renderer holding a stale tree cannot read a byte out of a tombstoned
 * project even in the window before it learns the project is gone.
 *
 * ## Nothing here is a silent cut
 *
 * Two bounds exist on this surface and each one REPORTS itself:
 *
 *   - a listing is paginated: `hasMore` plus `nextCursor` means every row not
 *     shown is reachable by asking again, in the same total order;
 *   - a change batch that exceeded the pending-buffer bound carries
 *     `overflowed: true` and `droppedCount`, so a consumer knows exactly how
 *     many changes it did not receive and that its remedy is to re-list;
 *   - a consumer that stops acknowledging batches stops being sent them past
 *     `FILES_EVENTS_OUTSTANDING_MAX`, and is told so with one `resync` whose
 *     reason is `consumer_backlog` and whose `droppedCount` is exactly what
 *     was withheld.
 *
 * A read that exceeds `FILE_READ_MAX_BYTES` is REFUSED with the real size
 * rather than served truncated, because half a file rendered as if it were the
 * whole file is the precise failure the decree exists to prevent.
 *
 * ## Bounds
 *
 * Every constant below is a CONTRACT VALUE with a named at-bound behaviour.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/**
 * The largest page a single `listChildren` will return.
 *
 * A directory with 50k entries is a real thing (a build output, a dataset), and
 * serving it in one message would put megabytes of JSON through the IPC channel
 * for a tree that renders 40 rows. The remainder is not lost: `hasMore` and
 * `nextCursor` name it and the next call returns it in the same order.
 */
export const FILES_LIST_PAGE_MAX = 500;

/** The page size a caller gets when it does not ask for one. */
export const FILES_LIST_PAGE_DEFAULT = 200;

/**
 * The largest file the viewer will read into a renderer, in bytes.
 *
 * 2 MiB. The bound is enforced on the bytes ACTUALLY READ from the open handle,
 * not on a `stat` taken beforehand: a file can grow between the two, and the
 * limit must hold on the object actually consumed. A file over the bound is
 * REFUSED with its real size, never served truncated.
 */
export const FILE_READ_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How many leading bytes decide whether a file is binary.
 *
 * 512, and the test is a NUL byte, which is what VS Code's text-file service
 * uses. It is a heuristic and it is named as one: a UTF-16 text file has NUL
 * bytes and is reported binary, which is the conservative direction - the
 * viewer says "this looks binary" instead of rendering mojibake.
 */
export const FILE_BINARY_SNIFF_BYTES = 512;

/**
 * The window over which raw watcher events are aggregated before coalescing.
 *
 * 75 ms, VS Code's value. A single editor save produces a create, an update and
 * a delete of a temp file within a few milliseconds; aggregating first is what
 * lets the coalescer turn that into the one change a consumer should see.
 */
export const FILES_AGGREGATION_MS = 75;

/** The minimum spacing between two emitted change batches. */
export const FILES_EMIT_THROTTLE_MS = 200;

/** The most changes one emitted batch carries. The rest ride the next batch. */
export const FILES_EMIT_MAX_ITEMS = 500;

/**
 * The most coalesced changes held pending before the buffer overflows.
 *
 * At the bound, further DISTINCT paths are dropped and COUNTED, and the next
 * batch says so with `overflowed` and `droppedCount`. The consumer's remedy is
 * a re-list, which is why the count is on the wire rather than in a log: a
 * consumer that is told nothing cannot know its tree is stale.
 */
export const FILES_PENDING_CHANGES_MAX = 5_000;

/** How many times a failed native watcher is restarted before it gives up. */
export const FILES_WATCHER_MAX_RESTARTS = 5;

/** The delay between stopping a failed native watcher and starting its successor. */
export const FILES_WATCHER_RESTART_DELAY_MS = 800;

/**
 * How often a SUSPENDED watcher polls for its vanished root.
 *
 * A deliberately odd interval so a fleet of suspended watchers does not beat in
 * time with each other or with any other 5-second timer in the process.
 */
export const FILES_SUSPEND_POLL_MS = 5_007;

/**
 * The most projects watched natively at once in this process.
 *
 * Each one is a recursive OS watch over a whole project tree, which on Linux
 * costs one inotify watch per directory out of a system-wide budget. The bound
 * exists so a user who opens projects all afternoon meets a named refusal
 * rather than an ENOSPC from the kernel.
 */
export const FILES_WATCHERS_MAX = 8;

/**
 * The most file subscriptions ONE WINDOW may hold at once.
 *
 * Subscriptions are cheap individually - they are filters over a project's one
 * native watch - but every native event fans out to EVERY one of them, so an
 * unbounded count turns a single `git checkout` into work proportional to
 * however many subscriptions a renderer chose to open. A window legitimately
 * holds one per project tree plus one per open editor tab, so 64 is far above
 * any real workspace and far below a number that costs anything.
 *
 * AT THE BOUND: the request is REFUSED with `subscription_limit`. It is not queued
 * and nothing already held is evicted - a subscription the consumer believes it
 * has is the one thing this surface must not take away silently.
 */
export const FILES_SUBSCRIPTIONS_PER_WINDOW_MAX = 64;

/**
 * The most `changed` batches main will have OUTSTANDING to one subscription.
 *
 * `webContents.send` does not block and does not tell the sender whether the
 * renderer ever ran. A renderer wedged on a long task, or paused at a debugger
 * breakpoint, still has every batch queued for it - so a `git checkout` behind
 * a stalled consumer is an IPC backlog with no bound at all, in the privileged
 * process, holding the change payloads alive.
 *
 * So delivery is ACKNOWLEDGED, and the acknowledgement comes from CONSUMPTION:
 * preload posts one ack per `changed` batch it has already handed to the
 * renderer's callback. That is the same discipline the terminal's flow control
 * uses - there the ack comes from xterm's write completion, here from the
 * callback returning - and for the same reason: an ack posted on arrival in
 * preload would prove only that a message was delivered to a process that may
 * still be doing nothing with it.
 *
 * 32, and the number is derived rather than picked. A watcher emits at most one
 * batch per `FILES_EMIT_THROTTLE_MS`, so 32 outstanding batches is 6.4 seconds
 * of un-consumed events: far beyond any renderer that is merely busy, and far
 * short of a backlog worth worrying about in memory. A consumer that has not
 * acked one batch in six seconds is not slow, it is not there.
 *
 * AT THE BOUND: main STOPS sending `changed` batches to that subscription and
 * remembers that it did. `status` and `resync` still go - they are the honest
 * signal about a watcher and must never be the thing that is dropped. When acks
 * bring the count back under the bound, main sends exactly ONE `resync` with
 * reason `consumer_backlog` and `droppedCount` set to the number of individual
 * changes it withheld, so the consumer knows precisely what it missed and that
 * its remedy is to re-list. Nothing is silently cut: the count is on the wire.
 */
export const FILES_EVENTS_OUTSTANDING_MAX = 32;

/**
 * The most RAW native events held between two aggregation ticks.
 *
 * `FILES_PENDING_CHANGES_MAX` bounds the map that survives coalescing, but the
 * array feeding it is filled by the native callback and drained only when the
 * 75 ms timer fires - so a burst large enough to outrun one tick grows it with
 * no bound at all. Four aggregation windows' worth is the ceiling: enough that
 * an ordinary burst never pays for an early fold, small enough that the array
 * cannot become the leak the pending map was bounded to prevent.
 *
 * AT THE BOUND: the watcher AGGREGATES EAGERLY rather than dropping. Nothing is
 * lost here; the fold moves the events into the pending map, whose own bound
 * drops and COUNTS, and reports both on the next batch as `overflowed` with
 * `droppedCount`.
 */
export const FILES_RAW_EVENTS_MAX = FILES_PENDING_CHANGES_MAX * 4;

/** The longest project-relative path this surface will carry. */
export const FILES_RELATIVE_PATH_MAX = 4_096;

/** The longest project id this surface will carry. */
export const FILES_PROJECT_ID_MAX = 64;

/**
 * The token and cursor bounds are DERIVED, never chosen.
 *
 * Both values are ENCODINGS of a path this surface already declared it will
 * carry, so a bound picked by eye is a bound that rejects a path the contract
 * promises. It did: `FILES_NODE_ID_MAX` was 1024 while a token minted from a
 * path of `FILES_RELATIVE_PATH_MAX` is several thousand characters, so a
 * legitimately deep file was refused by the surface's own `.strict()` output
 * validation rather than by anything about the file.
 *
 * So the arithmetic is written down and the constants fall out of it. Every
 * step is an upper bound, and each one is stated where it is taken.
 */

/**
 * Bytes an unpadded base64url string costs per input byte, rounded up.
 *
 * base64 encodes three input bytes as four characters and drops the padding,
 * so `ceil(n * 4 / 3)` is exact for the unpadded form (16 bytes -> 22 chars,
 * which is the signature length this surface actually emits).
 */
function base64urlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/**
 * The most UTF-8 bytes one UTF-16 code unit can cost.
 *
 * `z.string().max()` counts UTF-16 code units. A code point in U+0800..U+FFFF
 * is one code unit and three UTF-8 bytes, which is the worst ratio: a
 * non-BMP code point costs four bytes but spends TWO code units to do it.
 */
const UTF8_BYTES_PER_CODE_UNIT_MAX = 3;

/** Decimal digits an epoch can reach. `Number.MAX_SAFE_INTEGER` has 16. */
const NODE_EPOCH_DIGITS_MAX = 20;

/** `f1.` plus the `.` before the signature. */
const NODE_TOKEN_FRAMING_CHARS = 4;

/** The HMAC prefix the token carries, in bytes, before base64url. */
const NODE_TOKEN_SIGNATURE_BYTES = 16;

/**
 * `epoch NUL projectId NUL relativePath`, in UTF-8 bytes, at its worst.
 *
 * The two NUL separators are one byte each.
 */
const NODE_TOKEN_PAYLOAD_BYTES_MAX =
  NODE_EPOCH_DIGITS_MAX
  + 1
  + FILES_PROJECT_ID_MAX * UTF8_BYTES_PER_CODE_UNIT_MAX
  + 1
  + FILES_RELATIVE_PATH_MAX * UTF8_BYTES_PER_CODE_UNIT_MAX;

/**
 * The longest node token this surface will accept.
 *
 * `f1.<base64url(payload)>.<base64url(signature)>` at the payload's worst case.
 * With today's inputs that is 4 + ceil(12502 * 4 / 3) + 22 = 16_696 characters.
 */
export const FILES_NODE_ID_MAX =
  NODE_TOKEN_FRAMING_CHARS
  + base64urlLength(NODE_TOKEN_PAYLOAD_BYTES_MAX)
  + base64urlLength(NODE_TOKEN_SIGNATURE_BYTES);

/**
 * `{"v":1,"n":"","r":0,"k":""}` with both strings empty, in characters.
 *
 * The cursor is that JSON object, UTF-8 encoded and base64url'd; `ordering.ts`
 * owns the shape and this constant is its fixed cost.
 */
const CURSOR_JSON_FRAMING_CHARS = 27;

/**
 * The most UTF-8 bytes `JSON.stringify` can spend on one code unit.
 *
 * A control character becomes `\uXXXX`, six ASCII bytes, and a filename may
 * legally contain control characters on POSIX. That is worse than the three
 * bytes an unescaped code unit can cost, so six is the bound.
 */
const CURSOR_JSON_BYTES_PER_CODE_UNIT_MAX = 6;

/**
 * The longest listing cursor this surface will accept.
 *
 * The cursor names a directory (`n`) and one of its children by name (`k`),
 * and that child's own path is `n/k` - so `n.length + 1 + k.length` cannot
 * exceed `FILES_RELATIVE_PATH_MAX` and the two strings share one budget.
 * With today's inputs that is ceil((27 + 4096 * 6) * 4 / 3) = 32_804.
 */
export const FILES_CURSOR_MAX = base64urlLength(
  CURSOR_JSON_FRAMING_CHARS
  + FILES_RELATIVE_PATH_MAX * CURSOR_JSON_BYTES_PER_CODE_UNIT_MAX,
);

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * An opaque node token. Structure is main's business and nobody else's.
 *
 * Deliberately typed as a bounded string rather than a parsed shape: giving the
 * renderer a schema for the inside of this value would invite it to build one.
 */
export const fileNodeIdSchema = z.string().min(1).max(FILES_NODE_ID_MAX);
export type FileNodeId = z.infer<typeof fileNodeIdSchema>;

export const filesProjectIdSchema = z.string().min(1).max(FILES_PROJECT_ID_MAX);

/**
 * A project-relative POSIX path, for DISPLAY and for change identity.
 *
 * The project root itself is the empty string. This value is never accepted
 * back as a request parameter - `FileNodeId` is - so it cannot become a path a
 * handler resolves.
 */
export const fileRelativePathSchema = z.string().max(FILES_RELATIVE_PATH_MAX);

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

/**
 * Every refusal this surface can produce, as CODES.
 *
 * No prose crosses the boundary: a filesystem error's message names the user's
 * home directory and their folder layout, and the renderer's remedy is
 * identical for every member of a class. Main logs the sentence; the wire
 * carries the code, exactly as the terminal and host-status surfaces do.
 */
export const filesErrorCodeSchema = z.enum([
  /** The token did not verify, or its epoch is spent. Never says which. */
  "invalid_node",
  /** The cursor did not decode, or names a different listing. */
  "invalid_cursor",
  /** Nothing is at that path any more. */
  "not_found",
  /** The path resolved outside the project directory after realpath. */
  "outside_project",
  /** A component of the path is a symbolic link. Vex does not follow it. */
  "symlinked_path",
  /**
   * The path stopped naming the file that was opened, and the read was
   * abandoned before a byte was taken from it.
   *
   * Distinct from `symlinked_path` on purpose: main proves a handle's identity
   * against the path's after opening it, and a mismatch says the file was
   * REPLACED, not that a link was followed. Labelling every mismatch a symlink
   * would report evidence that was never collected. A second attempt can
   * legitimately answer differently.
   */
  "path_changed",
  /** A listing was asked of something that is not a directory. */
  "not_a_directory",
  /** A read was asked of something that is not a regular file. */
  "not_a_file",
  /** The file is larger than `FILE_READ_MAX_BYTES`. Carries the real size. */
  "too_large",
  /** The first `FILE_BINARY_SNIFF_BYTES` bytes contain a NUL. */
  "binary",
  /** The bytes are not valid UTF-8, so no honest text can be shown. */
  "invalid_utf8",
  /** The project has no active row, or its lifecycle gate closed admission. */
  "project_closed",
  /** The projects root could not be prepared, or has moved since it was anchored. */
  "root_unavailable",
  /** No watcher could be started: the per-process watcher bound is reached. */
  "watcher_limit",
  /** This WINDOW holds the per-window subscription bound already. Release one. */
  "subscription_limit",
  /** The watcher is not running for this project and cannot be started. */
  "watcher_unavailable",
  /** No subscription with that id belongs to this window. */
  "unknown_subscription",
  /** The filesystem refused, for a reason main logged and will not repeat here. */
  "io_error",
]);
export type FilesErrorCode = z.infer<typeof filesErrorCodeSchema>;

/**
 * A discriminated outcome inside a successful `Result`.
 *
 * "That file is binary" is an ANSWER, not an error: the viewer renders it as a
 * message about the file rather than as a failure of Vex. Genuine
 * infrastructure failure still travels as `Result.error`.
 *
 * The return type is INFERRED rather than annotated, which is the one place on
 * this surface a public function does not spell its own type out. Zod's
 * `ZodDiscriminatedUnion` carries the discriminator and both member shapes in
 * its type parameters, and any hand-written `z.ZodType<...>` annotation is a
 * WIDER type that the inferred one does not structurally satisfy - so writing
 * the annotation forces a cast, and a cast here is the thing that would let the
 * schema and its declared type drift apart unnoticed. `FilesOutcome<T>` below
 * remains the domain-side name for the parsed value.
 */
export function filesOutcomeSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z
      .object({
        ok: z.literal(false),
        code: filesErrorCodeSchema,
        /** Present only on `too_large`: the file's REAL size, so the UI can say it. */
        size: z.number().int().nonnegative().optional(),
      })
      .strict(),
  ]);
}

export type FilesOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: FilesErrorCode; readonly size?: number };

/* ------------------------------------------------------------------ *
 * Tree nodes and listings
 * ------------------------------------------------------------------ */

/**
 * What a directory entry IS, decided by `lstat` and never by `stat`.
 *
 * `symlink` is its own kind rather than being resolved to its target, because
 * resolving would silently show the user a file outside their project as
 * though it were inside it. The tree shows the link; opening it is refused
 * with `symlinked_path`.
 */
export const fileNodeKindSchema = z.enum(["file", "directory", "symlink", "other"]);
export type FileNodeKind = z.infer<typeof fileNodeKindSchema>;

export const fileNodeSchema = z
  .object({
    nodeId: fileNodeIdSchema,
    /** The entry's own name, never a path. */
    name: z.string().min(1).max(512),
    /** Project-relative POSIX path, for display and for change correlation. */
    path: fileRelativePathSchema,
    kind: fileNodeKindSchema,
    /** Bytes, for regular files only. `null` when unknown or not applicable. */
    size: z.number().int().nonnegative().nullable(),
    /** Last modification, epoch milliseconds. `null` when unknown. */
    modifiedMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type FileNode = z.infer<typeof fileNodeSchema>;

/**
 * One page of a directory, in the SAME total order the tree renders.
 *
 * The order is a contract, not a convenience: the cursor encodes a position in
 * it, so a page boundary is only meaningful while producer and consumer agree
 * on the comparator. Directories first, then a numeric-aware collation of
 * names, then an exact byte comparison as the tiebreak so two names that
 * collate equally (`README` and `readme`) still have ONE defined order.
 */
export const fileListingSchema = z
  .object({
    children: z.array(fileNodeSchema).max(FILES_LIST_PAGE_MAX),
    /** True when rows exist beyond this page. Never true with a null cursor. */
    hasMore: z.boolean(),
    /** Opaque. Pass it back verbatim to continue; `null` at the end. */
    nextCursor: z.string().max(FILES_CURSOR_MAX).nullable(),
    /**
     * How many entries this directory holds in total, INCLUDING the ones this
     * page does not carry and EXCLUDING the ones the exclude rules hide.
     */
    totalCount: z.number().int().nonnegative(),
    /**
     * How many entries the exclude rules hid, so the UI can offer to show them
     * rather than leaving the user wondering where `node_modules` went.
     */
    excludedCount: z.number().int().nonnegative(),
  })
  .strict();
export type FileListing = z.infer<typeof fileListingSchema>;

/* ------------------------------------------------------------------ *
 * File contents
 * ------------------------------------------------------------------ */

export const fileContentSchema = z
  .object({
    nodeId: fileNodeIdSchema,
    path: fileRelativePathSchema,
    /** The WHOLE file, decoded as UTF-8. Never a prefix; see the module note. */
    text: z.string(),
    /** Bytes on disk, as measured on the open handle. */
    size: z.number().int().nonnegative(),
    modifiedMs: z.number().int().nonnegative().nullable(),
    /** SHA-256 of the exact bytes read, hex. The viewer's change identity. */
    hash: z.string().length(64),
  })
  .strict();
export type FileContent = z.infer<typeof fileContentSchema>;

/* ------------------------------------------------------------------ *
 * Change events
 * ------------------------------------------------------------------ */

export const fileChangeKindSchema = z.enum(["added", "updated", "deleted"]);
export type FileChangeKind = z.infer<typeof fileChangeKindSchema>;

export const fileChangeSchema = z
  .object({
    path: fileRelativePathSchema,
    kind: fileChangeKindSchema,
    /**
     * A token for the changed path, so a consumer can act on it without
     * re-listing its parent. Minted under the CURRENT epoch, so a change
     * emitted before a delete stops verifying with everything else.
     */
    nodeId: fileNodeIdSchema,
  })
  .strict();
export type FileChange = z.infer<typeof fileChangeSchema>;

/**
 * Why a consumer is being told its picture of the tree may be wrong.
 *
 * Each of these is a moment where changes provably happened that no batch
 * carried, so the honest thing - and the only thing that does not leave a stale
 * tree on screen - is to name the moment and let the consumer re-list.
 */
export const filesResyncReasonSchema = z.enum([
  /** The native watcher was restarted after a failure. */
  "watcher_restarted",
  /** The project root came back after vanishing, and watching resumed. */
  "root_resumed",
  /** The pending buffer overflowed; `droppedCount` says by how much. */
  "overflow",
  /**
   * This consumer stopped acknowledging batches, so main stopped sending them
   * past `FILES_EVENTS_OUTSTANDING_MAX` and has now resumed. `droppedCount` is
   * the number of individual changes withheld while it was stopped.
   */
  "consumer_backlog",
]);
export type FilesResyncReason = z.infer<typeof filesResyncReasonSchema>;

/**
 * The watcher's own honest state.
 *
 * `unavailable` is DURABLE for the watcher that reported it: it is what a spent
 * restart cap and an ENOSPC look like, and pretending otherwise would leave a
 * tree that silently stops updating. Every further subscription to that same
 * project joins the same unavailable watcher and is told so; only a project
 * that loses its last subscriber, and is therefore watched by a NEW watcher
 * next time, starts over.
 */
export const filesWatcherStateSchema = z.enum([
  /** Native watching is live. */
  "watching",
  /** The project root is not there; polling for its return. */
  "suspended",
  /**
   * Not watching, and not going to for the life of this watcher; a project
   * nobody watches any more gets a fresh watcher, and a fresh budget, on its
   * next first subscription.
   */
  "unavailable",
  /** The project was deleted. Every token it issued is spent. */
  "closed",
]);
export type FilesWatcherState = z.infer<typeof filesWatcherStateSchema>;

/**
 * Why the watcher is in the state it is in. CODES, never a provider's prose.
 *
 * `os_watch_limit` and `os_file_limit` are separate members because the user's
 * remedy differs: one is `fs.inotify.max_user_watches`, the other is a process
 * file-descriptor limit, and collapsing them into "watcher failed" would tell
 * the user nothing they could act on.
 */
export const filesWatcherReasonSchema = z.enum([
  "started",
  "root_missing",
  "root_returned",
  "restarted",
  "restart_cap_reached",
  "os_watch_limit",
  "os_file_limit",
  "watcher_limit",
  "project_deleted",
  "released",
  "io_error",
]);
export type FilesWatcherReason = z.infer<typeof filesWatcherReasonSchema>;

/**
 * A STICKY warning: a fact about this project's watcher that outlived the
 * moment it happened and that the UI must keep showing.
 *
 * ENOSPC is the reason this exists. It is logged once per process (a watcher
 * that retries logs it thousands of times otherwise), and a fact that is only
 * in a log the user will never open is a fact the product does not have. So it
 * is also a durable field on the status, re-sent with every status event for as
 * long as it holds.
 */
export const filesWatcherWarningSchema = z.enum([
  "os_watch_limit_reached",
  "os_file_limit_reached",
  "restart_cap_reached",
]);
export type FilesWatcherWarning = z.infer<typeof filesWatcherWarningSchema>;

/**
 * What main pushes on `EV.files.changed`.
 *
 * A DISCRIMINATED UNION rather than one shape with optional fields, because a
 * batch of changes and a statement about the watcher's health are different
 * facts and a consumer handles them differently. Every member carries the
 * subscription it belongs to and the watcher GENERATION it was produced under:
 * a batch from a generation the consumer has already been told was superseded
 * describes a tree that no longer exists, and dropping it at the consumer is
 * the last guard against a stale change repainting a fresh tree.
 */
export const filesEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("changed"),
      subscriptionId: z.string().min(1).max(64),
      projectId: filesProjectIdSchema,
      watcherGeneration: z.number().int().nonnegative(),
      /** Monotonic within a generation, starting at 0. Resets when it bumps. */
      batchSeq: z.number().int().nonnegative(),
      changes: z.array(fileChangeSchema).max(FILES_EMIT_MAX_ITEMS),
      /** True when the pending buffer dropped changes before this batch. */
      overflowed: z.boolean(),
      /** How many DISTINCT paths were dropped. Zero unless `overflowed`. */
      droppedCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resync"),
      subscriptionId: z.string().min(1).max(64),
      projectId: filesProjectIdSchema,
      watcherGeneration: z.number().int().nonnegative(),
      reason: filesResyncReasonSchema,
      /** Changes provably missed, when the reason can count them. */
      droppedCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("status"),
      subscriptionId: z.string().min(1).max(64),
      projectId: filesProjectIdSchema,
      watcherGeneration: z.number().int().nonnegative(),
      state: filesWatcherStateSchema,
      reason: filesWatcherReasonSchema,
      warnings: z.array(filesWatcherWarningSchema).max(8),
    })
    .strict(),
]);
export type FilesEvent = z.infer<typeof filesEventSchema>;

/* ------------------------------------------------------------------ *
 * Request inputs (validated at BOTH the preload gate and the main handler)
 * ------------------------------------------------------------------ */

/**
 * `nodeId: null` means the project root.
 *
 * Explicitly nullable rather than optional: "no node" is a real, common
 * addressing mode (the tree's first listing), and an absent field would make it
 * indistinguishable from a caller that forgot to send one.
 */
export const filesListChildrenInputSchema = z
  .object({
    projectId: filesProjectIdSchema,
    nodeId: fileNodeIdSchema.nullable(),
    limit: z.number().int().min(1).max(FILES_LIST_PAGE_MAX).optional(),
    cursor: z.string().max(FILES_CURSOR_MAX).nullable().optional(),
  })
  .strict();
export type FilesListChildrenInput = z.infer<typeof filesListChildrenInputSchema>;

export const filesReadFileInputSchema = z
  .object({ projectId: filesProjectIdSchema, nodeId: fileNodeIdSchema })
  .strict();
export type FilesReadFileInput = z.infer<typeof filesReadFileInputSchema>;

/**
 * Start a subscription.
 *
 * `nodeId: null` subscribes to the WHOLE project tree; a node subscribes to one
 * open file. Both ride the same native watcher - opening a file starts no
 * second OS watch - and the difference is which changes reach this consumer.
 */
export const filesWatchInputSchema = z
  .object({
    projectId: filesProjectIdSchema,
    nodeId: fileNodeIdSchema.nullable(),
  })
  .strict();
export type FilesWatchInput = z.infer<typeof filesWatchInputSchema>;

export const filesUnwatchInputSchema = z
  .object({ subscriptionId: z.string().min(1).max(64) })
  .strict();
export type FilesUnwatchInput = z.infer<typeof filesUnwatchInputSchema>;

/**
 * Acknowledge ONE delivered `changed` batch.
 *
 * Sent by PRELOAD, not by the renderer: the renderer never learns that this
 * channel exists, and a component that forgets to acknowledge cannot wedge its
 * own subscription's flow control - exactly the placement the terminal bridge
 * chose for the same reason. It carries no count, because one ack means one
 * batch and a count would be a number a caller could inflate to buy itself
 * headroom it never earned.
 *
 * The WINDOW is not on this packet. It comes from the sender of the IPC event,
 * so one window cannot credit another window's subscription; an ack for a
 * subscription this window does not own is refused with `unknown_subscription`.
 */
export const filesAckEventInputSchema = z
  .object({ subscriptionId: z.string().min(1).max(64) })
  .strict();
export type FilesAckEventInput = z.infer<typeof filesAckEventInputSchema>;

/** What a successful `watchFile` hands back. */
export const filesSubscriptionSchema = z
  .object({
    subscriptionId: z.string().min(1).max(64),
    watcherGeneration: z.number().int().nonnegative(),
    state: filesWatcherStateSchema,
    warnings: z.array(filesWatcherWarningSchema).max(8),
  })
  .strict();
export type FilesSubscription = z.infer<typeof filesSubscriptionSchema>;

/* ------------------------------------------------------------------ *
 * Response schemas
 * ------------------------------------------------------------------ */

export const filesListChildrenResultSchema = filesOutcomeSchema(fileListingSchema);
export const filesReadFileResultSchema = filesOutcomeSchema(fileContentSchema);
export const filesWatchResultSchema = filesOutcomeSchema(filesSubscriptionSchema);
export const filesAckResultSchema = filesOutcomeSchema(z.null());
export type FilesAckResult = FilesOutcome<null>;
