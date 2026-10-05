/** FLC-8: stall attribution from a sampled main-thread call stack. */

import { describe, expect, it } from "vitest";

import {
  EVENT_LOOP_STALL_PROFILER,
  EVENT_LOOP_STALL_PROFILER_OVERHEAD_GUARD,
  STALL_PROFILER_COLLECTION_BUDGET_MS,
  STALL_PROFILER_MAX_LINES_PER_SEGMENT,
  STALL_PROFILER_MIN_RUN_MS,
  STALL_PROFILER_SAMPLING_INTERVAL_US,
  STALL_PROFILER_SEGMENT_MS,
  findStalls,
  formatFrame,
  formatStall,
  shortScriptName,
  startStallProfiler,
  type CpuProfile,
  type ProfileNode,
  type ProfilerSession,
  type StallProfilerDeps,
} from "../stall-profiler.js";

const APP = "file:///Users/alice/Documents/projects/Vex/vex-app/dist/main/index.js";

function frame(id: number, functionName: string, children: number[] = [], url = "", lineNumber = 0): ProfileNode {
  return { id, callFrame: { functionName, url, lineNumber }, children };
}

/**
 * root(1) -> idle(2), program(3), gc(4), main(5) -> handler(6) -> parse(7)
 *                                              -> other(8)
 */
const NODES: readonly ProfileNode[] = [
  frame(1, "(root)", [2, 3, 4, 5]),
  frame(2, "(idle)"),
  frame(3, "(program)"),
  frame(4, "(garbage collector)"),
  frame(5, "runMain", [6, 8], APP, 99),
  frame(6, "handleDeskAction", [7], APP, 1_233),
  frame(7, "parseAccountSnapshot", [], `${APP.replace("dist/main/index.js", "node_modules/pg/lib/client.js")}`, 41),
  frame(8, "otherWork", [], APP, 500),
];

/** Builds a profile from runs of [nodeId, count], one sample per millisecond. */
function profileOf(runs: ReadonlyArray<readonly [number, number]>): CpuProfile {
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  for (const [node, n] of runs) {
    for (let i = 0; i < n; i += 1) {
      samples.push(node);
      timeDeltas.push(1_000);
    }
  }
  return { nodes: NODES, startTime: 0, endTime: samples.length * 1_000, samples, timeDeltas };
}

describe("FLC-8 switch and constants", () => {
  it("is on, samples every millisecond and reports K-5's stall threshold", () => {
    expect(EVENT_LOOP_STALL_PROFILER).toBe(true);
    expect(EVENT_LOOP_STALL_PROFILER_OVERHEAD_GUARD).toBe(true);
    expect(STALL_PROFILER_COLLECTION_BUDGET_MS).toBeLessThan(STALL_PROFILER_MIN_RUN_MS);
    expect(STALL_PROFILER_SAMPLING_INTERVAL_US).toBe(1_000);
    expect(STALL_PROFILER_SEGMENT_MS).toBe(10_000);
    expect(STALL_PROFILER_MIN_RUN_MS).toBe(100);
  });
});

describe("code locations without directories", () => {
  it("keeps the file name, or the path inside node_modules, and never a home directory", () => {
    expect(shortScriptName(APP)).toBe("index.js");
    expect(shortScriptName("file:///Users/alice/x/node_modules/pg/lib/client.js?v=1")).toBe("pg/lib/client.js");
    expect(shortScriptName("node:internal/perf/performance")).toBe("node:internal/perf/performance");
    expect(shortScriptName("")).toBe("");
  });

  it("formats named, anonymous and native frames", () => {
    expect(formatFrame({ functionName: "f", url: APP, lineNumber: 9 })).toBe("f@index.js:10");
    expect(formatFrame({ functionName: "", url: APP, lineNumber: 0 })).toBe("(anonymous)@index.js:1");
    expect(formatFrame({ functionName: "(garbage collector)", url: "", lineNumber: -1 })).toBe("(garbage collector)");
  });
});

