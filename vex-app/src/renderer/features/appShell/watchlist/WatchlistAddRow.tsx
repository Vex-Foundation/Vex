/**
 * Follow a token: a chain and an address. The engine resolves the chain
 * against its closed set and checks the address shape; a refusal comes back
 * by name and is shown as it is.
 */

import { useId, useState, type FormEvent, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WATCHLIST_CHAINS } from "@shared/alerts-chains.js";
import { Button } from "../../../components/ui/button.js";
import { SelectMenu } from "../../../components/ui/select-menu.js";
import { invalidateWatchlist } from "../../../lib/api/alerts.js";

export function WatchlistAddRow({ full }: { readonly full: boolean }): JSX.Element {
  const queryClient = useQueryClient();
  const addressId = useId();
  const chainLabelId = useId();
  const [chain, setChain] = useState("base");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const family = WATCHLIST_CHAINS.find((option) => option.slug === chain)?.family ?? "evm";

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (address.trim() === "" || busy) return;
    setBusy(true);
    setRefusal(null);
    void window.vex.alerts.editWatchlist({ action: "add", chain, tokenAddress: address.trim() }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setRefusal(result.error.message);
        return;
      }
      if (!result.data.ok) {
        setRefusal(result.data.message);
        return;
      }
      setAddress("");
      void invalidateWatchlist(queryClient);
    });
  };

  return (
    <form className="flex flex-col gap-2" aria-label="Follow a token" onSubmit={submit} data-testid="watchlist-add">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <span id={chainLabelId} className="text-[12px] font-medium text-ink-tertiary">
            Chain
          </span>
          <SelectMenu
            value={chain}
            options={WATCHLIST_CHAINS.map((option) => ({ value: option.slug, label: option.name }))}
            onChange={setChain}
            ariaLabelledBy={chainLabelId}
            className="w-44"
          />
        </div>
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
          <label htmlFor={addressId} className="text-[12px] font-medium text-ink-tertiary">
            Token address
          </label>
          <input
            id={addressId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={family === "solana" ? "Mint address" : "0x..."}
            data-testid="watchlist-add-address"
            className="h-10 border border-rule bg-surface-field px-3 font-mono text-[13px] text-ink-primary outline-none focus:border-accent-primary"
          />
        </div>
        <Button type="submit" disabled={busy || full || address.trim() === ""} aria-busy={busy}>
          {busy ? "Adding…" : "Follow"}
        </Button>
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
