/**
 * AN ATOMIC SAVE, IN THE THREE SHAPES THE THREE PINNED BACKENDS DELIVER IT.
 *
 * `files-real-fs.test.ts` saves a file for real, which is the only way to learn
 * what an operating system actually emits - but it can only ever learn it about
 * the operating system it is running on. The macOS shape therefore goes
 * unproven on the Linux lane, which is where nearly every run happens, and the
 * defect it would catch (an editor's scratch file drawn into the user's tree,
 * or the file being saved reported as deleted) reaches CI only on the one lane
 * that runs last.
 *
 * So the SHAPES are scripted here and driven through the real
 * `ProjectFileWatcher` and the real coalescer, on every platform. Nothing about
 * the pipeline is faked: only the bytes the native backend would have handed
 * it are.
 *
 * WHERE THE SHAPES COME FROM. @parcel/watcher 2.6.0 maps each backend's raw
 * notifications onto `create` / `update` / `delete`:
 *
 *  - INOTIFY (linux) reports every notification separately: the temp file's
 *    creation, then `IN_MOVED_FROM` for the temp name and `IN_MOVED_TO` for the
 *    target, which the backend surfaces as a delete and a create.
 *  - READDIRECTORYCHANGESW (win32) likewise reports the temp's addition and
 *    modification, then `RENAMED_OLD_NAME` / `RENAMED_NEW_NAME` as a delete of
 *    the temp and a create of the target.
 *  - FSEVENTS (darwin) does NOT. It coalesces per path inside its own latency
 *    window and reports each path's FINAL state, so the temp name arrives once,
 *    as a `delete`, and its `create` half never crosses the boundary at all.
 *    Corroborated by measurement, not by reading alone: on the darwin lane of
 *    run 33602264566 the domain delivered exactly one change for the temp name,
 *    `{ kind: "deleted" }`, where the Linux lane delivers none.
 *
 * WHAT MUST HOLD ON ALL THREE, and what this file asserts: the file the user is
 * editing is reported exactly ONCE and NEVER as a delete, and a save whose two
 * halves arrive in ONE aggregation window never draws the temp name. Two
 * differences are legitimate and both are pinned here rather than left to be
 * rediscovered: the lone macOS delete of a path the consumer never had, which no
 * coalescer can remove without keeping a private record of what each consumer
 * has been shown; and the flicker when the pair straddles two windows, which the
 * last test states in full.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FILES_AGGREGATION_MS,
  FILES_EMIT_THROTTLE_MS,
  type FileChangeKind,
} from "@shared/schemas/files.js";

import {
  ProjectFileWatcher,
  type NativeEvent,
  type WatcherEmission,
} from "../watcher.js";

/**
 * Resolved, and every event path joined onto it: `toProjectRelative` compares
 * with `path.sep`, so a POSIX literal would be resolved to a drive-rooted path
 * on win32 while the event paths stayed POSIX, and every event would be dropped
 * as outside the project.
 */
const ROOT = path.resolve("/tmp/vex-atomic-save-shapes");

const TARGET = "config.json";
const TEMP = ".config.json.tmp";

const entry = (name: string): string => path.join(ROOT, name);

interface Harness {
  readonly watcher: ProjectFileWatcher;
  readonly deliver: (events: NativeEvent[]) => void;
  readonly changes: () => ReadonlyArray<{ path: string; kind: FileChangeKind }>;
}

function harness(): Harness {
  const emissions: WatcherEmission[] = [];
  let callback: ((error: Error | null, events: NativeEvent[]) => void) | null = null;
  const watcher = new ProjectFileWatcher({
    projectId: "project-1",
    realRoot: ROOT,
    ignore: [],
    subscribeNative: (_directory, received) => {
      callback = received;
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    pollForRoot: () => () => undefined,
    rootExists: () => Promise.resolve(true),
    emit: (emission) => {
      emissions.push(emission);
    },
  });
  return {
    watcher,
    deliver: (events) => {
      callback?.(null, events);
    },
    changes: () =>
      emissions.flatMap((emission) =>
        emission.payload.kind === "changed" ? [...emission.payload.changes] : []),
  };
}

/**
 * Drain the watcher's own pipeline: the aggregation window, then the throttle.
 *
 * Timers are faked because the subject is what the pipeline PRODUCES, not how
 * long it takes; a test that slept 275 ms would be slower and would still not
 * prove the window was the thing that folded the pair.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(FILES_AGGREGATION_MS + FILES_EMIT_THROTTLE_MS + 1);
}

interface Shape {
  readonly backend: string;
  readonly platform: string;
  readonly events: readonly NativeEvent[];
  /** What the consumer must be told about the temp name, in order. */
  readonly temp: readonly FileChangeKind[];
}

