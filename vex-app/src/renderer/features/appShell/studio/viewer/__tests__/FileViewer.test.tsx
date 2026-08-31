/**
 * The file viewer component: what a person actually sees.
 *
 * The session suite proves the rules; this proves they REACH the screen, plus
 * the three things only a rendered DOM can show:
 *
 *  - the file text never becomes HTML. A file containing `<img onerror=...>`
 *    must appear as those characters, not as an element. The build gate bans
 *    `dangerouslySetInnerHTML` in renderer source, but a gate on an attribute
 *    is not a proof about output, and this is.
 *  - line numbers are decoration: `aria-hidden` and unselectable, so a screen
 *    reader does not read "forty-two" before every line and Select All does not
 *    paste the gutter into the user's clipboard.
 *  - a StrictMode double mount reads the file ONCE. The registry's deferred
 *    teardown is what buys that, and it is invisible without a real remount.
 */

import { StrictMode, type JSX } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileTab } from "../../workspace/types.js";
import { FileViewer } from "../FileViewer.js";
import { FileViewerRegistry } from "../file-viewer-registry.js";
import { VIEWER_HIGHLIGHT_MAX_BYTES } from "../file-viewer-session.js";
import { ExplorerRegistry } from "../../explorer/explorer-registry.js";
import {
  FakeHighlighterPort,
  FileApiFake,
  contentOf,
  ok,
  refused,
  transportFailure,
} from "./viewer-harness.js";
import {
  FilesApiFake,
  listingOf,
  testViewport,
} from "../../explorer/__tests__/explorer-harness.js";

let files: FileApiFake;
let tree: FilesApiFake;
let highlighter: FakeHighlighterPort;
let registry: FileViewerRegistry;
let clipboard: { writeText: ReturnType<typeof vi.fn> };

vi.mock("../../../../../lib/api/files.js", () => ({
  readProjectFile: (projectId: string, nodeId: string) => files.readFile(projectId, nodeId),
  listProjectChildren: (input: Parameters<FilesApiFake["listChildren"]>[0]) =>
    tree.listChildren(input),
  watchProjectFiles: (input: Parameters<FilesApiFake["watchFile"]>[0]) => tree.watchFile(input),
  unwatchProjectFiles: (subscriptionId: string) => tree.unwatchFile({ subscriptionId }),
  onProjectFilesEvent: (
    subscriptionId: string,
    cb: Parameters<FilesApiFake["onFilesEvent"]>[1],
  ) => tree.onFilesEvent(subscriptionId, cb),
}));

const TAB: WorkspaceFileTab = {
  kind: "file",
  tabId: "tab-1",
  title: "a.ts",
  relativePath: "src/a.ts",
  nodeId: "node-1",
  dirty: false,
};

beforeEach(() => {
  files = new FileApiFake();
  tree = new FilesApiFake();
  tree.listResponder = () => ({ ok: true, data: { ok: true, value: listingOf([]) } });
  highlighter = new FakeHighlighterPort();
  registry = new FileViewerRegistry({
    createHighlighter: () => highlighter,
    explorers: new ExplorerRegistry(),
  });
  clipboard = { writeText: vi.fn(() => Promise.resolve()) };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  document.body.innerHTML = "";
});

afterEach(() => {
  registry.disposeAll();
  vi.restoreAllMocks();
});

function View({
  active = true,
  tab = TAB,
}: {
  readonly active?: boolean;
  readonly tab?: WorkspaceFileTab;
}): JSX.Element {
  return (
    <FileViewer
      projectId="p1"
      tab={tab}
      active={active}
      registry={registry}
      viewport={testViewport}
    />
  );
}

