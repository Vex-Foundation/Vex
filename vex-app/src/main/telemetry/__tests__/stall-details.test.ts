import { afterEach, describe, expect, it } from "vitest";
import {
  EVENT_LOOP_STALL_DETAILS, MAIN_THREAD_SLOW_STAGES, STALL_DETAIL_GC_LIMIT,
  measureMainThreadStage, startStallDetails, type GcSample,
} from "../stall-details.js";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
function harness(overrides: { observeFailure?: boolean; slowStages?: boolean; sinkFailure?: boolean } = {}) {
  let now = 0;
  let active = 0;
  let idle = 0;
  let disconnected = 0;
  let recordGc: (sample: GcSample) => void = () => undefined;
  const lines: string[] = [];
  const details = startStallDetails({
    log: (line) => { if (overrides.sinkFailure) throw new Error("sink"); lines.push(line); },
    deps: {
      now: () => now, wallNow: () => 1_800_000_000_000 + now,
      utilization: () => ({ active, idle }), slowStages: overrides.slowStages ?? true,
      observeGc: (record) => {
        if (overrides.observeFailure) throw new Error("observer");
        recordGc = record;
        return () => { disconnected += 1; };
      },
    },
  });
  stops.push(details.stop);
  return { lines, details, gc: (sample: GcSample) => recordGc(sample),
    set: (time: number, busy = time, waiting = 0) => { now = time; active = busy; idle = waiting; },
    disconnects: () => disconnected };
}

