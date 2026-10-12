/**
 * `SessionSleepBanner` — the "Vex is sleeping" state made visible.
 *
 * `loop_defer` parks a run as `paused_wake` for up to 24 hours. Without this
 * banner the operator saw nothing at all for that state and could not tell a
 * sleeping agent from a dead one. The banner's whole job is to say WHEN it
 * wakes and WHY it slept.
 *
 * Driven ENTIRELY by `pausedWake`'s presence, never by `status` alone: a
 * `paused_wake` run whose pending row is already claimed is no longer
 * sleeping, and a banner counting down to a wake that already fired is worse
 * than no banner.
 *
 * `reason` and `watchSummary` are display text — model-authored and
 * main-derived respectively. They are rendered as plain text, never parsed and
 * never used to drive behavior.
 *
 * Informational palette, not the destructive one used by `SessionErrorBanner`:
 * sleeping on purpose is not a failure.
 */

import { useEffect, useState, type JSX } from "react";
import { useRuntimeState } from "../../lib/api/runtime.js";
import { Swatch } from "../../components/ui/swatch.js";

const TICK_MS = 1_000;

/**
 * Wall-clock deadline in epoch ms, or `null` when the field is absent or
 * unparseable. An unreadable `dueAt` hides the banner rather than rendering
 * "Invalid Date" over a real financial run.
 */
function parseDueAtMs(dueAt: string | undefined): number | null {
  if (dueAt === undefined) return null;
  const ms = new Date(dueAt).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Remaining time in the operator's words. Rounded UP, so the last partial
 * minute is not silently lost, and never negative: the executor polls on its
 * own cadence, so a passed deadline means "imminent", not "overdue".
 */
function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "any moment now";
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function SessionSleepBanner({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element | null {
  const stateQuery = useRuntimeState(sessionId);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const result = stateQuery.data;
  const pausedWake = result?.ok === true ? result.data.pausedWake : undefined;
  const dueAtMs = parseDueAtMs(pausedWake?.dueAt);

  // Re-derived from the deadline on every tick rather than decremented, so a
  // suspended laptop or a long-idle window still shows the truth on the next
  // tick. The interval exists only while there is a deadline to count to.
  useEffect(() => {
    if (dueAtMs === null) return;
    // Resync BEFORE the first tick. The component can sit mounted for hours
    // with nothing to show, so a `now` captured at mount would make the first
    // paint of a freshly-arrived wake report the age of the window.
    setNowMs(Date.now());
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [dueAtMs]);

  if (pausedWake === undefined || dueAtMs === null) return null;

  const dueAt = new Date(dueAtMs);
  const wakeAt = dueAt.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  // `break-words` on the container: `reason` is model-authored (up to 500
  // chars) and can carry an unbroken token — a mint address, a URL — that
  // would otherwise push the session column wider than its container.
  return (
    <div
      data-testid="session-sleep-banner"
      data-vex-area="session-sleep-banner"
      className="mb-3 w-full break-words border border-rule px-3.5 py-2.5"
    >
      <p className="flex items-center gap-[9px] font-mono text-[11px] uppercase leading-none tracking-status text-ink-secondary">
        <span aria-hidden className="inline-flex text-accent-primary">
          <Swatch state="draft" size={9} />
        </span>
        Vex went to sleep
      </p>
      <p className="mt-1.5 text-[13px] leading-5 text-ink-primary">
        Wakes at {wakeAt} - {formatRemaining(dueAtMs - nowMs)}
      </p>
      {pausedWake.reason !== null ? (
        <p className="mt-1 text-[13px] leading-5 text-ink-secondary">{pausedWake.reason}</p>
      ) : null}
      {pausedWake.watchSummary !== null ? (
        <p className="mt-1 font-mono text-[11px] tracking-[0.02em] text-ink-secondary">
          {pausedWake.watchSummary}
        </p>
      ) : null}
    </div>
  );
}
