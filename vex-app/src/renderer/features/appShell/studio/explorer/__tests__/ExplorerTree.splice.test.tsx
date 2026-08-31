/**
 * THE SPLICE INVARIANT, ported from the stage-B3 spike that ratified this model.
 *
 * The property under test is the one the whole flat-index design exists for: a
 * folder with 10,400 children can be open, and a single child arriving through
 * the watcher costs ONE `Array#splice` plus a re-render of the rows that are
 * actually on screen - not a walk of the tree and not 10,400 row renders.
 *
 * DELIBERATELY NOT A TIMING ASSERTION. The spike MEASURED (10-13x faster per
 * splice than @headless-tree at 10k visible rows) and that measurement is what
 * decided the port; a wall-clock threshold in CI would only measure the machine.
 * What survives as a regression guard is the COUNT, which is deterministic.
 *
 * Under `<StrictMode>`, because a double-invoked effect is where a lifecycle
 * mistake in the acquire/release path would show up as doubled work.
 */

import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerRegistry } from "../explorer-registry.js";
import { EXPLORER_REFRESH_DELAY_MS } from "../explorer-session.js";
import { ExplorerTree } from "../ExplorerTree.js";
import {
  FilesApiFake,
  TEST_VIEWPORT_HEIGHT,
  buildTreeFixture,
  createRenderCounters,
  countRow,
  fixtureResponder,
  listingOf,
  testViewport,
  type TreeFixture,
} from "./explorer-harness.js";
import { EXPLORER_ROW_HEIGHT } from "../ExplorerRow.js";

let api: FilesApiFake;
let registry: ExplorerRegistry;
const counters = createRenderCounters();

vi.mock("../../../../../lib/api/files.js", () => ({
  listProjectChildren: (input: Parameters<FilesApiFake["listChildren"]>[0]) =>
    api.listChildren(input),
  readProjectFile: () => {
    throw new Error("the tree never reads a file");
  },
  watchProjectFiles: (input: Parameters<FilesApiFake["watchFile"]>[0]) => api.watchFile(input),
  unwatchProjectFiles: (subscriptionId: string) => api.unwatchFile({ subscriptionId }),
  onProjectFilesEvent: (
    subscriptionId: string,
    cb: Parameters<FilesApiFake["onFilesEvent"]>[1],
  ) => api.onFilesEvent(subscriptionId, cb),
}));

/**
 * The real row, counted.
 *
 * A wrapper rather than a replacement: the assertion is about how many rows
 * REACT RENDERS, so the component under test has to be the shipped one, and
 * only rows the virtualizer actually mounted can be counted at all.
 */
vi.mock("../ExplorerRow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ExplorerRow.js")>();
  return {
    ...actual,
    ExplorerRow: (props: Parameters<typeof actual.ExplorerRow>[0]) => {
      countRow(counters, props.rowId);
      return <actual.ExplorerRow {...props} />;
    },
  };
});

