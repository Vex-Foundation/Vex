/**
 * The add form's token field: type a ticker or a name and pick the token from
 * what DexScreener knows on the chosen chain, or paste an address.
 *
 * A pasted address skips the search. Anything else of two characters or more
 * is searched once typing pauses (300 ms); the list shows each token's short
 * address, price, 24 hour volume and pool count, because several tokens share
 * one ticker and the address and the trading are what tell them apart. The
 * engine ranks by volume for the same reason.
 *
 * Combobox and listbox ARIA, as `SelectMenu`: focus stays in the input, the
 * active row is `aria-activedescendant`, ArrowUp/ArrowDown move, Enter picks,
 * Escape closes. No inline styles (CSP `style-src 'self'`).
 */

import { useEffect, useId, useState, type JSX, type KeyboardEvent } from "react";
import type { TokenSearchHitDto } from "@shared/schemas/alerts.js";
import { alertChainName } from "@shared/alerts-copy.js";
import { cn } from "../../../lib/utils.js";
import { useTokenSearch } from "../../../lib/api/alerts.js";
import { hitDetail, looksLikeAddress, shortAddress } from "./token-search-format.js";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 2;

export interface TokenSearchFieldProps {
  readonly chain: string;
  readonly family: "evm" | "solana";
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly picked: TokenSearchHitDto | null;
  readonly onPick: (hit: TokenSearchHitDto | null) => void;
  readonly inputId: string;
}

export function TokenSearchField({
  chain,
  family,
  text,
  onTextChange,
  picked,
  onPick,
  inputId,
}: TokenSearchFieldProps): JSX.Element {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const trimmed = text.trim();
  const isAddress = looksLikeAddress(trimmed, family);

  // Search the text once typing pauses, never a pasted address.
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const searchable = picked === null && !isAddress && settled.length >= SEARCH_MIN_CHARS && settled === trimmed;
  const search = useTokenSearch(chain, settled, searchable);
  const answer = search.data?.ok === true ? search.data.data : null;
  const hits = answer?.ok === true ? answer.tokens : [];
  const showList = open && searchable;

  useEffect(() => setActiveIndex(0), [settled, chain]);

  const choose = (hit: TokenSearchHitDto | undefined): void => {
    if (hit === undefined) return;
    onPick(hit);
    onTextChange(hit.symbol);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!showList || hits.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(hits.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(hits[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  const chainName = alertChainName(chain);
  const status = ((): string | null => {
    if (!showList) return null;
    if (search.isFetching && answer === null) return "Searching DexScreener…";
    if (search.data !== undefined && !search.data.ok) return search.data.error.message;
    if (answer !== null && !answer.ok) return answer.message;
    if (answer !== null && hits.length === 0) return `No ${chainName} token matches "${settled}". Paste its address instead.`;
    return null;
  })();

  return (
    <div className="relative flex flex-col gap-1.5">
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={showList && hits.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={showList && hits.length > 0 ? `${listboxId}-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          onTextChange(event.target.value);
          if (picked !== null) onPick(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={family === "solana" ? "Ticker, name or mint address" : "Ticker, name or 0x address"}
        data-testid="watchlist-add-address"
        className="h-10 border border-rule bg-surface-field px-3 font-mono text-[13px] text-ink-primary outline-none focus:border-accent-primary"
      />

      {picked !== null ? (
        <p className="m-0 flex items-center gap-2 text-[12px] text-ink-secondary" data-testid="watchlist-add-picked">
          <span>
            {picked.symbol} on {chainName} ·{" "}
            <span className="font-mono vex-num">{shortAddress(picked.address)}</span>
          </span>
          <button
            type="button"
            className="text-accent-primary underline-offset-2 hover:underline"
            onClick={() => {
              onPick(null);
              onTextChange("");
            }}
          >
            Change
          </button>
        </p>
      ) : null}

      {showList && (hits.length > 0 || status !== null) ? (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 border border-rule-ink bg-surface-field text-ink-primary">
          {hits.length > 0 ? (
            <ul id={listboxId} role="listbox" aria-label={`Tokens on ${chainName}`} className="vex-scroll-elevated m-0 max-h-80 list-none overflow-y-auto p-0 py-1">
              {hits.map((hit, index) => (
                <li
                  key={hit.address}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid="watchlist-token-option"
                  // mousedown, not click: the input's blur would close the list first.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(hit);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn("flex cursor-pointer flex-col gap-0.5 px-3 py-2", index === activeIndex && "bg-interactive-hover")}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-[13.5px] font-medium text-ink-primary">{hit.symbol}</span>
                    {hit.name === null ? null : <span className="min-w-0 truncate text-[12px] text-ink-tertiary">{hit.name}</span>}
                    <span className="ml-auto font-mono text-[12px] text-ink-secondary vex-num">{shortAddress(hit.address)}</span>
                  </span>
                  <span className="font-mono text-[12px] text-ink-tertiary vex-num">{hitDetail(hit)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {status !== null ? (
            <p role="status" className="m-0 px-3 py-2 text-[12.5px] text-ink-secondary" data-testid="watchlist-token-status">
              {status}
            </p>
          ) : null}
          {answer?.ok === true && answer.source === "public_search" && hits.length > 0 ? (
            <p className="m-0 border-t border-rule-quiet px-3 py-1.5 text-[12px] text-ink-tertiary">
              Searched DexScreener across chains. If your token is missing, paste its address.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
