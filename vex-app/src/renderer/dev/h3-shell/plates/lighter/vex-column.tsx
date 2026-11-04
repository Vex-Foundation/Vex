/**
 * Vex's column on the desk (the plate's proposal for row S8-11): the desk
 * chat stays at the right, and it IS her column there, 30% of the window as
 * H3's Vex column is (H3-DESKTOP.md section 1.2). Top to bottom:
 *
 *   - her console's top block, in the console's own classes: Needs you and
 *     the missions row (desktop has no strategies row, section 4.1);
 *   - her section, a box LAID OVER the column (section 1.5), never a row in
 *     it, so opening or closing her moves nothing under it: open it is 216
 *     high (132 under 1024, the band's height), closed it is the 56 strip;
 *   - the desk chat, under her box: its scope, its quick prompts, the turn;
 *   - the composer at the foot, in the shell's own composer classes: the
 *     status strip and the row that stands in the bottom row.
 *
 * Static markup: every word and figure is the plate's. Her art is the
 * harness's stand-in (`standins/`), never her real files.
 */

import type { JSX, ReactNode } from "react";
import {
  LineChevronDown,
  LineChevronRight,
  LineClose,
  LineMissions,
  LineShield,
  LineUser,
} from "../../../../components/icons/line/index.js";
import { VxToken } from "../../../../components/ui/vx-token.js";
import { KIMM_STANDINS } from "../../standins/manifest.js";

export interface NeedsYouItem {
  readonly sentence: string;
  readonly meta: ReactNode;
}

function NeedsYou({ item }: { readonly item: NeedsYouItem | null }): JSX.Element {
  return (
    <section data-vex-area="vex-needs-you" className="vex-console__needs" aria-label="Needs you">
      <h3 className="vex-console__head">
        <span className="vex-console__label">Needs you</span>
        <span className="vex-console__count vex-num">{item === null ? 0 : 1}</span>
      </h3>
      <div className="vex-console__decision" data-vex-area="vex-needs-you-row">
        {item === null ? (
          <p className="vex-console__line vex-console__empty">Nothing needs you.</p>
        ) : (
          <>
            <div className="vex-console__what" data-vex-needs-you-item="approval">
              <p className="vex-console__sentence">{item.sentence}</p>
              <p className="vex-console__meta">{item.meta}</p>
            </div>
            <button type="button" className="vex-console__key" aria-label={`Review: ${item.sentence}`}>
              <span className="vex-console__key-word">Review</span>
              <LineChevronDown size={14} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function Missions(): JSX.Element {
  return (
    <div className="vex-console__missions" data-vex-area="vex-missions">
      <button type="button" className="vex-console__row-key">
        <LineMissions size={16} className="vex-console__icon" />
        <span className="vex-console__row-text">No mission running</span>
        <LineChevronRight size={14} className="vex-console__chevron" />
      </button>
    </div>
  );
}

/** Her box over the column: her figure and HIDE VEX while open, the strip and SHOW VEX while closed. */
function KimmBox({ open }: { readonly open: boolean }): JSX.Element {
  return (
    <div className="lp-kimm" data-closed={open ? undefined : ""} aria-label="Vex">
      <img src={open ? KIMM_STANDINS.sections.offer.src : KIMM_STANDINS.strip.src} alt="" draggable={false} />
      <button type="button" className="lp-kimm__key" aria-label={open ? "Hide Vex" : "Show Vex"}>
        {open ? "Hide Vex" : "Show Vex"}
        {open ? <LineClose size={16} /> : <LineChevronDown size={16} />}
      </button>
    </div>
  );
}

/** The desk chat's turn: the scope it reads, its quick prompts, a question and the answer. */
function DeskChat(): JSX.Element {
  return (
    <div className="lp-chat" aria-label="Desk chat">
      <div className="lp-chat__scope">
        <span className="lp-cap">On the desk</span>
        <span className="lp-num">BTC perp · 5m · Long 0.2000 BTC</span>
      </div>
      <div className="lp-chat__prompts">
        <span>
          Should I trim? <span aria-hidden>→</span>
        </span>
        <span>
          Set a protective stop <span aria-hidden>→</span>
        </span>
        <span>
          What invalidates this? <span aria-hidden>→</span>
        </span>
      </div>
      <div className="lp-chat__me">
        <span className="lp-chat__bubble">Should I trim?</span>
        <span className="lp-chat__disc" aria-hidden>
          <LineUser size={16} />
        </span>
      </div>
      <p className="lp-chat__vex">
        Hold for now. You are up <span className="vex-num">36.00 USDC</span> with the mark at{" "}
        <span className="vex-num">64,100.0</span>, and liquidation sits far below at{" "}
        <span className="vex-num">51,940.0</span>. A stop under <span className="vex-num">63,500.0</span> keeps
        most of the gain if the 5m structure breaks.
      </p>
    </div>
  );
}

/** The composer at the column's foot, in the shell's own composer classes. */
function Composer(): JSX.Element {
  return (
    <form className="vex-composer-card w-full" data-vex-area="chat-composer" data-vex-composer-state="input">
      <div className="vex-composer-strip @container" data-vex-area="composer-strip">
        <div className="vex-composer-strip__cell vex-composer-strip__model min-w-0">
          <span className="vex-composer-options__model font-sans text-[13px] leading-5 text-ink-primary">GPT-5.2</span>
          <span className="lp-cap lp-muted">Medium</span>
          <LineChevronDown size={14} />
        </div>
        <div className="vex-composer-strip__cell vex-composer-strip__promise flex-none">
          <LineShield size={16} className="lp-promise-icon" />
          <span className="vex-composer-promise lp-promise-words">Funds require approval</span>
        </div>
      </div>
      <div className="vex-composer-row" data-vex-area="composer-row">
        <button type="button" className="vex-composer-model" aria-label="Model: GPT-5.2">
          <VxToken size={20} />
        </button>
        <div className="vex-composer-field">
          <div className="vex-composer-field__text">Ask about this market, or describe an order.</div>
        </div>
        <button type="button" className="vex-composer-send vex-composer-key" aria-label="Send message">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="vex-composer-key__glyph">
            {[3, 8, 13].flatMap((cy) =>
              [3, 8, 13].map((cx) => <circle key={`${String(cx)}-${String(cy)}`} cx={cx} cy={cy} r="1.75" fill="currentColor" />),
            )}
          </svg>
          <span className="vex-composer-key__word">Send</span>
        </button>
      </div>
    </form>
  );
}

export function VexColumn({ open, needsYou, chat, foot }: {
  /** Her section open (the box) or closed (the strip). */
  readonly open: boolean;
  readonly needsYou: NeedsYouItem | null;
  /** What the desk chat shows under her box: the turn, or a card waiting. */
  readonly chat?: ReactNode;
  /** What stands at the column's foot: the composer, or a card's docked decision row. */
  readonly foot?: ReactNode;
}): JSX.Element {
  return (
    <aside className="lp-vex" aria-label="Vex" data-vex-area="vex-sidebar">
      <div className="vex-console__top" data-vex-area="vex-console-top">
        <NeedsYou item={needsYou} />
        <Missions />
      </div>
      <div className="lp-vex__body">
        <KimmBox open={open} />
        {chat ?? <DeskChat />}
      </div>
      {foot ?? <Composer />}
    </aside>
  );
}
