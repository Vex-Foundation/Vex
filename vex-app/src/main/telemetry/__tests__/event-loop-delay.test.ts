/** K-5: event loop delay telemetry, driven by injected clocks and timers. */

import { describe, expect, it } from "vitest";

import {
  EVENT_LOOP_STALL_THRESHOLD_MS,
  EVENT_LOOP_STALL_TICK_MS,
  EVENT_LOOP_TELEMETRY_ENABLED,
  EVENT_LOOP_WINDOW_MS,
  StallCounter,
  formatKdfStats,
  formatWindow,
  startEventLoopTelemetry,
  summariseWindow,
  type DelayHistogram,
  type EventLoopKdfStats,
  type EventLoopWindow,
} from "../event-loop-delay.js";

class FakeHistogram implements DelayHistogram {
  enabled = false;
  resets = 0;
  count = 0;
  max = 0;
  values = new Map<number, number>();

  enable(): boolean {
    this.enabled = true;
    return true;
  }

  disable(): boolean {
    this.enabled = false;
    return true;
  }

  reset(): void {
    this.resets += 1;
    this.count = 0;
    this.max = 0;
    this.values.clear();
  }

  percentile(p: number): number {
    return this.values.get(p) ?? 0;
  }
}

interface Scheduled {
  readonly ms: number;
  readonly fn: () => void;
  cancelled: boolean;
}

