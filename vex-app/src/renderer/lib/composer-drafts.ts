/**
 * Per-session composer draft store (B1). A module-level map keyed by session
 * id (the welcome composer uses a reserved key), so an unsent draft survives
 * switching sessions and coming back. In-memory only: drafts are transient
 * typing state, not documents, and are deliberately not persisted across an
 * app restart.
 */

import { useCallback, useSyncExternalStore } from "react";

/** Draft key for the sessionless welcome composer. */
export const WELCOME_DRAFT_KEY = "welcome";

export function draftKeyFor(sessionId: string | null): string {
  return sessionId ?? WELCOME_DRAFT_KEY;
}

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function readDraft(key: string): string {
  return drafts.get(key) ?? "";
}

/** Write a draft; an empty value releases the slot instead of storing "". */
export function writeDraft(key: string, value: string): void {
  if (readDraft(key) === value) return;
  if (value.length === 0) drafts.delete(key);
  else drafts.set(key, value);
  emit();
}

export function clearDraft(key: string): void {
  writeDraft(key, "");
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset so specs never leak drafts into each other. */
export function resetDraftsForTest(): void {
  drafts.clear();
  emit();
}

/** The draft for one key plus its setter, live across store writers. */
export function useComposerDraft(
  key: string,
): readonly [string, (value: string) => void] {
  const draft = useSyncExternalStore(subscribeDrafts, () => readDraft(key));
  const setDraft = useCallback(
    (value: string): void => {
      writeDraft(key, value);
    },
    [key],
  );
  return [draft, setDraft];
}