describe("findStalls", () => {
  it("names the deepest frame that held most of a busy stretch", () => {
    const stalls = findStalls(profileOf([[2, 50], [7, 150], [4, 20], [6, 10], [2, 50]]));
    expect(stalls).toHaveLength(1);
    const stall = stalls[0];
    expect(stall?.durationMs).toBe(181);
    expect(stall?.samples).toBe(180);
    // From the last idle sample before it (50 ms) to the first after it (231 ms).
    expect(stall?.offsetMs).toBe(50);
    expect(stall?.gcPct).toBe(11);
    expect(stall?.programPct).toBe(0);
    expect(stall?.path).toEqual([
      "parseAccountSnapshot@pg/lib/client.js:42",
      "handleDeskAction@index.js:1234",
      "runMain@index.js:100",
    ]);
    expect(stall?.pathPct).toBe(83);
  });

  it("ignores busy stretches shorter than the threshold", () => {
    expect(findStalls(profileOf([[2, 50], [7, 60], [2, 50], [8, 80], [2, 10]]))).toEqual([]);
  });

  it("reports a stretch that runs to the end of the profile", () => {
    const stalls = findStalls(profileOf([[2, 10], [8, 120]]));
    expect(stalls).toHaveLength(1);
    // From the last idle sample (10 ms) to the end of the profile (130 ms).
    expect(stalls[0]?.durationMs).toBe(120);
    expect(stalls[0]?.path).toEqual(["otherWork@index.js:501", "runMain@index.js:100"]);
  });

  it("says a stretch is GC when garbage collection held it", () => {
    const stall = findStalls(profileOf([[2, 5], [4, 140], [8, 20], [2, 5]]))[0];
    expect(stall?.gcPct).toBe(88);
    expect(stall?.path).toEqual(["(garbage collector)"]);
  });

  it("stops the path where no single frame holds half the stretch", () => {
    const stall = findStalls(profileOf([[2, 5], [3, 60], [4, 50], [8, 40], [2, 5]]))[0];
    expect(stall?.path).toEqual([]);
    expect(formatStall(stall ?? { offsetMs: 0, durationMs: 0, samples: 0, gcPct: 0, programPct: 0, pathPct: 0, path: [] })).toContain(
      "(mixed)",
    );
  });

  it("formats a numbers-and-code-locations line with no directory in it", () => {
    const stall = findStalls(profileOf([[2, 50], [7, 150], [2, 50]]))[0];
    const line = formatStall(stall ?? { offsetMs: 0, durationMs: 0, samples: 0, gcPct: 0, programPct: 0, pathPct: 0, path: [] });
    expect(line).toBe(
      "[event-loop-stall] ms=151 samples=150 gc=0% native=0% path=100% " +
        "parseAccountSnapshot@pg/lib/client.js:42 <- handleDeskAction@index.js:1234 <- runMain@index.js:100",
    );
    expect(line).not.toContain("/Users/");
  });
});

interface FakeSession extends ProfilerSession {
  readonly posts: string[];
  disconnected: number;
}

