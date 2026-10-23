/**
 * Deposit: the swap-card form (owner decision D11), then the approval card,
 * then the outcome. A deterministic panel the USER drives; no agent path
 * reaches it.
 *
 * States: the pin decides first (plan 15.6): "Deposits open soon" when the
 * build pins no address, an error when it differs from the backend's, the
 * form only when they match. Then editing -> preparing -> review (the
 * proposal) -> sending -> sent, with every refusal shown as main worded it.
 * Only a wallet LINKED to the account can deposit (Vex Cloud credits a
 * deposit to the account its sender is linked to): the others are listed
 * but disabled, with the reason and the next step. Main enforces the same.
 * A reply that lands after the user moved on (a newer press, Reject, unmount)
 * is dropped by the generation guard.
 */

import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import type { VexCloudAccount, VexCloudDepositPin } from "@shared/schemas/vex-cloud.js";
import type { VexCloudDepositProposal, VexCloudSubmitDepositResult } from "@shared/schemas/vex-cloud-funding.js";
import { formatMicroUsd, formatUnitsExact, formatVexExact, VEX_CLOUD_CHAIN_ID } from "@shared/vex-cloud-money.js";
import type { VexError } from "@shared/ipc/result.js";
import { Button } from "../../../components/ui/button.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { StateWord } from "../../../components/ui/state-word.js";
import {
  prepareVexCloudDeposit,
  submitVexCloudDeposit,
  useInvalidateVexCloudFunding,
  useVexCloudDepositWallets,
} from "../../../lib/api/vex-cloud.js";
import { WalletSelect } from "../../appShell/SessionWalletSelect.js";
import { FundingApprovalCard } from "./FundingApprovalCard.js";
import { depositResultLook, NOT_AVAILABLE, rateOf, readAmount, shortAddress, spendableNowCopy } from "./funding-model.js";

type Step =
  | { readonly kind: "editing" }
  | { readonly kind: "preparing"; readonly cancel: () => void }
  | { readonly kind: "review"; readonly proposal: VexCloudDepositProposal }
  | { readonly kind: "sending"; readonly proposal: VexCloudDepositProposal; readonly cancel: () => void }
  | { readonly kind: "sent"; readonly result: VexCloudSubmitDepositResult };

export const DEPOSITS_OPEN_SOON = "Deposits open soon";

/** Why a wallet in the picker cannot deposit, and what to do (main refuses it too). */
export const SENDER_NOT_LINKED = "Not linked to your Vex Inference account. Sign in again to link it.";
export const DEPOSIT_MISMATCH_TITLE = "Funding is disabled";

function errorText(error: VexError): string {
  return error.code === "internal.cancelled" ? "Cancelled. Nothing was signed." : error.message;
}

export function DepositTab({
  account,
  pin,
}: {
  readonly account: VexCloudAccount;
  readonly pin: VexCloudDepositPin;
}): JSX.Element {
  if (pin.state === "not_open") {
    return (
      <EmptyBlock
        scope="Deposit"
        title={DEPOSITS_OPEN_SOON}
        detail="Vex Inference deposits are not open yet, so nothing can be sent from here. Your balance still pays for requests."
        data-testid="deposit-not-open"
      />
    );
  }
  if (pin.state === "mismatch") {
    return (
      <EmptyBlock
        scope="Deposit"
        state="error"
        title={DEPOSIT_MISMATCH_TITLE}
        detail={`The deposit address built into Vex (${pin.pinned}) does not match the one Vex Inference reports (${pin.backend}). Nothing can be sent. Update Vex, and contact support if this stays.`}
        data-testid="deposit-mismatch"
      />
    );
  }
  return <DepositForm account={account} />;
}

