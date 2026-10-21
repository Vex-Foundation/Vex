/**
 * Withdraw: an amount and a wallet picked from the ones that are BOTH linked
 * to the account AND in this app (owner decision D5). There is no address
 * field. The approval card says the amount, the destination, "Funds leave Vex
 * Cloud" and the daily limit left; after the submit the status is polled
 * until it reads Completed or Returned (fill plus word).
 *
 * TWO STATES THAT LOOK ALIKE AND MUST NOT BE CONFUSED:
 *  - `reviewing`: the approval was never submitted. Reject is honest here:
 *    nothing was sent.
 *  - `outcome_unknown`: the request WAS sent and Vex Cloud's answer did not
 *    prove a refusal, so the withdrawal may exist. There is no Reject (it
 *    would claim nothing was sent). "Check status" replays the same request
 *    with the same idempotency key in main, which can only return the
 *    existing withdrawal; "Close" keeps the record visible ("Status
 *    unknown") with History one press away, and a NEW review of the same
 *    amount to the same wallet stays blocked until the record resolves.
 *
 * A record resolves only on an answer about the original request (the
 * withdrawal, or "not created"). A check that main answers with "no such
 * proposal" means main no longer holds it: the record stays, says so, and
 * leaves only when the user dismisses it after checking History.
 */

import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import type { VexCloudAccount } from "@shared/schemas/vex-cloud.js";
import type { VexCloudWithdrawal, VexCloudWithdrawalProposal } from "@shared/schemas/vex-cloud-funding.js";
import { formatMicroUsd, formatVexExact, VEX_CLOUD_CHAIN_ID } from "@shared/vex-cloud-money.js";
import type { VexError } from "@shared/ipc/result.js";
import { Button } from "../../../components/ui/button.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { StateWord } from "../../../components/ui/state-word.js";
import {
  prepareVexCloudWithdrawal,
  submitVexCloudWithdrawal,
  useInvalidateVexCloudFunding,
  useVexCloudWithdrawal,
} from "../../../lib/api/vex-cloud.js";
import { WalletSelect } from "../../appShell/SessionWalletSelect.js";
import { FundingApprovalCard } from "./FundingApprovalCard.js";
import { eligibleDestinations, NOT_AVAILABLE, rateOf, readAmount, shortAddress, withdrawalLook } from "./funding-model.js";
import { unresolvedFor, useUnresolvedWithdrawals, type UnresolvedWithdrawal } from "./unresolved-withdrawals.js";

type Step =
  | { readonly kind: "editing" }
  | { readonly kind: "preparing"; readonly cancel: () => void }
  | { readonly kind: "reviewing"; readonly proposal: VexCloudWithdrawalProposal }
  | { readonly kind: "sending"; readonly proposal: VexCloudWithdrawalProposal }
  | { readonly kind: "outcome_unknown"; readonly record: UnresolvedWithdrawal }
  | { readonly kind: "sent"; readonly withdrawal: VexCloudWithdrawal };

export const WITHDRAWALS_NOT_OPEN = "Withdrawals are not open yet";

export const NO_WITHDRAW_DESTINATION =
  "Withdrawals go only to a wallet that is linked to your Vex Cloud account and is in this app, and none is.";

export const STATUS_UNKNOWN = "Status unknown";

export const OUTCOME_UNKNOWN_DETAIL =
  "Vex sent this withdrawal to Vex Cloud but did not get a clear answer, so it may or may not have been created. Check status asks again with the same request, which cannot create a second withdrawal.";

export const LOST_UNRESOLVED_DETAIL =
  "Vex no longer holds this request, so it cannot re-check it here. Look for it in History; do not send it again until you have checked.";

export const DISMISS_LOST = "I checked History";

export const UNRESOLVED_BLOCKS_REVIEW =
  "A withdrawal of this amount to this wallet was sent and its status is not known yet. Check its status above before starting another.";

function errorText(error: VexError): string {
  return error.code === "internal.cancelled" ? "Cancelled. Nothing was sent." : error.message;
}

