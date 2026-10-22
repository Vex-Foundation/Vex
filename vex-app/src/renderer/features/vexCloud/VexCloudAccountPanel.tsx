/**
 * Vex Cloud account (named "Vex Inference" to the user), in the R3 Minimal
 * register: the state as a fill and a word, the VEX balance with its unit
 * and a USD estimate per row, the rate and its age stated once under the
 * balances, the linked wallets, and Sign in or
 * Sign out. "Fund" opens the funding page (a centre page: Deposit, Withdraw,
 * Cashback, History).
 *
 * Drawn by the provider step's Vex Inference choice, in onboarding and in
 * Settings, Inference.
 *
 * Deposit credit not final yet (`balances.provisional`): the backend's
 * provisional grants (VexVirtualsCompute plan 4.1). They are spendable for
 * inference now, within the per-account cap, and never withdrawable; at
 * finality the unspent part moves to Available. A deposit that reverts
 * before finality voids its grant. The row says exactly that and no more.
 *
 * THE CONSENT. Signed out, the panel lists the in-app EVM wallets main will
 * sign with, and the one Sign in press sends exactly that list back: main
 * refuses if its inventory changed in between. Nothing is signed before the
 * press; nothing moves funds.
 *
 * Money arrives raw (wei with decimals, integer micro-USD) and is formatted
 * here with integer arithmetic, rounded down. A missing figure reads
 * "Not available".
 */

import { useEffect, useRef, useState, type JSX } from "react";
import type { VexCloudAccount, VexCloudAmount } from "@shared/schemas/vex-cloud.js";
import { Button } from "../../components/ui/button.js";
import { EmptyBlock } from "../../components/ui/empty-block.js";
import { StateWord } from "../../components/ui/state-word.js";
import {
  signInToVexCloud,
  signOutOfVexCloud,
  useInvalidateVexCloudState,
  useVexCloudAccount,
} from "../../lib/api/vex-cloud.js";
import { useUiStore } from "../../stores/uiStore.js";
import {
  formatRateAge,
  formatUsdEstimate,
  formatUsdPerVex,
  formatVexAmount,
  NOT_AVAILABLE,
} from "./vex-cloud-format.js";
import { WithdrawalNotices } from "./funding/WithdrawalNotices.js";

type Action =
  | { readonly kind: "idle" }
  | { readonly kind: "signing_in"; readonly cancel: () => void }
  | { readonly kind: "signing_out" };

const ROW = "flex items-baseline justify-between gap-4 border-t border-rule-quiet py-2.5 first:border-t-0";

/** The provisional row's words: what it is, and what it can and cannot do yet. */
export const PROVISIONAL_ROW = {
  name: "Deposit credit, not final yet",
  note: "Usable for AI now. Moves to Available once the deposit is final; only then can it be withdrawn.",
} as const;

function BalanceRow({
  name,
  note,
  amount,
  testId,
}: {
  readonly name: string;
  /** A short line under the name, where the row needs its terms said. */
  readonly note?: string;
  readonly amount: VexCloudAmount;
  readonly testId: string;
}): JSX.Element {
  const usd = formatUsdEstimate(amount.usdMicroEstimate);
  return (
    <div className={ROW} data-vex-cloud-balance={testId}>
      <dt className="text-[14px] text-ink-primary">
        {name}
        {note === undefined ? null : (
          <span className="block text-[12.5px] leading-[1.45] text-ink-secondary" data-vex-cloud-note={testId}>
            {note}
          </span>
        )}
      </dt>
      <dd className="m-0 shrink-0 text-right">
        <span className="vex-num font-mono text-[13px] text-ink-primary">{formatVexAmount(amount)}</span>
        <span className="block text-[12.5px] text-ink-tertiary" data-vex-cloud-usd={testId}>
          {usd === null ? (
            `USD estimate: ${NOT_AVAILABLE}`
          ) : (
            <>
              about <span className="vex-num font-mono">{usd}</span>
            </>
          )}
        </span>
      </dd>
    </div>
  );
}

function hasValue(amount: VexCloudAmount): boolean {
  return amount.wei !== "0";
}

