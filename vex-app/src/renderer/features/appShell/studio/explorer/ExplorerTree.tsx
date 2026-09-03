/**
 * THE EXPLORER TREE - the virtualized, keyboard-operable view of one session.
 *
 * ## Focus lives on the CONTAINER, not on the rows
 *
 * The container is the single tab stop (`tabIndex={0}`) and names the active
 * row with `aria-activedescendant`; rows are never focusable. This is VS Code's
 * model (`listView.ts:410`, `listWidget.ts:2060-2081`) and it is chosen here
 * over the roving tabindex that `terminal/TerminalTabs.tsx` uses, for a reason
 * that is specific to this surface: THESE ROWS ARE VIRTUALIZED. A roving
 * tabindex puts real DOM focus on a row element, and a row element can be
 * unmounted by a scroll - at which point the browser moves focus to `body` and
 * the user's place in the tree is gone. A tab strip has no such problem because
 * every tab is mounted, which is why the two surfaces answer differently.
 *
 * The consequence to keep true: the focused row must be MOUNTED for
 * `aria-activedescendant` to resolve, so every keyboard action reveals it
 * (`scrollToIndex`), and the attribute is omitted while it is out of view
 * rather than pointing at an id that is not in the document.
 *
 * ## The model is the store
 *
 * `useSyncExternalStore` over the session's revision counter, so one splice
 * produces one commit and a focus move produces one commit. Rows read
 * `getRow(index)` for the ~30 the virtualizer mounts, never `getRows()`.
 */

import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { FileNode } from "@shared/schemas/files.js";
import { cn } from "../../../../lib/utils.js";
import type { FileOpenMode } from "../workspace/types.js";
import {
  EXPLORER_TREE_LABEL,
  SHOW_MORE_FAILED,
  SHOW_MORE_LOADING,
  hiddenEntriesDescription,
  showMoreLabel,
} from "./explorer-copy.js";
import {
  findTypeAheadIndex,
  nextTypeAheadPrefix,
  resolveExplorerKey,
  type ExplorerIntent,
} from "./explorer-keys.js";
import type { ExplorerRow as ExplorerRowModel } from "./explorer-rows.js";
import { explorerRegistry, type ExplorerRegistry } from "./explorer-registry.js";
import type { ExplorerSession } from "./explorer-session.js";
import { EXPLORER_ROW_HEIGHT, ExplorerRow } from "./ExplorerRow.js";
import { ExplorerEditRow } from "./ExplorerEditRow.js";
import {
  ExplorerDeleteDialog,
  type ExplorerDeleteRequest,
} from "./ExplorerDeleteDialog.js";
import {
  ExplorerRowMenu,
  type ExplorerMenuAction,
  type ExplorerMenuRequest,
} from "./ExplorerRowMenu.js";

/** Rows rendered beyond the viewport, so a scroll does not show blank space. */
const EXPLORER_OVERSCAN = 8;

/**
 * The virtualizer's measurement seam.
 *
 * jsdom has no layout: every element measures 0x0, so the default observers
 * compute a zero-height viewport and the tree renders nothing at all. Injecting
 * them is the same seam `TerminalRegistry` opens for its WebGL loader and for
 * the same stated reason - a real dependency that cannot run under the test
 * runtime. Production passes nothing and gets the library's own observers.
 */
export interface ExplorerViewportObservers {
  readonly observeElementRect: Parameters<
    typeof useVirtualizer<HTMLDivElement, HTMLDivElement>
  >[0]["observeElementRect"];
  readonly observeElementOffset: Parameters<
    typeof useVirtualizer<HTMLDivElement, HTMLDivElement>
  >[0]["observeElementOffset"];
}

