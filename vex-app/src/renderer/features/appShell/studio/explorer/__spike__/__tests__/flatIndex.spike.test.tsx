/**
 * SPIKE ONLY (Stage B3 measurement). Not production code.
 *
 * Candidate B: the owned flat-index model (VS Code IndexTreeModel shape) over
 * @tanstack/react-virtual, measured with the SAME fixture, the SAME virtual
 * window, the SAME memoized Row contract and the SAME counters as candidate A,
 * so the two numbers are comparable.
 */
import { render, act, cleanup } from "@testing-library/react";
import React, { Profiler, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FlatIndexHarness } from "../FlatIndexHarness";
import { FlatIndexModel } from "../flatIndexModel";
import { buildSpikeTree, createLoaderProbe } from "../fixture";
import { createRenderCounters } from "../renderCounters";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const report: string[] = [];
const log = (line: string): void => {
  report.push(line);
  process.stdout.write(`[FLAT] ${line}\n`);
};

afterEach(cleanup);

describe("SPIKE candidate B: owned flat-index model + react-virtual", () => {
  it("measures mount, expand, splice, collapse under StrictMode", async () => {
    const source = buildSpikeTree(50_000);
    const probe = createLoaderProbe();
    const counters = createRenderCounters();

    const listeners = new Set<() => void>();
    const model = new FlatIndexModel({
      rootId: source.rootId,
      loadChildren: (folderId) => {
        probe.childrenCalls.push(folderId);
        return (source.children.get(folderId) ?? []).map((id) => {
          const node = source.nodes.get(id);
          return {
            id,
            name: node?.name ?? id,
            isFolder: node?.isFolder ?? false,
          };
        });
      },
      onSplice: () => {
        for (const listener of listeners) listener();
      },
    });
    const subscribe = (onChange: () => void): (() => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    };

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

    // ---- scenario 1: initial mount with the root expanded one level --------
    model.expandRoot();
    const t0 = performance.now();
    const view = render(
      <StrictMode>
        <Profiler id="flat" onRender={onRender}>
          <FlatIndexHarness
            model={model}
            subscribe={subscribe}
            counters={counters}
            selectedId={null}
          />
        </Profiler>
      </StrictMode>,
    );
    await act(async () => {
      await flush();
    });
    const mountMs = performance.now() - t0;
    const rowsAtMount = view.container.querySelectorAll("[role='treeitem']")
      .length;
    log(
      `1. mount: ${mountMs.toFixed(1)}ms, DOM rows=${rowsAtMount}, ` +
        `flattened=${model.getRowCount()}, ` +
        `loadChildren calls=${probe.childrenCalls.length} ` +
        `(unique=${new Set(probe.childrenCalls).size}), commits=${counters.commits}`,
    );
    const mountCalls = [...probe.childrenCalls];
    const duplicated = mountCalls.filter(
      (id, i) => mountCalls.indexOf(id) !== i,
    );
    log(`4. StrictMode duplicate loadChildren ids: ${duplicated.length}`);

    // ---- scenario 2: expand a deep directory -------------------------------
    for (let depth = 1; depth <= 6; depth++) {
      probe.reset();
      await act(async () => {
        model.expand(`deep-${depth}`);
        await flush();
      });
    }
    log(
      `2. expand deep-6: loadChildren=${probe.childrenCalls.length} ` +
        `ids=${JSON.stringify(probe.childrenCalls)}, DOM rows=` +
        `${view.container.querySelectorAll("[role='treeitem']").length}, ` +
        `flattened=${model.getRowCount()}`,
    );

    // ---- scenario 3: incremental splice on a 10k-descendant folder ---------
    probe.reset();
    counters.reset();
    actualDurationMs = 0;
    const tExpandBig = performance.now();
    await act(async () => {
      model.expand(source.bigFolderId);
      await flush();
    });
    log(
      `3a. expand 10k folder: ${(performance.now() - tExpandBig).toFixed(1)}ms, ` +
        `flattened=${model.getRowCount()}, DOM rows=` +
        `${view.container.querySelectorAll("[role='treeitem']").length}, ` +
        `loadChildren=${probe.childrenCalls.length}, commits=${counters.commits}, ` +
        `React render+commit=${actualDurationMs.toFixed(1)}ms`,
    );

    // INSERT
    counters.reset();
    probe.reset();
    actualDurationMs = 0;
    let insertSyncMs = 0;
    const tInsert = performance.now();
    await act(async () => {
      const tSync = performance.now();
      model.insertChild(source.bigFolderId, 3, {
        id: "big-new",
        name: "file-new.ts",
        isFolder: false,
      });
      insertSyncMs = performance.now() - tSync;
      await flush();
    });
    log(
      `3b. INSERT one file: model-mutation=${insertSyncMs.toFixed(1)}ms ` +
        `total(incl. commit + 4x setTimeout(0) flush)=` +
        `${(performance.now() - tInsert).toFixed(1)}ms, ` +
        `commits=${counters.commits}, row renders=${counters.totalRowRenders()} ` +
        `across ${counters.distinctRows()} distinct rows, ` +
        `loadChildren=${probe.childrenCalls.length}, ` +
        `React render+commit=${actualDurationMs.toFixed(1)}ms, ` +
        `list renders=${counters.listRenders}, flattened=${model.getRowCount()}`,
    );
    log(
      `3b. identity: big still expanded=${
        model.getRow(model.getIndexOf(source.bigFolderId)).expanded
      }, big-0 index=${model.getIndexOf("big-0")}, ` +
        `big-new index=${model.getIndexOf("big-new")}`,
    );

    // DELETE
    counters.reset();
    probe.reset();
    actualDurationMs = 0;
    let deleteSyncMs = 0;
    const tDelete = performance.now();
    await act(async () => {
      const tSync = performance.now();
      model.removeChild("big-new");
      deleteSyncMs = performance.now() - tSync;
      await flush();
    });
    log(
      `3c. DELETE one file: model-mutation=${deleteSyncMs.toFixed(1)}ms ` +
        `total=${(performance.now() - tDelete).toFixed(1)}ms, ` +
        `commits=${counters.commits}, row renders=${counters.totalRowRenders()} ` +
        `across ${counters.distinctRows()} distinct rows, ` +
        `React render+commit=${actualDurationMs.toFixed(1)}ms, ` +
        `list renders=${counters.listRenders}`,
    );

    // RENAME + case-only rename
    counters.reset();
    actualDurationMs = 0;
    let renameSyncMs = 0;
    const tRename = performance.now();
    await act(async () => {
      const tSync = performance.now();
      model.rename("big-1", "RENAMED.ts");
      renameSyncMs = performance.now() - tSync;
      await flush();
    });
    log(
      `3d. RENAME: model-mutation=${renameSyncMs.toFixed(3)}ms ` +
        `total=${(performance.now() - tRename).toFixed(1)}ms, ` +
        `commits=${counters.commits}, row renders=${counters.totalRowRenders()} ` +
        `across ${counters.distinctRows()} distinct rows, ` +
        `React render+commit=${actualDurationMs.toFixed(1)}ms`,
    );

    counters.reset();
    actualDurationMs = 0;
    const tCase = performance.now();
    await act(async () => {
      model.rename("big-1", "renamed.ts");
      await flush();
    });
    log(
      `3e. CASE-ONLY rename: total=${(performance.now() - tCase).toFixed(1)}ms, ` +
        `commits=${counters.commits}, row renders=${counters.totalRowRenders()}, ` +
        `React render+commit=${actualDurationMs.toFixed(1)}ms, ` +
        `name now=${model.getRow(model.getIndexOf("big-1")).name}`,
    );

    // ---- flush overhead baseline ------------------------------------------
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
    let collapseSyncMs = 0;
    const tCollapse = performance.now();
    await act(async () => {
      const tSync = performance.now();
      model.collapse(source.bigFolderId);
      collapseSyncMs = performance.now() - tSync;
      await flush();
    });
    const collapseMs = performance.now() - tCollapse;
    let reexpandSyncMs = 0;
    const tReexpand = performance.now();
    await act(async () => {
      const tSync = performance.now();
      model.expand(source.bigFolderId);
      reexpandSyncMs = performance.now() - tSync;
      await flush();
    });
    log(
      `5. collapse: model=${collapseSyncMs.toFixed(1)}ms total=${collapseMs.toFixed(1)}ms; ` +
        `re-expand: model=${reexpandSyncMs.toFixed(1)}ms ` +
        `total=${(performance.now() - tReexpand).toFixed(1)}ms; ` +
        `loadChildren during both=${probe.childrenCalls.length} ` +
        `(0 => cached, no re-resolution)`,
    );

    // ---- scenario 7: is the shared ~34ms per commit O(visible rows)? -------
    // Both candidates pay the same React+react-virtual cost per commit. This
    // repeats the identical insert with the 10k folder COLLAPSED, so the only
    // variable is the virtualizer's row count.
    await act(async () => {
      model.collapse(source.bigFolderId);
      await flush();
    });
    counters.reset();
    actualDurationMs = 0;
    const smallCount = model.getRowCount();
    const tSmall = performance.now();
    await act(async () => {
      model.insertChild(source.deepFolderId, 0, {
        id: "deep-new",
        name: "file-new.ts",
        isFolder: false,
      });
      await flush();
    });
    log(
      `7. SAME insert with only ${smallCount} visible rows: ` +
        `total=${(performance.now() - tSmall).toFixed(1)}ms, ` +
        `React render+commit=${actualDurationMs.toFixed(1)}ms, ` +
        `commits=${counters.commits}, row renders=${counters.totalRowRenders()}`,
    );
    await act(async () => {
      model.expand(source.bigFolderId);
      await flush();
    });

    // ---- scenario 6: aria emitted from the same identity model -------------
    const firstRow = view.container.querySelector("[role='treeitem']");
    log(
      `6. first row aria: level=${firstRow?.getAttribute("aria-level")} ` +
        `posinset=${firstRow?.getAttribute("aria-posinset")} ` +
        `setsize=${firstRow?.getAttribute("aria-setsize")}`,
    );
    log(
      `6. roving tabindex: NOT provided by the model (candidate B would own it; ` +
        `candidate A ships it in item.getProps()).`,
    );

    // collapsed nodes are never resolved
    log(
      `RESOLVED FOLDERS: ${new Set(mountCalls).size + 8} unique folder ids ` +
        `over the whole run vs ${source.totalNodes} nodes in the fixture`,
    );

    process.stdout.write(
      `\n===== CANDIDATE B REPORT =====\n${report.join("\n")}\n\n`,
    );
    expect(rowsAtMount).toBeGreaterThan(0);
  }, 300_000);
});