function SignedIn({
  account,
  localWallets,
  busy,
  onSignOut,
  onLink,
  onFund,
}: {
  readonly account: VexCloudAccount;
  readonly localWallets: readonly string[];
  readonly busy: boolean;
  readonly onSignOut: () => void;
  readonly onLink: () => void;
  /** Open the funding page (Deposit, Withdraw, Cashback, History). */
  readonly onFund: () => void;
}): JSX.Element {
  // The rate and its age are said once for the whole block, not per row.
  const usdPerVex = formatUsdPerVex(account.rate);
  const rateAge = formatRateAge(account.rate);
  const linked = new Set(account.wallets.map((wallet) => wallet.address.toLowerCase()));
  const unlinkedLocal = localWallets.filter((address) => !linked.has(address.toLowerCase()));
  const readAt = new Date(account.readAt);
  const { balances } = account;
  return (
    <div className="flex flex-col gap-4" data-vex-cloud-state="signed_in">
      <StateWord
        state={account.paused ? "concerned" : "done"}
        word={account.paused ? "Paused for review" : "Signed in"}
        size={12}
      />
      {account.paused ? (
        <p className="m-0 text-[13px] text-ink-secondary">
          Vex Inference paused this account for review. Requests are refused until it is cleared.
        </p>
      ) : null}
      <section aria-label="VEX balance">
        <dl className="m-0 flex flex-col">
          <BalanceRow name="Available" amount={balances.available} testId="available" />
          <BalanceRow name="Reserved for running requests" amount={balances.reserved} testId="reserved" />
          {hasValue(balances.provisional) ? (
            <BalanceRow
              name={PROVISIONAL_ROW.name}
              note={PROVISIONAL_ROW.note}
              amount={balances.provisional}
              testId="provisional"
            />
          ) : null}
          {hasValue(balances.pendingWithdrawal) ? (
            <BalanceRow name="Withdrawing" amount={balances.pendingWithdrawal} testId="pendingWithdrawal" />
          ) : null}
          {hasValue(balances.claimable) ? (
            <BalanceRow name="Cashback to claim" amount={balances.claimable} testId="claimable" />
          ) : null}
          {balances.cashbackPending !== null && hasValue(balances.cashbackPending) ? (
            <BalanceRow
              name="Cashback pending, not claimable yet"
              amount={balances.cashbackPending}
              testId="cashbackPending"
            />
          ) : null}
        </dl>
        <p className="m-0 mt-1 text-[12px] text-ink-tertiary" data-vex-cloud-rate-line="">
          {usdPerVex === null || rateAge === null ? (
            `USD rate: ${NOT_AVAILABLE}`
          ) : (
            <>
              1 VEX = <span className="vex-num font-mono">{usdPerVex}</span>, {rateAge}
            </>
          )}
          . Balances as of{" "}
          <span className="vex-num font-mono">
            {Number.isNaN(readAt.getTime()) ? NOT_AVAILABLE : readAt.toLocaleTimeString()}
          </span>
          .
        </p>
      </section>
      <section aria-label="Linked wallets">
        <h3 className="m-0 text-[12px] font-medium text-ink-tertiary">Linked wallets</h3>
        <ul className="m-0 mt-1 flex list-none flex-col p-0">
          {account.wallets.map((wallet) => (
            <li key={wallet.address} className={ROW} data-vex-cloud-wallet="linked">
              <span className="vex-num font-mono text-[13px] text-ink-primary">{wallet.address}</span>
              <StateWord state="done" word="Linked" />
            </li>
          ))}
          {unlinkedLocal.map((address) => (
            <li key={address} className={ROW} data-vex-cloud-wallet="unlinked">
              <span className="vex-num font-mono text-[13px] text-ink-primary">{address}</span>
              <StateWord state="idle" word="Not linked" />
            </li>
          ))}
        </ul>
      </section>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onFund} data-testid="vex-cloud-fund">
          Fund
        </Button>
        {unlinkedLocal.length > 0 ? (
          <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={onLink}>
            Link {unlinkedLocal.length === 1 ? "this wallet" : "these wallets"}
          </Button>
        ) : null}
        <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

function SignedOut({
  reason,
  localWallets,
  action,
  onSignIn,
}: {
  readonly reason: "not_signed_in" | "session_expired";
  readonly localWallets: readonly string[];
  readonly action: Action;
  readonly onSignIn: () => void;
}): JSX.Element {
  const signing = action.kind === "signing_in";
  return (
    <div className="flex flex-col gap-3" data-vex-cloud-state="signed_out">
      <StateWord
        state={reason === "session_expired" ? "concerned" : "idle"}
        word={reason === "session_expired" ? "Session expired" : "Signed out"}
        size={12}
      />
      {localWallets.length === 0 ? (
        <p className="m-0 text-[13.5px] text-ink-secondary">
          Vex Inference signs in with your in-app EVM wallets, and none exists yet. Add one in Wallets first.
        </p>
      ) : (
        <>
          <p className="m-0 text-[13.5px] leading-[1.5] text-ink-secondary">
            Signing in proves you own these wallets: Vex signs one sign-in message with each of them on
            this computer. No transaction is sent and no funds move.
          </p>
          <ul className="m-0 flex list-none flex-col p-0" aria-label="Wallets that will sign">
            {localWallets.map((address) => (
              <li key={address} className={ROW} data-vex-cloud-wallet="local">
                <span className="vex-num font-mono text-[13px] text-ink-primary">{address}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={localWallets.length === 0 || signing} onClick={onSignIn}>
          {signing ? "Signing in…" : "Sign in to Vex Inference"}
        </Button>
        {action.kind === "signing_in" ? (
          <Button type="button" variant="ink" onClick={action.cancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function VexCloudAccountPanel(): JSX.Element {
  const accountQuery = useVexCloudAccount();
  const invalidate = useInvalidateVexCloudState();
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const [action, setAction] = useState<Action>({ kind: "idle" });
  const [message, setMessage] = useState<string | null>(null);
  // Publication guard: a reply that lands after unmount or after a newer
  // press must not overwrite the current state.
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const result = accountQuery.data;
  const view = result?.ok === true ? result.data : null;

  const signIn = async (wallets: readonly string[]): Promise<void> => {
    const mine = ++generation.current;
    setMessage(null);
    const invocation = signInToVexCloud({ wallets: [...wallets] });
    setAction({ kind: "signing_in", cancel: invocation.cancel });
    const outcome = await invocation.promise;
    if (mine !== generation.current) return;
    setAction({ kind: "idle" });
    if (outcome.ok) {
      invalidate();
      return;
    }
    setMessage(
      outcome.error.code === "internal.cancelled"
        ? "Sign-in cancelled. Nothing was stored."
        : outcome.error.message,
    );
    invalidate();
  };

  const signOut = async (): Promise<void> => {
    const mine = ++generation.current;
    setMessage(null);
    setAction({ kind: "signing_out" });
    const outcome = await signOutOfVexCloud();
    if (mine !== generation.current) return;
    setAction({ kind: "idle" });
    if (!outcome.ok) setMessage(outcome.error.message);
    invalidate();
  };

  let body: JSX.Element;
  if (accountQuery.isLoading) {
    body = <EmptyBlock scope="Vex Inference" title="Checking Vex Inference" loading />;
  } else if (view === null) {
    const error = result?.ok === false ? result.error : null;
    body = (
      <EmptyBlock
        scope="Vex Inference"
        state="error"
        title={
          error?.code === "wallet.keystore_locked"
            ? "Unlock Vex to use Vex Inference."
            : "Vex Inference could not be read."
        }
        detail={error?.message ?? "Try again in a moment."}
        action={{ label: "Try again", onClick: () => void accountQuery.refetch() }}
      />
    );
  } else if (view.state === "signed_in") {
    body = (
      <>
        <WithdrawalNotices />
        <SignedIn
          account={view.account}
          localWallets={view.localWallets}
          busy={action.kind !== "idle"}
          onSignOut={() => void signOut()}
          onLink={() => void signIn(view.localWallets)}
          onFund={() => setShellRoute({ kind: "vexCloudFunding", origin: null })}
        />
      </>
    );
  } else {
    body = (
      <SignedOut
        reason={view.reason}
        localWallets={view.localWallets}
        action={action}
        onSignIn={() => void signIn(view.localWallets)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" data-vex-cloud-panel="">
      {body}
      {message === null ? null : (
        <p role="alert" className="m-0 text-[13px] text-ink-primary" data-vex-cloud-message="">
          {message}
        </p>
      )}
    </div>
  );
}
