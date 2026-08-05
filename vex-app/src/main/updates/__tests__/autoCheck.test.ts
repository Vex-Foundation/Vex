/**
 * Ambient auto-check scheduler (M13 follow-up). Verifies the guards: feed gate,
 * safe-state guard, persisted success throttle, focus debounce, and the
 * in-memory failure backoff. Auto-check never downloads — this only governs
 * WHEN checkForUpdates runs.
 *
 * Updater redesign Part A item 3: the safe-state guard now also allows a
 * check from `available` (previously idle/current/error only) so a NEWER
 * release can surface even while the current one sits snoozed in the
 * renderer's per-version "Later" state — see the guard preserved for the
 * remaining in-progress/blocked states below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let isPackaged = true;
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return isPackaged;
    },
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

let currentKind = "idle";
vi.mock("../statusCache.js", () => ({
  getCurrentStatus: () => ({ kind: currentKind, currentVersion: "1.0.0" }),
}));

let lastCheckedAt: string | null = null;
let prefsLoadHook: (() => void) | null = null;
vi.mock("../../preferences/store.js", () => ({
  preferencesStore: {
    load: async () => {
      prefsLoadHook?.();
      return { updater: { lastCheckedAt } };
    },
  },
}));

const silentCheck = vi.fn(async () => true);
vi.mock("../updateActions.js", () => ({ silentCheck: () => silentCheck() }));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { maybeAutoCheck, installUpdaterAutoCheck, __resetAutoCheckForTests } =
  await import("../autoCheck.js");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-28T12:00:00Z"));
  isPackaged = true;
  currentKind = "idle";
  lastCheckedAt = null;
  prefsLoadHook = null;
  silentCheck.mockReset();
  silentCheck.mockResolvedValue(true);
  __resetAutoCheckForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("maybeAutoCheck", () => {
  it("skips when no feed is configured (plain dev)", async () => {
    isPackaged = false;
    await maybeAutoCheck("startup");
    expect(silentCheck).not.toHaveBeenCalled();
  });

  it("runs when feed configured, quiet, and no prior check", async () => {
    await maybeAutoCheck("startup");
    expect(silentCheck).toHaveBeenCalledTimes(1);
  });

  it("skips from an actionable state (downloaded)", async () => {
    currentKind = "downloaded";
    await maybeAutoCheck("focus");
    expect(silentCheck).not.toHaveBeenCalled();
  });

  it("skips from installing (guard preserved)", async () => {
    currentKind = "installing";
    await maybeAutoCheck("focus");
    expect(silentCheck).not.toHaveBeenCalled();
  });

  it("skips from blockedByOperation (guard preserved)", async () => {
    currentKind = "blockedByOperation";
    await maybeAutoCheck("focus");
    expect(silentCheck).not.toHaveBeenCalled();
  });

  it("skips from downloading (guard preserved)", async () => {
    currentKind = "downloading";
    await maybeAutoCheck("focus");
    expect(silentCheck).not.toHaveBeenCalled();
  });

  it("NOW also runs from available — a newer release must still surface while snoozed", async () => {
    currentKind = "available";
    await maybeAutoCheck("startup");
    expect(silentCheck).toHaveBeenCalledTimes(1);
  });

  it("skips within the success throttle (recent lastCheckedAt)", async () => {
    lastCheckedAt = new Date().toISOString();
    await maybeAutoCheck("focus");
    expect(silentCheck).not.toHaveBeenCalled();
  });

  it("runs once lastCheckedAt is older than the throttle window (minutes, not hours)", async () => {
    lastCheckedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await maybeAutoCheck("focus");
    expect(silentCheck).toHaveBeenCalledTimes(1);
  });

  it("debounces focus bursts within 60s", async () => {
    await maybeAutoCheck("focus");
    vi.advanceTimersByTime(30_000);
    await maybeAutoCheck("focus");
    expect(silentCheck).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failure (no retry within the backoff window)", async () => {
    silentCheck.mockResolvedValue(false);
    await maybeAutoCheck("startup"); // fails -> backoff armed
    expect(silentCheck).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60 * 1000); // 2 min: past 60s debounce, within 10m backoff
    await maybeAutoCheck("focus");
    expect(silentCheck).toHaveBeenCalledTimes(1);
  });
});

describe("installUpdaterAutoCheck - periodic timer", () => {
  it("checks on startup, then every 5 minutes while the app runs, and stops on teardown", async () => {
    const teardown = installUpdaterAutoCheck();

    await vi.advanceTimersByTimeAsync(3_000); // deferred startup check
    expect(silentCheck).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(silentCheck).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(silentCheck).toHaveBeenCalledTimes(3);

    teardown();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(silentCheck).toHaveBeenCalledTimes(3);
  });

  it("re-checks the safe-state guard AFTER the awaited preference read (download starting mid-schedule)", async () => {
    // The preference read is async; a download can begin inside that gap.
    // Simulate it: prefs load flips the status to `downloading` before
    // resolving - the ambient check must then abort, not proceed.
    prefsLoadHook = () => {
      currentKind = "downloading";
    };
    await maybeAutoCheck("periodic");
    expect(silentCheck).not.toHaveBeenCalled();
  });

  it("backs off exponentially: second consecutive failure doubles the wait", async () => {
    silentCheck.mockResolvedValue(false);
    await maybeAutoCheck("startup"); // failure #1 -> 10m backoff
    expect(silentCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000); // past 10m
    await maybeAutoCheck("periodic"); // failure #2 -> 20m backoff
    expect(silentCheck).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000); // 11m < 20m: blocked
    await maybeAutoCheck("periodic");
    expect(silentCheck).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 21m total: allowed
    await maybeAutoCheck("periodic");
    expect(silentCheck).toHaveBeenCalledTimes(3);
  });

  it("a periodic tick respects the safe-state guard (never clobbers a download)", async () => {
    const teardown = installUpdaterAutoCheck();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(silentCheck).toHaveBeenCalledTimes(1);

    currentKind = "downloading";
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(silentCheck).toHaveBeenCalledTimes(1);
    teardown();
  });
});
