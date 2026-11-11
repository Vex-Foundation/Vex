/**
 * The chats search (docs/design/H3-DESKTOP.md section 1.4; VEX Cloud's
 * `shell/sidebar/chat-search.tsx`, `.vx-lc-search`): the field is always
 * open in its 48 cell, no row that opens into it. The search icon in the
 * muted ink 24 in, the input at 14 with "Search chats" as its name and
 * placeholder, and "Clear search" (a 24 key, the 16 close glyph, muted)
 * only while there is a query. The whole cell carries the focus ring.
 *
 * Escape (not while composing) with a query clears it and keeps the focus in
 * the field; with an empty field it passes on, so the column's search mode
 * or the chats panel closes. Clear empties the query and focuses the field.
 *
 * Under it, in the column's search mode, the All, Agent and Mission tabs
 * (desktop's own). Each tab carries its count in mono 11; the count is
 * decoration (`aria-hidden`), so a tab's name stays its word.
 */

import { useCallback, useRef, type JSX, type KeyboardEvent, type Ref } from "react";
import { LineClose, LineSearch } from "../../../components/icons/line/index.js";
import type { SessionModeFilter } from "../../../stores/uiStore.js";
import { SESSION_MODE_FILTERS } from "../sessionListModel.js";

/** H3's word for the search (Appendix A.2): the cell, its key and the field. */
export const SEARCH_FIELD_LABEL = "Search chats";

/** The name of the key that empties the field (Cloud's). */
export const SEARCH_CLEAR_LABEL = "Clear search";

export function SessionSearchField({
  value,
  onChange,
  onClear,
  inputRef,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Empties the query (Escape with a query, or the Clear key). */
  readonly onClear: () => void;
  readonly inputRef?: Ref<HTMLInputElement>;
}): JSX.Element {
  const ownRef = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback(
    (element: HTMLInputElement | null): void => {
      ownRef.current = element;
      if (typeof inputRef === "function") inputRef(element);
      else if (inputRef !== null && inputRef !== undefined) inputRef.current = element;
    },
    [inputRef],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || value === "") return;
    event.preventDefault();
    event.stopPropagation();
    onClear();
  };
  return (
    <div className="vex-ls-search vex-ls-search--chats" data-search-open={value === "" ? undefined : ""}>
      <LineSearch className="vex-ls-search__i" />
      <input
        ref={setRef}
        type="search"
        enterKeyHint="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={SEARCH_FIELD_LABEL}
        placeholder={SEARCH_FIELD_LABEL}
        autoComplete="off"
        spellCheck={false}
        className="vex-ls-search__input"
      />
      {value === "" ? null : (
        <button
          type="button"
          aria-label={SEARCH_CLEAR_LABEL}
          onClick={() => {
            onClear();
            ownRef.current?.focus({ preventScroll: true });
          }}
          className="vex-ls-search__clear"
        >
          <LineClose size={16} />
        </button>
      )}
    </div>
  );
}

export function SessionModeTabs({
  value,
  counts,
  onChange,
}: {
  readonly value: SessionModeFilter;
  readonly counts: Readonly<Record<SessionModeFilter, number>>;
  readonly onChange: (next: SessionModeFilter) => void;
}): JSX.Element {
  return (
    <div role="tablist" aria-label="Filter chats" className="vex-ls-tabs">
      {SESSION_MODE_FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          role="tab"
          aria-selected={value === filter.value}
          onClick={() => onChange(filter.value)}
          className="vex-ls-tabs__tab"
        >
          {filter.label}
          <span aria-hidden className="vex-ls-tabs__n vex-num">
            {counts[filter.value]}
          </span>
        </button>
      ))}
    </div>
  );
}