/** Mount and let the read plus its publication settle. */
async function mount(props: Parameters<typeof View>[0] = {}): Promise<void> {
  await act(async () => {
    render(<View {...props} />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function lineTexts(): string[] {
  return [...document.querySelectorAll("[data-line]")].map(
    (row) => row.lastElementChild?.textContent ?? "",
  );
}

/* ------------------------------------------------------------------ *
 * The header
 * ------------------------------------------------------------------ */

describe("the header strip", () => {
  it("shows the path, the language and the size", async () => {
    files.responder = () => ok(contentOf("const a = 1;\n"));
    await mount();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("TypeScript")).toBeTruthy();
    expect(screen.getByText("13 B")).toBeTruthy();
  });

  it("copies the RAW text and names the action for a screen reader", async () => {
    files.responder = () => ok(contentOf("line one\r\nline two\n"));
    await mount();

    const copy = screen.getByRole("button", { name: "Copy file contents" });
    await act(async () => {
      fireEvent.click(copy);
      await Promise.resolve();
    });

    // The RAW text, `\r\n` and all: reassembling it from the rendered spans
    // would silently normalise line endings the file actually contains.
    expect(clipboard.writeText).toHaveBeenCalledWith("line one\r\nline two\n");
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("disables Copy when there is nothing to copy", async () => {
    files.responder = () => refused("binary");
    await mount();
    const copy = screen.getByRole("button", { name: "Copy file contents" });
    expect(copy.hasAttribute("disabled")).toBe(true);
    fireEvent.click(copy);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Answers
 * ------------------------------------------------------------------ */

describe("refusals are answers about the file", () => {
  it("names the REAL size and the bound on too_large", async () => {
    files.responder = () => refused("too_large", 3_145_728);
    await mount();
    const refusal = screen.getByTestId("file-viewer-refusal");
    expect(refusal.textContent).toContain("3.0 MiB");
    expect(refusal.textContent).toContain("2.0 MiB");
    // No escape hatch: the refusal is main's and the renderer cannot grant
    // itself a capability the privileged process declined.
    expect(screen.queryByRole("button", { name: /open anyway/i })).toBeNull();
  });

  it.each([
    ["binary", /binary/i],
    ["invalid_utf8", /UTF-8/],
    ["symlinked_path", /symbolic link/i],
    ["not_a_file", /not a regular file/i],
    ["project_closed", /project is closed/i],
    ["not_found", /no longer on disk/i],
  ] as const)("explains %s in its own words", async (code, matcher) => {
    files.responder = () => refused(code);
    await mount();
    expect(screen.getByTestId("file-viewer-refusal").textContent).toMatch(matcher);
  });

  it("offers Retry on a transport failure, and it re-reads", async () => {
    files.responder = transportFailure;
    await mount();
    expect(screen.getByTestId("file-viewer-failure")).toBeTruthy();

    files.responder = () => ok(contentOf("recovered\n"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(lineTexts()).toContain("recovered");
  });
});

/* ------------------------------------------------------------------ *
 * The chip
 * ------------------------------------------------------------------ */

describe("the chip names every bound", () => {
  it("says why a file with no grammar has no colour", async () => {
    files.responder = () => ok(contentOf("plain words\n"));
    await mount({ tab: { ...TAB, relativePath: "notes.txt" } });
    expect(screen.getByTestId("file-viewer-chip").textContent).toContain("no grammar");
  });

  it("names the size AND the limit when the file is too large to highlight", async () => {
    files.responder = () => ok(contentOf("x".repeat(VIEWER_HIGHLIGHT_MAX_BYTES + 1)));
    await mount();
    const chip = screen.getByTestId("file-viewer-chip").textContent ?? "";
    expect(chip).toContain("512 KiB");
    expect(chip).toMatch(/over the .* highlighting limit/);
  });

  it("names a dead highlighter rather than showing grey code in silence", async () => {
    files.responder = () => ok(contentOf("const a = 1;\n"));
    await mount();
    await act(async () => {
      highlighter.failOldest("worker_unavailable");
      await Promise.resolve();
    });
    expect(screen.getByTestId("file-viewer-chip").textContent).toContain(
      "highlighter is unavailable",
    );
    // And the file is still fully readable.
    expect(lineTexts()).toContain("const a = 1;");
  });

  it("reports the long-line count even on a fully highlighted file", async () => {
    files.responder = () => ok(contentOf("const a = 1;\n"));
    await mount();
    await act(async () => {
      highlighter.settleOldest(
        [[{ text: "const a = 1;", color: null, italic: false, bold: false, underline: false }]],
        3,
      );
      await Promise.resolve();
    });
    const chip = screen.getByTestId("file-viewer-chip").textContent ?? "";
    expect(chip).toContain("3 lines are over 20000 characters");
  });

  it("shows NO chip when the whole file is highlighted with nothing to report", async () => {
    files.responder = () => ok(contentOf("const a = 1;\n"));
    await mount();
    await act(async () => {
      highlighter.settleOldest([[]], 0);
      await Promise.resolve();
    });
    expect(screen.queryByTestId("file-viewer-chip")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The code area
 * ------------------------------------------------------------------ */

describe("the code area", () => {
  it("renders hostile file text as TEXT, never as an element", async () => {
    const hostile = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>';
    files.responder = () => ok(contentOf(hostile));
    await mount();

    const region = screen.getByTestId("file-viewer-lines");
    // The characters are on screen...
    expect(region.textContent).toContain('<img src=x onerror="alert(1)">');
    // ...and no element was created from them. This is the assertion the build
    // gate on `dangerouslySetInnerHTML` cannot make.
    expect(region.querySelector("img")).toBeNull();
    expect(region.querySelector("script")).toBeNull();
  });

  it("renders EVERY line of the file, in order", async () => {
    files.responder = () => ok(contentOf("alpha\nbeta\n\ndelta"));
    await mount();
    expect(lineTexts()).toEqual(["alpha", "beta", "", "delta"]);
  });

  it("hides the line-number gutter from assistive tech and from selection", async () => {
    files.responder = () => ok(contentOf("alpha\nbeta\n"));
    await mount();
    const gutters = [...document.querySelectorAll("[data-line] > span:first-child")];
    expect(gutters.length).toBeGreaterThan(0);
    for (const gutter of gutters) {
      expect(gutter.getAttribute("aria-hidden")).toBe("true");
      expect(gutter.className).toContain("select-none");
    }
    expect(gutters.map((g) => g.textContent)).toEqual(["1", "2", "3"]);
  });

  it("paints a token with the theme VARIABLE the tokenizer produced", async () => {
    files.responder = () => ok(contentOf("const a = 1;\n"));
    await mount();
    await act(async () => {
      highlighter.settleOldest(
        [
          [
            {
              text: "const",
              color: "var(--vex-alias-code-token-keyword)",
              italic: true,
              bold: false,
              underline: false,
            },
          ],
        ],
        0,
      );
      await Promise.resolve();
    });
    const token = document.querySelector('[data-line="1"] > span:last-child > span');
    expect(token?.getAttribute("style")).toContain("--vex-alias-code-token-keyword");
    expect(token?.className).toContain("italic");
  });

  it("names itself for a screen reader", async () => {
    files.responder = () => ok(contentOf("alpha\n"));
    await mount();
    expect(screen.getByRole("region", { name: "File contents" })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Mounting
 * ------------------------------------------------------------------ */

describe("mounting", () => {
  it("reads ONCE under a StrictMode double mount", async () => {
    files.responder = () => ok(contentOf("alpha\n"));
    await act(async () => {
      render(
        <StrictMode>
          <View />
        </StrictMode>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The registry's deferred teardown is what buys this: an immediate dispose
    // on the cleanup would rebuild the session and read the file again.
    expect(files.readCount).toBe(1);
  });

  it("an INACTIVE tab reads but holds no worker request", async () => {
    files.responder = () => ok(contentOf("const a = 1;\n"));
    await mount({ active: false });
    // The content is current - a tab shown later must not show stale text...
    expect(lineTexts()).toContain("const a = 1;");
    // ...but seven hidden tabs must not queue seven tokenizations.
    expect(highlighter.asks).toEqual([]);
  });

  it("releases the session when the tab unmounts", async () => {
    files.responder = () => ok(contentOf("alpha\n"));
    const view = render(<View />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(registry.sessionCount()).toBe(1);

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    expect(registry.consumerCount(TAB.tabId)).toBe(0);
    expect(registry.sessionCount()).toBe(0);
  });
});
