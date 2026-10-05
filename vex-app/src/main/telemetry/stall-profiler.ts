/**
 * Stall attribution for the Electron main process (FLC-8). DIAGNOSTIC ONLY:
 * nothing reads these lines to decide anything.
 *
 * WHY. K-5 (`./event-loop-delay.ts`) counts the main-thread freezes a click
 * would feel, and FLC-6 removed the vault KDF from them. Live desk orders
 * still show about nine freezes of about 300 ms per order cycle with no KDF
 * in them, and the logs around them do not say which code ran. A count cannot
 * name the code; a sampled call stack can.
 *
 * HOW. An in-process V8 CPU profiler (`node:inspector`, no port is opened)
 * samples the main thread every {@link STALL_PROFILER_SAMPLING_INTERVAL_US}.
 * Every {@link STALL_PROFILER_SEGMENT_MS} the profile is collected and
 * restarted, and each stretch of at least {@link STALL_PROFILER_MIN_RUN_MS}
 * in which the thread never went idle is logged as one `[event-loop-stall]`
 * line: its length, how much of it was garbage collection or native code, and
 * the deepest call path that held most of its samples.
 *
 * WHAT A LINE CARRIES. Numbers, plus code locations: function names and the
 * script's file name (or its path inside `node_modules`) with a line number.
 * A CPU profile holds no values, arguments or user data, and directory paths
 * are cut so no home directory reaches the log.
 *
 * Off in packaged builds; the caller passes `enabled`. The segment timer is
 * unref'd: the profiler never keeps the process alive. If collecting a
 * profile blocks this thread beyond its budget, attribution stops rather
 * than repeating a pause created by the diagnostic itself. The separate
 * event-loop-delay telemetry remains active.
 */

import { Session } from "node:inspector";

/**
 * FLC-8 switch. `true`: profile the main thread in development builds and
 * log each stall's call path. `false`: no profiler, no session.
 */
export const EVENT_LOOP_STALL_PROFILER = true;

/** False preserves continuous capture even when collection is expensive. */
export const EVENT_LOOP_STALL_PROFILER_OVERHEAD_GUARD = true;

/** Stop capture before collection becomes a recurring perceptible pause. */
export const STALL_PROFILER_COLLECTION_BUDGET_MS = 50;

/** Sampling interval of the CPU profiler, in microseconds. */
export const STALL_PROFILER_SAMPLING_INTERVAL_US = 1_000;

/** How long one profile runs before it is collected and restarted. */
export const STALL_PROFILER_SEGMENT_MS = 10_000;

/** A busy stretch at least this long (ms) is reported: K-5's stall threshold. */
export const STALL_PROFILER_MIN_RUN_MS = 100;

/** At most this many stall lines per segment; the rest are counted. */
export const STALL_PROFILER_MAX_LINES_PER_SEGMENT = 10;

/** Frames of the dominant call path written per line, deepest first. */
export const STALL_PROFILER_STACK_DEPTH = 10;

/** The part of a DevTools `Profiler.CallFrame` this module reads. */
export interface ProfileCallFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
}

/** The part of a DevTools `Profiler.ProfileNode` this module reads. */
export interface ProfileNode {
  readonly id: number;
  readonly callFrame: ProfileCallFrame;
  readonly children?: readonly number[];
}

/** The part of a DevTools `Profiler.Profile` this module reads. */
export interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

export interface StallAttribution {
  /** Start of the busy stretch, ms after the profile started. */
  readonly offsetMs: number;
  readonly durationMs: number;
  readonly samples: number;
  /** Share of samples in garbage collection, percent. */
  readonly gcPct: number;
  /** Share of samples in native code V8 cannot attribute, percent. */
  readonly programPct: number;
  /** Share of samples under the deepest frame of `path`, percent. */
  readonly pathPct: number;
  /** The dominant call path, deepest frame first, formatted. */
  readonly path: readonly string[];
}

const IDLE = "(idle)";
const GC = "(garbage collector)";
const PROGRAM = "(program)";
const ROOT = "(root)";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * A script location without its directories: the path inside `node_modules`
 * when there is one, otherwise the file name. Never a home directory.
 */
