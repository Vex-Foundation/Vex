/**
 * Cashback: the claimable amount and "Claim to balance" (owner decision D13;
 * the wallet destination is phase 3 and is not offered). A claim moves
 * everything claimable. When Vex Cloud's answer does not prove whether the
 * claim went through, the outcome is "Status unknown" (never "Nothing was
 * changed"), and "Check status" repeats the SAME claim in main (the same
 * idempotency key), which reports what that claim moved and cannot pay twice.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import type { VexCloudAccount } from "@shared/schemas/vex-cloud.js";
import { formatMicroUsdEstimate, formatVexExact } from "@shared/vex-cloud-money.js";
import { Button } from "../../../components/ui/button.js";
import { StateWord } from "../../../components/ui/state-word.js";
import { claimVexCloudCashback, useInvalidateVexCloudFunding } from "../../../lib/api/vex-cloud.js";
import { NOT_AVAILABLE } from "./funding-model.js";

export const CLAIM_STATUS_UNKNOWN =
  "Vex did not get a clear answer from Vex Inference, so this claim may or may not have gone through. Check status repeats the same claim, which cannot pay twice.";

export const NOTHING_TO_CLAIM = "Nothing to claim yet. Cashback is 3% of the model cost of your requests, credited as Vex Inference settles them.";

export function CashbackTab({ account }: { readonly account: VexCloudAccount }): JSX.Element {
  const invalidate = useInvalidateVexCloudFunding();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    | { readonly kind: "claimed"; readonly text: string }
    | { readonly kind: "unknown"; readonly note: string | null }
    | { readonly kind: "refused"; readonly text: string }
    | null
  >(null);
  const mounted = useRef(true);
  useEffect(() => {
    // Set in the setup, not only at creation: StrictMode runs setup, cleanup, setup.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const claimable = BigInt(account.balances.claimable.wei);
  const usd = account.balances.claimable.usdMicroEstimate;

  const claim = (): void => {
    // A press while the outcome is unknown is a CHECK of that claim, not a new one.
    const checkingUnknown = outcome?.kind === "unknown";
    setBusy(true);
    setOutcome(checkingUnknown ? { kind: "unknown", note: null } : null);
    void claimVexCloudCashback().then((result) => {
      invalidate();
      if (!mounted.current) return;
      setBusy(false);
      if (!result.ok) {
        // A refused CHECK says nothing about the earlier claim: main still holds
        // its key, so the view stays "Status unknown" and shows why the check failed.
        setOutcome(checkingUnknown ? { kind: "unknown", note: result.error.message } : { kind: "refused", text: result.error.message });
        return;
      }
      if (result.data.outcome === "unknown") {
        setOutcome({ kind: "unknown", note: null });
        return;
      }
      const claimed = BigInt(result.data.claimedWei);
      setOutcome({
        kind: "claimed",
        text: claimed === 0n ? "Nothing was claimable, so nothing moved." : `Claimed ${formatVexExact(claimed)} VEX to your Vex Inference balance.`,
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
          {usd === null ? `USD estimate: ${NOT_AVAILABLE}` : formatMicroUsdEstimate(BigInt(usd))}
        </span>
        <p className="m-0 mt-2 text-[13px] text-ink-secondary">
          Claiming adds it to your Vex Inference balance at once.
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
      {claimable === 0n && outcome?.kind !== "unknown" ? (
        <p className="m-0 text-[13px] text-ink-primary" data-testid="cashback-disabled-reason">
          {NOTHING_TO_CLAIM}
        </p>
      ) : null}
      <div>
        {outcome?.kind === "unknown" ? (
          // The balance may already show the claim, so the key stays enabled whatever it reads.
          <Button type="button" onClick={claim} disabled={busy} aria-busy={busy}>
            {busy ? "Checking…" : "Check status"}
          </Button>
        ) : (
          <Button type="button" onClick={claim} disabled={claimable === 0n || busy} aria-busy={busy}>
            {busy ? "Claiming…" : "Claim to balance"}
          </Button>
        )}
      </div>
      {outcome === null ? null : outcome.kind === "claimed" ? (
        <StateWord state="done" word={outcome.text} live data-testid="cashback-outcome" />
      ) : outcome.kind === "unknown" ? (
        <div className="flex flex-col gap-1" data-testid="cashback-outcome">
          <StateWord state="error" word="Status unknown" live />
          <p className="m-0 text-[13px] text-ink-secondary">{CLAIM_STATUS_UNKNOWN}</p>
          {outcome.note === null ? null : (
            <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="cashback-check-note">
              {outcome.note}
            </p>
          )}
        </div>
      ) : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="cashback-outcome">
          {outcome.text}
        </p>
      )}
    </section>
  );
}