function harness(takeKdfStats?: () => EventLoopKdfStats): {
  clock: { now: number };
  histogram: FakeHistogram;
  scheduled: Scheduled[];
  lines: Array<{ level: string; line: string }>;
  recorded: EventLoopWindow[];
  run: (ms: number) => void;
  stop: () => void;
} {
  const clock = { now: 1_000 };
  const histogram = new FakeHistogram();
  const scheduled: Scheduled[] = [];
  const lines: Array<{ level: string; line: string }> = [];
  const recorded: EventLoopWindow[] = [];
  const stop = startEventLoopTelemetry({
    enabled: true,
    stallDetails: false,
    log: (level, line) => lines.push({ level, line }),
    record: (window) => recorded.push(window),
    ...(takeKdfStats === undefined ? {} : { takeKdfStats }),
    deps: {
      now: () => clock.now,
      createHistogram: () => histogram,
      every: (fn, ms) => {
        const entry: Scheduled = { ms, fn, cancelled: false };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
  });
  const run = (ms: number): void => {
    for (const entry of scheduled) if (entry.ms === ms && !entry.cancelled) entry.fn();
  };
  return { clock, histogram, scheduled, lines, recorded, run, stop };
}

describe("K-5 switch and constants", () => {
  it("is on by default with a named stall threshold", () => {
    expect(EVENT_LOOP_TELEMETRY_ENABLED).toBe(true);
    expect(EVENT_LOOP_STALL_THRESHOLD_MS).toBe(100);
    expect(EVENT_LOOP_WINDOW_MS).toBe(60_000);
  });

  it("starts nothing when disabled", () => {
    let created = 0;
    const stop = startEventLoopTelemetry({
      enabled: false,
      log: () => undefined,
      record: () => undefined,
      deps: {
        createHistogram: () => {
          created += 1;
          return new FakeHistogram();
        },
      },
    });
    stop();
    expect(created).toBe(0);
  });
});

describe("StallCounter", () => {
  it("counts only ticks at least the threshold late and keeps the longest", () => {
    const counter = new StallCounter(0, 50, 100);
    counter.observeTick(50); // on time
    counter.observeTick(160); // 60 ms late: not a stall
    counter.observeTick(360); // 150 ms late
    counter.observeTick(410); // on time
    counter.observeTick(800); // 340 ms late
    expect(counter.take()).toEqual({ stallCount: 2, longestStallMs: 340 });
    expect(counter.take()).toEqual({ stallCount: 0, longestStallMs: 0 });
  });
});

describe("summariseWindow", () => {
  it("converts nanoseconds to rounded milliseconds", () => {
    const h = new FakeHistogram();
    h.count = 3000;
    h.max = 412_345_678;
    h.values.set(50, 10_123_456);
    h.values.set(99, 55_555_555);
    expect(summariseWindow(h, { stallCount: 2, longestStallMs: 401.5 }, 60_000.4, 100)).toEqual({
      windowMs: 60_000,
      sampleCount: 3000,
      p50Ms: 10.12,
      p99Ms: 55.56,
      maxMs: 412.35,
      stallCount: 2,
      stallThresholdMs: 100,
      longestStallMs: 401.5,
    });
  });

  it("reports zeros for an empty histogram instead of its sentinel values", () => {
    const h = new FakeHistogram();
    h.max = Number.MAX_SAFE_INTEGER;
    const window = summariseWindow(h, { stallCount: 0, longestStallMs: 0 }, 10, 100);
    expect([window.p50Ms, window.p99Ms, window.maxMs]).toEqual([0, 0, 0]);
  });

  it("formats a numbers-only log line", () => {
    const line = formatWindow({
      windowMs: 60_000,
      sampleCount: 10,
      p50Ms: 10,
      p99Ms: 20,
      maxMs: 30,
      stallCount: 1,
      stallThresholdMs: 100,
      longestStallMs: 150,
    });
    expect(line).toBe(
      "[event-loop] window=60000ms samples=10 p50=10ms p99=20ms max=30ms stalls>=100ms=1 longestStall=150ms",
    );
  });
});

describe("startEventLoopTelemetry", () => {
  it("enables the histogram and schedules the tick and the window", () => {
    const h = harness();
    expect(h.histogram.enabled).toBe(true);
    expect(h.scheduled.map((s) => s.ms).sort((a, b) => a - b)).toEqual([
      EVENT_LOOP_STALL_TICK_MS,
      EVENT_LOOP_WINDOW_MS,
    ]);
    h.stop();
  });

  it("logs and records one sanitised window, warn when it had a stall", () => {
    const h = harness();
    h.histogram.count = 100;
    h.histogram.max = 300_000_000;
    h.histogram.values.set(50, 11_000_000);
    h.histogram.values.set(99, 120_000_000);
    h.clock.now += 50;
    h.run(EVENT_LOOP_STALL_TICK_MS);
    h.clock.now += 300; // 250 ms late
    h.run(EVENT_LOOP_STALL_TICK_MS);
    h.clock.now = 61_000;
    h.run(EVENT_LOOP_WINDOW_MS);
    expect(h.recorded).toEqual([
      {
        windowMs: 60_000,
        sampleCount: 100,
        p50Ms: 11,
        p99Ms: 120,
        maxMs: 300,
        stallCount: 1,
        stallThresholdMs: EVENT_LOOP_STALL_THRESHOLD_MS,
        longestStallMs: 250,
      },
    ]);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]?.level).toBe("warn");
    expect(h.histogram.resets).toBe(1);
    h.stop();
  });

  it("logs a quiet window at info and skips an empty one", () => {
    const h = harness();
    h.histogram.count = 5;
    h.clock.now += 60_000;
    h.run(EVENT_LOOP_WINDOW_MS);
    expect(h.lines.map((l) => l.level)).toEqual(["info"]);
    h.clock.now += 60_000;
    h.run(EVENT_LOOP_WINDOW_MS);
    expect(h.recorded).toHaveLength(1);
    h.stop();
  });

  it("never throws when the recorder throws", () => {
    const h = harness();
    const stop = startEventLoopTelemetry({
      enabled: true,
      log: () => undefined,
      record: () => {
        throw new Error("db down");
      },
      deps: {
        now: () => 0,
        createHistogram: () => {
          const fake = new FakeHistogram();
          fake.count = 1;
          return fake;
        },
        every: (fn, ms) => {
          if (ms === EVENT_LOOP_WINDOW_MS) expect(() => fn()).not.toThrow();
          return () => undefined;
        },
      },
    });
    stop();
    h.stop();
  });

  it("FLC-6: appends the window's KDF numbers to the line and leaves the row unchanged", () => {
    const takes: EventLoopKdfStats[] = [
      { derives: 6, offMainDerives: 0, callerBlockedMs: 1326.184 },
      { derives: 0, offMainDerives: 0, callerBlockedMs: 0 },
      { derives: 2, offMainDerives: 2, callerBlockedMs: 0.04 },
    ];
    let taken = 0;
    const h = harness(() => {
      const next = takes[taken] ?? { derives: 0, offMainDerives: 0, callerBlockedMs: 0 };
      taken += 1;
      return next;
    });
    h.histogram.count = 5;
    h.clock.now += 60_000;
    h.run(EVENT_LOOP_WINDOW_MS);
    // An empty window is skipped but still takes (and so resets) the count.
    h.histogram.count = 0;
    h.clock.now += 60_000;
    h.run(EVENT_LOOP_WINDOW_MS);
    h.histogram.count = 5;
    h.clock.now += 60_000;
    h.run(EVENT_LOOP_WINDOW_MS);
    expect(taken).toBe(3);
    expect(h.lines.map((l) => l.line)).toEqual([
      expect.stringMatching(/ longestStall=0ms kdf=6 kdfOffMain=0 kdfMainMs=1326\.18$/),
      expect.stringMatching(/ longestStall=0ms kdf=2 kdfOffMain=2 kdfMainMs=0\.04$/),
    ]);
    expect(h.recorded).toHaveLength(2);
    for (const row of h.recorded) {
      expect(Object.keys(row).sort()).toEqual([
        "longestStallMs",
        "maxMs",
        "p50Ms",
        "p99Ms",
        "sampleCount",
        "stallCount",
        "stallThresholdMs",
        "windowMs",
      ]);
    }
    h.stop();
  });

  it("FLC-6: a KDF reader that throws leaves today's line", () => {
    const h = harness(() => {
      throw new Error("not available");
    });
    h.histogram.count = 5;
    h.clock.now += 60_000;
    h.run(EVENT_LOOP_WINDOW_MS);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]?.line).toMatch(/ longestStall=0ms$/);
    h.stop();
  });

  it("FLC-6: formats the KDF suffix in numbers only", () => {
    expect(formatKdfStats({ derives: 3, offMainDerives: 3, callerBlockedMs: 0.123 })).toBe(
      " kdf=3 kdfOffMain=3 kdfMainMs=0.12",
    );
  });

  it("stops idempotently: both timers cancelled and the histogram disabled", () => {
    const h = harness();
    h.stop();
    h.stop();
    expect(h.scheduled.every((s) => s.cancelled)).toBe(true);
    expect(h.histogram.enabled).toBe(false);
  });

  it("runs against the real perf_hooks histogram and timers", () => {
    const stop = startEventLoopTelemetry({
      enabled: true,
      log: () => undefined,
      record: () => undefined,
    });
    stop();
  });
});

