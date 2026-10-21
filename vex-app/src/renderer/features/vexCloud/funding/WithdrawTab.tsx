/**
 * Withdraw: an amount and a wallet picked from the ones that are BOTH linked
 * to the account AND in this app (owner decision D5). There is no address
 * field. The approval card says the amount, the destination, "Funds leave Vex
 * Cloud" and the daily limit left; after the submit the status is polled
 * until it reads Completed or Returned (fill plus word).
 *
 * A transport failure keeps the approved proposal: pressing the key again
 * sends the SAME request (main reuses its idempotency key), so a retry can
 * never withdraw twice.
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

type Step =
  | { readonly kind: "editing" }
  | { readonly kind: "preparing"; readonly cancel: () => void }
  | { readonly kind: "review"; readonly proposal: VexCloudWithdrawalProposal; readonly retryNote: string | null }
  | { readonly kind: "sending"; readonly proposal: VexCloudWithdrawalProposal }
  | { readonly kind: "sent"; readonly withdrawal: VexCloudWithdrawal };

export const WITHDRAWALS_NOT_OPEN = "Withdrawals are not open yet";

export const NO_WITHDRAW_DESTINATION =
  "Withdrawals go only to a wallet that is linked to your Vex Cloud account and is in this app, and none is.";

function errorText(error: VexError): string {
  return error.code === "internal.cancelled" ? "Cancelled. Nothing was sent." : error.message;
}

export function WithdrawTab({
  account,
  localWallets,
}: {
  readonly account: VexCloudAccount;
  readonly localWallets: readonly string[];
}): JSX.Element {
  const destinations = useMemo(() => eligibleDestinations(account, localWallets), [account, localWallets]);
  const invalidate = useInvalidateVexCloudFunding();
  const amountId = useId();
  const [destination, setDestination] = useState<string | null>(destinations[0] ?? null);
  const [amountText, setAmountText] = useState("");
  const [step, setStep] = useState<Step>({ kind: "editing" });
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const withdrawable = account.withdrawable === null ? null : BigInt(account.withdrawable.wei);
  const reading = readAmount({
    text: amountText,
    rateX18: rateOf(account.rate),
    minimumMicroUsd: BigInt(account.limits.minWithdrawMicroUsd),
    max: withdrawable,
    maxLabel: "can be withdrawn now",
  });
  const disabledReason =
    destinations.length === 0
      ? NO_WITHDRAW_DESTINATION
      : account.paused
        ? "Vex Cloud paused this account for review, so funds cannot leave it right now."
        : destination === null
          ? "Pick a wallet."
          : reading.problem;

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
  if (destinations.length === 0) {
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
        setStep({ kind: "review", proposal: result.data, retryNote: null });
        return;
      }
      setStep({ kind: "editing" });
      setMessage(errorText(result.error));
    });
  };

  const approve = (proposal: VexCloudWithdrawalProposal): void => {
    const mine = ++generation.current;
    setMessage(null);
    setStep({ kind: "sending", proposal });
    void submitVexCloudWithdrawal({
      proposalId: proposal.proposalId,
      destination: proposal.destination,
      amountWei: proposal.amountWei,
    }).then((result) => {
      if (result.ok) {
        invalidate();
        setStep({ kind: "sent", withdrawal: result.data.withdrawal });
        setAmountText("");
        return;
      }
      if (mine !== generation.current) return;
      if (result.error.retryable && result.error.code === "provider.unavailable") {
        // The same proposal, the same key: pressing again cannot withdraw twice.
        setStep({ kind: "review", proposal, retryNote: result.error.message });
        return;
      }
      setStep({ kind: "editing" });
      setMessage(errorText(result.error));
    });
  };

  if (step.kind === "review" || step.kind === "sending") {
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
            generation.current += 1;
            setStep({ kind: "editing" });
            setMessage("Withdrawal rejected. Nothing was sent.");
          }}
          onApprove={() => approve(proposal)}
        />
        {step.kind === "review" && step.retryNote !== null ? (
          <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="withdraw-retry-note">
            {step.retryNote}
          </p>
        ) : null}
      </div>
    );
  }

  if (step.kind === "sent") {
    return <WithdrawalStatus initial={step.withdrawal} onDone={() => setStep({ kind: "editing" })} />;
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Withdraw VEX" data-testid="withdraw-form">
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
