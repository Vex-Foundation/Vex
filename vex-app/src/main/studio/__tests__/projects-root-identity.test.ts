/**
 * THE ROOT-IDENTITY TABLE, including the row a real filesystem will not
 * produce on demand (B3).
 *
 * `projects-root.test.ts` proves root equality against real directories, real
 * symlinks and real `stat` calls, which is where that property belongs. Two
 * rows cannot be staged that way on a developer machine or a CI runner:
 *
 *   - `dev = 0, ino = 0`. Node reports this when the filesystem supplies no
 *     file index for a path. It is reachable on some Windows network shares and
 *     on FAT volumes, and it is exactly the input that would make a naive
 *     identity comparison report "these two unrelated folders are the same
 *     directory", because zero equals zero.
 *   - a `stat` that fails for a reason other than absence (an unreadable
 *     parent, a stalled network mount).
 *
 * So `node:fs/promises` is faked HERE and only here, and only its `stat`: the
 * subject is our decision about the values the filesystem returns, not the
 * filesystem. Everything else in the module under test stays real.
 */

import path from "node:path";
import type { Stats } from "node:fs";
import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}) as { projectsRoot?: string }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  stat: vi.fn(),
}));

vi.mock("@config/store.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, stat: mocks.stat };
});

const { assertProjectsRootUnchanged } = await import("../projects-root.js");

const CORR = "corr-root-identity";
const RECORDED = path.resolve("/roots/recorded");
const RESOLVED = path.resolve("/roots/resolved");

/** Only the two fields the comparison reads; nothing else is consulted. */
function identity(dev: number, ino: number): Stats {
  return { dev, ino } as Stats;
}

function scriptedClient(recorded: string): Client {
  return Object.assign(new Client(), {
    query: vi.fn(async () => ({ rows: [{ projects_root: recorded }], rowCount: 1 })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

interface Row {
  readonly name: string;
  /** `null` means this `stat` call rejects. */
  readonly recorded: readonly [number, number] | null;
  readonly resolved: readonly [number, number] | null;
  readonly expected: "ok" | "projects.root_changed" | "projects.root_unverifiable";
}

const ROWS: readonly Row[] = [
  {
    name: "the same dev+ino under two spellings is the SAME root",
    recorded: [66, 12345],
    resolved: [66, 12345],
    expected: "ok",
  },
  {
    name: "a different inode on the same device is a DIFFERENT root",
    recorded: [66, 12345],
    resolved: [66, 999],
    expected: "projects.root_changed",
  },
  {
    name: "the same inode on a different device is a DIFFERENT root",
    recorded: [66, 12345],
    resolved: [70, 12345],
    expected: "projects.root_changed",
  },
  {
    name: "a zero identity on the RECORDED root proves nothing",
    recorded: [0, 0],
    resolved: [66, 12345],
    expected: "projects.root_unverifiable",
  },
  {
    name: "a zero identity on the RESOLVED root proves nothing",
    recorded: [66, 12345],
    resolved: [0, 0],
    expected: "projects.root_unverifiable",
  },
  {
    name: "two zero identities are NOT equal, however tempting zero === zero is",
    recorded: [0, 0],
    resolved: [0, 0],
    expected: "projects.root_unverifiable",
  },
  {
    name: "a stat failure on the recorded root proves nothing",
    recorded: null,
    resolved: [66, 12345],
    expected: "projects.root_unverifiable",
  },
  {
    name: "a stat failure on the resolved root proves nothing",
    recorded: [66, 12345],
    resolved: null,
    expected: "projects.root_unverifiable",
  },
];

describe("projects-root identity comparison", () => {
  it.each(ROWS)("$name", async (row) => {
    mocks.stat.mockImplementation(async (target: string) => {
      const spec = path.resolve(target) === RECORDED ? row.recorded : row.resolved;
      if (spec === null) throw Object.assign(new Error("stat failed"), { code: "EIO" });
      return identity(spec[0], spec[1]);
    });

    const outcome = await assertProjectsRootUnchanged(
      scriptedClient(RECORDED),
      RESOLVED,
      CORR,
    );

    if (row.expected === "ok") {
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      return;
    }
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe(row.expected);
    // No refusal on this path ever carries a filesystem path to the renderer.
    expect(JSON.stringify(outcome.error)).not.toContain("/roots/");
  });

  it("does not stat at all when the two spellings are byte-identical", async () => {
    // The fast path is a correctness property, not a performance one: an
    // identical string names one path, so a `stat` failure there could only
    // turn a trivially-true comparison into a refusal.
    mocks.stat.mockRejectedValue(new Error("stat must not be called"));

    const outcome = await assertProjectsRootUnchanged(
      scriptedClient(RESOLVED),
      RESOLVED,
      CORR,
    );
    expect(outcome.ok).toBe(true);
    expect(mocks.stat).not.toHaveBeenCalled();
  });
});
