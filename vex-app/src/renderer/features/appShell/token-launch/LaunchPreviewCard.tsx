/**
 * LAUNCH PREVIEW — the cost surface of the launch dialog.
 *
 * This card exists to make ONE thing impossible: clicking Deploy without the
 * exact authorized amount on screen. Under owner decision D3 the submit IS the
 * spend-consent, so the figure it binds has to be visible at the moment of the
 * click, in a form the user can read.
 *
 * ── EVERY NUMBER, EACH IN ITS OWN VOICE, PLUS THE TOTAL ───────────────────
 * Each figure has a different truth status, so each keeps its own row and its
 * own wording — and the whole cost is stated at the end, because the user is
 * consenting to a spend and cannot consent to a number they were never shown:
 *
 *  1. **You authorize: X ETH** — `msg.value`, exactly `creationFee + prebuy`.
 *     This is the only number the click COMMITS, so it gets the loudest
 *     treatment and is broken out into its two proven components.
 *  2. **Network fees: ~Z ETH (estimated)** — the network's, not ours, and a
 *     guess. It covers EVERY transaction this consent causes, so when the fee
 *     leg is charged it is two of them; main budgets both into the one figure
 *     and this card never derives a second (coordinator ruling 2026-08-02).
 *  3. **Vex fee** — 25 bps of `msg.value`, taken as a SEPARATE transfer that
 *     runs only AFTER the launch confirms (§C7), so a launch that does not
 *     happen is never charged. It is a disclosure, not an approval gate, and it
 *     is not part of `msg.value` — but it IS money leaving the user's wallet
 *     because of this click, so the consent sentence names it.
 *  4. **Estimated total** — (1) + (2) + (3), labelled an ESTIMATE because it
 *     contains gas. Owner decision 2026-08-02: the modal submit is the spend
 *     consent, so the surface must state the whole cost. An earlier version
 *     showed only (1) and told the user "nothing else is authorized by this
 *     button", which was false — the same click authorizes the fee leg. The
 *     total never replaces (1); it sits below it, differently worded.
 *
 * ── NO MISSION-LIMIT CLAIM HERE (Codex round 4, 2026-08-02) ───────────────
 * This card used to print "Checked against your mission limit" beside
 * `msg.value + vexFee`. That was FALSE on the surface it appeared on: a
 * user-origin preview passes no ceilings at all (`main/token-launch/index.ts`
 * — a human click is its own authority), so nothing had been checked against
 * anything and the number was just a sum wearing a verdict's clothes. Telling a
 * user their spend cleared a limit that was never consulted is the worst kind of
 * false assurance on a consent surface, so the row is gone. It comes back only
 * with real ceiling metadata in the DTO, saying which ceiling and what it is.
 *
 * Glass: NONE of our own. This card is a FLAT surface (hairline + radius)
 * because it sits inside the dialog, whose chrome already carries the shell's
 * one glass layer. A second one here would be both a design regression and a
 * red build under the shell design guard.
 */

import type { JSX } from "react";
import type { TokenLaunchPreviewResult } from "../../../lib/api/token-launch.js";
import { AddressDisplay } from "../../../components/common/AddressDisplay.js";
import {
  estimatedTotalCostWei,
  formatWeiEth,
  formatWeiEthWithUnit,
  UNKNOWN_AMOUNT,
} from "./launch-display.js";

/**
 * The states ladder. `unavailable` is a DISTINCT rung from `idle` on purpose:
 * "we couldn't price this right now" and "you haven't filled the form yet" are
 * different facts, and collapsing them would tell the user their input was
 * incomplete when in truth our side was.
 */
export type PreviewState =
  | "idle"
  | "loading"
  | "error"
  | "unavailable"
  | "ready";

interface LaunchPreviewCardProps {
  readonly state: PreviewState;
  readonly preview: TokenLaunchPreviewResult | null;
  /** Main's own sentence for a failed preview. Rendered verbatim. */
  readonly errorMessage: string | null;
  readonly onRetry: () => void;
}

export function LaunchPreviewCard({
  state,
  preview,
  errorMessage,
  onRetry,
}: LaunchPreviewCardProps): JSX.Element {
  return (
    <section
      aria-label="Launch preview"
      className="flex flex-col gap-3 rounded-xl border border-line-2 bg-surface-deep p-4"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="vex-eyebrow">Launch preview</h3>
        {state === "ready" && preview !== null ? (
          <span className="font-mono text-[10px] tabular-nums text-ink-tertiary">
            block {preview.anchorBlockNumber}
          </span>
        ) : null}
      </header>
      <PreviewBody
        state={state}
        preview={preview}
        errorMessage={errorMessage}
        onRetry={onRetry}
      />
    </section>
  );
}

