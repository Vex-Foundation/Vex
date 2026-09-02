/**
 * The explorer tree component: keyboard, ARIA, click, paging and lifecycle.
 *
 * Two properties here are the ones a virtualized tree gets wrong quietly:
 *
 *  - `aria-activedescendant` on the CONTAINER. A roving tabindex would put DOM
 *    focus on a row element that a scroll can unmount, at which point the
 *    browser drops focus to `body`. The attribute must name a row that is
 *    actually in the document, and be ABSENT when it is not.
 *  - THE ORDER IS MAIN'S. The load-more case deliberately serves a second page
 *    whose names sort BEFORE the first page's, so a renderer that re-sorted
 *    would be caught: main's comparator is what the cursor encodes a position
 *    in, and a re-sort makes every page boundary meaningless.
 *
 * Every subject is wrapped in `<StrictMode>`, the way the B2 controller suite
 * does it, because the acquire/release contract only shows its seams under the
 * double-invoked effect.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "@shared/schemas/files.js";
import { ExplorerRegistry } from "../explorer-registry.js";
import { ExplorerTree } from "../ExplorerTree.js";
import {
  FilesApiFake,
  directoryNode,
  fileNode,
  listingOf,
  testViewport,
} from "./explorer-harness.js";

let api: FilesApiFake;
let registry: ExplorerRegistry;

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

async function flush(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

function tree(): HTMLElement {
  return screen.getByRole("tree");
}

function rowNames(): string[] {
  return screen.getAllByRole("treeitem").map((row) => row.textContent ?? "");
}

function rowFor(name: string): HTMLElement {
  const match = screen
    .getAllByRole("treeitem")
    .find((row) => (row.textContent ?? "").includes(name));
  if (match === undefined) throw new Error(`no row for ${name}`);
  return match;
}

function activeRow(): HTMLElement | null {
  const id = tree().getAttribute("aria-activedescendant");
  return id === null ? null : document.getElementById(id);
}

/** A small workspace: one folder with two files, plus a top-level file. */
function standardTree(): void {
  api.listResponder = (call) =>
    call.nodeId === null
      ? {
          ok: true,
          data: {
            ok: true,
            value: listingOf([
              directoryNode("src", "src"),
              fileNode("readme.md", "readme.md"),
              fileNode("tsconfig.json", "tsconfig.json"),
            ]),
          },
        }
      : {
          ok: true,
          data: {
            ok: true,
            value: listingOf([
              fileNode("alpha.ts", "src/alpha.ts"),
              fileNode("beta.ts", "src/beta.ts"),
            ]),
          },
        };
}

async function mountTree(
  onOpenFile: (node: FileNode) => void = () => undefined,
  driftedPaths?: ReadonlyMap<string, string>,
): Promise<void> {
  render(
    <StrictMode>
      <ExplorerTree
        projectId="p1"
        onOpenFile={onOpenFile}
        registry={registry}
        viewport={testViewport}
        driftedPaths={driftedPaths}
      />
    </StrictMode>,
  );
  await flush();
}

beforeEach(() => {
  api = new FilesApiFake();
  registry = new ExplorerRegistry((run) => {
    queueMicrotask(run);
  });
  document.body.innerHTML = "";
});

afterEach(async () => {
  await registry.disposeAll();
  vi.useRealTimers();
});