async function flush(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

/**
 * The naive recomputation: walk the fixture and count what SHOULD be rendered,
 * with no reference to the model's own bookkeeping.
 */
function naiveRowCount(fixture: TreeFixture, expanded: ReadonlySet<string>): number {
  const walk = (path: string): number => {
    let count = 0;
    for (const child of fixture.children.get(path) ?? []) {
      count += 1;
      if (child.kind === "directory" && expanded.has(child.path)) count += walk(child.path);
    }
    return count;
  };
  return walk("");
}

beforeEach(() => {
  api = new FilesApiFake();
  registry = new ExplorerRegistry((run) => {
    queueMicrotask(run);
  });
  counters.reset();
  document.body.innerHTML = "";
});

afterEach(async () => {
  await registry.disposeAll();
  vi.useRealTimers();
});

describe("splice cost at 50k nodes", () => {
  it("renders only the viewport when a 10,400-child folder opens, and again when one child arrives", async () => {
    vi.useFakeTimers();
    const fixture = buildTreeFixture(50_000);
    expect(fixture.totalNodes).toBeGreaterThan(50_000);
    api.listResponder = fixtureResponder(fixture);

    render(
      <StrictMode>
        <ExplorerTree
          projectId="p1"
          onOpenFile={() => undefined}
          registry={registry}
          viewport={testViewport}
        />
      </StrictMode>,
    );
    await flush();

    const session = registry.acquire("p1");
    const rootRows = naiveRowCount(fixture, new Set());
    expect(session.model.getRowCount()).toBe(rootRows);

    // ---- expand the fat folder ----
    counters.reset();
    session.expand(`id:${fixture.bigFolderPath}`);
    await flush();

    const expanded = new Set([fixture.bigFolderPath]);
    expect(session.model.getRowCount()).toBe(naiveRowCount(fixture, expanded));
    expect(session.model.getRowCount()).toBeGreaterThan(10_400);

    // The whole point: 10,400 rows became visible and the DOM holds a viewport.
    const viewportRows = Math.ceil(TEST_VIEWPORT_HEIGHT / EXPLORER_ROW_HEIGHT);
    const mounted = screen.getAllByRole("treeitem").length;
    expect(mounted).toBeLessThan(viewportRows * 3);
    expect(counters.distinctRows()).toBeLessThan(viewportRows * 3);

    // ---- one child arrives through the watcher ----
    const withExtra = [
      ...(fixture.children.get(fixture.bigFolderPath) ?? []),
      {
        nodeId: `id:${fixture.bigFolderPath}/zzz-new.ts`,
        name: "zzz-new.ts",
        path: `${fixture.bigFolderPath}/zzz-new.ts`,
        kind: "file" as const,
        size: 1,
        modifiedMs: 1,
      },
    ];
    const baseResponder = fixtureResponder(fixture);
    api.listResponder = (call) =>
      call.nodeId === `id:${fixture.bigFolderPath}`
        ? {
            ok: true,
            data: { ok: true, value: listingOf(withExtra, { totalCount: withExtra.length }) },
          }
        : baseResponder(call);

    counters.reset();
    api.emit({
      kind: "changed",
      subscriptionId: "sub-1",
      projectId: "p1",
      watcherGeneration: 1,
      batchSeq: 0,
      changes: [
        {
          path: `${fixture.bigFolderPath}/zzz-new.ts`,
          kind: "added",
          nodeId: `id:${fixture.bigFolderPath}/zzz-new.ts`,
        },
      ],
      overflowed: false,
      droppedCount: 0,
    });
    vi.advanceTimersByTime(EXPLORER_REFRESH_DELAY_MS);
    await flush();

    expect(session.model.getRowCount()).toBe(naiveRowCount(fixture, expanded) + 1);
    // Re-listing a 10,401-entry folder re-rendered a viewport, not the folder.
    expect(counters.distinctRows()).toBeLessThan(viewportRows * 3);
    expect(counters.totalRowRenders()).toBeLessThan(viewportRows * 8);

    registry.release("p1");
  });

  it("keeps getIndexOf and getRowId exact at 10k visible rows", async () => {
    const fixture = buildTreeFixture(50_000);
    api.listResponder = fixtureResponder(fixture);
    render(
      <StrictMode>
        <ExplorerTree
          projectId="p1"
          onOpenFile={() => undefined}
          registry={registry}
          viewport={testViewport}
        />
      </StrictMode>,
    );
    await flush();

    const session = registry.acquire("p1");
    session.expand(`id:${fixture.bigFolderPath}`);
    await flush();

    // The index map is a fast substitute for a scan; at this size a drift would
    // be invisible on screen and fatal to every keyboard move.
    const count = session.model.getRowCount();
    for (const index of [0, 1, 500, 5_000, 10_000, count - 1]) {
      const rowId = session.model.getRowId(index);
      expect(session.model.getIndexOf(rowId)).toBe(index);
    }

    registry.release("p1");
  });
});
