/**
 * The migration screen's state, driven by main alone: the status answers
 * what to offer, Move and Start fresh resolve when main has settled them,
 * and the progress events say where a move stands (the newest `seq` wins, so
 * the event replayed to a joining screen never moves it backwards).
 *
 * A screen that arrives while a move or a start-fresh already runs (a
 * reload) joins it by calling it again: main joins, never starts a second.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RuntimeMigrationFailureReason,
  RuntimeMigrationProgress,
  RuntimeMigrationStatus,
} from "@shared/schemas/runtime-migration.js";

export type PendingStatus = Extract<RuntimeMigrationStatus, { kind: "pending" | "pending_source_offline" }>;

export interface MigrationFailure {
  readonly op: "migrate" | "start_fresh";
  readonly reason: RuntimeMigrationFailureReason;
  readonly message: string;
  readonly requiredBytes: number | null;
  readonly availableBytes: number | null;
}

export type MigrationScreen =
  | { readonly kind: "loading" }
  | { readonly kind: "pending"; readonly status: PendingStatus }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "moving" }
  | { readonly kind: "starting_fresh" }
  | { readonly kind: "failed"; readonly failure: MigrationFailure }
  | { readonly kind: "cancelled" }
  | { readonly kind: "done"; readonly outcome: "migrated" | "fresh"; readonly oldStackStopped: boolean | null }
  /** Nothing to move: the screen hands off to the runtime screen. */
  | { readonly kind: "not_needed" };

export interface RuntimeMigrationHandle {
  readonly screen: MigrationScreen;
  /** The newest step of the move in flight (or the last one seen), null before any. */
  readonly progress: RuntimeMigrationProgress | null;
  readonly refresh: () => void;
  readonly move: () => void;
  readonly startFresh: () => void;
}

function ipcFailure(op: MigrationFailure["op"], message: string): MigrationFailure {
  return { op, reason: "unexpected", message, requiredBytes: null, availableBytes: null };
}

export function useRuntimeMigration(): RuntimeMigrationHandle {
  const [screen, setScreen] = useState<MigrationScreen>({ kind: "loading" });
  const [progress, setProgress] = useState<RuntimeMigrationProgress | null>(null);
  const live = useRef(true);
  const show = useCallback((next: MigrationScreen): void => {
    if (live.current) setScreen(next);
  }, []);

  const apply = useCallback((next: RuntimeMigrationProgress): void => {
    if (!live.current) return;
    setProgress((prev) => (prev !== null && prev.seq >= next.seq ? prev : next));
  }, []);

  const startFresh = useCallback((): void => {
    show({ kind: "starting_fresh" });
    setProgress(null);
    void window.vex.system.runtimeMigrationStartFresh().then((result) => {
      if (!result.ok) return show({ kind: "failed", failure: ipcFailure("start_fresh", result.error.message) });
      if (result.data.kind === "started_fresh") return show({ kind: "done", outcome: "fresh", oldStackStopped: null });
      const { reason, message, requiredBytes, availableBytes } = result.data;
      show({ kind: "failed", failure: { op: "start_fresh", reason, message, requiredBytes, availableBytes } });
    });
  }, [show]);

  // `refresh` and `move` call each other (a join, a "nothing to move"), so
  // they reach each other through refs.
  const refreshRef = useRef<() => void>(() => {});
  const move = useCallback((): void => {
    show({ kind: "moving" });
    // A new attempt's rows start over; main's seq keeps growing across them.
    setProgress(null);
    void window.vex.system.runtimeMigrationMove().then((result) => {
      if (!result.ok) return show({ kind: "failed", failure: ipcFailure("migrate", result.error.message) });
      const data = result.data;
      switch (data.kind) {
        case "migrated":
          return show({ kind: "done", outcome: "migrated", oldStackStopped: data.oldStackStopped });
        case "already_completed":
          return show({ kind: "done", outcome: data.outcome, oldStackStopped: null });
        case "cancelled":
          return show({ kind: "cancelled" });
        case "failed":
          // Nothing to move after all: main has re-detected; ask it what now.
          if (data.reason === "not_pending") return refreshRef.current();
          return show({
            kind: "failed",
            failure: {
              op: "migrate",
              reason: data.reason,
              message: data.message,
              requiredBytes: data.requiredBytes,
              availableBytes: data.availableBytes,
            },
          });
      }
    });
  }, [show]);

  const refresh = useCallback((): void => {
    show({ kind: "loading" });
    void window.vex.system.runtimeMigrationStatus().then((result) => {
      if (!result.ok) return show({ kind: "unreadable", message: result.error.message });
      const status = result.data;
      switch (status.kind) {
        case "not_needed":
          return show({ kind: "not_needed" });
        case "pending":
        case "pending_source_offline":
          return show({ kind: "pending", status });
        case "state_unreadable":
          return show({ kind: "unreadable", message: status.message });
        case "in_progress":
          if (status.op === "start_fresh") return startFresh();
          move();
          if (status.progress !== null) apply(status.progress);
          return;
      }
    });
  }, [apply, move, show, startFresh]);
  refreshRef.current = refresh;

  useEffect(() => {
    live.current = true;
    // Subscribe BEFORE asking: nothing replays across IPC.
    const off = window.vex.system.onRuntimeMigrationProgress(apply);
    refresh();
    return () => {
      live.current = false;
      off();
    };
  }, [apply, refresh]);

  return { screen, progress, refresh, move, startFresh };
}