describe("cheap main-thread diagnostics", () => {
  it("has named default-on switches and does nothing when disabled", () => {
    expect(EVENT_LOOP_STALL_DETAILS).toBe(true);
    expect(MAIN_THREAD_SLOW_STAGES).toBe(true);
    const disabled = startStallDetails({ enabled: false, log: () => { throw new Error("unused"); },
      deps: { now: () => { throw new Error("unused"); } } });
    expect(() => { disabled.tick(); disabled.stop(); }).not.toThrow();
  });
  it("delays delivery to include GC callbacks and keeps exact observation time", () => {
    const h = harness();
    h.set(250, 200, 50); h.details.tick();
    expect(h.lines).toEqual([]);
    h.gc({ startTime: 100, duration: 80, kind: 4 });
    h.set(1250, 200, 1050); h.details.tick();
    expect(h.lines[0]).toBe("[event-loop-stall-detail] observedAtMs=1800000000250 lateMs=200 intervalMs=250 activeMs=200 idleMs=50 eluAvailable=1 gcMs=80 gcCount=1 gcKinds=4 gcObserved=1 gcDropped=0");
  });
  it("clips GC overlap and rejects invalid observations", () => {
    const h = harness();
    h.set(50); h.details.tick(); h.set(200); h.details.tick();
    h.gc({ startTime: 25, duration: 50, kind: 1 });
    h.gc({ startTime: 190, duration: 40, kind: 4 });
    h.gc({ startTime: 0, duration: Number.NaN, kind: 4 });
    h.gc({ startTime: 0, duration: 300, kind: 999 });
    h.set(1200); h.details.tick();
    expect(h.lines[0]).toContain("lateMs=100 intervalMs=150");
    expect(h.lines[0]).toContain("gcMs=35 gcCount=2 gcKinds=1,4");
  });
  it("marks unavailable ELU rather than interpreting zero as an idle interval", () => {
    const h = harness(); h.set(250, 0, 0); h.details.tick(); h.set(1250, 0, 0); h.details.tick();
    expect(h.lines[0]).toContain("activeMs=0 idleMs=0 eluAvailable=0");
  });
  it("ignores ticks below threshold", () => {
    const h = harness();
    for (let now = 149; now < 2000; now += 149) { h.set(now); h.details.tick(); }
    expect(h.lines).toEqual([]);
  });
  it("bounds GC storage and pending deliveries", () => {
    const h = harness();
    for (let i = 0; i < 200; i += 1) h.gc({ startTime: 100, duration: 1, kind: 1 });
    h.set(250); h.details.tick(); h.set(1250); h.details.tick();
    expect(h.lines[0]).toContain(`gcCount=${STALL_DETAIL_GC_LIMIT} `);
    expect(h.lines[0]).toContain("gcDropped=136");
    for (let i = 2; i < 40; i += 1) { h.set(i * 1250); h.details.tick(); }
    expect(h.lines).toHaveLength(10);
  });
  it("renews the shared detail and stage rate limit", () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      measureMainThreadStage("lighter_public_frame", () => { h.set((i + 1) * 200); });
    }
    expect(h.lines).toHaveLength(10);
    h.set(60_000);
    measureMainThreadStage("lighter_public_frame", () => { h.set(60_200); });
    expect(h.lines).toHaveLength(11);
  });
  it("preserves values and errors from slow synchronous operations", () => {
    const h = harness();
    expect(measureMainThreadStage("dexscreener_window_create", () => { h.set(100); return 7; })).toBe(7);
    const failure = new Error("operation");
    expect(() => measureMainThreadStage("lighter_public_frame", () => { h.set(300); throw failure; })).toThrow(failure);
    expect(h.lines).toEqual([
      "[main-thread-stage] stage=dexscreener_window_create blockedMs=100 observedAtMs=1800000000100",
      "[main-thread-stage] stage=lighter_public_frame blockedMs=200 observedAtMs=1800000000300",
    ]);
  });
  it("supports the slow-stage rollback independently", () => {
    const h = harness({ slowStages: false });
    measureMainThreadStage("lighter_public_frame", () => { h.set(250); });
    expect(h.lines).toEqual([]);
    h.details.tick(); h.set(1250); h.details.tick();
    expect(h.lines[0]).toContain("[event-loop-stall-detail]");
  });
  it("survives observer and sink failures", () => {
    const h = harness({ observeFailure: true, sinkFailure: true });
    expect(() => measureMainThreadStage("lighter_public_frame", () => { h.set(200); })).not.toThrow();
    h.details.tick(); h.set(1250);
    expect(() => h.details.tick()).not.toThrow();
  });
  it("disconnects once and drops pending records on stop", () => {
    const h = harness(); h.set(200); h.details.tick();
    h.details.stop(); h.details.stop();
    h.gc({ startTime: 0, duration: 100, kind: 4 });
    h.set(2000); h.details.tick();
    measureMainThreadStage("lighter_public_frame", () => { h.set(2200); });
    expect(h.lines).toEqual([]); expect(h.disconnects()).toBe(1);
  });
  it("fails open when initial clocks or later clock reads fail", () => {
    expect(() => startStallDetails({ log: () => undefined,
      deps: { now: () => { throw new Error("clock"); } } })).not.toThrow();
    let now = 0;
    const details = startStallDetails({ log: () => { throw new Error("sink"); }, deps: {
      now: () => { if (now < 0) throw new Error("clock"); return now; },
      observeGc: () => () => { throw new Error("dispose"); },
    } });
    stops.push(details.stop);
    now = -1;
    expect(measureMainThreadStage("lighter_public_frame", () => 7)).toBe(7);
    expect(() => { details.tick(); details.stop(); details.stop(); }).not.toThrow();
  });
  it("contains malformed asynchronous observations and stop during a callback", () => {
    const h = harness();
    const sample: GcSample = { get startTime(): number { throw new Error("observation"); }, duration: 1, kind: 4 };
    expect(() => h.gc(sample)).not.toThrow();
    expect(measureMainThreadStage("lighter_public_frame", () => { h.details.stop(); h.set(200); return 3; })).toBe(3);
    expect(h.lines).toEqual([]);
  });
  it("an older capture's disposal cannot stop a newer stage observer", () => {
    const first = harness(); const second = harness(); first.details.stop();
    measureMainThreadStage("lighter_public_frame", () => { second.set(150); });
    expect(second.lines).toHaveLength(1); expect(first.lines).toEqual([]);
  });
  it("does not time a returned promise's asynchronous lifetime", async () => {
    const h = harness();
    const pending = measureMainThreadStage("lighter_public_frame", async () => { await Promise.resolve(); h.set(200); return 9; });
    expect(await pending).toBe(9); expect(h.lines).toEqual([]);
  });
});
