/**
 * THE CHAT'S HEADER CELLS (docs/design/H3-DESKTOP.md sections 1.3, 4.2 and
 * 4.7; Appendix A.1): the cells of the header row over the chat column that
 * follow its title cell. In H3's row at 1440 they are, after the title (680,
 * 398):
 *
 *   network   1078, 240   MAINNET, the REAL FUNDS mark and a chevron: a
 *                         network menu
 *   pause     1318, 122   PAUSE ALL
 *
 * and desktop puts, in their place:
 *
 *   [data-vex-head-cell="funds"]
 *       MAINNET and the REAL FUNDS mark, with NO chevron: a statement, never a
 *       menu. Desktop is mainnet only ("Nothing here is a sandbox or
 *       testnet", `src/vex-agent/studio/instructions/shared-usage.ts`), so
 *       there is nothing to choose and a static stamp is true. The mark is
 *       the money card's stamp without its fill (section 2.2: "In the header
 *       the same glyph and words stand without the fill"): the hatch glyph,
 *       three strokes drawn by the sheet rather than shipped as art, and the
 *       words in caps. MAINNET is sans 14, REAL FUNDS 12 (section 2.3).
 *       Under 1280, as VEX Cloud's header does, the cell reads MAIN and the
 *       hatch: "Mainnet" and "Real funds" stay for assistive tech only.
 *   [data-vex-head-cell="caption-reserve"]
 *       PAUSE ALL is left out (desktop has per-run pause and stop, and Lock
 *       Vex, which stops signing, not workers; section 4.1), so its cell
 *       becomes the reserve for the Windows and Linux caption buttons: as
 *       wide as `--overlay-w` (0 on macOS and on a native frame), a drag
 *       region with nothing in it, hidden from assistive tech.
 *
 * The title cell itself, the chat's title with its kind and access under it
 * ("Agent · Restricted", "Mission · Full access"), stays where the approvals
 * sync is mounted (`RunningHead.tsx`, which reads the session); its H3 type,
 * the title over the caps kind line, 24 in from the cell's edge, is drawn by
 * the chat's sheet (console.css) on that markup.
 *
 * Both cells are window drag regions (`.vex-drag`): neither holds a control.
 * Rules and type live in console.css, the chat's chrome sheet.
 */

import type { JSX } from "react";

/** The network statement's two words, in sentence case: the sheet sets the caps. */
export const CHAT_HEAD_NETWORK_WORD = "Mainnet";
export const CHAT_HEAD_FUNDS_WORD = "Real funds";
/** The network's short word under 1280 (VEX Cloud's "Main"). */
export const CHAT_HEAD_NETWORK_SHORT = "Main";

export function ChatHeaderCells(): JSX.Element {
  return (
    <>
      <div
        data-vex-head-cell="funds"
        className="vex-shell-head__funds vex-chat-funds vex-drag"
      >
        <span className="vex-chat-funds__net">{CHAT_HEAD_NETWORK_WORD}</span>
        {/* Under 1280 the cell says "Main" and keeps the hatch, the words
          * only for assistive tech (VEX Cloud's `.hd-short`, `.rf-word`). */}
        <span className="vex-chat-funds__short" aria-hidden="true">
          {CHAT_HEAD_NETWORK_SHORT}
        </span>
        {/* The hatch glyph is the sheet's `::before`: decoration, no text. */}
        <span className="vex-chat-funds__mark" data-vex-real-funds-mark="">
          <span className="vex-chat-funds__words">{CHAT_HEAD_FUNDS_WORD}</span>
        </span>
      </div>
      <div
        aria-hidden
        data-vex-head-cell="caption-reserve"
        className="vex-shell-head__reserve vex-drag"
      />
    </>
  );
}
