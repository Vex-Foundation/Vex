/**
 * BOOK — the on-demand right-side instrument rail (a new <aside> sibling in the
 * AppShell <main> flex row). Per-session register: POSITION (scoped wallet
 * portfolio), MOVES (what the agent did), RUNTIME & COST (model/context/usage/
 * compaction), SESSION (metadata). The global no-session view shows the GLOBAL
 * inventory POSITION ("Portfolio"). The MISSION contract/setup lives in the
 * centre column (SessionPanel), not here — this rail is instruments only.
 *
 * The rail is ONE continuous editorial column of soft translucent ink
 * (--vex-rail + backdrop-blur, guard-whitelisted for exactly this file and
 * SessionsList) floating over the Signal Sky WebGL canvas behind the shell,
 * delimited only by the edge-fading .vex-rail-seam-l hairline (seamless-shell
 * owner review — no full-height border wall). Inside, the landing
 * right-workspace-column grammar (.ws-col) holds: eyebrow section heads +
 * border-t hairlines between sections (BookBlock owns that chrome), no boxed
 * tiles, so the column reads as one pane, not a card stack. Mode is a pure
 * derivation of `activeSessionId`: null = welcome (global), else the open
 * session (scoped). Slides in via a CSP-safe one-shot keyframe
 * (`vex-book-enter`); reduced motion collapses it to the final frame.
 *
 * The panel owns its own collapse header bar (first child): the version stamp
 * (relocated from the DESK RULE) + a chevron that calls the same `toggleBook`
 * the DESK RULE toggle uses. When collapsed the panel keeps the header bar
 * mounted (chevron-only spine) and hides the instrument blocks via CSS (no
 * remount), so the BOOK slide-in keyframe never replays on expand. The version
 * stamp is shown only when expanded and drops away when collapsed.
 */

import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PanelRightCloseIcon,
  PanelRightOpenIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "../../lib/utils.js";
import { SessionRuntimeBar } from "./SessionRuntimeBar.js";
import { BookBlock } from "./book/BookBlock.js";
import { MovesBlock } from "./book/MovesBlock.js";
import { PositionBlock } from "./book/PositionBlock.js";
import { SessionBlock } from "./book/SessionBlock.js";
import { HyperliquidPositionsBlock } from "./book/HyperliquidPositionsBlock.js";
import { HyperliquidRiskBlock } from "./book/HyperliquidRiskBlock.js";
import { HypervexingEnterButton } from "./workspace/HypervexingEnterButton.js";
import { SidebarIconButton } from "./SessionRows.js";

export function BookPanel({
  activeSessionId,
  bookOpen,
  onToggle,
}: {
  readonly activeSessionId: string | null;
  readonly bookOpen: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <aside
      data-vex-area="book-panel"
      data-vex-book-open={bookOpen ? "true" : "false"}
      aria-label="Session instrument"
      className={cn(
        // Rail over the Signal Sky: softer translucent ink (--vex-rail) in
        // BOTH states — the collapsed spine is the same tint, thinner. Pure
        // glass, NO separating stroke (owner review round 2: even the
        // edge-fading hairline still read as a dividing line). Backdrop-blur
        // stays guard-whitelisted for this rail.
        "vex-book-enter flex h-full shrink-0 flex-col overflow-y-auto bg-[var(--vex-rail)] backdrop-blur-xl",
        // Collapsed: a thin spine carrying only the header bar (version +
        // chevron). Expanded: the full instrument rail. Width change is CSS
        // only — the panel never remounts, so the blocks keep their state.
        bookOpen ? "w-[320px] gap-3 p-3" : "w-12 p-0",
      )}
    >
      {/* Collapse header bar — version stamp (relocated from the DESK RULE)
       * + the chevron. When collapsed the bar centres the chevron in the
       * narrow spine and the version stamp drops away. */}
      <div
        className={cn(
          "flex shrink-0 items-center",
          bookOpen ? "justify-between" : "justify-center pt-3",
        )}
      >
        {bookOpen ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--vex-text-3)]">
            v{__VEX_APP_VERSION__}
          </span>
        ) : null}
        <SidebarIconButton
          label={bookOpen ? "Collapse the BOOK panel" : "Expand the BOOK panel"}
          onClick={onToggle}
        >
          <HugeiconsIcon
            icon={bookOpen ? PanelRightCloseIcon : PanelRightOpenIcon}
            size={17}
            aria-hidden
          />
        </SidebarIconButton>
      </div>

      {bookOpen ? (
        // Sections separate themselves (BookBlock border-t hairlines + py
        // rhythm) — no gap here, so the rules run edge to edge as one column.
        <div className="flex min-h-0 flex-col">
          {activeSessionId !== null ? (
            <>
              <PositionBlock activeSessionId={activeSessionId} hero />
              <HyperliquidPositionsBlock sessionId={activeSessionId} />
              <HyperliquidRiskBlock sessionId={activeSessionId} />
              <MovesBlock sessionId={activeSessionId} />
              <BookBlock title="Runtime & Cost">
                <SessionRuntimeBar sessionId={activeSessionId} layout="stack" />
              </BookBlock>
              <SessionBlock sessionId={activeSessionId} />
              {/* Zero-token door back into the room (owner feature): shows
                  only for acknowledged sessions with mode history — main
                  re-verifies both fail-closed on the invoke. */}
              <HypervexingEnterButton sessionId={activeSessionId} />
            </>
          ) : (
            <>
              {/* Global portfolio (no active session) — the configured inventory.
                  No Hyperliquid block here by owner decree: the agent activates
                  the mode and risk setup arrives as a confirmable card. */}
              <PositionBlock activeSessionId={null} hero />
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
