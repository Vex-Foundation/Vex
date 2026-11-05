/**
 * THE TAGLINE CELL (docs/design/H3-DESKTOP.md sections 1.8 and Appendix A.6):
 * the bottom row's cell under the Vex column, Vex's line on the foot of her
 * column (VEX Cloud's `.moment` over its bars, the H3 mockup's app.css and
 * js/data.js). It says the moment in one of two registers, on a dark strip
 * laid over the cell:
 *
 *   CAPS, two tones (her first clause in ink, the second muted), 600:
 *     at rest (the welcome, an idle chat, every other moment)
 *       "An AI trading agent, on your computer."  (H3's "inside your limits"
 *       would be false: desktop has no spend limits)
 *     a card waiting in the chat beside it
 *       "Check the card, then decide."            (H3's own words)
 *     Studio, whatever it shows
 *       "Coding agents, on your computer."        (our approved Studio plate,
 *       section 4.9)
 *     a turn that has just settled
 *       "Done."                                   (the state word: desktop
 *       proves no fill and no approval, so it never says Cloud's "Filled,
 *       approved by you."; nothing joins a turn to its activity)
 *   SAY, the narration in sentence case, in ink 2: while Vex works
 *     (Thinking, Working), her one line from real parts (`narration.ts`:
 *     the live word the turn island shows, the resolved tool title, the
 *     person's own last message), or the state word alone where the
 *     narration has nothing true to add.
 *
 * UNDER THE STRIP, THE BARS (`VexBars.tsx`, Cloud's bars canvas): a display
 * of her mood (ready, busy, approve), never a key or a reading (PD-15). With
 * a line on it the strip covers them at 82%; an empty line leaves them alone.
 *
 * THE SETTLED LINE HOLDS 3.4 S (Cloud's `LINE_HOLD`, her act and a beat),
 * then the line empties and the strip goes, so the bars under it show
 * alone; it stays empty until the moment changes (a new turn, a card,
 * another chat). Cloud's 4.0 s hold is a refusal's, a moment desktop never
 * proves, so it has no line here.
 *
 * "A card waiting" is read from the real state, never guessed: the chat open
 * in the agent shell, no page over it, and Vex's state Waiting for approval,
 * which in a chat counts only that chat's own approvals (`useVexPresence`).
 * The welcome, a page and Studio are never a card's moment.
 *
 * The line is a picture of what the Vex key's state word and the transcript
 * already say (Cloud's G14, one carrier per fact), so it is hidden from
 * assistive tech, as Cloud's is. Words are written in sentence case; the
 * caps register's style sets them in caps.
 */

import { useEffect, useState, type JSX } from "react";
import { useUiStore } from "../../stores/uiStore.js";
import { useVexPresence } from "./useVexPresence.js";
import { VexBars } from "./VexBars.js";
import { vexBarsMoodOf, type VexBarsMood } from "./vex-bars.js";
import type { VexState } from "./vex-state.js";

/** The moments the sheet gives a tagline, and Studio's. */
export type TaglineMoment = "rest" | "card" | "studio";

export interface Tagline {
  /** The first clause, in ink. */
  readonly lead: string;
  /** The second clause, muted. */
  readonly rest: string;
}

export const TAGLINES: Readonly<Record<TaglineMoment, Tagline>> = {
  rest: { lead: "An AI trading agent,", rest: "on your computer." },
  card: { lead: "Check the card,", rest: "then decide." },
  studio: { lead: "Coding agents,", rest: "on your computer." },
};

/** The settled line: the state word, and nothing it cannot prove. */
export const SETTLED_LINE: Tagline = { lead: "Done.", rest: "" };

/** How long the settled line holds before the line empties (Cloud's `LINE_HOLD.signed`). */
export const SETTLED_HOLD_MS = 3_400;

/** Which tagline the moment takes. */
export function taglineMomentOf(input: {
  readonly runtimeMode: string;
  readonly activeSessionId: string | null;
  readonly pageOpen: boolean;
  readonly state: VexState;
}): TaglineMoment {
  if (input.runtimeMode === "studio") return "studio";
  const inChat = input.runtimeMode === "agent" && input.activeSessionId !== null && !input.pageOpen;
  return inChat && input.state === "awaiting" ? "card" : "rest";
}

/** Where a settled moment stands: its line holding, then the line empty. */
export type SettledPhase = "settled" | "quiet";

/** Vex's line on the foot of her column, as one of its two registers. */
export type VexLine =
  | {
      readonly kind: TaglineMoment | "settled";
      readonly reg: "caps";
      readonly lead: string;
      readonly rest: string;
      /** The line has emptied: the strip leaves, the bars show alone. */
      readonly empty: boolean;
    }
  | { readonly kind: "working"; readonly reg: "say"; readonly text: string };