describe("cheap stall detail integration", () => {
  it("shares the existing tick and stops observer delivery with telemetry", () => {
    let now = 1000;
    let disconnects = 0;
    const scheduled: Scheduled[] = [];
    const lines: string[] = [];
    const stop = startEventLoopTelemetry({
      log: (_level, line) => { lines.push(line); }, record: () => undefined,
      stallDetails: true,
      deps: {
        now: () => now, createHistogram: () => new FakeHistogram(),
        every: (fn, ms) => {
          const entry: Scheduled = { fn, ms, cancelled: false };
          scheduled.push(entry);
          return () => { entry.cancelled = true; };
        },
      },
      stallDetailsDeps: {
        now: () => now, wallNow: () => 1_800_000_000_000 + now,
        utilization: () => ({ active: now, idle: 0 }), slowStages: false,
        observeGc: () => () => { disconnects += 1; },
      },
    });
    expect(scheduled.map((entry) => entry.ms)).toEqual([50, 60000]);
    now = 1250;
    for (const entry of scheduled) if (entry.ms === 50) entry.fn();
    now = 2250;
    for (const entry of scheduled) if (entry.ms === 50) entry.fn();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[event-loop-stall-detail] observedAtMs=1800000001250 lateMs=200");
    stop(); stop();
    expect(disconnects).toBe(1);
    expect(scheduled.every((entry) => entry.cancelled)).toBe(true);
    now = 4000;
    for (const entry of scheduled) if (entry.ms === 50) entry.fn();
    expect(lines).toHaveLength(1);
  });
});
