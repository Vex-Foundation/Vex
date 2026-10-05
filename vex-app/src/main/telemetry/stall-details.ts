/**
 * Cheap stall timing and correlation. No stacks, arguments or provider values.
 * ELU measures event-loop activity, including synchronous native waits. It is
 * not CPU utilization. GC observations are a bounded best-effort overlap, not
 * proof that an unobserved GC did not occur. Detailed lines share a rate cap;
 * the existing minute counter still records every detected stall.
 */
import { constants, performance, PerformanceObserver } from "node:perf_hooks";

export const EVENT_LOOP_STALL_DETAILS = true;
export const MAIN_THREAD_SLOW_STAGES = true;
export const STALL_DETAIL_LIMIT = 10;
export const STALL_DETAIL_WINDOW_MS = 60_000;
export const STALL_DETAIL_GC_LIMIT = 64;
const THRESHOLD_MS = 100;
const DELIVERY_GRACE_MS = 1_000;
const GC_KINDS: ReadonlySet<number> = new Set([
  0, // Unknown kind when the runtime does not provide detail.
  constants.NODE_PERFORMANCE_GC_MINOR,
  constants.NODE_PERFORMANCE_GC_MAJOR,
  constants.NODE_PERFORMANCE_GC_INCREMENTAL,
  constants.NODE_PERFORMANCE_GC_WEAKCB,
]);

type Stage = "dexscreener_window_create" | "lighter_public_frame";
interface Utilization { readonly active: number; readonly idle: number }
export interface GcSample {
  readonly startTime: number;
  readonly duration: number;
  readonly kind: number;
}
export interface StallDetailsDeps {
  readonly now: () => number;
  readonly wallNow: () => number;
  readonly utilization: () => Utilization;
  readonly observeGc: (record: (sample: GcSample) => void) => () => void;
  readonly slowStages: boolean;
}
const round = (value: number): number => Math.round(value * 100) / 100;
const valid = (value: number): boolean => Number.isFinite(value) && value >= 0;
let stageMeasure: (<T>(stage: Stage, run: () => T) => T) | undefined;

/** The scope is the synchronous callback, including any synchronous listeners. */
export function measureMainThreadStage<T>(stage: Stage, run: () => T): T {
  return stageMeasure === undefined ? run() : stageMeasure(stage, run);
}

function observeGc(record: (sample: GcSample) => void): () => void {
  const observer = new PerformanceObserver((list) => {
    try {
      for (const entry of list.getEntries()) {
        const detail: unknown = "detail" in entry ? entry.detail : undefined;
        const kind = typeof detail === "object" && detail !== null && "kind" in detail
          && typeof detail.kind === "number" ? detail.kind : 0;
        record({ startTime: entry.startTime, duration: entry.duration, kind });
      }
    } catch { /* Observer delivery cannot become an uncaught error. */ }
  });
  observer.observe({ entryTypes: ["gc"] });
  return () => observer.disconnect();
}

