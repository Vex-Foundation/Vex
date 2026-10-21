/**
 * Cashback: the claimable amount and "Claim to balance" (owner decision D13;
 * the wallet destination is phase 3 and is not offered). A claim moves
 * everything claimable; pressing again after a lost answer finds nothing
 * left, so it cannot pay twice.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import type { VexCloudAccount } from "@shared/schemas/vex-cloud.js";
import { formatMicroUsd, formatVexExact } from "@shared/vex-cloud-money.js";
import { Button } from "../../../components/ui/button.js";
import { StateWord } from "../../../components/ui/state-word.js";
import { claimVexCloudCashback, useInvalidateVexCloudFunding } from "../../../lib/api/vex-cloud.js";
import { NOT_AVAILABLE } from "./funding-model.js";

export const NOTHING_TO_CLAIM = "Nothing to claim yet. Cashback is 3% of what your requests cost, credited as Vex Cloud settles them.";

export function CashbackTab({ account }: { readonly account: VexCloudAccount }): JSX.Element {
  const invalidate = useInvalidateVexCloudFunding();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const claimable = BigInt(account.balances.claimable.wei);
  const usd = account.balances.claimable.usdMicroEstimate;

  const claim = (): void => {
    setBusy(true);
    setOutcome(null);
    void claimVexCloudCashback().then((result) => {
      invalidate();
      if (!mounted.current) return;
      setBusy(false);
      if (!result.ok) {
        setOutcome({ ok: false, text: result.error.message });
        return;
      }
      const claimed = BigInt(result.data.claimedWei);
      setOutcome({
        ok: true,
        text: claimed === 0n ? "Nothing was claimable, so nothing moved." : `Claimed ${formatVexExact(claimed)} VEX to your Vex Cloud balance.`,
      });
    });
  };

  return (
    <section className="flex flex-col gap-4" aria-label="Cashback" data-testid="cashback-tab">
      <div className="flex flex-col gap-1 border border-rule-ink p-4">
        <span className="text-[12px] font-medium text-ink-tertiary">Claimable cashback</span>
        <span className="vex-num font-mono text-[34px] font-medium leading-[1.1] tracking-[-0.03em] text-ink-primary" data-testid="cashback-claimable">
          {formatVexExact(claimable)} VEX
        </span>
        <span className="text-[13px] text-ink-tertiary">
          {usd === null ? `USD estimate: ${NOT_AVAILABLE}` : `about ${formatMicroUsd(BigInt(usd))}`}
        </span>
        <p className="m-0 mt-2 text-[13px] text-ink-secondary">
          Claiming adds it to your Vex Cloud balance at once. Claiming to a wallet comes later.
        </p>
        <p className="m-0 text-[13px] text-ink-tertiary" data-testid="cashback-pending">
          Pending, not claimable yet:{" "}
          <span className="vex-num font-mono text-ink-primary">
            {account.balances.cashbackPending === null
              ? NOT_AVAILABLE
              : `${formatVexExact(BigInt(account.balances.cashbackPending.wei))} VEX`}
          </span>
          . Cashback earned on a deposit that is still finalizing is released when it finalizes, in about 16 minutes.
        </p>
      </div>
      {claimable === 0n ? (
        <p className="m-0 text-[13px] text-ink-primary" data-testid="cashback-disabled-reason">
          {NOTHING_TO_CLAIM}
        </p>
      ) : null}
      <div>
        <Button type="button" onClick={claim} disabled={claimable === 0n || busy} aria-busy={busy}>
          {busy ? "Claiming…" : "Claim to balance"}
        </Button>
      </div>
      {outcome === null ? null : outcome.ok ? (
        <StateWord state="done" word={outcome.text} live data-testid="cashback-outcome" />
      ) : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="cashback-outcome">
          {outcome.text}
        </p>
      )}
    </section>
  );
}
