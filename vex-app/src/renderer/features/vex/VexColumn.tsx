/**
 * D2'S VEX COLUMN BODY (docs/design/H3-DESKTOP.md section 6.3; the owner's D2
 * plates, 2026-11-09): Vex's column at the right edge, 280 wide, top to
 * bottom,
 *
 *   [data-vex-area="vex-portrait-card"]   Kimm's portrait card: her live
 *                                         glyph field behind her figure,
 *                                         still for her mood, the column's
 *                                         width and about 360 high
 *   [data-vex-area="vex-state-row"]       her state square and word in caps,
 *                                         the live timer at the right end
 *   [data-vex-area="vex-this-chat"]       THIS CHAT (or this mission, this
 *                                         project) and one line of what Vex
 *                                         does there, from real parts
 *   the console's top block               NEEDS YOU and its list (Review
 *                                         rows, never a decision), the
 *                                         missions row (`VexConsoleTop`)
 *   the page slot                         a page's own block (the Board's
 *                                         Ask Vex), nothing elsewhere
 *   OPEN ACTIVITY                         the column's foot row
 *
 * and under that the column's empty ground. In Studio, with a project open,
 * This project's facts take THIS CHAT's place (our approved Studio plate).
 *
 * Every word comes from `useVexPresence` (the state machine's word, its
 * narration, the Needs you model), as the console and the header always
 * read it: nothing here is invented, and nothing here decides an approval.
 * The card is a picture (`aria-hidden`): her state is the state row's word.
 */

import type { JSX } from "react";
import { KimmPanel } from "../../components/vex/kimm/KimmPanel.js";
import { StateSquare } from "../../components/ui/state-square.js";
import { useUiStore } from "../../stores/uiStore.js";
import { decisionsWaitLine } from "./narration.js";
import { useKimmShellMood } from "./useKimmShellMood.js";
import { useAllMissions, type VexPresence } from "./useVexPresence.js";
import { OpenActivityKey, VexConsoleThisProject, VexConsoleTop } from "./VexConsole.js";
import { VexElapsed } from "./VexElapsed.js";
import { VEX_STATE_SQUARE, type VexScope, type VexState } from "./vex-state.js";
import { setVexSidebarSlot } from "./vex-sidebar-slot.js";

/** THIS CHAT's line when Vex has nothing to say and nothing waits anywhere. */
export const THIS_CHAT_REST_LINE = "Nothing waiting in your chats.";

/** The block's label for a scope, in sentence case: the sheet sets the caps. */
export function thisChatLabelOf(scope: VexScope | null): string {
  // The welcome has no scope; it is a chat about to start.
  return (scope ?? "This chat:").replace(/:$/, "");
}

/**
 * THIS CHAT's one line, from real parts only: the narration desktop already
 * writes for the state ("Running Read balances to answer ..."); with none,
 * the decisions waiting elsewhere ("Two decisions wait for you."), or the
 * rest line once the Needs you read says nothing waits. A count nobody
 * verified says nothing.
 */
export function thisChatLineOf(presence: Pick<VexPresence, "narration" | "needsYou">): string | null {
  if (presence.narration !== null) return presence.narration;
  const { needsYou } = presence;
  if (needsYou.status !== "ready" || needsYou.count === null) return null;
  return needsYou.count > 0 ? decisionsWaitLine(needsYou.count) : THIS_CHAT_REST_LINE;
}

/**
 * Her portrait card: the lock screen's panel in its card seat, her mood from
 * Vex's state through the shell's mood clock. On a page her field holds its
 * frame (VEX Cloud runs it only in a chat), as her section's did.
 */
export function VexPortraitCard({ state }: { readonly state: VexState }): JSX.Element {
  const mood = useKimmShellMood(state);
  const pageOpen = useUiStore((s) => s.shellRoute.kind !== "none");
  return (
    <div className="vex-col__card" data-vex-area="vex-portrait-card">
      <KimmPanel mood={mood} figure seat="card" hold={pageOpen} />
    </div>
  );
}

/** The state row: her square and word, the live timer at the right end. */
export function VexStateRow({
  state,
  word,
  timerStartedAt,
}: Pick<VexPresence, "state" | "word" | "timerStartedAt">): JSX.Element {
  return (
    <div className="vex-col__state" data-vex-area="vex-state-row" data-vex-state={state}>
      <StateSquare state={VEX_STATE_SQUARE[state]} size={6} className="vex-col__square" />
      <span className="vex-col__word">{word}</span>
      {timerStartedAt === null ? null : (
        <VexElapsed startedAtMs={timerStartedAt} className="vex-col__timer" decorative />
      )}
    </div>
  );
}

/** THIS CHAT, this mission or this project: the label and Vex's one line. */
export function VexThisChat({ presence }: { readonly presence: VexPresence }): JSX.Element {
  const line = thisChatLineOf(presence);
  return (
    <section className="vex-col__this" data-vex-area="vex-this-chat" aria-label={thisChatLabelOf(presence.scope)}>
      <span className="vex-col__label" aria-hidden="true">
        {thisChatLabelOf(presence.scope)}
      </span>
      {line === null ? null : <p className="vex-col__line">{line}</p>}
    </section>
  );
}

/** The column's body, top to bottom, under the header's VEX cell. */
export function VexColumnBody({ presence }: { readonly presence: VexPresence }): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const missions = useAllMissions();
  const project = runtimeMode === "studio" ? activeProjectId : null;
  return (
    <div className="vex-col" data-vex-area="vex-column-body">
      <VexPortraitCard state={presence.state} />
      <VexStateRow state={presence.state} word={presence.word} timerStartedAt={presence.timerStartedAt} />
      {project === null ? <VexThisChat presence={presence} /> : <VexConsoleThisProject projectId={project} />}
      <VexConsoleTop needsYou={presence.needsYou} missions={missions} />
      <div ref={setVexSidebarSlot} data-vex-area="vex-sidebar-slot" className="vex-vs__slot" />
      <div className="vex-col__foot" data-vex-area="vex-column-foot">
        <OpenActivityKey projectId={project} />
      </div>
    </div>
  );
}
