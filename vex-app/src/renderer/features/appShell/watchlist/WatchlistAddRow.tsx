/**
 * Follow a token: a chain, then a ticker picked from DexScreener's list for
 * that chain, or a pasted address. The engine resolves the chain against its
 * closed set and checks the address shape; a refusal comes back by name and
 * is shown as it is.
 */

import { useId, useState, type FormEvent, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TokenSearchHitDto } from "@shared/schemas/alerts.js";
import { WATCHLIST_CHAINS } from "@shared/alerts-chains.js";
import { Button } from "../../../components/ui/button.js";
import { SelectMenu } from "../../../components/ui/select-menu.js";
import { invalidateWatchlist } from "../../../lib/api/alerts.js";
import { TokenSearchField } from "./TokenSearchField.js";
import { looksLikeAddress } from "./token-search-format.js";

export function WatchlistAddRow({ full }: { readonly full: boolean }): JSX.Element {
  const queryClient = useQueryClient();
  const tokenId = useId();
  const chainLabelId = useId();
  const [chain, setChain] = useState("base");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<TokenSearchHitDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const family = WATCHLIST_CHAINS.find((option) => option.slug === chain)?.family ?? "evm";

  // A picked token, else a pasted address; a bare ticker is not an address.
  const tokenAddress = picked?.address ?? (looksLikeAddress(text, family) ? text.trim() : "");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (tokenAddress === "" || busy) return;
    setBusy(true);
    setRefusal(null);
    const label = picked?.symbol;
    void window.vex.alerts
      .editWatchlist({ action: "add", chain, tokenAddress, ...(label === undefined ? {} : { label }) })
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          setRefusal(result.error.message);
          return;
        }
        if (!result.data.ok) {
          setRefusal(result.data.message);
          return;
        }
        setText("");
        setPicked(null);
        void invalidateWatchlist(queryClient);
      });
  };

  return (
    <form className="flex flex-col gap-2" aria-label="Follow a token" onSubmit={submit} data-testid="watchlist-add">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-1.5">
          <span id={chainLabelId} className="text-[12px] font-medium text-ink-tertiary">
            Chain
          </span>
          <SelectMenu
            value={chain}
            options={WATCHLIST_CHAINS.map((option) => ({ value: option.slug, label: option.name }))}
            onChange={(next) => {
              setChain(next);
              setPicked(null);
              setText("");
              setRefusal(null);
            }}
            ariaLabelledBy={chainLabelId}
            className="w-44"
          />
        </div>
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
          <label htmlFor={tokenId} className="text-[12px] font-medium text-ink-tertiary">
            Token
          </label>
          <TokenSearchField
            chain={chain}
            family={family}
            text={text}
            onTextChange={setText}
            picked={picked}
            onPick={setPicked}
            inputId={tokenId}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span aria-hidden="true" className="text-[12px] leading-[18px]">
            &nbsp;
          </span>
          <Button type="submit" disabled={busy || full || tokenAddress === ""} aria-busy={busy}>
            {busy ? "Adding…" : "Follow"}
          </Button>
        </div>
      </div>
      {full ? (
        <p className="m-0 text-[13px] text-ink-secondary">Your watchlist is full. Remove a token to follow another.</p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="watchlist-add-refusal">
          {refusal}
        </p>
      )}
    </form>
  );
}
