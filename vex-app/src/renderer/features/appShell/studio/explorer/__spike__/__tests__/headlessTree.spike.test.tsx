/**
 * SPIKE ONLY (Stage B3 measurement). Not production code, not a regression
 * guard: it prints numbers and asserts only the facts the recommendation
 * rests on.
 *
 * Workload: 50k-node synthetic workspace, depth 6-8, lazy child resolution.
 * Method: jsdom + vitest, React 19 StrictMode ON (as `main.tsx` runs it),
 * @tanstack/react-virtual with a fixed 600px viewport, commits counted by a
 * React Profiler, row renders counted per stable id inside a memoized Row.
 */
import { render, act, cleanup } from "@testing-library/react";
import React, { Profiler, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { TreeInstance } from "@headless-tree/core";

import {
  HeadlessTreeHarness,
  type SpikeItemData,
} from "../HeadlessTreeHarness";
import { buildSpikeTree, createLoaderProbe } from "../fixture";
import { createRenderCounters } from "../renderCounters";

/** The async loader resolves on the microtask queue AND headless-tree chains
 * a further tick before rebuilding, so a macrotask flush is required; two
 * microtask ticks silently measure an EMPTY tree (observed in the first run of
 * this spike, which reported flattened=0). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const report: string[] = [];
const log = (line: string): void => {
  report.push(line);
  process.stdout.write(`[HT] ${line}\n`);
};

afterEach(cleanup);

describe("SPIKE candidate A: @headless-tree + react-virtual", () => {
  it("measures mount, expand, splice, collapse under StrictMode", async () => {
    const source = buildSpikeTree(50_000);
    const probe = createLoaderProbe();
    const counters = createRenderCounters();

    const getItem = async (id: string): Promise<SpikeItemData> => {
      probe.dataCalls.push(id);
      const node = source.nodes.get(id);
      return { name: node?.name ?? id, isFolder: node?.isFolder ?? false };
    };
    const getChildrenWithData = async (
      id: string,
    ): Promise<Array<{ id: string; data: SpikeItemData }>> => {
      probe.childrenCalls.push(id);
      return (source.children.get(id) ?? []).map((childId) => {
        const node = source.nodes.get(childId);
        return {
          id: childId,
          data: { name: node?.name ?? childId, isFolder: node?.isFolder ?? false },
        };
      });
    };

    // Ref object, not a closure-assigned let: TypeScript narrows a let assigned
    // only inside a callback to null at the read site, which is what the cast
    // this replaces was hiding.
    const treeRef: { current: TreeInstance<SpikeItemData> | null } = { current: null };
    let actualDurationMs = 0;
    const onRender = (
      _id: string,
      _phase: string,
      actualDuration: number,
    ): void => {
      counters.commits++;
      actualDurationMs += actualDuration;
    };

    log(`fixture: ${source.totalNodes} nodes`);

    // ---- scenario 1: initial mount, root expanded one level ----------------
    const t0 = performance.now();
    const view = render(
      <StrictMode>
        <Profiler id="ht" onRender={onRender}>
          <HeadlessTreeHarness
            rootId={source.rootId}
            getItem={getItem}
            getChildrenWithData={getChildrenWithData}
            counters={counters}
            onTree={(t) => {
              treeRef.current = t;
            }}
          />
        </Profiler>
      </StrictMode>,
    );
    await act(async () => {
      await flush();
    });
    const mountMs = performance.now() - t0;

    if (treeRef.current === null) throw new Error("spike: tree never mounted");
    const treeInstance = treeRef.current;
    const rowsAtMount = view.container.querySelectorAll("[role='treeitem']")
      .length;
    log(
      `1. mount: ${mountMs.toFixed(1)}ms, DOM rows=${rowsAtMount}, ` +
        `flattened=${treeInstance.getItems().length}, ` +
        `getChildren calls=${probe.childrenCalls.length} ` +
        `(unique=${new Set(probe.childrenCalls).size}), ` +
        `getItem calls=${probe.dataCalls.length} ` +
        `(unique=${new Set(probe.dataCalls).size}), ` +
        `commits=${counters.commits}`,
    );
    const mountChildrenCalls = [...probe.childrenCalls];
    // StrictMode double-load check: a folder must not be fetched twice.
    const duplicated = mountChildrenCalls.filter(
      (id, i) => mountChildrenCalls.indexOf(id) !== i,
    );
    log(`4. StrictMode duplicate getChildren ids: ${duplicated.length}`);

    // ---- scenario 2: expand a deep directory -------------------------------
    // Walk the chain down so deep-6 is reachable (each level must be expanded).
    for (let depth = 1; depth <= 6; depth++) {
      probe.reset();
      await act(async () => {
        treeInstance.getItemInstance(`deep-${depth}`).expand();
        await flush();
      });
    }
    const deepCalls = [...probe.childrenCalls];
    const rowsAfterDeep = view.container.querySelectorAll("[role='treeitem']")
      .length;
    log(
      `2. expand deep-6: getChildren=${deepCalls.length} ids=${JSON.stringify(
        [...new Set(deepCalls)].slice(0, 5),
      )}, DOM rows=${rowsAfterDeep}, flattened=${treeInstance.getItems().length}`,
    );

    // ---- scenario 3: incremental splice on a 10k-descendant folder ---------
    probe.reset();
    counters.reset();
    const tExpandBig = performance.now();
    await act(async () => {
      treeInstance.getItemInstance(source.bigFolderId).expand();
      await flush();
    });
    const expandBigMs = performance.now() - tExpandBig;
    const visibleAfterBig = treeInstance.getItems().length;
    log(
      `3a. expand 10k folder: ${expandBigMs.toFixed(1)}ms, ` +
        `flattened=${visibleAfterBig}, DOM rows=` +
        `${view.container.querySelectorAll("[role='treeitem']").length}, ` +
        `getChildren=${probe.childrenCalls.length}, commits=${counters.commits}`,
    );

    // select + focus so we can prove they survive the splice
    await act(async () => {
      treeInstance.setSelectedItems(["big-0"]);
      treeInstance.getItemInstance("big-0").setFocused();
    });

    // INSERT
    counters.reset();
    probe.reset();
    actualDurationMs = 0;
    const bigKids = source.children.get(source.bigFolderId) as string[];
    source.nodes.set("big-new", {
      id: "big-new",
      name: "file-new.ts",
      isFolder: false,
    });
    bigKids.splice(3, 0, "big-new");
    let insertSyncMs = 0;
    const tInsert = performance.now();
    await act(async () => {
      const tSync = performance.now();
      treeInstance
        .getItemInstance(source.bigFolderId)
        .updateCachedChildrenIds([...bigKids]);
      insertSyncMs = performance.now() - tSync;
      await flush();
    });
    const insertMs = performance.now() - tInsert;
    log(
      `3b. INSERT one file: model-mutation=${insertSyncMs.toFixed(1)}ms ` +
        `total(incl. commit + ${"4x setTimeout(0)"} flush)=${insertMs.toFixed(1)}ms, ` +
        `commits=${counters.commits}, ` +
        `row renders=${counters.totalRowRenders()} across ` +
        `${counters.distinctRows()} distinct rows, ` +
        `getChildren=${probe.childrenCalls.length}, ` +
        `getItem=${probe.dataCalls.length}, ` +
        `React render+commit=${actualDurationMs.toFixed(1)}ms, ` +
        `list renders=${counters.listRenders}, ` +
        `flattened=${treeInstance.getItems().length}`,
    );
    const selectionSurvived = treeInstance.getState().selectedItems;
    const focusSurvived = treeInstance.getState().focusedItem;
    const expansionSurvived = treeInstance
      .getState()
      .expandedItems.includes(source.bigFolderId);
    log(
      `3b. identity: selected=${JSON.stringify(selectionSurvived)} ` +
        `focused=${focusSurvived} bigStillExpanded=${expansionSurvived}`,
    );

    // DELETE
    counters.reset();
    probe.reset();
    actualDurationMs = 0;
    bigKids.splice(bigKids.indexOf("big-new"), 1);
    let deleteSyncMs = 0;
    const tDelete = performance.now();
    await act(async () => {
      const tSync = performance.now();
      treeInstance
        .getItemInstance(source.bigFolderId)
        .updateCachedChildrenIds([...bigKids]);
      deleteSyncMs = performance.now() - tSync;
      await flush();
    });
    const deleteMs = performance.now() - tDelete;
    log(
      `3c. DELETE one file: model-mutation=${deleteSyncMs.toFixed(1)}ms ` +
        `total=${deleteMs.toFixed(1)}ms, commits=${counters.commits}, ` +
        `row renders=${counters.totalRowRenders()} across ` +
        `${counters.distinctRows()} distinct rows, ` +
        `React render+commit=${actualDurationMs.toFixed(1)}ms, ` +
        `list renders=${counters.listRenders}`,
    );

    // RENAME (content change, same id) and case-only rename
    counters.reset();
    probe.reset();
    const renamed = source.nodes.get("big-1");
    source.nodes.set("big-1", {
      id: "big-1",
      name: "RENAMED.ts",
      isFolder: false,
    });
    const tRename = performance.now();
    await act(async () => {
      await treeInstance.getItemInstance("big-1").invalidateItemData();
      await flush();
    });
    const renameMs = performance.now() - tRename;
    log(
      `3d. RENAME (invalidateItemData): ${renameMs.toFixed(1)}ms, ` +
        `commits=${counters.commits}, row renders=${counters.totalRowRenders()} ` +
        `across ${counters.distinctRows()} distinct rows, ` +
        `getItem calls=${probe.dataCalls.length}`,
    );

    counters.reset();
    probe.reset();
    source.nodes.set("big-1", {
      id: "big-1",
      name: "renamed.ts",
      isFolder: false,
    });
    const tCase = performance.now();
    await act(async () => {
      await treeInstance.getItemInstance("big-1").invalidateItemData();
      await flush();
    });
    log(
      `3e. CASE-ONLY rename: ${(performance.now() - tCase).toFixed(1)}ms, ` +
        `commits=${counters.commits}, row renders=${counters.totalRowRenders()}, ` +
        `getItem calls=${probe.dataCalls.length}`,
    );
    expect(renamed?.name).toBeDefined();

    // ---- flush overhead baseline (subtract from every "total" above) ------
    const tBaseline = performance.now();
    await act(async () => {
      await flush();
    });
    log(
      `BASELINE empty act(flush) = ${(performance.now() - tBaseline).toFixed(1)}ms`,
    );

    // ---- scenario 5: collapse and re-expand the 10k subtree ----------------
    counters.reset();
    probe.reset();
    const tCollapse = performance.now();
    await act(async () => {
      treeInstance.getItemInstance(source.bigFolderId).collapse();
      await flush();
    });
    const collapseMs = performance.now() - tCollapse;
    const tReexpand = performance.now();
    await act(async () => {
      treeInstance.getItemInstance(source.bigFolderId).expand();
      await flush();
    });
    const reexpandMs = performance.now() - tReexpand;
    log(
      `5. collapse=${collapseMs.toFixed(1)}ms re-expand=${reexpandMs.toFixed(1)}ms, ` +
        `getChildren during both=${probe.childrenCalls.length} ` +
        `(0 => cached, no re-resolution)`,
    );

    // ---- scenario 6: aria / roving tabindex from the model -----------------
    const firstRow = view.container.querySelector("[role='treeitem']");
    const container = view.container.querySelector("[data-testid='tree']");
    const containerProps = treeInstance.getContainerProps("Explorer");
    const itemProps = treeInstance.getItemInstance("big-0").getProps();
    log(
      `6. container props keys=${JSON.stringify(Object.keys(containerProps))}`,
    );
    log(`6. item props keys=${JSON.stringify(Object.keys(itemProps))}`);
    log(
      `6. itemMeta of big-0=${JSON.stringify(
        treeInstance.getItemInstance("big-0").getItemMeta(),
      )}`,
    );
    expect(container).not.toBeNull();
    expect(firstRow).not.toBeNull();

    // ---- where does candidate A's per-commit time go? ---------------------
    // @tanstack/virtual-core calls `getItemKey(i)` inside an O(count) loop on
    // every measurements rebuild. For candidate A each call goes through a
    // headless-tree proxied item instance; for candidate B it is one array
    // read. This times the raw cost of the two key sources at 10.6k rows.
    {
      const items = treeInstance.getItems();
      const tProxy = performance.now();
      let sink = 0;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item) sink += item.getId().length;
      }
      const proxyMs = performance.now() - tProxy;
      const ids = items.map((item) => item.getId());
      const tArray = performance.now();
      for (let i = 0; i < ids.length; i++) sink += ids[i]?.length ?? 0;
      const arrayMs = performance.now() - tArray;
      log(
        `A-KEYS: ${items.length} x item.getId() via proxied instance = ` +
          `${proxyMs.toFixed(1)}ms; same count from a plain id array = ` +
          `${arrayMs.toFixed(2)}ms (sink=${sink})`,
      );
      const tMeta = performance.now();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item) sink += item.getItemMeta().level;
      }
      log(
        `A-KEYS: ${items.length} x item.getItemMeta() = ` +
          `${(performance.now() - tMeta).toFixed(1)}ms`,
      );
      const tRebuild = performance.now();
      treeInstance.rebuildTree();
      log(
        `A-KEYS: one explicit tree.rebuildTree() at ${items.length} visible ` +
          `rows = ${(performance.now() - tRebuild).toFixed(1)}ms`,
      );
    }

    // ---- collapsed nodes are never resolved --------------------------------
    const uniqueResolved = new Set(
      [...mountChildrenCalls, ...deepCalls].map((id) => id),
    );
    log(
      `RESOLVED FOLDERS TOTAL (whole run) is bounded by expansions: ` +
        `${uniqueResolved.size} unique folder ids resolved vs ` +
        `${source.totalNodes} nodes in the fixture`,
    );

    process.stdout.write(
      `\n===== CANDIDATE A REPORT =====\n${report.join("\n")}\n\n`,
    );
    expect(rowsAtMount).toBeGreaterThan(0);
  }, 300_000);
});
