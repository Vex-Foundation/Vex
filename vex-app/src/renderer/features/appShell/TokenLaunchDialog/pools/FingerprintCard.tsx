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
 * TWO THINGS ON THIS CARD ARE ALARMS, not fields:
 *  - a RESOLVED fee recipient, when the user typed an X username. That address
 *    receives the token's trading fees permanently and an unread resolution is
 *    unrecoverable.
 *  - `imageLanded: false`. The provider accepts a launch and silently drops the
 *    picture; it blanked a real funded launch. The user must see it BEFORE
 *    deploying a token that will render empty everywhere.
 */

import type { JSX } from "react";
import type { PoolsAmount, PoolsPreparedLaunch } from "@shared/schemas/pools-launch.js";

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
      <h3 className="font-doto text-[11px] font-medium uppercase tracking-[0.16em] text-ink-tertiary">
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
        <span className="font-doto text-[11px] font-medium uppercase text-ink-primary">
          {fingerprint.pairedAsset}
        </span>
      </Row>

      <Row label="Fee recipient">
        <Mono>{fingerprint.resolvedFeeRecipient}</Mono>
      </Row>

      <CostRow label="Deployment fee" amount={fingerprint.costs.deploymentFee} />
      {fingerprint.costs.prebuy !== null ? (
        <CostRow label="Prebuy" amount={fingerprint.costs.prebuy} />
      ) : null}
      <CostRow label="You send now" amount={fingerprint.costs.transactionValue} />
      <CostRow label="Vex fee, after it confirms" amount={fingerprint.costs.vexFee} />
      <CostRow label="Network gas, at most" amount={fingerprint.costs.gasBound} />
    </section>
  );
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
