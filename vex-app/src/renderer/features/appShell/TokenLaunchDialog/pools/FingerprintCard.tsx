/**
 * STAGE 1's ANSWER, on screen: exactly what the Deploy click will authorize.
 *
 * Every figure here was computed and verified by MAIN and is rendered as given.
 * The renderer performs no arithmetic: a raw amount is formatted with the
 * decimals that travelled beside it, and nothing is summed into a total this
 * side of the boundary (rules/90). There is deliberately no merged "total" —
 * `transactionValue` is a commitment, the gas bound is a ceiling, and the Vex
 * fee is charged after the launch confirms. Adding them would present three
 * different kinds of number as one.
 *
 * THREE THINGS ON THIS CARD ARE ALARMS, not fields:
 *  - a RESOLVED fee recipient, when the user typed an X username. That address
 *    receives the token's trading fees permanently and an unread resolution is
 *    unrecoverable.
 *  - `imageLanded: false`. The provider accepts a launch and silently drops the
 *    picture; it blanked a real funded launch. The user must see it BEFORE
 *    deploying a token that will render empty everywhere.
 *  - HOLDER REWARDS. The creator gets nothing from this token's trading fees
 *    for its whole life, and it is locked at launch.
 *
 * ── THE COUNTDOWN, AND WHY IT IS NOT DECORATION ────────────────────────────
 *
 * This confirmation is only valid for a WINDOW, and the window's length depends
 * on what is being launched: a tokenised stock priced by a signed quote is valid
 * for a matter of SECONDS, while an ordinary launch has minutes. Showing an
 * absolute timestamp would make those look identical, and a user reading
 * "expires 12:04:31" has to do arithmetic to learn they have twenty seconds.
 *
 * So the remaining time is counted down, once a second, WITH the reason it ends.
 * The countdown is a display of main's own `expiresAt`; it decides nothing. Main
 * re-checks that same deadline against the clock immediately before it
 * authorizes anything, so a card left open past zero cannot deploy even if this
 * timer never ran - which is exactly the property that lets the timer be
 * cosmetic.
 *
 * The interval is cleared on unmount and whenever the deadline changes, and it
 * stops itself at zero rather than counting into negative numbers.
 */

import { useEffect, useState, type JSX } from "react";
import type { PoolsAmount, PoolsPreparedLaunch } from "@shared/schemas/pools-launch.js";
import { HOLDER_REWARDS_MODE_LABEL } from "./form-values.js";

export function FingerprintCard({
  fingerprint,
}: {
  readonly fingerprint: PoolsPreparedLaunch;
}): JSX.Element {
  return (
    <section
      aria-label="What you are authorizing"
      data-vex-pools-fingerprint={fingerprint.fingerprintId}
      className="flex flex-col gap-2 rounded-xl border border-line-3 bg-surface-deep p-3"
    >
      <h3 className="vex-micro-label vex-micro-label--wide uppercase text-ink-secondary">
        What you are authorizing
      </h3>

      {!fingerprint.imageLanded ? (
        <p role="alert" className="text-[12px] leading-relaxed text-warning">
          The image did not make it into this token&apos;s published metadata.
          Deploying now creates a token with no picture, and that cannot be
          changed afterwards. Prepare again with a different image URL.
        </p>
      ) : null}

      <Row label="Token address">
        <Mono>{fingerprint.predictedTokenAddress}</Mono>
      </Row>
      <Row label="Pool">
        <Mono>{fingerprint.predictedPoolAddress}</Mono>
      </Row>
      <Row label="Paired with">
        <span className="vex-micro-label uppercase text-ink-primary">
          {fingerprint.pairedAsset}
        </span>
      </Row>

      {fingerprint.holderRewards === undefined ? (
        <Row label="Fee recipient">
          <Mono>{fingerprint.resolvedFeeRecipient}</Mono>
        </Row>
      ) : (
        <>
          <Row label="Trading fees go to">
            <span className="text-[11px] text-ink-primary">
              This token&apos;s holders
            </span>
          </Row>
          <Row label="Holders are paid in">
            <span className="text-[11px] text-ink-primary">
              {HOLDER_REWARDS_MODE_LABEL[fingerprint.holderRewards.mode]}
            </span>
          </Row>
          <p role="alert" className="text-[12px] leading-relaxed text-warning">
            You will receive nothing from this token&apos;s trading fees, ever.
            This is locked at launch and cannot be undone. The launchpad deploys
            the rewards distributor during the launch itself, so its address does
            not exist yet; Vex checks that this transaction carries the
            launchpad&apos;s own holders marker and reports the distributor once
            the launch confirms.
          </p>
        </>
      )}

      <CostRow label="Deployment fee" amount={fingerprint.costs.deploymentFee} />
      {fingerprint.costs.prebuy !== null ? (
        <CostRow label="Prebuy" amount={fingerprint.costs.prebuy} />
      ) : null}
      <CostRow label="You send now" amount={fingerprint.costs.transactionValue} />
      <CostRow label="Vex fee, after it confirms" amount={fingerprint.costs.vexFee} />
      <CostRow label="Network gas, at most" amount={fingerprint.costs.gasBound} />

      {/* The identity of the exact bytes Deploy will sign. Every figure above is
          a rendering of them; this is the one value that changes if any of them
          do, which is why it is shown rather than kept as an internal handle. */}
      <Row label="Transaction fingerprint">
        <Mono>{fingerprint.callFingerprint}</Mono>
      </Row>

      <ExpiryCountdown
        expiresAt={fingerprint.expiresAt}
        reason={fingerprint.expiryReason}
      />
    </section>
  );
}