function fakeSession(profiles: CpuProfile[], failOn?: string): FakeSession {
  const session: FakeSession = {
    posts: [],
    disconnected: 0,
    post: (method, params) => {
      session.posts.push(params === undefined ? method : `${method} ${JSON.stringify(params)}`);
      if (method === failOn) return Promise.reject(new Error("inspector refused"));
      if (method === "Profiler.stop") return Promise.resolve({ profile: profiles.shift() });
      return Promise.resolve({});
    },
    disconnect: () => {
      session.disconnected += 1;
    },
  };
  return session;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function harness(session: FakeSession, overrides: Partial<StallProfilerDeps> = {}): {
  lines: string[];
  tick: () => void;
  cancelled: () => boolean;
  stop: () => void;
} {
  const lines: string[] = [];
  let segment: (() => void) | null = null;
  let cancelled = false;
  const stop = startStallProfiler({
    enabled: true,
    log: (line) => lines.push(line),
    deps: {
      connect: () => session,
      every: (fn, ms) => {
        expect(ms).toBe(STALL_PROFILER_SEGMENT_MS);
        segment = fn;
        return () => {
          cancelled = true;
        };
      },
      ...overrides,
    },
  });
  return { lines, tick: () => segment?.(), cancelled: () => cancelled, stop };
}

describe("startStallProfiler", () => {
  it("opens nothing when disabled", () => {
    let connects = 0;
    const stop = startStallProfiler({
      enabled: false,
      log: () => undefined,
      deps: {
        connect: () => {
          connects += 1;
          return fakeSession([]);
        },
      },
    });
    stop();
    expect(connects).toBe(0);
  });

  it("starts at 1 ms sampling and logs each segment's stalls", async () => {
    const session = fakeSession([profileOf([[2, 50], [7, 150], [2, 50]])]);
    const h = harness(session);
    await settle();
    expect(session.posts).toEqual([
      "Profiler.enable",
      'Profiler.setSamplingInterval {"interval":1000}',
      "Profiler.start",
    ]);
    expect(h.lines).toEqual(["[event-loop-stall] profiler on intervalUs=1000 segmentMs=10000 minMs=100"]);
    h.tick();
    await settle();
    expect(session.posts.slice(3)).toEqual(["Profiler.stop", "Profiler.start"]);
    expect(h.lines[1]).toMatch(/^\[event-loop-stall\] ms=151 .* parseAccountSnapshot@pg\/lib\/client\.js:42 /u);
    h.stop();
  });

  it("caps the lines per segment and counts the rest", async () => {
    const runs: Array<readonly [number, number]> = [[2, 5]];
    for (let i = 0; i < STALL_PROFILER_MAX_LINES_PER_SEGMENT + 3; i += 1) runs.push([8, 110], [2, 5]);
    const session = fakeSession([profileOf(runs)]);
    const h = harness(session);
    await settle();
    h.tick();
    await settle();
    const stallLines = h.lines.filter((line) => line.startsWith("[event-loop-stall] ms="));
    expect(stallLines).toHaveLength(STALL_PROFILER_MAX_LINES_PER_SEGMENT);
    expect(h.lines[h.lines.length - 1]).toBe("[event-loop-stall] more=3 in this segment");
    h.stop();
  });

  it("logs once and switches off when the inspector fails, never throwing", async () => {
    const session = fakeSession([], "Profiler.start");
    const h = harness(session);
    await settle();
    expect(h.lines).toEqual(["[event-loop-stall] profiler failed; attribution off"]);
    h.tick();
    await settle();
    expect(session.disconnected).toBe(1);
    h.stop();
    expect(session.disconnected).toBe(1);
  });

  it("logs once when no session can be opened", () => {
    const lines: string[] = [];
    const stop = startStallProfiler({
      enabled: true,
      log: (line) => lines.push(line),
      deps: {
        connect: () => {
          throw new Error("no inspector");
        },
      },
    });
    stop();
    expect(lines).toEqual(["[event-loop-stall] profiler unavailable; attribution off"]);
  });

  it("stops idempotently: segment timer cancelled, profiler stopped, session closed", async () => {
    const session = fakeSession([]);
    const h = harness(session);
    await settle();
    h.stop();
    h.stop();
    await settle();
    expect(h.cancelled()).toBe(true);
    expect(session.posts.filter((post) => post === "Profiler.stop")).toHaveLength(1);
    expect(session.disconnected).toBe(1);
  });

  it("ignores a profile it cannot read", async () => {
    const session = fakeSession([]);
    const h = harness(session);
    await settle();
    h.tick();
    await settle();
    expect(h.lines).toHaveLength(1);
    h.stop();
  });

  it("stops expensive collection once without collecting or restarting again", async () => {
    const session = fakeSession([profileOf([[2, 50], [7, 150], [2, 50]])]);
    let time = 0;
    const h = harness(session, {
      now: () => { const value = time; time += 150; return value; },
    });
    await settle();
    h.tick();
    await settle();
    expect(h.lines[1]).toBe("[event-loop-stall] collectionBlockedMs=150 budgetMs=50; attribution off");
    expect(h.cancelled()).toBe(true);
    expect(session.disconnected).toBe(1);
    expect(session.posts.filter((post) => post === "Profiler.stop")).toHaveLength(1);
    expect(session.posts.filter((post) => post === "Profiler.start")).toHaveLength(1);
    h.tick();
    h.stop();
    await settle();
    expect(session.posts.filter((post) => post === "Profiler.stop")).toHaveLength(1);
    expect(h.lines).toHaveLength(2);
  });

  it("keeps the prior continuous capture path when the collection guard is off", async () => {
    const session = fakeSession([profileOf([[2, 50], [7, 150], [2, 50]])]);
    let time = 0;
    const h = harness(session, {
      collectionGuard: false,
      now: () => { const value = time; time += 150; return value; },
    });
    await settle();
    h.tick();
    await settle();
    expect(h.cancelled()).toBe(false);
    expect(session.posts.filter((post) => post === "Profiler.start")).toHaveLength(2);
    expect(h.lines[1]).toContain("parseAccountSnapshot@pg/lib/client.js");
    h.stop();
  });

  it.each([{ cost: 50, stopped: false }, { cost: 50.1, stopped: true }])("enforces the collection budget at $cost ms", async ({ cost, stopped }) => {
    const session = fakeSession([]);
    let time = 0;
    const h = harness(session, {
      now: () => { const value = time; time += cost; return value; },
    });
    await settle();
    h.tick();
    await settle();
    expect(h.cancelled()).toBe(stopped);
    h.stop();
    await settle();
  });

  it("does not treat waiting for an asynchronous response as synchronous collection cost", async () => {
    const session = fakeSession([]);
    let deliver: (value: unknown) => void = () => undefined;
    const priorPost = session.post;
    session.post = (method, params) => {
      if (method !== "Profiler.stop") return priorPost(method, params);
      session.posts.push(method);
      return new Promise((resolve) => { deliver = resolve; });
    };
    let time = 0;
    const h = harness(session, { now: () => time });
    await settle();
    h.tick();
    time = 1_000;
    deliver({ profile: profileOf([[2, 50], [7, 150], [2, 50]]) });
    await settle();
    expect(h.cancelled()).toBe(false);
    expect(session.posts.filter((post) => post === "Profiler.start")).toHaveLength(2);
    h.stop();
    deliver({});
    await settle();
  });

  it.each(["Profiler.enable", "Profiler.setSamplingInterval"])("cannot start after shutdown during %s", async (heldMethod) => {
    const session = fakeSession([]);
    let release: (value: unknown) => void = () => undefined;
    const priorPost = session.post;
    session.post = (method, params) => {
      if (method !== heldMethod) return priorPost(method, params);
      session.posts.push(method);
      return new Promise((resolve) => { release = resolve; });
    };
    const h = harness(session);
    await settle();
    h.stop();
    release({});
    await settle();
    expect(session.posts).not.toContain("Profiler.start");
    expect(session.disconnected).toBe(1);
    expect(h.lines).toEqual([]);
  });

  it("does not restart after shutdown during a pending rotation", async () => {
    const session = fakeSession([]);
    let release: (value: unknown) => void = () => undefined;
    const priorPost = session.post;
    let stops = 0;
    session.post = (method, params) => {
      if (method !== "Profiler.stop" || ++stops !== 1) return priorPost(method, params);
      session.posts.push(method);
      return new Promise((resolve) => { release = resolve; });
    };
    const h = harness(session);
    await settle();
    h.tick();
    h.stop();
    release({ profile: profileOf([[2, 50], [7, 150], [2, 50]]) });
    await settle();
    expect(session.posts.filter((post) => post === "Profiler.start")).toHaveLength(1);
    expect(h.lines).toHaveLength(1);
  });

  it("does not report a profile after shutdown during a pending restart", async () => {
    const session = fakeSession([profileOf([[2, 50], [7, 150], [2, 50]])]);
    let release: (value: unknown) => void = () => undefined;
    let starts = 0;
    const priorPost = session.post;
    session.post = (method, params) => {
      if (method !== "Profiler.start" || ++starts !== 2) return priorPost(method, params);
      session.posts.push(method);
      return new Promise((resolve) => { release = resolve; });
    };
    const h = harness(session);
    await settle();
    h.tick();
    await settle();
    h.stop();
    release({});
    await settle();
    expect(h.lines).toHaveLength(1);
    expect(session.disconnected).toBe(1);
  });

  it("disconnects once if collection rejects, including after expensive submission", async () => {
    const session = fakeSession([], "Profiler.stop");
    let time = 0;
    const h = harness(session, {
      now: () => { const value = time; time += 150; return value; },
    });
    await settle();
    h.tick();
    await settle();
    h.tick();
    h.stop();
    await settle();
    expect(h.lines[1]).toBe("[event-loop-stall] profiler failed; attribution off");
    expect(h.lines).toHaveLength(2);
    expect(h.cancelled()).toBe(true);
    expect(session.disconnected).toBe(1);
  });
});
