/**
 * The phase note - the one line under the form that says where the launch
 * stands, shared by every platform lane.
 *
 * It renders MAIN's own sentence verbatim in every terminal case. The lane
 * appends nothing: main knows the status, the hash and the redaction rules, and
 * a renderer-authored embellishment on a money outcome is how a surface starts
 * claiming more than it can prove.
 *
 * LOOK (docs/design/R3-MINIMAL.md sections 1.3, 1.6 and 12). A state note is a
 * flat row: a swatch and the sentence in ink, sans 13.5 / 1.5. The fill says
 * the state (done = solid, caution and re-review = concerned, failure and
 * refused = error, not available = idle) and the sentence says it again, so no
 * state is ever colour alone and no note is ever red or amber. An ALARM (a
 * condition the user must read before deploying) is the ink callout: a 1.5px
 * ink frame around the same swatch and sentence.
 *
 * `NoteRow`, `InkCallout` and `DoneNote` are exported because the lane, the
 * fingerprint card and the form all draw their notes from this one place.
 */

import type { JSX, ReactNode } from "react";
import { Button } from "../../../components/ui/button.js";
import { Swatch, type SwatchState } from "../../../components/ui/swatch.js";
import { cn } from "../../../lib/utils.js";
import { RE_REVIEW_NOTE, type TerminalTone } from "../token-launch/launch-display.js";
import type { DialogPhase } from "./phase.js";

/**
 * A flat state row: the swatch, then the sentence. `children` is the sentence
 * exactly as it was given, `detail` an optional second, quieter line, and
 * `action` an optional key under both. `breakAll` is for a sentence that may
 * carry an address or a transaction hash, which has no space to break at.
 */
export function NoteRow({
  state,
  role,
  breakAll = false,
  detail,
  action,
  children,
}: {
  readonly state: SwatchState;
  readonly role: "alert" | "status";
  readonly breakAll?: boolean;
  readonly detail?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div role={role} className="flex items-start gap-2.5">
      <Swatch state={state} size={10} className="mt-[5px] shrink-0 text-accent-primary" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <p
          className={cn(
            "text-[13.5px] leading-[1.5] text-ink-primary",
            breakAll && "break-all",
          )}
        >
          {children}
        </p>
        {detail === undefined ? null : (
          <p className="text-[13px] leading-[1.45] text-ink-secondary">{detail}</p>
        )}
        {action}
      </div>
    </div>
  );
}

/**
 * The ink callout for an alarm: a 1.5px ink frame, the concerned swatch, the
 * sentence in ink. It is the alert itself (`role="alert"`), never a hue.
 */
export function InkCallout({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 border-[1.5px] border-rule-ink px-3.5 py-3"
    >
      <Swatch state="concerned" size={10} className="mt-[5px] shrink-0" />
      <p className="min-w-0 text-[13.5px] leading-[1.5] text-ink-primary">
        {children}
      </p>
    </div>
  );
}

/**
 * A COMPLETED launch, in the tone main reported.
 *
 * Every completed submit used to be presented as a success. A REVERTED launch
 * burned gas and created nothing - drawing it as a success is the lie this
 * splits. The failure is an alert (the error swatch); the success (solid) and
 * the caution (concerned) are status.
 */
export function DoneNote({
  tone,
  message,
}: {
  readonly tone: TerminalTone;
  readonly message: string;
}): JSX.Element {
  if (tone === "failure") {
    return (
      <NoteRow state="error" role="alert" breakAll>
        {message}
      </NoteRow>
    );
  }
  return (
    <NoteRow
      state={tone === "caution" ? "concerned" : "done"}
      role="status"
      breakAll
    >
      {message}
    </NoteRow>
  );
}

export function PhaseNote({
  phase,
  onRePrice,
}: {
  readonly phase: DialogPhase;
  readonly onRePrice: () => void;
}): JSX.Element | null {
  if (phase.kind === "re_review") {
    return (
      <NoteRow
        state="concerned"
        role="alert"
        detail={RE_REVIEW_NOTE}
        action={
          <Button variant="quiet" size="sm" onClick={onRePrice}>
            Review new price
          </Button>
        }
      >
        {phase.message}
      </NoteRow>
    );
  }
  if (phase.kind === "refused") {
    return (
      <NoteRow state="error" role="alert">
        {phase.message}
      </NoteRow>
    );
  }
  if (phase.kind === "done") {
    return <DoneNote tone={phase.tone} message={phase.message} />;
  }
  return null;
}