/** The rest line, as the stage before the shell says it. */
export const REST_LINE: VexLine = { kind: "rest", reg: "caps", ...TAGLINES.rest, empty: false };

/** The line a moment takes; see the file header for each. */
export function vexLineOf(input: {
  readonly runtimeMode: string;
  readonly activeSessionId: string | null;
  readonly pageOpen: boolean;
  readonly state: VexState;
  /** The state's word, the narration's fallback. */
  readonly word: string;
  /** Her narration from real parts, or null where it has nothing true to add. */
  readonly narration: string | null;
  /** A settled moment's phase in this chat, or null. */
  readonly settled: SettledPhase | null;
}): VexLine {
  const moment = taglineMomentOf(input);
  if (moment === "studio") return { kind: "studio", reg: "caps", ...TAGLINES.studio, empty: false };
  if (input.state === "thinking" || input.state === "working") {
    return { kind: "working", reg: "say", text: input.narration ?? input.word };
  }
  if (moment === "card") return { kind: "card", reg: "caps", ...TAGLINES.card, empty: false };
  if (input.settled !== null) {
    return { kind: "settled", reg: "caps", ...SETTLED_LINE, empty: input.settled === "quiet" };
  }
  return { kind: "rest", reg: "caps", ...TAGLINES.rest, empty: false };
}

/** The states a settled moment stays through: her rest and the person typing. */
const SETTLED_STAYS: ReadonlySet<VexState> = new Set<VexState>(["done", "ready", "listening"]);

/**
 * A settled moment in one scope: from the edge into Done its line holds for
 * `SETTLED_HOLD_MS`, then the line is quiet until the moment changes (any
 * state but Done, Ready or Listening) or the scope does. Derived while
 * rendering from the changing state (React's own pattern, as `useDoneEdge`),
 * with the one timeout the edge arms.
 */
export function useSettledPhase(state: VexState, scope: string): SettledPhase | null {
  const [seen, setSeen] = useState<{ readonly state: VexState; readonly scope: string }>({
    state,
    scope,
  });
  const [settle, setSettle] = useState<{ readonly scope: string; readonly phase: SettledPhase } | null>(
    null,
  );
  if (seen.state !== state || seen.scope !== scope) {
    setSeen({ state, scope });
    if (seen.scope !== scope) {
      if (settle !== null) setSettle(null);
    } else if (state === "done" && seen.state !== "done") {
      setSettle({ scope, phase: "settled" });
    } else if (!SETTLED_STAYS.has(state) && settle !== null) {
      setSettle(null);
    }
  }
  const holding = settle?.phase === "settled";
  useEffect(() => {
    if (!holding) return undefined;
    const timer = window.setTimeout(() => {
      setSettle((current) => (current?.phase === "settled" ? { ...current, phase: "quiet" } : current));
    }, SETTLED_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holding]);
  return settle !== null && settle.scope === scope ? settle.phase : null;
}

/**
 * The foot as drawn: the bars, and over them the strip and the line on it.
 * The shell's cell reads the moment (`TaglineCell`); the stage before the
 * shell hands in its rest line and its own state's mood for the bars.
 */
export function TaglineView({
  line,
  bars,
}: {
  readonly line: VexLine;
  /** The bars' mood: her presence state's (`vexBarsMoodOf`). */
  readonly bars: VexBarsMood;
}): JSX.Element {
  const empty = line.reg === "caps" && line.empty;
  return (
    <div className="vex-foot" data-vex-area="vex-foot">
      <VexBars mood={bars} />
      <p
        className="vex-tagline"
        data-vex-tagline={line.kind}
        data-reg={line.reg}
        data-empty={empty ? "" : undefined}
        aria-hidden="true"
      >
        <span className="vex-tagline__text">
          {line.reg === "say" ? (
            line.text
          ) : (
            <>
              <span className="vex-tagline__lead">{line.lead}</span>
              {line.rest === "" ? null : (
                <>
                  {" "}
                  <span className="vex-tagline__rest">{line.rest}</span>
                </>
              )}
            </>
          )}
        </span>
      </p>
    </div>
  );
}

export function TaglineCell(): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const pageOpen = useUiStore((s) => s.shellRoute.kind !== "none");
  const { state, word, narration } = useVexPresence();
  const settled = useSettledPhase(state, `${runtimeMode}:${activeSessionId ?? ""}`);
  const line = vexLineOf({ runtimeMode, activeSessionId, pageOpen, state, word, narration, settled });
  return <TaglineView line={line} bars={vexBarsMoodOf(state)} />;
}