export function startStallDetails(options: {
  readonly log: (line: string) => void;
  readonly enabled?: boolean;
  readonly deps?: Partial<StallDetailsDeps>;
}): { readonly tick: () => void; readonly stop: () => void } {
  if (!(options.enabled ?? EVENT_LOOP_STALL_DETAILS)) {
    return { tick: () => undefined, stop: () => undefined };
  }
  const deps: StallDetailsDeps = {
    now: () => performance.now(), wallNow: Date.now,
    utilization: () => performance.eventLoopUtilization(), observeGc,
    slowStages: MAIN_THREAD_SLOW_STAGES, ...options.deps,
  };
  let stopped = false;
  let gc: GcSample[] = [];
  let gcDropped = 0;
  let gcObserved = false;
  const pending: Array<{ start: number; end: number; wall: number; late: number; active: number; idle: number; eluAvailable: boolean }> = [];
  let last: number;
  let previous: Utilization;
  try {
    last = deps.now();
    previous = deps.utilization();
    if (!valid(last) || !valid(previous.active) || !valid(previous.idle)) throw new Error("invalid timing");
  } catch {
    return { tick: () => undefined, stop: () => undefined };
  }
  let budgetStart = last;
  let emitted = 0;
  const log = (line: string): void => {
    try { options.log(line); } catch { /* Diagnostics cannot affect app behavior. */ }
  };
  const admitted = (now: number): boolean => {
    if (now - budgetStart >= STALL_DETAIL_WINDOW_MS) { budgetStart = now; emitted = 0; }
    if (emitted >= STALL_DETAIL_LIMIT) return false;
    emitted += 1;
    return true;
  };
  let disconnectGc = (): void => undefined;
  try {
    disconnectGc = deps.observeGc((sample) => {
      try {
        if (stopped || !valid(sample.startTime) || !valid(sample.duration) || !GC_KINDS.has(sample.kind)) return;
        gc.push(sample);
        if (gc.length > STALL_DETAIL_GC_LIMIT) { gc.shift(); gcDropped += 1; }
      } catch { /* Malformed observations cannot escape asynchronous delivery. */ }
    });
    gcObserved = true;
  } catch { /* Timing still works without GC observations. */ }
  const measure = <T>(stage: Stage, run: () => T): T => {
    let start: number | undefined;
    try { start = deps.now(); } catch { /* Run the operation even when timing fails. */ }
    try { return run(); } finally {
      try {
        const end = deps.now();
        if (!stopped && start !== undefined && end - start >= THRESHOLD_MS && admitted(end)) {
          log(`[main-thread-stage] stage=${stage} blockedMs=${round(end - start)} observedAtMs=${deps.wallNow()}`);
        }
      } catch { /* Preserve the operation's value or error. */ }
    }
  };
  if (deps.slowStages) stageMeasure = measure;
  return {
    tick: () => {
      if (stopped) return;
      try {
        const now = deps.now();
        const current = deps.utilization();
        if (!valid(now) || !valid(current.active) || !valid(current.idle)) return;
        const late = now - last - 50;
        if (late >= THRESHOLD_MS && pending.length < STALL_DETAIL_LIMIT) {
          pending.push({ start: last, end: now, wall: deps.wallNow(), late,
            active: Math.max(0, current.active - previous.active), idle: Math.max(0, current.idle - previous.idle),
            eluAvailable: current.active > previous.active || current.idle > previous.idle });
        }
        last = now;
        previous = current;
        while (pending[0] !== undefined && now - pending[0].end >= DELIVERY_GRACE_MS) {
          const sample = pending.shift();
          if (sample === undefined || !admitted(now)) continue;
          const matches = gc.filter((entry) => entry.startTime < sample.end && entry.startTime + entry.duration > sample.start);
          const gcMs = matches.reduce((sum, entry) => sum + Math.max(0,
            Math.min(entry.startTime + entry.duration, sample.end) - Math.max(entry.startTime, sample.start)), 0);
          const kinds = [...new Set(matches.map((entry) => entry.kind))].sort().join(",") || "none";
          log(`[event-loop-stall-detail] observedAtMs=${sample.wall} lateMs=${round(sample.late)} ` +
            `intervalMs=${round(sample.end - sample.start)} activeMs=${round(sample.active)} idleMs=${round(sample.idle)} eluAvailable=${sample.eluAvailable ? 1 : 0} ` +
            `gcMs=${round(gcMs)} gcCount=${matches.length} gcKinds=${kinds} gcObserved=${gcObserved ? 1 : 0} gcDropped=${gcDropped}`);
        }
        const keepAfter = pending[0]?.start ?? now - DELIVERY_GRACE_MS;
        gc = gc.filter((entry) => entry.startTime + entry.duration >= keepAfter);
      } catch { /* A clock or observer failure must never escape the timer. */ }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (stageMeasure === measure) stageMeasure = undefined;
      pending.length = 0;
      gc = [];
      try { disconnectGc(); } catch { /* Disposal remains idempotent. */ }
    },
  };
}
