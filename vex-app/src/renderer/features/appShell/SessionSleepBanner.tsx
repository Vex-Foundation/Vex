/**
 * `SessionSleepBanner` - the "Vex is sleeping" state made visible.
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
 * `reason` and `watchSummary` are display text - model-authored and
 * main-derived respectively. They are rendered as plain text, never parsed and
 * never used to drive behavior.
 *
 * Quiet ink on paper with the sleeping swatch (a dotted outline), not the
 * treatment `SessionErrorBanner` uses: sleeping on purpose is not a failure.
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
  // chars) and can carry an unbroken token (a mint address, a URL) that
  // would otherwise push the session column wider than its container.
  // No `role="status"`: the countdown ticks every second and would announce
  // each tick.
  return (
    <div
      data-testid="session-sleep-banner"
      data-vex-area="session-sleep-banner"
      className="mb-3 grid w-full grid-cols-[22px_1fr] items-start gap-x-2.5 gap-y-0.5 break-words border border-rule bg-surface-base px-4 py-3.5"
    >
      <span aria-hidden className="mt-[5px] inline-flex text-accent-primary">
        <Swatch state="sleeping" size={10} />
      </span>
      <p className="text-[15px] font-medium leading-6 text-ink-primary">Vex went to sleep</p>
      <p className="col-start-2 text-[14px] leading-[1.5] text-ink-secondary">
        Wakes at <span className="font-mono vex-num">{wakeAt}</span> - {formatRemaining(dueAtMs - nowMs)}
        {pausedWake.reason !== null ? ` · ${pausedWake.reason}` : null}
      </p>
      {pausedWake.watchSummary !== null ? (
        <p className="col-start-2 mt-1 text-[12.5px] leading-5 text-ink-tertiary">
          Watching: <span className="font-mono vex-num">{pausedWake.watchSummary}</span>
        </p>
      ) : null}
    </div>
  );
}
