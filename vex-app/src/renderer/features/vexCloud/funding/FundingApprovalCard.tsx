/**
 * The funding approval card: the inline R3 approval (ELEMENTS section 14) for
 * a deposit or a withdrawal the USER started on the funding page. The same
 * sheet as the agent's card (`.vex-real-funds .vex-appr`, approval.css): the
 * ink frame with the hatch band, "Approval needed", the expiry, the REAL
 * FUNDS stamp, the plain sentence, the source row, the money lines (a missing
 * figure reads "Not available"), the risk sentences, "All signed fields"
 * closed, then Reject and the action named key.
 *
 * REJECT IS THE FIRST FOCUS, set on mount, so Enter on a card that just
 * appeared never approves. With `armed`, the action key needs a second press
 * within 4 seconds ("Click again to confirm"), the desktop's own rule for a
 * wallet broadcast. Everything shown is the proposal main minted; the card
 * computes no figure of its own.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Stamp } from "../../../components/ui/stamp.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { utcClock } from "./funding-model.js";

/** How long the armed second press stays open. */
export const ARMED_WINDOW_MS = 4_000;

export interface FundingMoneyLine {
  readonly label: string;
  /** `null` reads "Not available". */
  readonly value: ReactNode | null;
}

export interface FundingRisk {
  readonly lead: string;
  readonly text: string;
}

export interface FundingSignedField {
  readonly label: string;
  readonly value: string;
}

const KEY = "inline-flex h-10 items-center justify-center border px-[18px] text-[14px] font-medium leading-none focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus disabled:cursor-not-allowed";

export function FundingApprovalCard({
  sentence,
  source,
  lines,
  risks,
  signedFields,
  expiresAt,
  approveLabel,
  pendingLabel,
  armed,
  busy,
  onReject,
  onApprove,
  testId,
}: {
  readonly sentence: string;
  readonly source: { readonly left: ReactNode; readonly right: ReactNode | null };
  readonly lines: readonly FundingMoneyLine[];
  readonly risks: readonly FundingRisk[];
  readonly signedFields: readonly FundingSignedField[];
  readonly expiresAt: string;
  readonly approveLabel: string;
  readonly pendingLabel: string;
  /** Require a second press within 4 s (a wallet broadcast). */
  readonly armed: boolean;
  readonly busy: boolean;
  readonly onReject: () => void;
  readonly onApprove: () => void;
  readonly testId: string;
}): JSX.Element {
  const rejectRef = useRef<HTMLButtonElement | null>(null);
  const [armedUntil, setArmedUntil] = useState<number | null>(null);

  useEffect(() => {
    rejectRef.current?.focus();
  }, []);

  useEffect(() => {
    if (armedUntil === null) return;
    const timer = window.setTimeout(() => setArmedUntil(null), Math.max(0, armedUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [armedUntil]);

  const isArmed = armedUntil !== null;
  const press = (): void => {
    if (busy) return;
    if (armed && !isArmed) {
      setArmedUntil(Date.now() + ARMED_WINDOW_MS);
      return;
    }
    setArmedUntil(null);
    onApprove();
  };

  const approveText = busy ? pendingLabel : isArmed ? "Click again to confirm" : approveLabel;

  return (
    <section
      className="vex-real-funds vex-appr"
      data-vex-real-funds=""
      data-testid={testId}
      aria-label={`Approval needed: ${sentence}`}
    >
      <div className="vex-appr__in">
        <header className="vex-appr__top">
          <span aria-hidden className="vex-appr__pin">
            <Swatch state="awaiting" />
          </span>
          <span className="vex-appr__eyebrow">Approval needed</span>
          <span className="vex-appr__sp" />
          <span className="vex-appr__expiry">
            Expires at <span className="vex-num">{utcClock(expiresAt)}</span>
          </span>
          <Stamp>Real funds</Stamp>
        </header>
        <h3 className="vex-appr__title">{sentence}</h3>
        <p className="vex-appr__meta" data-testid="funding-source">
          <span>{source.left}</span>
          {source.right === null ? null : <span>{source.right}</span>}
        </p>
        <dl className="vex-appr__dl" data-vex-area="approval-money">
          {lines.map((line) => (
            <div key={line.label} className="contents">
              <dt>{line.label}</dt>
              <dd>
                {line.value === null ? (
                  <span className="vex-appr__missing" data-vex-money-missing="">
                    Not available
                  </span>
                ) : (
                  line.value
                )}
              </dd>
            </div>
          ))}
        </dl>
        <div className="vex-appr__why">
          {risks.map((risk) => (
            <p key={risk.lead}>
              <b>{risk.lead}</b> {risk.text}
            </p>
          ))}
        </div>
        <details className="vex-appr__more">
          <summary className="vex-appr__more-key">
            <span aria-hidden className="vex-appr__chev">
              ›
            </span>
            All signed fields
          </summary>
          <dl className="vex-appr__well">
            {signedFields.map((field) => (
              <div key={field.label} className="contents">
                <dt>{field.label}</dt>
                <dd className="vex-appr__num vex-num vex-appr__break">{field.value}</dd>
              </div>
            ))}
          </dl>
        </details>
        <footer className="vex-appr__foot">
          <button
            ref={rejectRef}
            type="button"
            onClick={onReject}
            disabled={busy}
            className={`${KEY} border-rule-ink bg-transparent text-ink-primary enabled:hover:bg-rule-ink enabled:hover:text-ink-on-primary disabled:border-dotted disabled:text-ink-tertiary`}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={press}
            disabled={busy}
            aria-busy={busy}
            data-armed={isArmed ? "true" : undefined}
            className={`${KEY} gap-2 ${
              isArmed
                ? "border-rule-ink bg-transparent text-ink-primary"
                : "border-button-accent-edge bg-button-accent text-ink-on-button-accent enabled:hover:bg-button-accent-hover"
            }`}
          >
            {busy ? (
              <span aria-hidden className="inline-flex shrink-0">
                <Swatch state="ongoing" size={9} />
              </span>
            ) : null}
            {approveText}
          </button>
        </footer>
      </div>
    </section>
  );
}