const SHAPES: readonly Shape[] = [
  {
    backend: "inotify",
    platform: "linux",
    events: [
      { path: entry(TEMP), type: "create" },
      { path: entry(TEMP), type: "delete" },
      { path: entry(TARGET), type: "create" },
    ],
    // Both halves met inside one window, so the pair annihilated.
    temp: [],
  },
  {
    backend: "windows",
    platform: "win32",
    events: [
      { path: entry(TEMP), type: "create" },
      { path: entry(TEMP), type: "update" },
      { path: entry(TEMP), type: "delete" },
      { path: entry(TARGET), type: "create" },
    ],
    temp: [],
  },
  {
    backend: "fs-events",
    platform: "darwin",
    events: [
      { path: entry(TEMP), type: "delete" },
      { path: entry(TARGET), type: "update" },
    ],
    // The create half was never delivered, so a lone delete for a path the
    // consumer never had is what survives. It is a no-op for the tree.
    temp: ["deleted"],
  },
];

describe("an atomic save, as each pinned backend delivers it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const shape of SHAPES) {
    it(`reports ONE non-delete change to the target on ${shape.platform} (${shape.backend})`, async () => {
      const test = harness();
      await test.watcher.start();

      test.deliver([...shape.events]);
      await settle();

      const target = test.changes().filter((change) => change.path === TARGET);
      expect(target).toHaveLength(1);
      // A delete-then-create for the file being saved would collapse its row
      // and rebuild it, losing selection and scroll on the file the user is
      // editing. That is the defect the DELETED+ADDED rule exists to prevent.
      expect(target[0]?.kind).not.toBe("deleted");

      const temp = test.changes().filter((change) => change.path === TEMP);
      expect(temp.map((change) => change.kind)).toEqual(shape.temp);

      await test.watcher.dispose();
    });
  }

  /**
   * THE KNOWN LIMIT OF THE 75 MS WINDOW, pinned rather than discovered again.
   *
   * The coalescer can only annihilate a pair it is handed together. On a LOADED
   * machine the temp file's creation and its rename away land in two
   * CONSECUTIVE aggregation windows - measured on Linux while the rest of the
   * `src/main/studio` suite ran alongside - and the consumer then sees the
   * scratch file flicker into the tree for one batch before the delete removes
   * it. VS Code's parcel watcher coalesces per native callback and carries the
   * same property, so this is the reference's behaviour and not a departure
   * from it.
   *
   * What still holds, and is what the tree needs: the LAST WORD about the temp
   * name is that it is gone, and the target is still reported once and never as
   * a delete. Widening the window would trade real latency on every create for
   * this flicker, which is a product decision and not this module's to make; if
   * it is ever made, THIS is the test that turns red and states the new
   * contract.
   */
  it("FLICKERS the temp name when the pair straddles two aggregation windows", async () => {
    const test = harness();
    await test.watcher.start();

    test.deliver([{ path: entry(TEMP), type: "create" }]);
    await settle();
    test.deliver([
      { path: entry(TEMP), type: "delete" },
      { path: entry(TARGET), type: "create" },
    ]);
    await settle();

    expect(test.changes().filter((change) => change.path === TEMP).map((c) => c.kind))
      .toEqual(["added", "deleted"]);
    const target = test.changes().filter((change) => change.path === TARGET);
    expect(target).toHaveLength(1);
    expect(target[0]?.kind).not.toBe("deleted");

    await test.watcher.dispose();
  });

  it("NEVER draws the temp name when a whole save arrives in ONE window", async () => {
    for (const shape of SHAPES) {
      const test = harness();
      await test.watcher.start();
      test.deliver([...shape.events]);
      await settle();

      const drawn = test
        .changes()
        .filter((change) => change.path === TEMP && change.kind !== "deleted");
      expect(drawn, `${shape.backend} drew the temp file`).toEqual([]);

      await test.watcher.dispose();
    }
  });
});