export interface ExplorerTreeProps {
  readonly projectId: string;
  /**
   * A file row was activated. Called ONLY for `kind: "file"`: main refuses to
   * read a symlink (`symlinked_path`) or a device (`not_a_file`), so opening a
   * tab for one would promise a viewer that can never render.
   *
   * `mode` is what the GESTURE meant, never what the tree decided: a single
   * click previews, a double click and the keyboard's Enter keep the tab. The
   * tree does not know what a tab is; it reports the gesture and the workspace
   * owns the rest.
   */
  readonly onOpenFile: (node: FileNode, mode: FileOpenMode) => void;
  readonly registry?: ExplorerRegistry;
  readonly viewport?: ExplorerViewportObservers;
  /**
   * Project-relative path -> the drift sentence for that file.
   *
   * The tree does not decide what has drifted: the PROJECT owns that fact (it
   * arrives on the project DTO, read from disk on every project read), and the
   * sidebar hands it down. Absent means "no decorations", which is what every
   * mount outside the Studio sidebar wants.
   */
  readonly driftedPaths?: ReadonlyMap<string, string>;
  readonly className?: string;
}

export function ExplorerTree({
  projectId,
  onOpenFile,
  registry,
  viewport,
  driftedPaths,
  className,
}: ExplorerTreeProps): JSX.Element {
  const activeRegistry = registry ?? explorerRegistry;
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * The `role="tree"` element: the ONE tab stop, and the only thing here that
   * can hold DOM focus. A pointer press has to hand it focus explicitly; see
   * `onMouseDown`.
   */
  const treeRef = useRef<HTMLDivElement>(null);
  const typeAheadRef = useRef<{ prefix: string; atMs: number } | null>(null);
  const [session, setSession] = useState<ExplorerSession | null>(null);
  /** The open context menu, or `null`. Owned here: it is chrome over the tree. */
  const [menu, setMenu] = useState<ExplorerMenuRequest | null>(null);
  /**
   * The delete awaiting confirmation, or `null`.
   *
   * The tree never deletes without one. This state is the ONLY path from a key
   * or a menu row to `session.deleteNode`, which is what makes "a keystroke
   * cannot remove a file" a property of the component rather than a habit.
   */
  const [deleteRequest, setDeleteRequest] = useState<ExplorerDeleteRequest | null>(null);

  /**
   * Acquire in an effect, never in render.
   *
   * `acquire` takes a reference and `release` gives it back; doing that during
   * render would double-count under StrictMode's double render, which renders
   * twice but only runs effects setup/cleanup/setup. The registry's deferred
   * teardown is what makes that cleanup free - see `explorer-registry.ts`.
   */
  useEffect(() => {
    const acquired = activeRegistry.acquire(projectId);
    setSession(acquired);
    void acquired.activate();
    return () => {
      activeRegistry.release(projectId);
    };
  }, [activeRegistry, projectId]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (session === null) return () => undefined;
      return session.subscribeRevision(onChange);
    },
    [session],
  );
  useSyncExternalStore(
    subscribe,
    () => session?.getRevision() ?? 0,
    () => 0,
  );

  const rowCount = session?.model.getRowCount() ?? 0;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => EXPLORER_ROW_HEIGHT,
    overscan: EXPLORER_OVERSCAN,
    // O(1) by contract; virtual-core calls this in an O(count) loop whenever it
    // rebuilds its measurements, so anything slower is O(n^2) per commit.
    getItemKey: (index) =>
      session !== null && index < session.model.getRowCount()
        ? session.model.getRowId(index)
        : String(index),
    ...(viewport ?? {}),
  });

  const focusedRowId = session?.getFocusedRowId() ?? null;
  const selectedRowId = session?.getSelectedRowId() ?? null;
  const focusedIndex =
    session === null || focusedRowId === null ? -1 : session.model.getIndexOf(focusedRowId);

  const moveFocusTo = useCallback(
    (index: number) => {
      if (session === null) return;
      const count = session.model.getRowCount();
      if (count === 0) return;
      const clamped = Math.min(Math.max(index, 0), count - 1);
      session.setFocusedRowId(session.model.getRowId(clamped));
      virtualizer.scrollToIndex(clamped);
    },
    [session, virtualizer],
  );

  const activateRow = useCallback(
    (row: ExplorerRowModel, mode: FileOpenMode) => {
      if (session === null) return;
      if (row.kind === "loadMore") {
        session.loadMore(row.parentId);
        return;
      }
      if (row.kind === "notice") {
        if (row.action === "retry") session.retry(row.parentId);
        return;
      }
      // The name box owns its own keys and its own clicks; activating it from
      // the tree would commit or open something under a caret.
      if (row.kind === "edit") return;
      session.setSelectedRowId(row.id);
      if (row.node.kind === "directory") {
        session.toggle(row.id);
        return;
      }
      if (row.node.kind === "file") onOpenFile(row.node, mode);
    },
    [onOpenFile, session],
  );

  /**
   * A row was activated by a pointer or, through `dispatch`, by a key.
   *
   * `mode` DEFAULTS TO PINNED, which is the keyboard's answer: VS Code's tree
   * opens preview on a single click and PINNED on Enter
   * (`explorerView.ts:532-549` reads `editorOptions.pinned` off the open
   * event, which its list sets for a keyboard open), because a user arrowing
   * to a file and pressing Enter has chosen it rather than browsed past it.
   */
  const selectRow = useCallback(
    (rowId: string, mode: FileOpenMode = "pinned") => {
      if (session === null) return;
      const index = session.model.getIndexOf(rowId);
      if (index === -1) return;
      session.setFocusedRowId(rowId);
      activateRow(session.model.getRow(index), mode);
    },
    [activateRow, session],
  );

  /**
   * Ask for a delete. It OPENS THE CONFIRMATION and never writes.
   *
   * The disposition the caller chose (the key, or the menu row) travels into
   * the dialog so the sentence the user reads is the one their action implied.
   */
  const requestDelete = useCallback(
    (rowId: string, permanent: boolean) => {
      if (session === null) return;
      const node = session.model.nodeOf(rowId);
      if (node === null) return;
      setDeleteRequest({ node, mode: permanent ? "permanent" : "trash" });
    },
    [session],
  );

  /** Open the name box for a new entry, in the directory the row implies. */
  const requestCreate = useCallback(
    (rowId: string | null, kind: "file" | "directory") => {
      if (session === null) return;
      // VS Code's rule (`fileActions.ts:931-938`): a directory takes the new
      // entry, a FILE gives it to its parent. Creating "inside" a file is not a
      // thing, and refusing the keystroke there would make the action feel
      // arbitrary from a row the user has selected.
      let parentId: string | null = null;
      if (rowId !== null) {
        const node = session.model.nodeOf(rowId);
        parentId =
          node !== null && node.kind === "directory" ? rowId : session.model.parentOf(rowId);
      }
      void session.beginCreate(parentId, kind);
    },
    [session],
  );

  /** Open the row's menu, anchored where the caller says. */
  const openMenu = useCallback(
    (rowId: string, x: number, y: number) => {
      if (session === null) return;
      const node = session.model.nodeOf(rowId);
      if (node === null) return;
      session.setFocusedRowId(rowId);
      setMenu({ rowId, name: node.name, x, y });
    },
    [session],
  );

  const onMenuSelect = useCallback(
    (action: ExplorerMenuAction, rowId: string) => {
      if (session === null) return;
      switch (action) {
        case "newFile":
          requestCreate(rowId, "file");
          return;
        case "newFolder":
          requestCreate(rowId, "directory");
          return;
        case "rename":
          session.beginRename(rowId);
          return;
        case "delete":
          requestDelete(rowId, false);
          return;
        case "deletePermanent":
          requestDelete(rowId, true);
          return;
      }
    },
    [requestCreate, requestDelete, session],
  );

  const dispatch = useCallback(
    (intent: ExplorerIntent): boolean => {
      if (session === null) return false;
      const count = session.model.getRowCount();
      if (count === 0) return false;
      /**
       * Focus is read from the SESSION at dispatch time, never from a render
       * closure. Two key presses can land in one React batch - End then Enter,
       * or a held arrow key - and a closed-over index would still be the one
       * from before the first press, so the second key would act on the wrong
       * row or, for Enter, on no row at all.
       */
      const focusedNow = session.getFocusedRowId();
      const liveIndex = focusedNow === null ? -1 : session.model.getIndexOf(focusedNow);
      const current = liveIndex === -1 ? 0 : liveIndex;
      const page = pageSizeOf(virtualizer);

      switch (intent.kind) {
        case "moveFocus": {
          if (intent.to === "first") {
            moveFocusTo(0);
            return true;
          }
          if (intent.to === "last") {
            moveFocusTo(count - 1);
            return true;
          }
          // A RELATIVE move with nothing focused yet ENTERS the list at the
          // first row rather than stepping off it. Home and End above are
          // absolute and are not subject to that, which is the distinction an
          // earlier version of this collapsed - End then landed on row 0.
          if (liveIndex === -1) {
            moveFocusTo(0);
            return true;
          }
          moveFocusTo(
            intent.to === "previous"
              ? current - 1
              : intent.to === "next"
                ? current + 1
                : intent.to === "pageUp"
                  ? current - page
                  : current + page,
          );
          return true;
        }
        case "collapseOrParent": {
          const row = session.model.getRow(current);
          if (row.kind === "node" && row.expanded) {
            session.collapse(row.id);
            return true;
          }
          // Nothing to collapse, so go to the parent - VS Code's `onLeftArrow`.
          if (row.parentId === null) return true;
          const parentIndex = session.model.getIndexOf(row.parentId);
          if (parentIndex !== -1) moveFocusTo(parentIndex);
          return true;
        }
        case "expandOrFirstChild": {
          const row = session.model.getRow(current);
          if (row.kind !== "node" || row.node.kind !== "directory") return true;
          if (!row.expanded) {
            session.expand(row.id);
            return true;
          }
          // Already expanded: the first child is the very next row, if it has one.
          if (current + 1 < session.model.getRowCount()) {
            const child = session.model.getRow(current + 1);
            if (child.parentId === row.id) moveFocusTo(current + 1);
          }
          return true;
        }
        case "activate": {
          if (liveIndex === -1) return true;
          // PINNED, as VS Code's Enter is. See `selectRow`.
          activateRow(session.model.getRow(current), "pinned");
          return true;
        }
        case "toggle": {
          const row = session.model.getRow(current);
          if (row.kind === "node" && row.node.kind === "directory") session.toggle(row.id);
          return true;
        }
        case "rename": {
          const row = session.model.getRow(current);
          if (liveIndex !== -1 && row.kind === "node") session.beginRename(row.id);
          return true;
        }
        case "delete": {
          const row = session.model.getRow(current);
          // NOTHING IS DELETED HERE. The key opens the confirmation, and the
          // confirmation is the only caller of the write.
          if (liveIndex !== -1 && row.kind === "node") {
            requestDelete(row.id, intent.permanent);
          }
          return true;
        }
        case "contextMenu": {
          const row = session.model.getRow(current);
          if (liveIndex === -1 || row.kind !== "node") return true;
          // A KEYBOARD opening has no pointer, so the menu anchors on the row's
          // own rectangle and appears attached to what it acts on.
          const element = treeRef.current?.querySelector<HTMLElement>(
            `[data-row-id="${CSS.escape(row.id)}"]`,
          );
          const rect = element?.getBoundingClientRect();
          openMenu(row.id, rect?.left ?? 0, rect?.bottom ?? 0);
          return true;
        }
        case "typeAhead": {
          const now = Date.now();
          const prefix = nextTypeAheadPrefix(typeAheadRef.current, intent.character, now);
          typeAheadRef.current = { prefix, atMs: now };
          const match = findTypeAheadIndex(
            count,
            (index) => {
              const row = session.model.getRow(index);
              return row.kind === "node" ? row.node.name : null;
            },
            current,
            prefix,
          );
          if (match !== -1) moveFocusTo(match);
          return true;
        }
      }
    },
    [activateRow, moveFocusTo, openMenu, requestDelete, session, virtualizer],
  );

  /**
   * A POINTER PRESS FOCUSES THE CONTAINER.
   *
   * The rows are not focusable - that is the whole point of the
   * `aria-activedescendant` model this tree uses - so a click has nothing to
   * focus on its own, and the browser leaves focus wherever it was. The result
   * is a tree the user has visibly selected a row in whose arrow keys go to the
   * page instead, and a screen reader that never hears the active row because
   * nothing is focused for the attribute to apply to.
   *
   * VS Code answers this the same way and for the same reason
   * (`listWidget.ts:740-748`: `onMouseDown` calls `domFocus()` unless the press
   * landed on the element that already has focus), and `preventScroll` is its
   * choice too (`listWidget.ts:1714`): the virtualizer owns scrolling here, and
   * a focus that also scrolled would fight the row reveal.
   *
   * MOUSEDOWN, not click: focus must be settled before the press completes, so
   * a drag or a fast double click never runs with focus in the wrong place.
   */
  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const container = treeRef.current;
    if (container === null) return;
    // Something focusable inside the tree was pressed and has its own claim on
    // focus. Stealing it would break that element the moment it is added.
    if (event.target !== container && event.target === document.activeElement) return;
    container.focus({ preventScroll: true });
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const intent = resolveExplorerKey(event);
      if (intent === null) return;
      if (dispatch(intent)) event.preventDefault();
    },
    [dispatch],
  );

  const items = virtualizer.getVirtualItems();
  const focusedIsMounted = items.some((item) => item.index === focusedIndex);
  const activeDescendantId =
    focusedRowId !== null && focusedIsMounted ? rowDomId(projectId, focusedRowId) : undefined;

  /**
   * The project root's hidden-entry count.
   *
   * Every other directory carries this on its own row, but the root HAS no row
   * - and the root is exactly where `node_modules` and `.git` are hidden. Left
   * unsaid, the most commonly filtered directory in the product would be the
   * one the user is never told about, so it rides the tree's own description.
   */
  const rootExcluded = session?.model.excludedCountOf(null) ?? null;
  const rootDescriptionId = `explorer-${projectId}-root-desc`;

  const total = virtualizer.getTotalSize();
  const listStyle = useMemo(
    () => ({ height: `${String(total)}px`, position: "relative" as const, width: "100%" }),
    [total],
  );

  return (
    <div
      ref={scrollRef}
      data-testid="explorer-scroller"
      className={cn("min-h-0 flex-1 overflow-auto bg-surface-sidebar", className)}
    >
      <div
        ref={treeRef}
        role="tree"
        aria-label={EXPLORER_TREE_LABEL}
        tabIndex={0}
        {...(activeDescendantId === undefined
          ? {}
          : { "aria-activedescendant": activeDescendantId })}
        {...(rootExcluded === null || rootExcluded === 0
          ? {}
          : { "aria-describedby": rootDescriptionId })}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        style={listStyle}
        className="focus-visible:outline-none"
      >
        {rootExcluded === null || rootExcluded === 0 ? null : (
          <span id={rootDescriptionId} className="sr-only">
            {hiddenEntriesDescription(rootExcluded)}
          </span>
        )}
        {items.map((item) => {
          if (session === null || item.index >= session.model.getRowCount()) return null;
          const row = session.model.getRow(item.index);
          if (row.kind === "edit") {
            return (
              <div
                key={item.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${String(item.start)}px)`,
                }}
              >
                <ExplorerEditRow
                  domId={rowDomId(projectId, row.id)}
                  intent={row.intent}
                  level={row.level}
                  posInSet={row.posInSet}
                  setSize={row.setSize}
                  initialName={row.initialName}
                  message={row.message}
                  submitting={row.submitting}
                  validate={(name) => session.validateEditName(name)}
                  onCommit={(name) => {
                    void session.commitEdit(name);
                  }}
                  onCancel={() => {
                    session.cancelEdit();
                    // Focus goes back to the tree, not to the page: the box was
                    // the only focusable thing in here, and a cancel that left
                    // focus on `body` would strand the user's arrow keys.
                    treeRef.current?.focus({ preventScroll: true });
                  }}
                />
              </div>
            );
          }
          const presentation = describeRow(row);
          const descriptionId =
            presentation.description === null ? null : `${rowDomId(projectId, row.id)}-desc`;
          return (
            <div
              key={item.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${String(item.start)}px)`,
              }}
            >
              <ExplorerRow
                rowId={row.id}
                domId={rowDomId(projectId, row.id)}
                rowKind={row.kind}
                label={presentation.label}
                level={row.level}
                posInSet={row.posInSet}
                setSize={row.setSize}
                nodeKind={presentation.nodeKind}
                expanded={presentation.expanded}
                loading={presentation.loading}
                errored={presentation.errored}
                focused={focusedRowId === row.id}
                selected={selectedRowId === row.id}
                describedById={descriptionId}
                description={presentation.description}
                driftLabel={
                  row.kind === "node" && row.node.kind === "file"
                    ? driftedPaths?.get(row.node.path) ?? null
                    : null
                }
                pending={row.kind === "node" ? row.pending : null}
                onSelect={selectRow}
                onContextMenu={row.kind === "node" ? openMenu : null}
              />
            </div>
          );
        })}
      </div>

      {/* CHROME OVER THE TREE, not inside it: a `role="tree"` may contain only
        * tree items, and a menu or a dialog in there would put controls into
        * the arrow-key sequence a screen reader walks. */}
      <ExplorerRowMenu
        request={menu}
        onSelect={onMenuSelect}
        onClose={() => {
          setMenu(null);
          treeRef.current?.focus({ preventScroll: true });
        }}
      />
      <ExplorerDeleteDialog
        request={deleteRequest}
        onClose={() => {
          setDeleteRequest(null);
          treeRef.current?.focus({ preventScroll: true });
        }}
        onConfirm={async (node, mode) => {
          if (session === null) {
            return { ok: false, code: null, message: "This project is no longer open." };
          }
          const outcome = await session.deleteNode(node.nodeId, mode);
          return outcome.ok
            ? { ok: true }
            : { ok: false, code: outcome.code, message: outcome.message };
        }}
      />
    </div>
  );
}