describe("mount and lifecycle", () => {
  it("opens exactly ONE watch and ONE listener under StrictMode", async () => {
    standardTree();
    await mountTree();

    // StrictMode runs setup, cleanup, setup. The registry's deferred teardown
    // is what stops that becoming two subscriptions in development only.
    expect(api.watchCount).toBe(1);
    expect(api.listenCount).toBe(1);
    expect(rowNames()).toHaveLength(3);
  });

  it("releases exactly once on unmount", async () => {
    standardTree();
    const view = render(
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
    expect(registry.consumerCount("p1")).toBe(1);

    view.unmount();
    await flush();

    expect(registry.sessionCount()).toBe(0);
    expect(api.unwatchCount).toBe(1);
    expect(api.offCount).toBe(1);
  });
});

describe("aria", () => {
  it("is a tree of treeitems with level, position and set size", async () => {
    standardTree();
    await mountTree();

    expect(tree().getAttribute("tabindex")).toBe("0");
    expect(tree().getAttribute("aria-label")).toBe("Project files");

    const src = rowFor("src");
    expect(src.getAttribute("aria-level")).toBe("1");
    expect(src.getAttribute("aria-posinset")).toBe("1");
    expect(src.getAttribute("aria-setsize")).toBe("3");

    fireEvent.keyDown(tree(), { key: "ArrowRight" });
    await flush();
    const alpha = rowFor("alpha.ts");
    expect(alpha.getAttribute("aria-level")).toBe("2");
    expect(alpha.getAttribute("aria-posinset")).toBe("1");
    expect(alpha.getAttribute("aria-setsize")).toBe("2");
  });

  it("puts aria-expanded on directories and NEVER on files", async () => {
    standardTree();
    await mountTree();

    expect(rowFor("src").getAttribute("aria-expanded")).toBe("false");
    // A false on a leaf announces a file as a collapsed group.
    expect(rowFor("readme.md").hasAttribute("aria-expanded")).toBe(false);

    fireEvent.keyDown(tree(), { key: "ArrowRight" });
    await flush();
    expect(rowFor("src").getAttribute("aria-expanded")).toBe("true");
    expect(rowFor("alpha.ts").hasAttribute("aria-expanded")).toBe(false);
  });

  it("moves aria-activedescendant with the focused row", async () => {
    standardTree();
    await mountTree();
    expect(tree().hasAttribute("aria-activedescendant")).toBe(false);

    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    await flush();
    expect(activeRow()?.textContent).toContain("src");

    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    await flush();
    expect(activeRow()?.textContent).toContain("readme.md");

    fireEvent.keyDown(tree(), { key: "End" });
    await flush();
    expect(activeRow()?.textContent).toContain("tsconfig.json");

    fireEvent.keyDown(tree(), { key: "Home" });
    await flush();
    expect(activeRow()?.textContent).toContain("src");
  });

  /**
   * A POINTER CLICK MUST LAND KEYBOARD FOCUS ON THE TREE.
   *
   * `aria-activedescendant` is only half the contract. It names the active row,
   * but a screen reader announces it and the arrow keys reach it only while the
   * CONTAINER holds real DOM focus - and the container is the only focusable
   * element here, because the rows deliberately are not. A user who clicks a row
   * and then presses ArrowDown must move within the tree, not scroll the page.
   *
   * The keyboard cases above dispatch keys AT the container and so can never
   * observe this: they assume the focus that this test is about establishing.
   */
  it("puts DOM focus on the tree container when a row is CLICKED", async () => {
    standardTree();
    await mountTree();
    expect(document.activeElement).not.toBe(tree());

    const row = rowFor("readme.md");
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    await flush();

    expect(document.activeElement).toBe(tree());
    // And the click also moved the active row, so the two halves agree.
    expect(activeRow()?.textContent).toContain("readme.md");
  });

  it("keeps the keyboard working after a click, from the clicked row", async () => {
    standardTree();
    await mountTree();

    const row = rowFor("readme.md");
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    await flush();

    // The proof that the focus above is the useful kind: the very next key is
    // dispatched at whatever the DOCUMENT says is focused - not at the tree by
    // name, which is what the keyboard cases above assume - and it still
    // continues from where the pointer left off.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
    await flush();
    expect(activeRow()?.textContent).toContain("tsconfig.json");
  });

  it("describes a directory whose entries the ignore rules hid", async () => {
    api.listResponder = (call) =>
      call.nodeId === null
        ? { ok: true, data: { ok: true, value: listingOf([directoryNode("src", "src")]) } }
        : {
            ok: true,
            data: {
              ok: true,
              value: listingOf([fileNode("a.ts", "src/a.ts")], { excludedCount: 42 }),
            },
          };
    await mountTree();
    fireEvent.click(rowFor("src"));
    await flush();

    const row = rowFor("src");
    expect(row.getAttribute("aria-describedby")).not.toBeNull();
    expect(within(row).getByText("42 entries hidden by ignore rules")).toBeTruthy();
  });

  it("describes the ROOT's hidden entries on the tree, which has no row", async () => {
    // node_modules and .git are hidden at the project root, and the root has no
    // row of its own - so without this the most commonly filtered directory in
    // the product is the one nobody is told about.
    api.listResponder = () => ({
      ok: true,
      data: {
        ok: true,
        value: listingOf([fileNode("readme.md", "readme.md")], { excludedCount: 7 }),
      },
    });
    await mountTree();

    const describedBy = tree().getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "7 entries hidden by ignore rules",
    );
  });

  it("marks the selected row and nothing else", async () => {
    standardTree();
    await mountTree();

    fireEvent.click(rowFor("readme.md"));
    await flush();

    expect(rowFor("readme.md").getAttribute("aria-selected")).toBe("true");
    expect(rowFor("src").getAttribute("aria-selected")).toBe("false");
  });
});

