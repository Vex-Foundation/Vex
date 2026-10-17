/**
 * The left sidebar's search mode (docs/design/R3-MINIMAL.md section 4): the
 * Search row turns into a 38px field (1px blue border, the field ground, the
 * line search icon in blue, an Esc keycap at the right), with the All, Agent
 * and Mission tabs under it. Each tab carries its count in mono 11; the count
 * is decoration (`aria-hidden`), so a tab's name stays its word.
 *
 * Escape in the field closes the mode; the owner clears the text and brings
 * back New chat and the sections.
 */

import type { JSX, KeyboardEvent, Ref } from "react";
import { LineSearch } from "../../../components/icons/line/index.js";
import type { SessionModeFilter } from "../../../stores/uiStore.js";
import { SESSION_MODE_FILTERS } from "../sessionListModel.js";

export function SessionSearchField({
  value,
  onChange,
  onClose,
  inputRef,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onClose: () => void;
  readonly inputRef?: Ref<HTMLInputElement>;
}): JSX.Element {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div className="vex-ls-search">
      <LineSearch className="vex-ls-search__i" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Search sessions"
        placeholder="Search sessions"
        autoComplete="off"
        spellCheck={false}
        className="vex-ls-search__input"
      />
      <kbd aria-hidden className="vex-ls-search__kbd">
        Esc
      </kbd>
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
    <div role="tablist" aria-label="Filter sessions" className="vex-ls-tabs">
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
