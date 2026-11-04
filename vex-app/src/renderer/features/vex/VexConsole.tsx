/**
 * THE VEX CONSOLE (docs/design/H3-DESKTOP.md section 1.5; Appendix A.3): what
 * Vex's column says under the Vex key, in square cells divided by 1px rules.
 *
 *   NEEDS YOU, and the count at the right            43
 *   the decision row: the sentence, its meta line    64
 *     and a Review key cell; "Nothing needs you."
 *     at zero
 *
 * THE COUNT is the shared Needs you model's (`needs-you.ts`), the same the
 * Needs you page and the desk's title row count, so no two can disagree. A
 * read that failed is "?", never 0: a count nobody verified is not a zero.
 * While the first read runs there is no count yet.
 *
 * THE ROW HOLDS ONE DECISION, at a fixed height, so nothing under it moves
 * when a decision arrives or is taken. With several waiting it shows the one
 * that expires first (section 1.5's default; `needsYouLeadOf`), the count in
 * the head says how many, and the Needs you page holds the rest. Its words are
 * the model's: the card's own sentence ("Swap 200 USDC for ETH on Base."), the
 * meta line ("Base, real funds · since 12:40 UTC"), the key's word ("Review",
 * "Recover", "Open"). The key only opens the thing (`openNeedsYouItem`), and
 * for a card in the chat beside it the key's chevron points down at it. The
 * row never decides: the REAL FUNDS approval stays in its card's two-step
 * confirm.
 *
 * An unreadable inbox or withdrawal check says which, with Retry, in the
 * row's place; neither it nor the first read is ever drawn as "Nothing needs
 * you.".
 *
 * Paint only: every word and count comes from `useVexPresence().needsYou`.
 * Words are written in sentence case; the console's label register sets the
 * heads in caps.
 */

import { useId, type JSX } from "react";
import { LineChevronDown, LineChevronRight } from "../../components/icons/line/index.js";
import { useUiStore } from "../../stores/uiStore.js";
import type { NeedsYouResult } from "./useVexPresence.js";
import {
  NEEDS_YOU_ALL_UNKNOWN_COPY,
  NEEDS_YOU_EMPTY_COPY,
  needsYouLeadOf,
  type NeedsYouItem,
} from "./needs-you.js";
import { needsYouItemIsHere, openNeedsYouItem } from "./needs-you-open.js";

/** The head's count: the number, "?" for a read that failed, nothing before the first read. */
export function needsYouCountText(model: Pick<NeedsYouResult, "status" | "count">): string | null {
  if (model.status === "unknown") return "?";
  if (model.status === "loading" || model.count === null) return null;
  return String(model.count);
}

function MetaLine({ item }: { readonly item: NeedsYouItem }): JSX.Element {
  if (item.metaTime === null) return <>{item.metaLead}</>;
  return (
    <>
      {item.metaLead} <span className="vex-num">{item.metaTime}</span>
    </>
  );
}

function DecisionRow({ needsYou }: { readonly needsYou: NeedsYouResult }): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  if (needsYou.status === "loading") {
    return (
      <p role="status" className="vex-console__line vex-console__quiet">
        Checking for pending approvals
      </p>
    );
  }
  if (needsYou.status === "unknown") {
    return (
      <>
        <p role="status" className="vex-console__what vex-console__alert">
          {needsYou.unknownCopy ?? NEEDS_YOU_ALL_UNKNOWN_COPY}
        </p>
        <button
          type="button"
          className="vex-console__key"
          disabled={needsYou.retrying}
          onClick={needsYou.retry}
        >
          {needsYou.retrying ? "Checking" : "Retry"}
        </button>
      </>
    );
  }
  const lead = needsYouLeadOf(needsYou.items);
  if (lead === null) {
    return <p className="vex-console__line vex-console__empty">{NEEDS_YOU_EMPTY_COPY}</p>;
  }
  const here = needsYouItemIsHere(lead, { runtimeMode, activeSessionId });
  return (
    <>
      <div className="vex-console__what" data-vex-needs-you-item={lead.kind}>
        <p className="vex-console__sentence" title={lead.title}>
          {lead.title}
        </p>
        <p className="vex-console__meta">
          <MetaLine item={lead} />
        </p>
      </div>
      <button
        type="button"
        className="vex-console__key"
        aria-label={`${lead.go}: ${lead.title}`}
        onClick={() => {
          openNeedsYouItem(lead);
        }}
      >
        <span className="vex-console__key-word">{lead.go}</span>
        {here ? <LineChevronDown size={14} /> : <LineChevronRight size={14} />}
      </button>
    </>
  );
}

/** NEEDS YOU, its count, and the one decision row. */
export function VexConsoleNeedsYou({ needsYou }: { readonly needsYou: NeedsYouResult }): JSX.Element {
  const headId = useId();
  const count = needsYouCountText(needsYou);
  return (
    <section
      aria-labelledby={headId}
      data-vex-area="vex-needs-you"
      data-state={needsYou.status}
      className="vex-console__needs"
    >
      <h3 id={headId} className="vex-console__head">
        <span className="vex-console__label">Needs you</span>
        {count === null ? null : (
          <>
            <span className="sr-only">: </span>
            <span className="vex-console__count vex-num">{count}</span>
          </>
        )}
      </h3>
      <div className="vex-console__decision" data-vex-area="vex-needs-you-row">
        <DecisionRow needsYou={needsYou} />
      </div>
    </section>
  );
}