function DepositForm({ account }: { readonly account: VexCloudAccount }): JSX.Element {
  const walletsQuery = useVexCloudDepositWallets(true);
  const invalidate = useInvalidateVexCloudFunding();
  const amountId = useId();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
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

  const wallets = walletsQuery.data?.ok === true ? walletsQuery.data.data.wallets : [];
  const linked = useMemo(() => new Set(account.wallets.map((wallet) => wallet.address.toLowerCase())), [account.wallets]);
  const isLinked = (address: string): boolean => linked.has(address.toLowerCase());
  const linkedWallets = wallets.filter((wallet) => isLinked(wallet.address));
  const unlinkedWallets = wallets.filter((wallet) => !isLinked(wallet.address));
  const firstLinked = linkedWallets[0]?.address ?? null;
  useEffect(() => {
    if (walletAddress === null && firstLinked !== null) setWalletAddress(firstLinked);
  }, [walletAddress, firstLinked]);
  const picked = wallets.find((wallet) => wallet.address === walletAddress) ?? null;
  const selected = picked !== null && isLinked(picked.address) ? picked : null;
  const rateX18 = rateOf(account.rate);
  const reading = useMemo(
    () =>
      readAmount({
        text: amountText,
        rateX18,
        minimumMicroUsd: BigInt(account.limits.minDepositMicroUsd),
        max: selected?.vexWei === null || selected === null ? null : BigInt(selected.vexWei),
        maxLabel: "this wallet holds",
      }),
    [amountText, rateX18, account.limits.minDepositMicroUsd, selected],
  );
  const disabledReason =
    walletsQuery.isLoading
      ? "Reading your wallets."
      : wallets.length === 0
        ? "Add an EVM wallet in Settings, Wallets first."
        : linkedWallets.length === 0
          ? `None of your wallets can deposit yet. ${SENDER_NOT_LINKED}`
          : selected === null
            ? "Pick a wallet."
            : reading.problem;

  const review = (): void => {
    if (selected === null || disabledReason !== null) return;
    const mine = ++generation.current;
    setMessage(null);
    const invocation = prepareVexCloudDeposit({ walletAddress: selected.address, amountText });
    setStep({ kind: "preparing", cancel: invocation.cancel });
    void invocation.promise.then((result) => {
      if (mine !== generation.current) return;
      if (result.ok) {
        setStep({ kind: "review", proposal: result.data });
        return;
      }
      setStep({ kind: "editing" });
      setMessage(errorText(result.error));
    });
  };

  const reject = (): void => {
    generation.current += 1;
    setStep({ kind: "editing" });
    setMessage("Deposit rejected. Nothing was signed.");
  };

  const approve = (proposal: VexCloudDepositProposal): void => {
    const mine = ++generation.current;
    setMessage(null);
    const invocation = submitVexCloudDeposit({
      proposalId: proposal.proposalId,
      walletAddress: proposal.from,
      amountWei: proposal.amountWei,
    });
    setStep({ kind: "sending", proposal, cancel: invocation.cancel });
    void invocation.promise.then((result) => {
      // A deposit result is never dropped by a newer press: a sent transfer is a fact.
      if (result.ok) {
        invalidate();
        setStep({ kind: "sent", result: result.data });
        setAmountText("");
        return;
      }
      if (mine !== generation.current) return;
      setStep({ kind: "editing" });
      setMessage(errorText(result.error));
    });
  };

  if (step.kind === "review" || step.kind === "sending") {
    const proposal = step.proposal;
    return (
      <div className="flex flex-col gap-3">
        <DepositApproval
          proposal={proposal}
          walletLabel={selected?.label ?? null}
          busy={step.kind === "sending"}
          onReject={reject}
          onApprove={() => approve(proposal)}
        />
        {step.kind === "sending" ? (
          <div className="flex items-center gap-3">
            <StateWord state="ongoing" word="Signing and sending" live />
            <Button type="button" variant="ink" size="sm" onClick={step.cancel}>
              Stop before signing
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (step.kind === "sent") {
    const look = depositResultLook(step.result.status);
    return (
      <section className="flex flex-col gap-3" aria-label="Deposit outcome" data-testid="deposit-outcome">
        <StateWord state={look.fill} word={look.word} size={12} live />
        <p className="m-0 text-[14px] leading-[1.5] text-ink-secondary">
          {step.result.status === "confirmed"
            ? `The transfer is on Robinhood Chain. ${spendableNowCopy(account.limits.provisionalCapMicroUsd)}`
            : step.result.status === "pending"
              ? "The transfer was sent and its outcome is not known yet. Vex will not send it again; Vex Inference credits it when it sees it on chain. Check History in a few minutes."
              : "The transfer failed on chain, so no VEX moved. The network fee was spent. Review the deposit again to retry."}
        </p>
        {step.result.status === "confirmed" && !step.result.transferProven ? (
          <p className="m-0 text-[13px] text-ink-primary">
            The receipt did not show the exact transfer amount. Vex Inference credits what its watcher sees on chain.
          </p>
        ) : null}
        <p className="m-0 text-[13px] text-ink-tertiary">
          Transaction <span className="vex-num font-mono text-ink-primary break-all">{step.result.txHash}</span>
          {step.result.status === "reverted" ? null : step.result.notified ? " · Vex Inference was told." : " · Vex Inference will find it on chain."}
        </p>
        <div>
          <Button type="button" variant="ink" size="sm" onClick={() => setStep({ kind: "editing" })}>
            New deposit
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Deposit VEX" data-testid="deposit-form">
      <div className="flex flex-col gap-3 border border-rule-ink p-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-tertiary">From</span>
          <WalletSelect
            label="Wallet to deposit from"
            caption="EVM"
            value={walletAddress}
            allowNone={false}
            options={wallets.map((wallet) => ({
              id: wallet.address,
              address: wallet.address,
              label: `${wallet.label} · ${wallet.vexWei === null ? `VEX ${NOT_AVAILABLE}` : `${formatVexExact(BigInt(wallet.vexWei))} VEX`}`,
              ...(!isLinked(wallet.address) && { disabled: true, note: "not linked" }),
            }))}
            onChange={(next) => setWalletAddress(next)}
          />
          {unlinkedWallets.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="deposit-unlinked">
              {unlinkedWallets.map((wallet) => (
                <li key={wallet.address} className="text-[13px] text-ink-secondary">
                  {wallet.label} <span className="vex-num font-mono">{shortAddress(wallet.address)}</span>: {SENDER_NOT_LINKED}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={amountId} className="text-[12px] font-medium text-ink-tertiary">
            You send
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
            <span className="flex items-center gap-2 border-l border-rule px-3 text-[14px] font-medium text-ink-primary" data-testid="token-chip">
              VEX
              <span className="text-[12px] font-normal text-ink-tertiary">Robinhood Chain</span>
            </span>
          </div>
          <p id={`${amountId}-usd`} className="m-0 text-[13px] text-ink-tertiary">
            {reading.usdLine ?? `USD estimate: ${NOT_AVAILABLE}`}
            {" · "}minimum {formatMicroUsd(BigInt(account.limits.minDepositMicroUsd))}
          </p>
        </div>
        <p className="m-0 text-[13px] text-ink-secondary">{spendableNowCopy(account.limits.provisionalCapMicroUsd)}</p>
      </div>
      <p id={`${amountId}-why`} className="m-0 min-h-[20px] text-[13px] text-ink-primary" data-testid="deposit-disabled-reason">
        {disabledReason ?? ""}
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={review} disabled={disabledReason !== null || step.kind === "preparing"}>
          {step.kind === "preparing" ? "Checking…" : "Review deposit"}
        </Button>
        {step.kind === "preparing" ? (
          <Button type="button" variant="ink" onClick={step.cancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      {message === null ? null : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary" data-testid="deposit-message">
          {message}
        </p>
      )}
    </section>
  );
}

function DepositApproval({
  proposal,
  walletLabel,
  busy,
  onReject,
  onApprove,
}: {
  readonly proposal: VexCloudDepositProposal;
  readonly walletLabel: string | null;
  readonly busy: boolean;
  readonly onReject: () => void;
  readonly onApprove: () => void;
}): JSX.Element {
  const amount = formatVexExact(BigInt(proposal.amountWei));
  const fee = formatUnitsExact(BigInt(proposal.feeBound.maxNetworkFeeWei), proposal.feeBound.nativeDecimals);
  return (
    <FundingApprovalCard
      testId="deposit-approval"
      sentence={`Deposit ${amount} VEX to Vex Inference.`}
      source={{
        left: (
          <>
            From your {walletLabel ?? "wallet"} <span className="vex-num">{shortAddress(proposal.from)}</span>
          </>
        ),
        right: (
          <>
            <span className="vex-num">{formatVexExact(BigInt(proposal.walletVexWei))}</span> VEX available on Robinhood Chain
          </>
        ),
      }}
      lines={[
        { label: "You send", value: <><span className="vex-appr__num vex-num">{amount} VEX</span><span className="vex-appr__sub"> · on Robinhood Chain</span></> },
        { label: "To", value: <span className="vex-appr__num vex-num vex-appr__break">{proposal.to}</span> },
        { label: "Value", value: <>about <span className="vex-appr__num vex-num">{formatMicroUsd(BigInt(proposal.usdMicroEstimate))}</span><span className="vex-appr__sub"> at the Vex Inference rate</span></> },
        { label: "Network fee", value: <>at most <span className="vex-appr__num vex-num">{fee} ETH</span></> },
        { label: "Credited", value: spendableNowCopy(proposal.provisionalCapMicroUsd) },
      ]}
      risks={[
        { lead: "Real funds:", text: "VEX leaves your wallet for Vex Inference, and a sent transfer cannot be undone. Unused VEX can be withdrawn later to a linked wallet." },
        { lead: "Address:", text: "Vex sends only to the deposit address built into this version, and only while Vex Inference reports the same one." },
      ]}
      signedFields={[
        { label: "Actor", value: "You, from the funding page" },
        { label: "Chain ID", value: String(VEX_CLOUD_CHAIN_ID) },
        { label: "Token contract", value: proposal.token.address },
        { label: "Amount, raw", value: `${proposal.amountWei} (18 decimals)` },
        { label: "From", value: proposal.from },
        { label: "To", value: proposal.to },
        { label: "Gas limit, at most", value: proposal.feeBound.gasLimit },
        { label: "Max fee per gas, wei", value: proposal.feeBound.maxFeePerGasWei },
        { label: "Max priority fee per gas, wei", value: proposal.feeBound.maxPriorityFeePerGasWei },
        { label: "Proposal", value: proposal.proposalId },
        { label: "Expires", value: proposal.expiresAt },
      ]}
      expiresAt={proposal.expiresAt}
      approveLabel="Approve deposit"
      pendingLabel="Sending deposit"
      armed
      busy={busy}
      onReject={onReject}
      onApprove={onApprove}
    />
  );
}
