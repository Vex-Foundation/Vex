import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

/** Superset row: watchlist fills a subset today, markets IPC fills all. */
export interface HvMarketRow {
  readonly coin: string;
  readonly midPx: string | null;
  readonly change24hPct: string | null;
  readonly openInterestUsd: string | null;
  readonly maxLeverage?: number;
  readonly fundingRate8hPct?: string | null;
  readonly dayVolumeUsd?: string | null;
}

export type PickerFilter = "all" | "favorites";

export interface MarketPickerState {
  readonly clampedCursor: number;
  readonly filter: PickerFilter;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly queryText: string;
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly setFilter: (value: PickerFilter) => void;
  readonly setMouseCursor: (index: number) => void;
  readonly setQueryText: (value: string) => void;
  readonly visible: readonly HvMarketRow[];
}

/** OI-desc default ordering — the venue's "what matters first". */
function orderRows(rows: readonly HvMarketRow[]): readonly HvMarketRow[] {
  return [...rows].sort((a, b) => {
    const oiA = a.openInterestUsd === null ? -1 : Number(a.openInterestUsd);
    const oiB = b.openInterestUsd === null ? -1 : Number(b.openInterestUsd);
    return (Number.isFinite(oiB) ? oiB : -1) - (Number.isFinite(oiA) ? oiA : -1);
  });
}

export function filterMarketRows(
  rows: readonly HvMarketRow[],
  queryText: string,
  filter: PickerFilter,
  favorites: readonly string[],
): readonly HvMarketRow[] {
  const needle = queryText.trim().toUpperCase();
  return orderRows(rows).filter((row) => {
    if (filter === "favorites" && !favorites.includes(row.coin)) return false;
    return needle.length === 0 || row.coin.toUpperCase().includes(needle);
  });
}

export function useMarketPicker({
  rows,
  favorites,
  onSelect,
  onClose,
}: {
  readonly rows: readonly HvMarketRow[];
  readonly favorites: readonly string[];
  readonly onSelect: (coin: string) => void;
  readonly onClose: () => void;
}): MarketPickerState {
  const [queryText, setQueryText] = useState("");
  const [filter, setFilter] = useState<PickerFilter>("all");
  const [cursor, setCursor] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Whether the last cursor move came from the keyboard (only then follow). */
  const keyboardCursor = useRef(false);

  const visible = useMemo(
    () => filterMarketRows(rows, queryText, filter, favorites),
    [rows, queryText, filter, favorites],
  );
  const clampedCursor = Math.min(cursor, Math.max(visible.length - 1, 0));

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Keep the keyboard cursor in view by scrolling ONLY the list element.
  // `scrollIntoView` is banned here: it also scrolls overflow-hidden
  // ancestors (the glass zone), which visibly lifted the chart header while
  // hover-scrolling the list (user bug report). Mouse-driven cursor moves
  // never scroll — adjusting scrollTop mid-wheel fights the user's hand.
  useEffect(() => {
    if (!keyboardCursor.current) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(
      `[data-hv-row-index="${clampedCursor}"]`,
    );
    if (list == null || row == null) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) {
      list.scrollTop += rowRect.top - listRect.top;
    } else if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    }
  }, [clampedCursor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      keyboardCursor.current = true;
      setCursor((current) => Math.min(current + 1, Math.max(visible.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      keyboardCursor.current = true;
      setCursor((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = visible[clampedCursor];
      if (row !== undefined) {
        onSelect(row.coin);
        onClose();
      }
    }
  };

  return {
    clampedCursor,
    filter,
    listRef,
    onKeyDown,
    queryText,
    searchRef,
    setFilter: (value: PickerFilter): void => {
      setFilter(value);
      setCursor(0);
    },
    setQueryText: (value: string): void => {
      setQueryText(value);
      setCursor(0);
    },
    setMouseCursor: (index: number): void => {
      keyboardCursor.current = false;
      setCursor(index);
    },
    visible,
  };
}