export function WithdrawTab({
  account,
  localWallets,
  onOpenHistory,
}: {
  readonly account: VexCloudAccount;
  readonly localWallets: readonly string[];
  readonly onOpenHistory: () => void;
}): JSX.Element {
  const destinations = useMemo(() => eligibleDestinations(account, localWallets), [account, localWallets]);
  const invalidate = useInvalidateVexCloudFunding();
  const amountId = useId();
  const [destination, setDestination] = useState<string | null>(destinations[0] ?? null);
  const [amountText, setAmountText] = useState("");
  const [step, setStep] = useState<Step>({ kind: "editing" });
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [checkNote, setCheckNote] = useState<{ readonly proposalId: string; readonly text: string } | null>(null);
  const unresolved = useUnresolvedWithdrawals((state) => state.records);
  const keepUnresolved = useUnresolvedWithdrawals((state) => state.keep);
  const resolveUnresolved = useUnresolvedWithdrawals((state) => state.resolve);
  const markLost = useUnresolvedWithdrawals((state) => state.markLost);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    // Set in the setup, not only at creation: StrictMode runs setup, cleanup, setup.
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const withdrawable = account.withdrawable === null ? null : BigInt(account.withdrawable.wei);
  const reading = readAmount({
    text: amountText,
    rateX18: rateOf(account.rate),
    minimumMicroUsd: BigInt(account.limits.minWithdrawMicroUsd),
    max: withdrawable,
    maxLabel: "can be withdrawn now",
  });
  const blockedBy = unresolvedFor(unresolved, reading.wei, destination);
  const disabledReason =
    destinations.length === 0
      ? NO_WITHDRAW_DESTINATION
      : account.paused
        ? "Vex Cloud paused this account for review, so funds cannot leave it right now."
        : destination === null
          ? "Pick a wallet."
          : (reading.problem ?? (blockedBy === null ? null : UNRESOLVED_BLOCKS_REVIEW));

  if (account.depositAddress === null) {
    // The backend reports no deposit address exactly when it has no custody
    // configured, and then refuses every withdrawal (503 `withdrawals_unavailable`).
    return (
      <EmptyBlock
        scope="Withdraw"
        title={WITHDRAWALS_NOT_OPEN}
        detail="Vex Cloud cannot send VEX out yet. Your balance stays in your account and still pays for requests."
        data-testid="withdraw-not-open"
      />
    );
  }
  if (destinations.length === 0 && unresolved.length === 0) {
    return <EmptyBlock scope="Withdraw" title="No wallet to withdraw to" detail={NO_WITHDRAW_DESTINATION} data-testid="withdraw-no-destination" />;
  }

  const review = (): void => {
    if (destination === null || disabledReason !== null) return;
    const mine = ++generation.current;
    setMessage(null);
    const invocation = prepareVexCloudWithdrawal({ destination, amountText });
    setStep({ kind: "preparing", cancel: invocation.cancel });
    void invocation.promise.then((result) => {
      if (mine !== generation.current) return;
      if (result.ok) {
        setStep({ kind: "reviewing", proposal: result.data });
        return;
      }
      setStep({ kind: "editing" });
      setMessage(errorText(result.error));
    });
  };

  /**
   * Submit (`proposal` from a review) or replay (`record` of an unknown
   * outcome): the same IPC call, the same proposal id, so main reuses its key.
   * A result is never dropped by a newer press: whether a withdrawal exists
   * is a fact, so an accepted or unknown answer always lands in the store.
   */
  const send = (record: UnresolvedWithdrawal, fromReview: boolean): void => {
    const mine = ++generation.current;
    setMessage(null);
    setCheckNote(null);
    setChecking(record.proposalId);
    void submitVexCloudWithdrawal({
      proposalId: record.proposalId,
      destination: record.destination,
      amountWei: record.amountWei,
    }).then((result) => {
      if (mounted.current) setChecking((current) => (current === record.proposalId ? null : current));
      if (result.ok && result.data.outcome === "accepted") {
        resolveUnresolved(record.proposalId);
        invalidate();
        if (!mounted.current || mine !== generation.current) return;
        setStep({ kind: "sent", withdrawal: result.data.withdrawal });
        setAmountText("");
        return;
      }
      if (result.ok && result.data.outcome === "not_created") {
        // An answer about the original: Vex Cloud found no withdrawal for its key and refused.
        resolveUnresolved(record.proposalId);
        invalidate();
        if (!mounted.current || mine !== generation.current) return;
        setStep({ kind: "editing" });
        setMessage(`Vex Cloud did not create this withdrawal. ${result.data.detail}`);
        return;
      }
      if (result.ok) {
        keepUnresolved(record);
        if (!mounted.current || mine !== generation.current) return;
        if (!fromReview) setCheckNote({ proposalId: record.proposalId, text: "Still no clear answer from Vex Cloud. Try Check status again in a moment, or look in History." });
        setStep((current) => (current.kind === "editing" ? current : { kind: "outcome_unknown", record }));
        return;
      }
      if (fromReview) {
        if (!mounted.current || mine !== generation.current) return;
        setStep({ kind: "editing" });
        setMessage(errorText(result.error));
        return;
      }
      // "No such proposal" on a check says nothing about the original: main
      // no longer holds it. The record stays, marked lost, until dismissed.
      if (result.error.code === "approvals.already_resolved") {
        markLost(record.proposalId);
        if (!mounted.current || mine !== generation.current) return;
        setStep({ kind: "editing" });
        return;
      }
      if (!mounted.current || mine !== generation.current) return;
      setCheckNote({ proposalId: record.proposalId, text: errorText(result.error) });
    });
  };

  const approve = (proposal: VexCloudWithdrawalProposal): void => {
    setStep({ kind: "sending", proposal });
    send({ proposalId: proposal.proposalId, amountWei: proposal.amountWei, destination: proposal.destination }, true);
  };

  if (step.kind === "reviewing" || step.kind === "sending") {
    const proposal = step.proposal;
    const amount = formatVexExact(BigInt(proposal.amountWei));
    return (
      <div className="flex flex-col gap-3">
        <FundingApprovalCard
          testId="withdraw-approval"
          sentence={`Withdraw ${amount} VEX to your wallet ${shortAddress(proposal.destination)}.`}
          source={{
            left: "From your Vex Cloud balance",
            right:
              proposal.withdrawableWei === null ? (
                `Withdrawable now: ${NOT_AVAILABLE}`
              ) : (
                <>
                  <span className="vex-num">{formatVexExact(BigInt(proposal.withdrawableWei))}</span> VEX withdrawable now
                </>
              ),
          }}
          lines={[
            { label: "You receive", value: <><span className="vex-appr__num vex-num">{amount} VEX</span><span className="vex-appr__sub"> · on Robinhood Chain</span></> },
            { label: "Destination", value: <span className="vex-appr__num vex-num vex-appr__break">{proposal.destination}</span> },
            { label: "Value", value: <>about <span className="vex-appr__num vex-num">{formatMicroUsd(BigInt(proposal.usdMicroEstimate))}</span></> },
            {
              label: "Daily limit left",
              value:
                proposal.dailyRemainingWei === null ? null : (
                  <span className="vex-appr__num vex-num">{formatVexExact(BigInt(proposal.dailyRemainingWei))} VEX</span>
                ),
            },
          ]}
          risks={[
            { lead: "Funds leave Vex Cloud:", text: "this VEX leaves your Vex Cloud balance for the wallet above, and the transfer cannot be undone once it is sent." },
          ]}
          signedFields={[
            { label: "Actor", value: "You, from the funding page" },
            { label: "Chain ID", value: String(VEX_CLOUD_CHAIN_ID) },
            { label: "Amount, raw", value: `${proposal.amountWei} (18 decimals)` },
            { label: "Destination", value: proposal.destination },
            { label: "Proposal", value: proposal.proposalId },
            { label: "Expires", value: proposal.expiresAt },
          ]}
          expiresAt={proposal.expiresAt}
          approveLabel="Approve withdrawal"
          pendingLabel="Sending withdrawal"
          armed={false}
          busy={step.kind === "sending"}
          onReject={() => {
            // Reachable only while `reviewing`: the card disables Reject once sending starts.
            generation.current += 1;
            setStep({ kind: "editing" });
            setMessage("Withdrawal rejected. Nothing was sent.");
          }}
          onApprove={() => approve(proposal)}
        />
      </div>
    );
  }

  if (step.kind === "outcome_unknown") {
    const record = step.record;
    return (
      <OutcomeUnknown
        record={record}
        checking={checking === record.proposalId}
        note={checkNote?.proposalId === record.proposalId ? checkNote.text : null}
        onCheck={() => send(record, false)}
        onClose={() => {
          setCheckNote(null);
          setStep({ kind: "editing" });
        }}
        onOpenHistory={onOpenHistory}
      />
    );
  }

  if (step.kind === "sent") {
    return <WithdrawalStatus initial={step.withdrawal} onDone={() => setStep({ kind: "editing" })} />;
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Withdraw VEX" data-testid="withdraw-form">
      {unresolved.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Withdrawals with an unknown status" data-testid="withdraw-unresolved">
          {unresolved.map((record) => (
            <li key={record.proposalId} className="flex flex-col gap-1.5 border border-rule-ink p-3" data-testid="withdraw-unresolved-row">
              <StateWord state="error" word={checking === record.proposalId ? "Checking status" : STATUS_UNKNOWN} />
              <p className="m-0 text-[13px] text-ink-secondary">
                {formatVexExact(BigInt(record.amountWei))} VEX to <span className="vex-num font-mono">{shortAddress(record.destination)}</span>. It may or may not have been created.
              </p>
              {record.lost === true ? (
                <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="withdraw-unresolved-lost">
                  {LOST_UNRESOLVED_DETAIL}
                </p>
              ) : checkNote?.proposalId === record.proposalId ? (
                <p role="alert" className="m-0 text-[13px] text-ink-primary">
                  {checkNote.text}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                {record.lost === true ? null : (
                  <Button type="button" variant="ink" size="sm" disabled={checking === record.proposalId} onClick={() => send(record, false)}>
                    Check status
                  </Button>
                )}
                <Button type="button" variant="quiet" size="sm" onClick={onOpenHistory}>
                  Open History
                </Button>
                {record.lost === true ? (
                  <Button type="button" variant="quiet" size="sm" onClick={() => resolveUnresolved(record.proposalId)}>
                    {DISMISS_LOST}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-3 border border-rule-ink p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={amountId} className="text-[12px] font-medium text-ink-tertiary">
            You withdraw
          </label>
          <div className="flex items-stretch border border-rule focus-within:border-accent-primary">
            <input
              id={amountId}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={amountText}
              placeholder="0"
              onChange={(event) => setAmountText(event.target.value)}
              disabled={step.kind === "preparing"}
              aria-describedby={`${amountId}-usd ${amountId}-why`}
              className="h-12 min-w-0 flex-1 bg-surface-field px-3 font-mono text-[22px] text-ink-primary outline-none"
            />
            <span className="flex items-center border-l border-rule px-3 text-[14px] font-medium text-ink-primary">VEX</span>
          </div>
          <p id={`${amountId}-usd`} className="m-0 text-[13px] text-ink-tertiary">
            {reading.usdLine ?? `USD estimate: ${NOT_AVAILABLE}`}
            {" · "}withdrawable now{" "}
            <span className="vex-num font-mono">{withdrawable === null ? NOT_AVAILABLE : `${formatVexExact(withdrawable)} VEX`}</span>
            {" · "}minimum {formatMicroUsd(BigInt(account.limits.minWithdrawMicroUsd))}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-tertiary">To your wallet</span>
          <WalletSelect
            label="Wallet to withdraw to"
            caption="EVM"
            value={destination}
            allowNone={false}
            options={destinations.map((address) => ({ id: address, address, label: "Linked wallet" }))}
            onChange={(next) => setDestination(next)}
          />
        </div>
        <p className="m-0 text-[13px] text-ink-secondary">
          Daily limit left:{" "}
          <span className="vex-num font-mono">
            {account.limits.withdrawDailyRemainingWei === null
              ? NOT_AVAILABLE
              : `${formatVexExact(BigInt(account.limits.withdrawDailyRemainingWei))} VEX`}
          </span>
        </p>
      </div>
      <p id={`${amountId}-why`} className="m-0 min-h-[20px] text-[13px] text-ink-primary" data-testid="withdraw-disabled-reason">
        {disabledReason ?? ""}
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={review} disabled={disabledReason !== null || step.kind === "preparing"}>
          {step.kind === "preparing" ? "Checking…" : "Review withdrawal"}
        </Button>
        {step.kind === "preparing" ? (
          <Button type="button" variant="ink" onClick={step.cancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      {message === null ? null : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="withdraw-message">
          {message}
        </p>
      )}
    </section>
  );
}

function OutcomeUnknown({
  record,
  checking,
  note,
  onCheck,
  onClose,
  onOpenHistory,
}: {
  readonly record: UnresolvedWithdrawal;
  readonly checking: boolean;
  readonly note: string | null;
  readonly onCheck: () => void;
  readonly onClose: () => void;
  readonly onOpenHistory: () => void;
}): JSX.Element {
  const checkRef = useRef<HTMLButtonElement | null>(null);
  // First focus on the safe, informative action; there is no Reject here.
  useEffect(() => {
    checkRef.current?.focus();
  }, []);
  return (
    <section className="flex flex-col gap-3 border-[1.5px] border-rule-ink p-4" aria-label="Withdrawal status unknown" data-testid="withdraw-outcome-unknown">
      <StateWord state="error" word={checking ? "Checking status" : STATUS_UNKNOWN} size={12} live />
      <p className="m-0 text-[14px] leading-[1.5] text-ink-secondary">{OUTCOME_UNKNOWN_DETAIL}</p>
      <p className="m-0 text-[13px] text-ink-tertiary">
        {formatVexExact(BigInt(record.amountWei))} VEX to <span className="vex-num font-mono">{record.destination}</span>
      </p>
      {note === null ? null : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="withdraw-check-note">
          {note}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button ref={checkRef} type="button" onClick={onCheck} disabled={checking} aria-busy={checking}>
          {checking ? "Checking…" : "Check status"}
        </Button>
        <Button type="button" variant="ink" onClick={onClose}>
          Close
        </Button>
        <Button type="button" variant="quiet" onClick={onOpenHistory}>
          Open History
        </Button>
      </div>
    </section>
  );
}

function WithdrawalStatus({ initial, onDone }: { readonly initial: VexCloudWithdrawal; readonly onDone: () => void }): JSX.Element {
  const query = useVexCloudWithdrawal(initial.id);
  const withdrawal = query.data?.ok === true ? query.data.data.withdrawal : initial;
  const look = withdrawalLook(withdrawal.status);
  return (
    <section className="flex flex-col gap-3" aria-label="Withdrawal status" data-testid="withdraw-status">
      <StateWord state={look.fill} word={look.word} size={12} live />
      <p className="m-0 text-[14px] leading-[1.5] text-ink-secondary">
        {look.word === "Pending"
          ? "Vex Cloud accepted the withdrawal and is sending it."
          : look.word === "Confirming"
            ? "The transfer is on Robinhood Chain and waiting to be final."
            : look.word === "Completed"
              ? "The VEX reached your wallet."
              : "The withdrawal did not go through, and the VEX is back in your Vex Cloud balance."}
      </p>
      <p className="m-0 text-[13px] text-ink-tertiary">
        {formatVexExact(BigInt(withdrawal.amountWei))} VEX to <span className="vex-num font-mono">{withdrawal.destination}</span>
        {withdrawal.txHash === null ? null : (
          <>
            {" · "}transaction <span className="vex-num font-mono break-all">{withdrawal.txHash}</span>
          </>
        )}
      </p>
      {query.data?.ok === false ? (
        <p role="alert" className="m-0 text-[13px] text-ink-primary">
          The status could not be read: {query.data.error.message}
        </p>
      ) : null}
      <div>
        <Button type="button" variant="ink" size="sm" onClick={onDone}>
          New withdrawal
        </Button>
      </div>
    </section>
  );
}
