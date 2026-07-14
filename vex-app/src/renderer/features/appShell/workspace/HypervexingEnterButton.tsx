/**
 * Zero-token Hypervexing re-entry (owner feature): a session that has been
 * in the mode before gets a one-click way back in — straight through the
 * main-owned IPC, no LLM turn spent on the transition.
 *
 * Visibility is main's verdict, not the renderer's guess: the workspace-mode
 * read carries `acknowledged` and `everEntered`, and the enter handler
 * re-checks both fail-closed. Like EXIT, the click never flips the UI
 * optimistically — main's pushed event drives the morph, so the button's
 * pending state simply waits for the room to pour in.
 *
 * Brand note: this chip wears the PROTOCOL ink (Hypervexing turquoise +
 * liquid veil) even on the cobalt desk — it is a door to another room, and
 * doors are painted the color of where they lead.
 */

import { useState, type JSX } from "react";

import { useHyperliquidWorkspaceModeRead } from "../../../lib/api/hyperliquid.js";
import { HlLiquidVeil } from "./HlLiquidVeil.js";
import { HypervexingWordmark } from "./HypervexingWordmark.js";

export function HypervexingEnterButton({
  sessionId,
}: {
  readonly sessionId: string | null;
}): JSX.Element | null {
  const modeRead = useHyperliquidWorkspaceModeRead(sessionId);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const dto = modeRead.data?.ok ? modeRead.data.data : null;
  if (
    sessionId === null ||
    dto === null ||
    dto.mode !== "normal" ||
    !dto.acknowledged ||
    !dto.everEntered
  ) {
    return null;
  }

  const enter = (): void => {
    setPending(true);
    setFailed(false);
    void window.vex.hyperliquid.enterWorkspace({ sessionId }).then((result) => {
      // Accepted → main broadcasts and the workspace pours in, unmounting
      // this rail; the pending spinner is simply the door opening.
      if (!result.ok) {
        setPending(false);
        setFailed(true);
      }
    });
  };

  return (
    <div className="mt-auto px-3 pb-3 pt-4">
      <button
        type="button"
        onClick={enter}
        disabled={pending}
        aria-label="Enter Hypervexing workspace"
        className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg border border-[#4fd1c5]/35 bg-[#0a0f11] px-3 py-2.5 transition-colors duration-150 hover:border-[#4fd1c5]/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-60"
      >
        <HlLiquidVeil />
        <img
          src="/protocols/hl.png"
          alt=""
          aria-hidden
          className="relative h-[18px] w-[18px] rounded-full"
        />
        <HypervexingWordmark className="relative text-[14px]" />
        <span className="relative font-mono text-[9px] uppercase tracking-[0.2em] text-[#5fe3d6]">
          {pending ? "Opening…" : failed ? "Retry" : "Enter"}
        </span>
      </button>
      {failed ? (
        <p role="alert" className="mt-1.5 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--vex-warn-text)]">
          Could not open the workspace.
        </p>
      ) : null}
    </div>
  );
}
