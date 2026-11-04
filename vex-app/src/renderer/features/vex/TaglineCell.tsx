/**
 * THE TAGLINE CELL (docs/design/H3-DESKTOP.md sections 1.8 and Appendix A.6):
 * the bottom row's cell under the Vex column, which says the moment in one
 * line, its first clause in ink and its second muted, in the label register's
 * caps at 600.
 *
 *   at rest (the welcome, an idle chat, every other moment)
 *     "An AI trading agent, on your computer."  (H3's "inside your limits"
 *     would be false: desktop has no spend limits)
 *   a card waiting in the chat beside it
 *     "Check the card, then decide."            (H3's own words)
 *
 * The other moments (thinking, done, an error) have no tagline of their own
 * on the sheet; the contract's default is the first line, so they say it.
 *
 * "A card waiting" is read from the real state, never guessed: the chat open
 * in the agent shell, no page over it, and Vex's state Waiting for approval,
 * which in a chat counts only that chat's own approvals (`useVexPresence`).
 * The welcome, a page and Studio are never a card's moment.
 *
 * Words are written in sentence case; the cell's style sets them in caps.
 */

import type { JSX } from "react";
import { useUiStore } from "../../stores/uiStore.js";
import { useVexPresence } from "./useVexPresence.js";
import type { VexState } from "./vex-state.js";

/** The two moments the sheet gives a tagline. */
export type TaglineMoment = "rest" | "card";

export interface Tagline {
  /** The first clause, in ink. */
  readonly lead: string;
  /** The second clause, muted. */
  readonly rest: string;
}

export const TAGLINES: Readonly<Record<TaglineMoment, Tagline>> = {
  rest: { lead: "An AI trading agent,", rest: "on your computer." },
  card: { lead: "Check the card,", rest: "then decide." },
};

/** Which tagline the moment takes. */
export function taglineMomentOf(input: {
  readonly runtimeMode: string;
  readonly activeSessionId: string | null;
  readonly pageOpen: boolean;
  readonly state: VexState;
}): TaglineMoment {
  const inChat = input.runtimeMode === "agent" && input.activeSessionId !== null && !input.pageOpen;
  return inChat && input.state === "awaiting" ? "card" : "rest";
}

export function TaglineCell(): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const pageOpen = useUiStore((s) => s.shellRoute.kind !== "none");
  const { state } = useVexPresence();
  const moment = taglineMomentOf({ runtimeMode, activeSessionId, pageOpen, state });
  const { lead, rest } = TAGLINES[moment];
  return (
    <p className="vex-tagline" data-vex-tagline={moment}>
      <span className="vex-tagline__text">
        <span className="vex-tagline__lead">{lead}</span>{" "}
        <span className="vex-tagline__rest">{rest}</span>
      </span>
    </p>
  );
}
