/**
 * ONE explorer row. Memoized, presentational, and deliberately primitive-only.
 *
 * Every prop is a string, number or boolean rather than the row object the
 * model hands out. That is not style: `ExplorerModel.getRow` allocates a fresh
 * object per call, so a `row` prop would change identity on every commit and
 * `memo` would never skip anything. Flattening is what makes the memo real, and
 * the splice suite asserts the consequence.
 *
 * The WHOLE ROW is the control, as in VS Code: the twistie is not a separate
 * button. A nested button inside a row-level control is the pattern
 * `rail-list.tsx` documents as forbidden (its select control and its actions
 * are siblings), and here there is only one action, so the row itself carries
 * it. Focus lives on the tree container, never here - see `ExplorerTree.tsx`.
 */

import { memo, type CSSProperties, type JSX } from "react";
import type { FileNodeKind } from "@shared/schemas/files.js";
import type { FileOpenMode } from "../workspace/types.js";
import type { ExplorerRowPending } from "./explorer-rows.js";
import {
  IconChevronRight,
  IconFile,
  IconFolderClose,
  IconFolderOpen,
  IconLink,
  IconLoading,
  IconWarning,
} from "../../../../components/icons/index.js";
import { StateDot } from "../../../../components/ui/state-dot.js";
import { cn } from "../../../../lib/utils.js";

/** Row height in pixels. A file tree is denser than the 32px rail row. */
export const EXPLORER_ROW_HEIGHT = 24;

/** Indent per depth level, in pixels. */
const INDENT_PER_LEVEL = 12;

/** The left gutter every row starts from, so level 0 is not flush to the edge. */
const BASE_INDENT = 4;

export interface ExplorerRowProps {
  readonly rowId: string;
  /** The DOM id. The tree's `aria-activedescendant` points at it. */
  readonly domId: string;
  readonly rowKind: "node" | "loadMore" | "notice";
  /** The visible text: a file name, the show-more sentence, or the notice. */
  readonly label: string;
  readonly level: number;
  readonly posInSet: number;
  readonly setSize: number;
  /** `null` for the rows that are not filesystem entries. */
  readonly nodeKind: FileNodeKind | null;
  /** `null` on a row that is not expandable, which omits `aria-expanded`. */
  readonly expanded: boolean | null;
  readonly loading: boolean;
  readonly errored: boolean;
  readonly focused: boolean;
  readonly selected: boolean;
  /** The id of the visually-hidden description, or `null` when there is none. */
  readonly describedById: string | null;
  /** The description's text. Rendered inside the row so the id resolves. */
  readonly description: string | null;
  /**
   * This file is a Vex-managed artifact that has drifted, said in words
   * (`"AGENTS.md: Edited since Vex wrote it"`), or `null` for every other row.
   *
   * A DECORATION in VS Code's sense (`explorerDecorationsProvider.ts`): the
   * badge sits on the resource the fact is about, not only on the project row
   * above it. A string rather than an object so the memo still compares by
   * value.
   */
  readonly driftLabel: string | null;
  /**
   * A write this row is waiting on, or `null`.
   *
   * The row KEEPS its name and its place while it is pending. A row that
   * vanished on Enter and came back on the answer would flicker; one that
   * vanished and did not come back would have deleted itself for a delete that
   * was refused.
   */
  readonly pending: ExplorerRowPending | null;
  /**
   * The row was activated, and WHICH GESTURE did it.
   *
   * A single click asks for a PREVIEW, a double click asks for a KEPT tab.
   * That is VS Code's split, from the same two events: its list opens on
   * single click with the preview flag and its tab control pins on
   * `DBLCLICK` (`multiEditorTabsControl.ts:1125-1150`). The mode travels with
   * the gesture because the gesture is the only thing that knows it - by the
   * time the workspace reads it, the click is long over.
   *
   * A DOUBLE CLICK ALSO FIRES A SINGLE ONE first, and that is fine rather
   * than tolerated: the preview open lands, then the pinned open promotes the
   * same tab in place (`addFileTab` selects and pins an already-open path), so
   * the user sees one tab either way.
   */
  readonly onSelect: (rowId: string, mode: FileOpenMode) => void;
  /**
   * Right click, with viewport coordinates. `null` on rows that have no menu.
   *
   * A primitive callback rather than a menu here, because this component is
   * memoized on primitives: a menu rendered per row would mount one control per
   * row in a virtualized list, which is exactly what the tree-wide menu avoids.
   */
  readonly onContextMenu: ((rowId: string, x: number, y: number) => void) | null;
}

