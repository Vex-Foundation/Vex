/**
 * Composer message queue store (A27). Messages submitted while a turn is
 * already in flight wait here per session instead of being dropped; the
 * composer drains the head when the session goes idle. Module store keyed by
 * session id - the welcome composer (no session) never queues.
 */

import { useSyncExternalStore } from "react";

export interface QueuedComposerMessage {
  readonly id: string;
  readonly text: string;
}

const EMPTY_QUEUE: readonly QueuedComposerMessage[] = [];
const queues = new Map<string, readonly QueuedComposerMessage[]>();
const listeners = new Set<() => void>();
let sequence = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function write(
  sessionId: string,
  rows: readonly QueuedComposerMessage[],
): void {
  if (rows.length === 0) queues.delete(sessionId);
  else queues.set(sessionId, rows);
  emit();
}

export function readQueue(sessionId: string): readonly QueuedComposerMessage[] {
  return queues.get(sessionId) ?? EMPTY_QUEUE;
}

export function enqueueMessage(
  sessionId: string,
  text: string,
): QueuedComposerMessage {
  sequence += 1;
  const row: QueuedComposerMessage = { id: `q${sequence}`, text };
  write(sessionId, [...readQueue(sessionId), row]);
  return row;
}

export function removeQueuedMessage(sessionId: string, id: string): void {
  const rows = readQueue(sessionId);
  const next = rows.filter((row) => row.id !== id);
  if (next.length !== rows.length) write(sessionId, next);
}

export function updateQueuedMessage(
  sessionId: string,
  id: string,
  text: string,
): void {
  const rows = readQueue(sessionId);
  const next = rows.map((row) => (row.id === id ? { ...row, text } : row));
  write(sessionId, next);
}

/**
 * Pop one row for dispatch: the head by default, or the named row for a
 * send-now action. Returns null when the queue (or the named row) is gone -
 * a concurrent removal must not dispatch a message the user just deleted.
 */
export function takeQueuedMessage(
  sessionId: string,
  id?: string,
): QueuedComposerMessage | null {
  const rows = readQueue(sessionId);
  const row = id === undefined ? rows[0] : rows.find((r) => r.id === id);
  if (row === undefined) return null;
  write(
    sessionId,
    rows.filter((r) => r.id !== row.id),
  );
  return row;
}

export function subscribeQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset so specs never leak queued rows into each other. */
export function resetComposerQueueForTest(): void {
  queues.clear();
  sequence = 0;
  emit();
}

export function useComposerQueue(
  sessionId: string | null,
): readonly QueuedComposerMessage[] {
  return useSyncExternalStore(subscribeQueue, () =>
    sessionId === null ? EMPTY_QUEUE : readQueue(sessionId),
  );
}
