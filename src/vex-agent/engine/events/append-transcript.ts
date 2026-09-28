/**
 * `appendMessage` — the single transcript-write entry point that delivers
 * a `TranscriptAppendEvent` to the in-process event bus.
 *
 * Two paths, picked by `opts.client`:
 *
 *   1. **No external client (the 11 current engine call sites)**: the
 *      wrapper opens its own `withTransaction(BEGIN/COMMIT)` so the
 *      INSERT messages + UPDATE sessions.message_count are atomic, then
 *      emits on the bus AFTER the COMMIT returns. A rollback (any throw
 *      inside the callback) skips the emit entirely.
 *
 *   2. **External client (`opts.client`)**: the caller owns the
 *      surrounding transaction. The wrapper runs only the storage
 *      writes and DOES NOT emit. The caller is responsible for emitting
 *      via `emitTranscriptAppend(event)` AFTER its own COMMIT. This
 *      avoids the “event without commit” failure mode codex flagged in
 *      the plan review (rollback after wrapper emits → UI invalidates
 *      and re-fetches a row that never existed).
 *
 * `appendMessage` is the ONLY event-emitting transcript write helper.
 * `addMessageReturningId` is storage-only — direct callers must not
 * imply event delivery.
 */

import type { PoolClient } from "pg";
import { withTransaction } from "../../db/client.js";
import {
  addMessageReturningId,
  type Message,
  type MessageMetadata,
  type MessageWithId,
} from "../../db/repos/messages.js";
import {
  TRANSCRIPT_APPEND_EVENT_TYPE,
  type TranscriptAppendEvent,
  type TranscriptAppendRole,
  TranscriptEventBus,
  transcriptEventBus,
} from "./transcript-bus.js";
import {
  guardedWrite,
  type RunnerLeaseGuard,
} from "../runtime/lease-guard.js";
import type { LeaseFenceSite } from "../../db/lease-fence.js";

export interface AppendOptions {
  /**
   * External `PoolClient` owning a surrounding transaction. When present,
   * the wrapper runs only the storage writes and does NOT emit — the
   * caller must emit via `emitTranscriptAppend` after their own COMMIT.
   */
  readonly client?: PoolClient;
  /** Optional correlation id (chat turn, mission run, wake job). */
  readonly correlationId?: string;
  /**
   * Dependency-injected bus for tests. Production code always lets this
   * default to the singleton; tests pass a standalone `TranscriptEventBus`
   * to keep state isolation cheap.
   */
  readonly bus?: TranscriptEventBus;
}

function narrowRole(raw: Message["role"]): TranscriptAppendRole {
  return raw;
}

function buildEvent(
  sessionId: string,
  inserted: MessageWithId,
  metadata: MessageMetadata | undefined,
  correlationId: string | null,
): TranscriptAppendEvent {
  return {
    type: TRANSCRIPT_APPEND_EVENT_TYPE,
    sessionId,
    messageId: inserted.id,
    role: narrowRole(inserted.role),
    createdAt: inserted.timestamp,
    messageType: metadata?.messageType ?? null,
    correlationId,
  };
}

/**
 * Persist a message and (in the no-external-client path) emit a
 * `TranscriptAppendEvent` after COMMIT. See module doc for the two
 * paths.
 */
export async function appendMessage(
  sessionId: string,
  msg: Message,
  metadata?: MessageMetadata,
  opts?: AppendOptions,
): Promise<MessageWithId> {
  const correlationId = opts?.correlationId ?? null;

  if (opts?.client) {
    // External tx: storage-only. The caller must emit after their COMMIT.
    return addMessageReturningId(sessionId, msg, metadata, opts.client);
  }

  // Own tx: INSERT messages + UPDATE sessions.message_count are atomic
  // because `withTransaction` runs both statements on the same client.
  // Emit fires after `withTransaction` resolves (i.e. after COMMIT).
  const inserted = await withTransaction((client) =>
    addMessageReturningId(sessionId, msg, metadata, client),
  );

  const event = buildEvent(sessionId, inserted, metadata, correlationId);
  (opts?.bus ?? transcriptEventBus).emit(event);

  return inserted;
}

/**
 * Engine-marker convenience wrapper — mirrors `addEngineMessage` but
 * routes through `appendMessage` so wake banners, recovery notices,
 * tool-overflow stubs etc. participate in the event spine.
 */
export async function appendEngineMessage(
  sessionId: string,
  content: string,
  metadata: MessageMetadata & { role?: Message["role"] },
  opts?: AppendOptions,
): Promise<MessageWithId> {
  return appendMessage(
    sessionId,
    {
      role: metadata.role ?? "system",
      content,
      timestamp: new Date().toISOString(),
    },
    metadata,
    opts,
  );
}

/**
 * Helper for explicit tx-aware callers (compact service, mission
 * lifecycle) that pass `opts.client` to `appendMessage` and must emit
 * the event themselves after their own COMMIT.
 *
 * Production code should prefer the no-client path of `appendMessage`
 * unless the surrounding work demands a single transaction.
 */
export function emitTranscriptAppend(
  event: TranscriptAppendEvent,
  bus: TranscriptEventBus = transcriptEventBus,
): void {
  bus.emit(event);
}

/** One row of a fenced multi-row append. */
export interface FencedAppendEntry {
  readonly msg: Message;
  readonly metadata?: MessageMetadata;
}

/**
 * Persist `entries` IN ORDER, in ONE transaction that commits only while the
 * runner's lease claim still holds (`db/lease-fence.ts`), then emit one
 * `TranscriptAppendEvent` per row after the COMMIT.
 *
 * All or nothing: an assistant tool-call row and its tool results either all
 * land or none do, so a lease lost between two of them can never leave a
 * tool_call without its result on the tape.
 *
 * A refused write returns `null` — nothing was written and nothing is emitted —
 * and never throws: the caller's loop sees the lease as lost at its next check.
 * Storage errors still throw, exactly like `appendMessage`.
 */
export async function appendMessagesUnderLease(
  sessionId: string,
  entries: readonly FencedAppendEntry[],
  guard: RunnerLeaseGuard,
  site: LeaseFenceSite,
  opts?: Pick<AppendOptions, "correlationId" | "bus">,
): Promise<MessageWithId[] | null> {
  if (entries.length === 0) return [];
  const outcome = await guardedWrite(guard, site, async (client) => {
    const inserted: MessageWithId[] = [];
    for (const entry of entries) {
      inserted.push(
        await addMessageReturningId(sessionId, entry.msg, entry.metadata, client),
      );
    }
    return inserted;
  });
  if (!outcome.fenced) return null;
  const correlationId = opts?.correlationId ?? null;
  const bus = opts?.bus ?? transcriptEventBus;
  outcome.value.forEach((row, i) => {
    bus.emit(buildEvent(sessionId, row, entries[i]?.metadata, correlationId));
  });
  return outcome.value;
}