/** Namespaced so two trees in one document cannot mint the same DOM id. */
function rowDomId(projectId: string, rowId: string): string {
  return `explorer-${projectId}-${rowId}`;
}

/**
 * How many rows one PageUp or PageDown moves.
 *
 * Derived from the observed viewport rather than a constant, so the jump always
 * matches what the user can actually see. At least one, so a viewport too short
 * to hold a row still moves.
 */
function pageSizeOf(virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>): number {
  const height = virtualizer.scrollRect?.height ?? 0;
  return Math.max(1, Math.floor(height / EXPLORER_ROW_HEIGHT));
}

interface RowPresentation {
  readonly label: string;
  readonly nodeKind: FileNode["kind"] | null;
  readonly expanded: boolean | null;
  readonly loading: boolean;
  readonly errored: boolean;
  readonly description: string | null;
}

/**
 * Turn a model row into the primitives the memoized row renders.
 *
 * Kept out of the component so the mapping is one readable table rather than
 * three ternaries inside JSX, and so a row kind added to the model shows up
 * here as a missing branch.
 */
function describeRow(row: Exclude<ExplorerRowModel, { kind: "edit" }>): RowPresentation {
  if (row.kind === "loadMore") {
    return {
      label:
        row.state === "loading"
          ? SHOW_MORE_LOADING
          : row.state === "error"
            ? SHOW_MORE_FAILED
            : showMoreLabel(row.remaining),
      nodeKind: null,
      expanded: null,
      loading: row.state === "loading",
      errored: row.state === "error",
      description: null,
    };
  }
  if (row.kind === "notice") {
    return {
      label: row.text,
      nodeKind: null,
      expanded: null,
      loading: false,
      // The TONE decides the mark: the session says whether this notice is a
      // failure, and the row is not the place to guess it back.
      errored: row.tone === "warning",
      description: null,
    };
  }
  const isDirectory = row.node.kind === "directory";
  return {
    label: row.node.name,
    nodeKind: row.node.kind,
    expanded: isDirectory ? row.expanded : null,
    loading: row.loadState === "loading",
    errored: row.loadState === "error",
    // A count, not a row: there is no action yet that could un-hide these, and
    // a row the user cannot act on is noise in a list navigated by arrow key.
    // The count still has to be SAID, or the folder is lying about its contents.
    description:
      row.excludedCount !== null && row.excludedCount > 0
        ? hiddenEntriesDescription(row.excludedCount)
        : null,
  };
}
