/**
 * Vex Cloud account, in the R3 Minimal register: the state as a fill and a
 * word, the VEX balance with its unit, its USD estimate and the rate's age,
 * the linked wallets, and Sign in or Sign out. "Fund" opens the funding page
 * (a centre page: Deposit, Withdraw, Cashback, History).
 *
 * Shared by the Settings "Vex Cloud" section and the provider step's Vex
 * Cloud branch, so both read and say the same thing.
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
import { formatRateAge, formatUsdEstimate, formatVexAmount, NOT_AVAILABLE } from "./vex-cloud-format.js";

type Action =
  | { readonly kind: "idle" }
  | { readonly kind: "signing_in"; readonly cancel: () => void }
  | { readonly kind: "signing_out" };

const ROW = "flex items-baseline justify-between gap-4 border-t border-rule-quiet py-2.5 first:border-t-0";

function BalanceRow({
  name,
  amount,
  testId,
  rateAge,
}: {
  readonly name: string;
  readonly amount: VexCloudAmount;
  readonly testId: string;
  readonly rateAge: string | null;
}): JSX.Element {
  const usd = formatUsdEstimate(amount.usdMicroEstimate);
  return (
    <div className={ROW} data-vex-cloud-balance={testId}>
      <dt className="text-[14px] text-ink-primary">{name}</dt>
      <dd className="m-0 text-right">
        <span className="vex-num font-mono text-[13px] text-ink-primary">{formatVexAmount(amount)}</span>
        <span className="block text-[12.5px] text-ink-tertiary" data-vex-cloud-usd={testId}>
          {usd === null ? (
            `USD estimate: ${NOT_AVAILABLE}`
          ) : (
            <>
              about <span className="vex-num font-mono">{usd}</span>
              {rateAge === null ? null : ` · ${rateAge}`}
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
          Vex Cloud paused this account for review. Requests are refused until it is cleared.
        </p>
      ) : null}
      <section aria-label="VEX balance">
        <dl className="m-0 flex flex-col">
          <BalanceRow name="Available" amount={balances.available} testId="available" rateAge={rateAge} />
          <BalanceRow name="Reserved for running requests" amount={balances.reserved} testId="reserved" rateAge={rateAge} />
          {hasValue(balances.provisional) ? (
            <BalanceRow name="Pending deposits" amount={balances.provisional} testId="provisional" rateAge={rateAge} />
          ) : null}
          {hasValue(balances.pendingWithdrawal) ? (
            <BalanceRow name="Withdrawing" amount={balances.pendingWithdrawal} testId="pendingWithdrawal" rateAge={rateAge} />
          ) : null}
          {hasValue(balances.claimable) ? (
            <BalanceRow name="Cashback to claim" amount={balances.claimable} testId="claimable" rateAge={rateAge} />
          ) : null}
          {balances.cashbackPending !== null && hasValue(balances.cashbackPending) ? (
            <BalanceRow
              name="Cashback pending, not claimable yet"
              amount={balances.cashbackPending}
              testId="cashbackPending"
              rateAge={rateAge}
            />
          ) : null}
        </dl>
        <p className="m-0 mt-1 text-[12px] text-ink-tertiary">
          {account.rate.available ? null : `USD rate: ${NOT_AVAILABLE}. `}
          Balances as of{" "}
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
          Vex Cloud signs in with your in-app EVM wallets, and none exists yet. Add one in Wallets first.
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
          {signing ? "Signing in…" : "Sign in to Vex Cloud"}
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
    body = <EmptyBlock scope="Vex Cloud" title="Checking Vex Cloud" loading />;
  } else if (view === null) {
    const error = result?.ok === false ? result.error : null;
    body = (
      <EmptyBlock
        scope="Vex Cloud"
        state="error"
        title={
          error?.code === "wallet.keystore_locked"
            ? "Unlock Vex to use Vex Cloud."
            : "Vex Cloud could not be read."
        }
        detail={error?.message ?? "Try again in a moment."}
        action={{ label: "Try again", onClick: () => void accountQuery.refetch() }}
      />
    );
  } else if (view.state === "signed_in") {
    body = (
      <SignedIn
        account={view.account}
        localWallets={view.localWallets}
        busy={action.kind !== "idle"}
        onSignOut={() => void signOut()}
        onLink={() => void signIn(view.localWallets)}
        onFund={() => setShellRoute({ kind: "vexCloudFunding", origin: null })}
      />
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