/** What ends this confirmation, in the words of the clock that ends it. */
const EXPIRY_REASON_TEXT: Readonly<
  Record<PoolsPreparedLaunch["expiryReason"], string>
> = {
  quote_window:
    "the signed stock price quote this launch carries expires; the launch factory accepts one for only a "
    + "matter of seconds",
  gateway_deadline: "this launch's own on-chain deadline passes",
  vex_window:
    "Vex stops accepting this quote; the launchpad's deployment fee moves, so a stale one is re-taken "
    + "rather than signed",
};

/**
 * The live countdown to {@link PoolsPreparedLaunch.expiresAt}.
 *
 * DISPLAY ONLY. Main re-checks the same deadline against the clock immediately
 * before it authorizes anything, so this timer cannot let an expired launch
 * through and its absence cannot block a valid one. What it CAN do is tell the
 * user that a stock launch has twenty seconds left rather than showing a
 * timestamp they have to subtract from.
 *
 * The interval is registered on mount, cleared on unmount AND whenever the
 * deadline changes, and it stops itself at zero rather than counting downwards
 * forever.
 */
export function ExpiryCountdown({
  expiresAt,
  reason,
}: {
  readonly expiresAt: string;
  readonly reason: PoolsPreparedLaunch["expiryReason"];
}): JSX.Element {
  const deadlineMs = Date.parse(expiresAt);
  const [remainingMs, setRemainingMs] = useState(() => deadlineMs - Date.now());

  useEffect(() => {
    // A deadline the boundary let through but that does not parse is a fact to
    // report, not a timer to run: ticking against NaN would render "expired"
    // every second forever.
    if (Number.isNaN(deadlineMs)) return undefined;
    setRemainingMs(deadlineMs - Date.now());
    const id = window.setInterval(() => {
      const left = deadlineMs - Date.now();
      setRemainingMs(left);
      if (left <= 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [deadlineMs]);

  if (Number.isNaN(deadlineMs)) {
    return (
      <p className="text-[11px] leading-relaxed text-ink-tertiary">
        Vex could not read when this confirmation expires. Deploying may be
        refused; prepare the launch again if it is.
      </p>
    );
  }

  const expired = remainingMs <= 0;
  return (
    <div className="flex flex-col gap-1">
      <Row label="Valid for">
        <span
          role="timer"
          aria-live="off"
          className={
            "font-mono text-[11px] tabular-nums "
            + (expired || remainingMs <= 30_000 ? "text-warning" : "text-ink-primary")
          }
        >
          {expired ? "expired" : formatRemaining(remainingMs)}
        </span>
      </Row>
      <p
        className={
          "text-[11px] leading-relaxed " + (expired ? "text-warning" : "text-ink-tertiary")
        }
        {...(expired ? { role: "alert" as const } : {})}
      >
        {expired
          ? `This confirmation has expired: ${EXPIRY_REASON_TEXT[reason]}. Nothing was signed. Prepare the launch again.`
          : `After that, ${EXPIRY_REASON_TEXT[reason]}, and the launch has to be prepared again.`}
      </p>
    </div>
  );
}

/**
 * Milliseconds left as `m:ss`, or `Ns` under a minute.
 *
 * Rounded UP, so a countdown never shows "0s" while time remains - the one
 * second a floor would shave off is the one that reads as "too late to click".
 */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function CostRow({
  label,
  amount,
}: {
  readonly label: string;
  readonly amount: PoolsAmount;
}): JSX.Element {
  return (
    <Row label={label}>
      <span className="font-mono text-[11px] tabular-nums text-ink-primary">
        {formatPoolsAmount(amount)}
      </span>
    </Row>
  );
}

function Mono({ children }: { readonly children: string }): JSX.Element {
  return (
    <span className="font-mono text-[11px] break-all text-ink-primary">
      {children}
    </span>
  );
}

function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-ink-secondary">{label}</span>
      {children}
    </div>
  );
}

/**
 * A raw integer amount and its decimals → a readable decimal string.
 *
 * STRING ARITHMETIC ON PURPOSE. `Number` loses precision above 2^53 and a wei
 * figure routinely exceeds it, so the digits are placed rather than divided.
 * Trailing zeros are trimmed for readability; no digit is ever rounded away, so
 * the value shown is exactly the value authorized.
 */
export function formatPoolsAmount(amount: PoolsAmount): string {
  const digits = amount.rawWei.replace(/^0+(?=\d)/, "");
  if (amount.decimals <= 0) return `${digits} ${amount.assetSymbol}`;

  const padded = digits.padStart(amount.decimals + 1, "0");
  const whole = padded.slice(0, padded.length - amount.decimals);
  const fraction = padded.slice(padded.length - amount.decimals).replace(/0+$/, "");

  return fraction.length === 0
    ? `${whole} ${amount.assetSymbol}`
    : `${whole}.${fraction} ${amount.assetSymbol}`;
}