function LeadingGlyph({
  rowKind,
  nodeKind,
  expanded,
  errored,
}: {
  readonly rowKind: "node" | "loadMore" | "notice";
  readonly nodeKind: FileNodeKind | null;
  readonly expanded: boolean | null;
  readonly errored: boolean;
}): JSX.Element | null {
  // A notice is marked only when it reports a FAILURE. "This project has no
  // files yet" is information, and a warning mark on it would say otherwise.
  // The slot is kept either way so the text stays on the tree's indent grid.
  if (rowKind === "notice") return errored ? <IconWarning size={14} /> : null;
  if (rowKind === "loadMore") return null;
  if (errored) return <IconWarning size={14} />;
  if (nodeKind === "directory") {
    return expanded === true ? <IconFolderOpen size={14} /> : <IconFolderClose size={14} />;
  }
  // A symlink shows the LINK mark rather than a file mark: main refuses to
  // follow it, so a row that looked like an ordinary file would be a promise
  // the product does not keep.
  if (nodeKind === "symlink") return <IconLink size={14} />;
  return <IconFile size={14} />;
}

export const ExplorerRow = memo(function ExplorerRow(props: ExplorerRowProps): JSX.Element {
  const isDirectory = props.rowKind === "node" && props.nodeKind === "directory";
  const style: CSSProperties = {
    height: `${String(EXPLORER_ROW_HEIGHT)}px`,
    paddingInlineStart: `${String(BASE_INDENT + props.level * INDENT_PER_LEVEL)}px`,
  };

  return (
    <div
      id={props.domId}
      role="treeitem"
      data-row-id={props.rowId}
      data-row-kind={props.rowKind}
      aria-level={props.level + 1}
      aria-posinset={props.posInSet}
      aria-setsize={props.setSize}
      aria-selected={props.selected}
      // Only expandable rows carry it; VS Code removes the attribute outright
      // rather than writing `aria-expanded="false"` on a leaf
      // (`abstractTree.ts:492-494`), because a false there announces a file as a
      // collapsed group.
      {...(props.expanded === null ? {} : { "aria-expanded": props.expanded })}
      {...(props.describedById === null ? {} : { "aria-describedby": props.describedById })}
      {...(props.rowKind === "node" ? {} : { "aria-label": props.label })}
      style={style}
      data-row-pending={props.pending ?? undefined}
      onClick={() => {
        props.onSelect(props.rowId, "preview");
      }}
      onDoubleClick={() => {
        props.onSelect(props.rowId, "pinned");
      }}
      onContextMenu={
        props.onContextMenu === null
          ? undefined
          : (event) => {
              // The platform menu would offer Reload and Inspect over a file
              // tree, so this row owns the gesture outright.
              event.preventDefault();
              event.stopPropagation();
              props.onContextMenu?.(props.rowId, event.clientX, event.clientY);
            }
      }
      className={cn(
        "flex w-full cursor-pointer select-none items-center gap-1 pr-2 text-[13px] leading-[24px]",
        // Hover fill and selected fill are the same tint, as the rail rows are.
        // `vex-tint` settles that fill over the fast step instead of snapping
        // it. COLOUR ONLY, and that is a constraint rather than a preference:
        // the row sits inside a virtualizer wrapper positioned by `transform`,
        // so anything here that moved a box would fight the list's own
        // translation. Safe against row reuse because the virtualizer keys by
        // ROW ID (`getItemKey` in ExplorerTree), so scrolling remounts rows
        // rather than repainting one element as a different file.
        "vex-tint",
        props.selected ? "bg-interactive-hover" : "hover:bg-interactive-hover",
        props.focused ? "ring-1 ring-inset ring-ring" : null,
        props.rowKind === "notice" ? "text-ink-tertiary" : "text-ink-primary",
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-tertiary"
      >
        {/* A PENDING WRITE takes the twistie slot, so a row waiting on main is
          * visibly busy without the list reflowing. It outranks the directory's
          * own loading spinner: a folder being renamed while its children load
          * is one row the user is waiting on, not two. */}
        {props.loading || props.pending !== null ? (
          <IconLoading size={12} />
        ) : isDirectory ? (
          <IconChevronRight
            size={12}
            // `vex-twistie` replaced a hand-written
            // `transition-transform duration-150 motion-reduce:transition-none`:
            // same behaviour, but the 150 is now the `--vex-duration-base`
            // token and the reduced-motion collapse is stated once in the
            // primitive instead of per call site.
            className={cn("vex-twistie", props.expanded === true ? "rotate-90" : null)}
          />
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-tertiary"
      >
        <LeadingGlyph
          rowKind={props.rowKind}
          nodeKind={props.nodeKind}
          expanded={props.expanded}
          errored={props.errored}
        />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          props.nodeKind === "other" ? "text-ink-tertiary" : null,
        )}
        title={props.label}
      >
        {props.label}
      </span>
      {props.driftLabel === null ? null : (
        // The SAME state vocabulary the project row and the outcome rows use,
        // so one glyph means one thing across Studio. `label` is what makes it
        // more than a colour: the dot itself is aria-hidden, and this row has
        // no visible word saying the file drifted.
        <span
          className="flex shrink-0 items-center text-warning"
          title={props.driftLabel}
          data-vex-file-drift="true"
        >
          <StateDot state="warning" size={8} label={props.driftLabel} />
        </span>
      )}
      {props.describedById === null || props.description === null ? null : (
        <span id={props.describedById} className="sr-only">
          {props.description}
        </span>
      )}
    </div>
  );
});
