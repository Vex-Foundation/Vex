import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import type { LighterTradingEnvironment, LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { IconChevronDown, IconClose, IconSearch, IconStar, IconStarFill } from "../../../components/icons/index.js";
import { MarketSymbol } from "./MarketSymbol.js";
import { classifyLighterMarket, marketProductLabel, type LighterMarketSection } from "./market-classification.js";
import { formatBaseAmount, formatNumber, formatPrice, formatQuoteVolume, marketSymbols } from "./format.js";

import { LIGHTER_ANALYSIS_STORAGE_KEY, useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
type SortColumn = "market" | "price" | "change" | "volume" | "interest";
type Sort = { readonly column: SortColumn; readonly direction: "asc" | "desc" };
const COLUMNS: readonly { readonly key: SortColumn; readonly label: string }[] = [
  { key: "market", label: "Market" },
  { key: "price", label: "Price" },
  { key: "change", label: "24h" },
  { key: "volume", label: "Volume" },
  { key: "interest", label: "Open interest" },
];

function identity(environment: LighterTradingEnvironment, market: LighterTradingMarket): string {
  return [environment, market.marketType, market.marketId, market.baseAssetId, market.quoteAssetId, market.symbol].join(":");
}

function sortValue(market: LighterTradingMarket, column: SortColumn): number | null {
  switch (column) {
    case "price": return market.statistics?.lastTradePrice ?? null;
    case "change": return market.statistics?.priceChange24h ?? null;
    case "volume": return market.activity24h.quoteVolume;
    case "interest": return market.statistics?.openInterestBase ?? null;
    case "market": return null;
  }
}

export function MarketPicker({ environment, markets, selectedMarketId, onClose, onSelect }: {
  readonly environment: LighterTradingEnvironment;
  readonly markets: readonly LighterTradingMarket[];
  readonly selectedMarketId: number | null;
  readonly onClose: () => void;
  readonly onSelect: (market: LighterTradingMarket) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | LighterMarketSection>("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const savedFavorites = useLighterAnalysisStore(state => state.favorites);
  const favorites = useMemo(() => new Set(savedFavorites), [savedFavorites]);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(() => {
    const selected = markets.find((market) => market.marketId === selectedMarketId);
    return selected === undefined ? null : identity(environment, selected);
  });
  const pickerRef = useRef<HTMLElement | null>(null);
  const highlightedOptionRef = useRef<HTMLButtonElement | null>(null);
  const initialScrollRef = useRef(true);
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const shown = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = markets.filter((market) => {
      const classification = classifyLighterMarket(environment, market);
      return (tab === "all" || classification.section === tab)
        && (!favoritesOnly || favorites.has(identity(environment, market)))
        && (normalized.length === 0 || market.symbol.toLocaleLowerCase().includes(normalized)
          || classification.ticker.toLocaleLowerCase().includes(normalized));
    });
    // Preserve provider list order until the user explicitly requests a sort.
    if (sort === null) return filtered;
    return filtered.sort((left, right) => {
      const fallback = left.symbol.localeCompare(right.symbol)
        || left.marketType.localeCompare(right.marketType) || left.marketId - right.marketId;
      if (sort.column === "market") return fallback * (sort.direction === "asc" ? 1 : -1);
      const leftValue = sortValue(left, sort.column);
      const rightValue = sortValue(right, sort.column);
      if (leftValue === null) return rightValue === null ? fallback : 1;
      if (rightValue === null) return -1;
      return (leftValue - rightValue) * (sort.direction === "asc" ? 1 : -1) || fallback;
    });
  }, [environment, favorites, favoritesOnly, markets, query, sort, tab]);
  const highlighted = shown.find((market) => identity(environment, market) === highlightedKey)
    ?? shown.find((market) => market.marketId === selectedMarketId) ?? shown[0];
  const activeKey = highlighted === undefined ? null : identity(environment, highlighted);
  const activeOptionId = highlighted === undefined ? undefined : `lit-market-${environment}-${highlighted.marketType}-${highlighted.marketId}`;

  useEffect(() => {
    if (highlightedOptionRef.current === null) return;
    highlightedOptionRef.current.scrollIntoView?.({ block: initialScrollRef.current ? "start" : "nearest" });
    initialScrollRef.current = false;
  }, [activeKey]);

  useEffect(() => () => { returnFocusRef.current?.focus(); }, []);

  useEffect(() => {
    const onOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || pickerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-lit-market-picker-trigger]")) return;
      onClose();
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === LIGHTER_ANALYSIS_STORAGE_KEY || event.key === null) void useLighterAnalysisStore.persist.rehydrate();
    };
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("storage", onStorage);
    };
  }, [onClose]);

  const toggleFavorite = (market: LighterTradingMarket): void => {
    const key = identity(environment, market);
    const next = new Set(favorites);
    if (next.has(key)) next.delete(key);
    else if (next.size < 1_000) next.add(key);
    setStorageUnavailable(!useLighterAnalysisStore.getState().saveFavorites([...next]));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      const controls = Array.from(pickerRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]):not([tabindex='-1']), input:not([disabled]):not([tabindex='-1'])",
      ) ?? []);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last !== undefined) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last && first !== undefined) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (!(event.target instanceof HTMLInputElement) || event.target.dataset.litMarketSearch !== "true") return;
    if (event.altKey && event.key.toLowerCase() === "f" && highlighted !== undefined) {
      event.preventDefault();
      toggleFavorite(highlighted);
      return;
    }
    if (event.key === "Enter" && highlighted !== undefined) {
      event.preventDefault();
      onSelect(highlighted);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? shown[0] : shown.at(-1);
      if (next !== undefined) setHighlightedKey(identity(environment, next));
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (shown.length === 0) return;
    const current = shown.findIndex((market) => identity(environment, market) === activeKey);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const next = shown[(current + direction + shown.length) % shown.length];
    if (next !== undefined) setHighlightedKey(identity(environment, next));
  };

  return <div className="lit-market-picker-layer" onKeyDown={onKeyDown}>
    <section id="lit-market-picker" ref={pickerRef} className="lit-market-picker" role="dialog"
      aria-labelledby="lit-market-picker-title" aria-describedby="lit-market-picker-description">
      <header className="lit-picker-heading">
        <h2 id="lit-market-picker-title"><span aria-hidden="true">Markets</span><span className="sr-only">Search Lighter markets</span></h2>
        <p id="lit-market-picker-description">{environment === "rhc" ? "Robinhood Chain" : "Lighter Core"}<span className="sr-only"> · Choose the market for this desk</span></p>
      </header>
      <div className="lit-picker-search"><IconSearch size={17} />
        <input autoFocus role="combobox" aria-autocomplete="list" aria-controls="lit-market-options" aria-expanded="true"
          aria-activedescendant={activeOptionId} aria-describedby="lit-picker-keyboard" data-lit-market-search="true"
          value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search markets" aria-label="Search Lighter markets" />
        <button type="button" onClick={onClose} aria-label="Close market search"><IconClose size={16} /></button>
      </div>
      <nav className="lit-picker-tabs" aria-label="Market type">
        <button type="button" className="lit-picker-favorites-filter" aria-label="Favorites" aria-pressed={favoritesOnly}
          title="Show favorites" onClick={() => setFavoritesOnly(!favoritesOnly)}><IconStar size={16} /></button>
        {(["all", "perp", "stocks", "spot"] as const).map((item) => <button type="button" key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>
          {item === "all" ? "All" : item === "perp" ? "Perps" : item === "stocks" ? "Stocks" : "Spot"}
        </button>)}
        <span>{shown.length}</span>
      </nav>
      <div className="lit-picker-scroll">
        <div className="lit-picker-columns">
          <span aria-hidden="true" />
          {COLUMNS.map(({ key, label }) => <button key={key} type="button" aria-label={`Sort by ${label}`}
            title={key === "volume" ? "24h volume in the displayed quote currency" : key === "interest" ? "Open interest in base units; compare the displayed units" : undefined}
            aria-pressed={sort?.column === key} data-direction={sort?.column === key ? sort.direction : undefined}
            onClick={() => setSort((current) => ({ column: key, direction: current?.column === key && current.direction === "desc" ? "asc" : current?.column === key ? "desc" : key === "market" ? "asc" : "desc" }))}>
            {label}<IconChevronDown size={10} />
          </button>)}
        </div>
        <div id="lit-market-options" role="listbox" aria-label="Available Lighter markets" className="lit-picker-options">
          {shown.map((market) => {
            const key = identity(environment, market);
            const symbols = marketSymbols(market.symbol, market.marketType);
            const productLabel = marketProductLabel(classifyLighterMarket(environment, market));
            const isFavorite = favorites.has(key);
            const change = market.statistics?.priceChange24h ?? null;
            const priceLabel = formatPrice(market.statistics?.lastTradePrice ?? null, market.decimals.price);
            const changeLabel = change === null ? "—" : `${change > 0 ? "+" : ""}${formatNumber(change, { maximumFractionDigits: 2 })}%`;
            const volumeLabel = formatQuoteVolume(market.activity24h.quoteVolume, symbols.quote);
            const interestLabel = formatBaseAmount(market.statistics?.openInterestBase ?? null, symbols.base);
            return <div className="lit-picker-row" key={key} role="presentation" data-highlighted={key === activeKey || undefined}>
              <button type="button" className="lit-picker-star" tabIndex={key === activeKey ? 0 : -1}
                aria-label={`${isFavorite ? "Remove" : "Add"} ${market.symbol} ${productLabel} ${isFavorite ? "from" : "to"} favorites`}
                aria-pressed={isFavorite} aria-keyshortcuts="Alt+F" title="Favorite (Alt+F in search)" onClick={() => toggleFavorite(market)}>
                {isFavorite ? <IconStarFill size={14} /> : <IconStar size={14} />}
              </button>
              <button type="button" className="lit-picker-option" role="option" tabIndex={-1}
                id={`lit-market-${environment}-${market.marketType}-${market.marketId}`}
                aria-label={`${market.symbol}, ${productLabel}, ${market.status}${isFavorite ? ", favorite" : ""}, price ${priceLabel} ${symbols.quote}, 24h change ${changeLabel}, 24h volume ${volumeLabel}, open interest ${interestLabel}`}
                aria-selected={market.marketId === selectedMarketId}
                ref={key === activeKey ? highlightedOptionRef : undefined}
                onMouseEnter={() => setHighlightedKey(key)} onClick={() => onSelect(market)}>
                <span className="lit-picker-identity"><MarketSymbol environment={environment} market={market} />
                  <span><b title={market.symbol}>{market.symbol}</b><small>{productLabel}{market.status === "inactive" ? " · Inactive" : ""}</small></span>
                </span>
                <span title={`${priceLabel} ${symbols.quote}`}>{priceLabel}</span>
                <span data-tone={change === null || change === 0 ? undefined : change > 0 ? "positive" : "negative"}>
                  {changeLabel}
                </span>
                <span title="24h quote volume">{volumeLabel}</span>
                <span title={market.marketType === "spot" ? "Open interest does not apply to spot" : "Open interest in base units"}>
                  {interestLabel}
                </span>
              </button>
            </div>;
          })}
        </div>
        {shown.length === 0 && <p className="lit-picker-empty" role="status">{favoritesOnly ? "No favorite markets match. Star a market to save it here." : "No matching markets. Try another symbol or category."}</p>}
      </div>
      <footer className="lit-picker-footer" id="lit-picker-keyboard">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select</span><span><kbd>Alt F</kbd> Favorite</span><span><kbd>Esc</kbd> Close</span>
        <span className="sr-only">Home moves to the first result. End moves to the last result.</span>
      </footer>
      {storageUnavailable && <p className="lit-picker-storage" role="status">Favorites are saved for this view only. Local storage is unavailable.</p>}
      <span className="sr-only" role="status">{sort === null ? "Default market order" : `Sorted by ${COLUMNS.find((column) => column.key === sort.column)?.label}, ${sort.direction === "asc" ? "ascending" : "descending"}`}</span>
    </section>
  </div>;
}