function PreviewBody({
  state,
  preview,
  errorMessage,
  onRetry,
}: LaunchPreviewCardProps): JSX.Element {
  if (state === "idle") {
    return (
      <p className="text-[12.5px] leading-relaxed text-ink-tertiary">
        Fill in the name, symbol and image and the exact cost of this launch
        will be priced here before you can deploy.
      </p>
    );
  }

  if (state === "loading") {
    return (
      <p className="font-doto text-[11px] font-medium uppercase tracking-[0.14em] text-ink-tertiary">
        Pricing…
      </p>
    );
  }

  // `unavailable` is a CALM try-again, never the empty state and never phrased
  // as the user's mistake — nothing about their input caused it.
  if (state === "unavailable") {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          Pricing is unavailable right now, so this launch can&apos;t be
          deployed yet. Nothing has been sent.
        </p>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  }

  if (state === "error" || preview === null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[12.5px] text-warning" role="alert">
          {errorMessage ?? "Couldn't price this launch."}
        </p>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  }

  return <PreviewAmounts preview={preview} />;
}

function RetryButton({ onRetry }: { readonly onRetry: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="rounded-full border border-line-2 px-3 py-1 font-doto text-[11px] font-medium uppercase tracking-[0.16em] text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
    >
      Try again
    </button>
  );
}

function PreviewAmounts({
  preview,
}: {
  readonly preview: TokenLaunchPreviewResult;
}): JSX.Element {
  const totalCost = estimatedTotalCostWei(
    preview.msgValueWei,
    preview.vexFeeWei,
    preview.estimatedNetworkFeeWei,
  );

  return (
    <div className="flex flex-col gap-3">
      {preview.predictedTokenAddress !== null ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-tertiary">
            Predicted address
          </span>
          <AddressDisplay address={preview.predictedTokenAddress} />
        </div>
      ) : null}

      {/* (1) THE AUTHORIZED FIGURE. Its own bordered block, so it can never be
       * skim-read as one line item among several. */}
      <div className="flex flex-col gap-1.5 rounded-xl border border-line-3 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] font-medium text-ink-primary">
            You authorize
          </span>
          <span className="font-mono text-[15px] tabular-nums text-ink-primary">
            {formatWeiEthWithUnit(preview.msgValueWei)}
          </span>
        </div>
        <AmountRow
          label="Creation fee"
          value={preview.creationFeeWei}
          subdued
        />
        <AmountRow label="Prebuy" value={preview.prebuyWei} subdued />
        <p className="text-[11px] leading-relaxed text-ink-tertiary">
          This is the exact amount the launch transaction sends. Deploying also
          authorizes Vex&apos;s 25 bps fee below, as a separate transfer once
          the launch confirms, and the network&apos;s gas — nothing else.
        </p>
      </div>

      {/* (2) THE ESTIMATE — visually and verbally separated, never added in.
       * Its label counts the TRANSACTIONS this consent causes: a charged fee
       * leg is a second one, and main budgets its gas into this same figure. */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-ink-secondary">
          {preview.vexFeeCharged
            ? "Network fees, 2 transactions (estimated)"
            : "Network fee (estimated)"}
        </span>
        <span className="font-mono text-[12px] tabular-nums text-ink-secondary">
          ~{formatWeiEth(preview.estimatedNetworkFeeWei)} ETH
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-tertiary">
        Paid to the network, not to us, and only an estimate — it is not part of
        the amount above. Gas scales with your image size
        {preview.vexFeeCharged ? ", and covers the fee transfer as well" : ""}.
      </p>

      {/* (3) THE VEX FEE — disclosure only, and only when main authored it. */}
      <VexFeeDisclosure preview={preview} />

      {/* (4) THE WHOLE COST. Below the authorized figure, never instead of it. */}
      <div className="flex items-baseline justify-between gap-3 border-t border-line-2 pt-2">
        <span className="text-[12.5px] font-medium text-ink-primary">
          Estimated total cost
        </span>
        <span className="font-mono text-[13px] tabular-nums text-ink-primary">
          {totalCost === null ? UNKNOWN_AMOUNT : `~${formatWeiEthWithUnit(totalCost)}`}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-tertiary">
        The amount you authorize, plus the Vex fee, plus the estimated gas for
        every transaction this sends. An estimate, because the gas is one.
      </p>

    </div>
  );
}

/**
 * §C7. The figure is MAIN's, always — this component never derives a fee from
 * the published rate, because a number no authority produced does not belong on
 * a spend-consent surface (rule 90). An unreadable one renders the em-dash.
 */
function VexFeeDisclosure({
  preview,
}: {
  readonly preview: TokenLaunchPreviewResult;
}): JSX.Element | null {
  if (preview.vexFeeCharged === false) {
    return (
      <p className="text-[11px] leading-relaxed text-ink-tertiary">
        Vex fee: none — 25 bps of this amount rounds to zero.
      </p>
    );
  }

  const amount = formatWeiEth(preview.vexFeeWei);
  if (amount === UNKNOWN_AMOUNT) return null;

  return (
    <p className="text-[11px] leading-relaxed text-ink-tertiary">
      Vex fee: {amount} ETH (25 bps) — charged separately after your launch
      confirms; a launch that does not happen is never charged.
    </p>
  );
}

function AmountRow({
  label,
  value,
  subdued,
}: {
  readonly label: string;
  readonly value: string;
  readonly subdued?: boolean;
}): JSX.Element {
  const tone = subdued === true ? "text-ink-tertiary" : "text-ink-secondary";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={`text-[11.5px] ${tone}`}>{label}</span>
      <span className={`font-mono text-[11.5px] tabular-nums ${tone}`}>
        {formatWeiEth(value)} ETH
      </span>
    </div>
  );
}