describe("keyboard", () => {
  it("ArrowRight expands, then moves to the first child", async () => {
    standardTree();
    await mountTree();
    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    await flush();

    fireEvent.keyDown(tree(), { key: "ArrowRight" });
    await flush();
    expect(rowFor("src").getAttribute("aria-expanded")).toBe("true");
    // Expanding does not move focus; that is the second press.
    expect(activeRow()?.textContent).toContain("src");

    fireEvent.keyDown(tree(), { key: "ArrowRight" });
    await flush();
    expect(activeRow()?.textContent).toContain("alpha.ts");
  });

  it("ArrowLeft collapses, then moves to the parent", async () => {
    standardTree();
    await mountTree();
    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    fireEvent.keyDown(tree(), { key: "ArrowRight" });
    await flush();
    fireEvent.keyDown(tree(), { key: "ArrowRight" });
    await flush();
    expect(activeRow()?.textContent).toContain("alpha.ts");

    // A file has nothing to collapse, so Left goes to the parent.
    fireEvent.keyDown(tree(), { key: "ArrowLeft" });
    await flush();
    expect(activeRow()?.textContent).toContain("src");

    fireEvent.keyDown(tree(), { key: "ArrowLeft" });
    await flush();
    expect(rowFor("src").getAttribute("aria-expanded")).toBe("false");
    expect(activeRow()?.textContent).toContain("src");
  });

  it("ArrowRight on a file does nothing at all", async () => {
    standardTree();
    await mountTree();
    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    await flush();
    const before = rowNames();

    fireEvent.keyDown(tree(), { key: "ArrowRight" });
    await flush();

    expect(rowNames()).toEqual(before);
    expect(activeRow()?.textContent).toContain("readme.md");
  });

  it("Enter toggles a directory and opens a file", async () => {
    standardTree();
    const opened: FileNode[] = [];
    await mountTree((node) => opened.push(node));

    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    fireEvent.keyDown(tree(), { key: "Enter" });
    await flush();
    expect(rowFor("src").getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    fireEvent.keyDown(tree(), { key: "Enter" });
    await flush();

    expect(opened).toHaveLength(1);
    expect(opened[0]?.path).toBe("src/alpha.ts");
    expect(opened[0]?.nodeId).toBe("id:src/alpha.ts");
  });

  it("Space toggles a directory and does nothing on a file", async () => {
    standardTree();
    const opened: FileNode[] = [];
    await mountTree((node) => opened.push(node));

    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    fireEvent.keyDown(tree(), { key: " " });
    await flush();
    expect(rowFor("src").getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(tree(), { key: "ArrowLeft" });
    await flush();
    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    fireEvent.keyDown(tree(), { key: " " });
    await flush();
    expect(opened).toHaveLength(0);
  });

  it("moving focus never expands or loads anything", async () => {
    standardTree();
    await mountTree();
    const listingsBefore = api.listCalls.length;

    for (const key of ["ArrowDown", "ArrowDown", "End", "Home", "PageDown", "PageUp"]) {
      fireEvent.keyDown(tree(), { key });
    }
    await flush();

    expect(api.listCalls).toHaveLength(listingsBefore);
    expect(rowFor("src").getAttribute("aria-expanded")).toBe("false");
  });

  it("type-ahead jumps to the next match and resets after one second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    standardTree();
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

    fireEvent.keyDown(tree(), { key: "t" });
    await flush();
    expect(activeRow()?.textContent).toContain("tsconfig.json");

    // Within the window: "tr" matches nothing, so focus stays put.
    vi.advanceTimersByTime(200);
    fireEvent.keyDown(tree(), { key: "r" });
    await flush();
    expect(activeRow()?.textContent).toContain("tsconfig.json");

    // Past the window: "r" is a fresh prefix and finds readme.md.
    vi.advanceTimersByTime(1_500);
    fireEvent.keyDown(tree(), { key: "r" });
    await flush();
    expect(activeRow()?.textContent).toContain("readme.md");
  });

  it("lets an application chord through instead of typing into the tree", async () => {
    standardTree();
    await mountTree();
    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    await flush();

    fireEvent.keyDown(tree(), { key: "t", ctrlKey: true });
    await flush();

    expect(activeRow()?.textContent).toContain("src");
  });
});

describe("mouse", () => {
  it("click focuses and selects, toggles a directory, opens a file", async () => {
    standardTree();
    const opened: FileNode[] = [];
    await mountTree((node) => opened.push(node));

    fireEvent.click(rowFor("src"));
    await flush();
    expect(rowFor("src").getAttribute("aria-expanded")).toBe("true");
    expect(activeRow()?.textContent).toContain("src");

    fireEvent.click(rowFor("alpha.ts"));
    await flush();
    expect(opened.map((node) => node.path)).toEqual(["src/alpha.ts"]);

    fireEvent.click(rowFor("src"));
    await flush();
    expect(rowFor("src").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("paging", () => {
  it("loads the next page and APPENDS it in the order received", async () => {
    api.listResponder = (call) =>
      call.cursor === "c1"
        ? {
            ok: true,
            data: {
              ok: true,
              // Names that sort BEFORE the first page. A renderer that re-sorted
              // would put them first and this assertion would catch it.
              value: listingOf([fileNode("aaa.ts"), fileNode("bbb.ts")], { totalCount: 4 }),
            },
          }
        : {
            ok: true,
            data: {
              ok: true,
              value: listingOf([fileNode("zzz.ts"), fileNode("yyy.ts")], {
                hasMore: true,
                nextCursor: "c1",
                totalCount: 4,
              }),
            },
          };
    await mountTree();

    const more = rowFor("Show 2 more entries");
    expect(more.getAttribute("aria-posinset")).toBe("3");
    expect(more.getAttribute("aria-setsize")).toBe("3");

    fireEvent.click(more);
    await flush();

    expect(rowNames()).toEqual(["zzz.ts", "yyy.ts", "aaa.ts", "bbb.ts"]);
  });

  it("loads the next page from the keyboard too", async () => {
    api.listResponder = (call) =>
      call.cursor === "c1"
        ? { ok: true, data: { ok: true, value: listingOf([fileNode("p2.ts")], { totalCount: 2 }) } }
        : {
            ok: true,
            data: {
              ok: true,
              value: listingOf([fileNode("p1.ts")], {
                hasMore: true,
                nextCursor: "c1",
                totalCount: 2,
              }),
            },
          };
    await mountTree();

    // End is ABSOLUTE: with nothing focused it must reach the last row, not
    // enter the list at the first one.
    fireEvent.keyDown(tree(), { key: "End" });
    fireEvent.keyDown(tree(), { key: "Enter" });
    await flush();

    expect(rowNames()).toEqual(["p1.ts", "p2.ts"]);
  });
});

describe("notices", () => {
  it("shows an empty project as a row, not as a blank panel", async () => {
    api.listResponder = () => ({ ok: true, data: { ok: true, value: listingOf([]) } });
    await mountTree();

    expect(rowNames()).toEqual(["This project has no files yet"]);
    // INFORMATION, not a failure. A notice row has no twistie, so the warning
    // mark would be the only glyph on the line - and it would claim something
    // is wrong with a project that is merely new.
    expect(rowFor("This project has no files yet").querySelectorAll("svg")).toHaveLength(0);
  });

  it("retries a failed folder from the notice row", async () => {
    let failed = false;
    api.listResponder = (call) => {
      if (call.nodeId === null) {
        return {
          ok: true,
          data: { ok: true, value: listingOf([directoryNode("src", "src")]) },
        };
      }
      if (!failed) {
        failed = true;
        return { ok: true, data: { ok: false, code: "io_error" } };
      }
      return { ok: true, data: { ok: true, value: listingOf([fileNode("a.ts", "src/a.ts")]) } };
    };
    await mountTree();

    fireEvent.click(rowFor("src"));
    await flush();
    const notice = rowFor("This folder could not be read.");
    expect(notice.getAttribute("data-row-kind")).toBe("notice");
    // A FAILURE keeps the mark.
    expect(notice.querySelectorAll("svg")).toHaveLength(1);

    fireEvent.click(notice);
    await flush();

    expect(rowNames()).toEqual(["src", "a.ts"]);
  });
});

describe("motion", () => {
  it("rotates the twistie through the shared motion primitive", async () => {
    standardTree();
    await mountTree();

    const twistie = rowFor("src").querySelector("svg");
    expect(twistie).not.toBeNull();
    // CONTRACT CHANGE (B5.2 motion pass). The guard used to be a per-call-site
    // `motion-reduce:transition-none` utility next to a hardcoded
    // `duration-150`. Both moved into `.vex-twistie`, which states the duration
    // as `--vex-duration-base` and its own reduced-motion collapse ONCE; the
    // promise to the user is unchanged - a user who asked the OS for less
    // motion gets no rotation on expand - and the CSS half of it is asserted by
    // styles/global-css/__tests__/motion-tokens.test.ts.
    expect(twistie?.getAttribute("class") ?? "").toContain("vex-twistie");
    expect(twistie?.getAttribute("class") ?? "").not.toContain("duration-150");
  });

  it("settles the row fill through the shared tint primitive", async () => {
    standardTree();
    await mountTree();

    // Selection and hover share one fill, so the row - not the glyph - is what
    // carries the colour transition.
    expect(rowFor("src").getAttribute("class") ?? "").toContain("vex-tint");
  });
});

/**
 * DECORATIONS: a drifted Vex-managed FILE carries the badge too (finding A7).
 *
 * VS Code's explorer puts this class of fact on the resource it is ABOUT
 * (`explorerDecorationsProvider.ts`, exercised in `explorerView.test.ts` by
 * calling `provideDecorations(stat)` per state), not only on the root above it.
 * Ours said "something Vex wrote has drifted" on the project row and left the
 * user to guess which file.
 *
 * The tree does not DECIDE any of this: the project owns the drift fact and the
 * sidebar hands down a path map, which is why these cases drive the prop
 * directly rather than inventing a second source of truth to assert against.
 */
describe("drift decorations", () => {
  it("badges the named file, in words, and leaves every other row alone", async () => {
    standardTree();
    await mountTree(
      () => undefined,
      new Map([["readme.md", "readme.md: Edited since Vex wrote it"]]),
    );

    const badged = rowFor("readme.md");
    expect(
      within(badged).getByText("readme.md: Edited since Vex wrote it"),
    ).not.toBeNull();
    expect(badged.querySelector("[data-vex-file-drift]")).not.toBeNull();
    // The dot is colour-only, so the words are what assistive technology gets.
    expect(
      rowFor("tsconfig.json").querySelector("[data-vex-file-drift]"),
    ).toBeNull();
  });

  it("decorates by PATH, not by name: a same-named file elsewhere is clean", async () => {
    // Two `alpha.ts` would be one bug: the map is keyed by the project-relative
    // path precisely because names repeat across folders.
    standardTree();
    await mountTree(
      () => undefined,
      new Map([["src/alpha.ts", "alpha.ts: Missing from the project folder"]]),
    );
    fireEvent.click(rowFor("src"));
    await flush();

    expect(
      rowFor("src/alpha.ts".split("/")[1] ?? "alpha.ts").querySelector(
        "[data-vex-file-drift]",
      ),
    ).not.toBeNull();
    expect(rowFor("beta.ts").querySelector("[data-vex-file-drift]")).toBeNull();
  });

  it("never badges a DIRECTORY, even when a drifted path names one", async () => {
    // A folder is not a Vex-managed artifact, and a badge on one would claim a
    // state no project DTO reports.
    standardTree();
    await mountTree(() => undefined, new Map([["src", "src: Edited since Vex wrote it"]]));
    expect(rowFor("src").querySelector("[data-vex-file-drift]")).toBeNull();
  });

  it("renders no decoration slot at all with no map (every other mount)", async () => {
    standardTree();
    await mountTree();
    expect(document.querySelector("[data-vex-file-drift]")).toBeNull();
  });
});