export function shortScriptName(url: string): string {
  if (url === "") return "";
  const clean = url.split(/[?#]/u)[0] ?? "";
  const marker = clean.lastIndexOf("node_modules/");
  if (marker >= 0) return clean.slice(marker + "node_modules/".length);
  if (clean.startsWith("node:")) return clean;
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

export function formatFrame(frame: ProfileCallFrame): string {
  const name = frame.functionName === "" ? "(anonymous)" : frame.functionName;
  const script = shortScriptName(frame.url);
  return script === "" ? name : `${name}@${script}:${frame.lineNumber + 1}`;
}

/**
 * Finds every stretch of at least `minRunMs` with no idle sample and names
 * what held it. Pure: the caller supplies the profile.
 */
export function findStalls(
  profile: CpuProfile,
  minRunMs: number = STALL_PROFILER_MIN_RUN_MS,
): StallAttribution[] {
  const byId = new Map<number, ProfileNode>();
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }
  const count = Math.min(profile.samples.length, profile.timeDeltas.length);
  const times: number[] = new Array<number>(count);
  let clock = profile.startTime;
  for (let i = 0; i < count; i += 1) {
    clock += profile.timeDeltas[i] ?? 0;
    times[i] = clock;
  }
  const isIdle = (i: number): boolean =>
    byId.get(profile.samples[i] ?? -1)?.callFrame.functionName === IDLE;

  const stalls: StallAttribution[] = [];
  let i = 0;
  while (i < count) {
    if (isIdle(i)) {
      i += 1;
      continue;
    }
    const first = i;
    while (i < count && !isIdle(i)) i += 1;
    const last = i - 1;
    // The stretch runs from the idle sample before it to the idle sample
    // after it (or the profile's own edges).
    const startedAt = first > 0 ? (times[first - 1] ?? profile.startTime) : profile.startTime;
    const endedAt = i < count ? (times[i] ?? profile.endTime) : profile.endTime;
    const durationUs = endedAt - startedAt;
    if (durationUs < minRunMs * 1_000) continue;
    stalls.push(attribute(profile, byId, parentOf, first, last, startedAt, durationUs));
  }
  return stalls;
}

function attribute(
  profile: CpuProfile,
  byId: ReadonlyMap<number, ProfileNode>,
  parentOf: ReadonlyMap<number, number>,
  first: number,
  last: number,
  startedAt: number,
  durationUs: number,
): StallAttribution {
  const inclusive = new Map<number, number>();
  let gc = 0;
  let program = 0;
  const samples = last - first + 1;
  for (let s = first; s <= last; s += 1) {
    const leaf = profile.samples[s] ?? -1;
    const name = byId.get(leaf)?.callFrame.functionName;
    if (name === GC) gc += 1;
    else if (name === PROGRAM) program += 1;
    let node: number | undefined = leaf;
    let guard = 0;
    while (node !== undefined && guard < 4_096) {
      inclusive.set(node, (inclusive.get(node) ?? 0) + 1);
      node = parentOf.get(node);
      guard += 1;
    }
  }
  // Descend from the root along the heaviest child while it still holds at
  // least half of the stretch's samples: the deepest frame that explains it.
  const root = profile.nodes.find((node) => node.callFrame.functionName === ROOT && !parentOf.has(node.id));
  const chain: ProfileNode[] = [];
  let current = root;
  while (current !== undefined) {
    let heaviest: ProfileNode | undefined;
    let heaviestCount = 0;
    for (const childId of current.children ?? []) {
      const childCount = inclusive.get(childId) ?? 0;
      if (childCount > heaviestCount) {
        heaviestCount = childCount;
        heaviest = byId.get(childId);
      }
    }
    if (heaviest === undefined || heaviestCount * 2 < samples) break;
    chain.push(heaviest);
    current = heaviest;
  }
  const deepest = chain[chain.length - 1];
  return {
    offsetMs: round1((startedAt - profile.startTime) / 1_000),
    durationMs: round1(durationUs / 1_000),
    samples,
    gcPct: pct(gc, samples),
    programPct: pct(program, samples),
    pathPct: deepest === undefined ? 0 : pct(inclusive.get(deepest.id) ?? 0, samples),
    path: chain
      .slice(-STALL_PROFILER_STACK_DEPTH)
      .reverse()
      .map((node) => formatFrame(node.callFrame)),
  };
}

export function formatStall(stall: StallAttribution): string {
  const path = stall.path.length === 0 ? "(mixed)" : stall.path.join(" <- ");
  return (
    `[event-loop-stall] ms=${stall.durationMs} samples=${stall.samples} ` +
    `gc=${stall.gcPct}% native=${stall.programPct}% path=${stall.pathPct}% ${path}`
  );
}

/** The `node:inspector` calls this module makes, so tests can drive it. */
export interface ProfilerSession {
  post(method: string, params?: Record<string, unknown>): Promise<unknown>;
  disconnect(): void;
}

export interface StallProfilerDeps {
  readonly connect: () => ProfilerSession;
  /** Runs `fn` every `ms` without keeping the process alive; returns a cancel. */
  readonly every: (fn: () => void, ms: number) => () => void;
  readonly log: (line: string) => void;
  readonly now: () => number;
  /** Defaults to EVENT_LOOP_STALL_PROFILER_OVERHEAD_GUARD. */
  readonly collectionGuard: boolean;
}

function connectInspector(): ProfilerSession {
  const session = new Session();
  session.connect();
  return {
    post: (method, params) =>
      new Promise((resolve, reject) => {
        session.post(method, params ?? {}, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      }),
    disconnect: () => session.disconnect(),
  };
}

function isCpuProfile(value: unknown): value is CpuProfile {
  if (typeof value !== "object" || value === null) return false;
  const nodes: unknown = Reflect.get(value, "nodes");
  const samples: unknown = Reflect.get(value, "samples");
  const timeDeltas: unknown = Reflect.get(value, "timeDeltas");
  return (
    Array.isArray(nodes) &&
    Array.isArray(samples) &&
    Array.isArray(timeDeltas) &&
    typeof Reflect.get(value, "startTime") === "number" &&
    typeof Reflect.get(value, "endTime") === "number"
  );
}

function profileOf(result: unknown): CpuProfile | null {
  if (typeof result !== "object" || result === null) return null;
  const profile: unknown = Reflect.get(result, "profile");
  return isCpuProfile(profile) ? profile : null;
}

/**
 * Starts the profiler and returns an idempotent stop. Disabled, it opens no
 * session. Any inspector failure logs once and turns the profiler off; it
 * never throws into the main process.
 */
export function startStallProfiler(options: {
  readonly log: StallProfilerDeps["log"];
  readonly enabled?: boolean;
  readonly deps?: Partial<StallProfilerDeps>;
}): () => void {
  if (!(options.enabled ?? EVENT_LOOP_STALL_PROFILER)) return () => undefined;
  const deps: StallProfilerDeps = {
    connect: connectInspector,
    every: (fn, ms) => {
      const handle = setInterval(fn, ms);
      handle.unref();
      return () => clearInterval(handle);
    },
    log: options.log,
    now: () => performance.now(),
    collectionGuard: EVENT_LOOP_STALL_PROFILER_OVERHEAD_GUARD,
    ...options.deps,
  };

  let session: ProfilerSession;
  try {
    session = deps.connect();
  } catch {
    deps.log("[event-loop-stall] profiler unavailable; attribution off");
    return () => undefined;
  }

  let stopped = false;
  let busy = false;
  let cancelSegment: () => void = () => undefined;

  const disconnect = (): void => {
    try {
      session.disconnect();
    } catch {
      // Already gone.
    }
  };

  const shutDown = (alreadyCollected = false): void => {
    if (stopped) return;
    stopped = true;
    cancelSegment();
    if (alreadyCollected) disconnect();
    else void session.post("Profiler.stop").catch(() => undefined).finally(disconnect);
  };

  const fail = (): void => {
    if (stopped) return;
    deps.log("[event-loop-stall] profiler failed; attribution off");
    shutDown();
  };

  const report = (profile: CpuProfile): void => {
    const stalls = findStalls(profile);
    for (const stall of stalls.slice(0, STALL_PROFILER_MAX_LINES_PER_SEGMENT)) {
      deps.log(formatStall(stall));
    }
    if (stalls.length > STALL_PROFILER_MAX_LINES_PER_SEGMENT) {
      deps.log(
        `[event-loop-stall] more=${stalls.length - STALL_PROFILER_MAX_LINES_PER_SEGMENT} in this segment`,
      );
    }
  };

  const rotate = (): void => {
    if (stopped || busy) return;
    busy = true;
    const started = deps.now();
    const collected = session.post("Profiler.stop");
    // Measure synchronous inspector work only. A delayed response alone
    // does not prove the profiler blocked the caller.
    const blockedMs = deps.now() - started;
    void collected
      .then(async (result) => {
        if (stopped) return;
        if (deps.collectionGuard && blockedMs > STALL_PROFILER_COLLECTION_BUDGET_MS) {
          deps.log(
            `[event-loop-stall] collectionBlockedMs=${round1(blockedMs)} ` +
            `budgetMs=${STALL_PROFILER_COLLECTION_BUDGET_MS}; attribution off`,
          );
          shutDown(true);
          return;
        }
        await session.post("Profiler.start");
        if (stopped) return;
        const profile = profileOf(result);
        if (profile !== null) report(profile);
      })
      .catch(fail)
      .finally(() => {
        busy = false;
      });
  };

  const initialize = async (): Promise<void> => {
    await session.post("Profiler.enable");
    if (stopped) return;
    await session.post("Profiler.setSamplingInterval", {
      interval: STALL_PROFILER_SAMPLING_INTERVAL_US,
    });
    if (stopped) return;
    await session.post("Profiler.start");
    if (stopped) return;
    deps.log(
      `[event-loop-stall] profiler on intervalUs=${STALL_PROFILER_SAMPLING_INTERVAL_US} ` +
        `segmentMs=${STALL_PROFILER_SEGMENT_MS} minMs=${STALL_PROFILER_MIN_RUN_MS}`,
    );
    cancelSegment = deps.every(rotate, STALL_PROFILER_SEGMENT_MS);
  };
  void initialize().catch(fail);

  return () => shutDown();
}
