/**
 * THE NAME BOX: an input rendered AS a tree row.
 *
 * VS Code's `renderInputBox` (`explorerViewer.ts:1032-1168`), ported to this
 * tree's primitives. What was adopted, and why each part is not a detail:
 *
 *  - THE INPUT REPLACES THE ROW. The name is typed at the position the entry
 *    will occupy, beside the sibling names it must not collide with. A modal
 *    dialog asking for a name hides the very list the user is choosing against.
 *  - LIVE VALIDATION under the input, re-run on every keystroke
 *    (`explorerViewer.ts:1096-1110`), so the refusal appears while the name is
 *    being typed rather than after Enter.
 *  - ENTER COMMITS, ESCAPE CANCELS (`explorerViewer.ts:1133-1139`), and Enter
 *    on an invalid name does NOT commit: it leaves the message showing.
 *  - THE STEM IS PRESELECTED for a file being renamed - `select(0, lastDot)`
 *    (`explorerViewer.ts:1079-1084`) - because renaming `notes.md` to
 *    `agenda.md` is the common case and retyping the extension is not.
 *
 * DEPARTURE, and it is deliberate: VS Code COMMITS ON BLUR
 * (`explorerViewer.ts:1144-1161`, after a loop that ignores focus moving into
 * its own context menu). Here blur CANCELS. The two products differ in what a
 * stray blur costs: there, a commit-on-blur creates a file the user can undo
 * with one keystroke, because the explorer's create and rename go through the
 * workbench undo stack (`applyBulkEdit` with an `undoLabel`). This surface has
 * NO UNDO - a create writes to the user's repository and only the filesystem
 * can take it back - so committing a half-typed name because the user clicked
 * somewhere is a write nobody asked for and nothing can reverse. Cancelling
 * loses at most a typed name the user can retype.
 *
 * The row keeps the tree's own indent grid and its glyph slots, so opening the
 * box does not make the list jump.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  IconFile,
  IconFolderClose,
  IconWarning,
} from "../../../../components/icons/index.js";
import { cn } from "../../../../lib/utils.js";
import { EXPLORER_EDIT_ARIA_LABEL } from "./explorer-copy.js";
import type { EditIntent } from "./explorer-rows.js";
import { EXPLORER_ROW_HEIGHT } from "./ExplorerRow.js";

/** Matches `ExplorerRow`'s grid so the box sits exactly where the row would. */
const INDENT_PER_LEVEL = 12;
const BASE_INDENT = 4;

export interface ExplorerEditRowProps {
  readonly domId: string;
  readonly intent: EditIntent;
  readonly level: number;
  readonly posInSet: number;
  readonly setSize: number;
  readonly initialName: string;
  /** The refusal to show under the input, or `null`. */
  readonly message: string | null;
  /** The commit is in flight: the input stays mounted and goes read-only. */
  readonly submitting: boolean;
  /**
   * Validate as the user types. Returns the sentence to show, or `null`.
   *
   * Owned by the session, not by this component: the rule is shared with main
   * and the sibling check needs the model, and a component that reimplemented
   * either would be a second answer to "is this name usable".
   */
  readonly validate: (name: string) => string | null;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}

export function ExplorerEditRow({
  domId,
  intent,
  level,
  posInSet,
  setSize,
  initialName,
  message,
  submitting,
  validate,
  onCommit,
  onCancel,
}: ExplorerEditRowProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  /** The LIVE message. Main's refusal arrives as `message` and outranks it. */
  const [liveMessage, setLiveMessage] = useState<string | null>(null);

  /**
   * Focus, and preselect the stem.
   *
   * On mount only: re-running it would steal the caret back to the start every
   * time a keystroke re-rendered the row, which is the classic controlled-input
   * defect. The dependency list is empty for that reason, and `initialName` is
   * captured from the first render because the box is remounted (a new row id)
   * for every new edit.
   */
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    const lastDot = initialName.lastIndexOf(".");
    // A leading dot is not an extension separator: `.gitignore` selects whole.
    const stemEnd = intent === "rename" && lastDot > 0 ? lastDot : initialName.length;
    input.setSelectionRange(0, stemEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = useCallback(
    (next: string) => {
      setValue(next);
      setLiveMessage(validate(next));
    },
    [validate],
  );

  const commit = useCallback(() => {
    if (submitting) return;
    // A name the live rule refuses does NOT commit. VS Code's Enter handler
    // makes the same call (`explorerViewer.ts:1133-1136`: it commits only when
    // `validate()` returns falsy), and the message is already on screen.
    if (validate(value) !== null) {
      setLiveMessage(validate(value));
      return;
    }
    onCommit(value);
  }, [onCommit, submitting, validate, value]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // The tree's own key table must never see these: Escape, Enter and every
      // arrow belong to the input while it is open, and a tree that moved focus
      // under a caret would take the row out from under what is being typed.
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    },
    [commit, onCancel],
  );

  const style: CSSProperties = {
    height: `${String(EXPLORER_ROW_HEIGHT)}px`,
    paddingInlineStart: `${String(BASE_INDENT + level * INDENT_PER_LEVEL)}px`,
  };
  const shown = message ?? liveMessage;
  const messageId = `${domId}-message`;

  return (
    <div
      id={domId}
      role="treeitem"
      data-row-kind="edit"
      data-vex-explorer-edit={intent}
      aria-level={level + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={false}
      style={style}
      className="flex w-full select-none items-center gap-1 pr-2 text-[13px] leading-[24px]"
      // The box is not the tree's focus target; the input inside it is, and it
      // is the one element in this tree that legitimately holds DOM focus.
      // Clicks must not reach the tree's row-select handler behind it.
      onClick={(event) => {
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
    >
      <span aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-tertiary"
      >
        {intent === "createFolder" ? <IconFolderClose size={14} /> : <IconFile size={14} />}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        readOnly={submitting}
        spellCheck={false}
        autoComplete="off"
        aria-label={EXPLORER_EDIT_ARIA_LABEL}
        aria-invalid={shown !== null}
        {...(shown === null ? {} : { "aria-describedby": messageId })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        // Blur CANCELS here rather than committing; see the module note.
        onBlur={onCancel}
        className={cn(
          "min-w-0 flex-1 rounded-sm border bg-surface-input px-1 text-[13px] text-ink-primary outline-none",
          shown === null ? "border-line-2 focus:border-ring" : "border-error",
        )}
      />
      {shown === null ? null : (
        // The refusal rides the row rather than a toast: the sentence belongs
        // beside the name that caused it, and a toast is gone before a user
        // reading a tree has looked up.
        <span
          id={messageId}
          role="alert"
          className="flex max-w-[60%] shrink-0 items-center gap-1 truncate text-[11px] text-error"
          title={shown}
        >
          <IconWarning size={12} />
          {shown}
        </span>
      )}
    </div>
  );
}
