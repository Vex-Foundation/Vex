/**
 * OPEN ASK VEX - the one action behind every "Ask Vex" key on the Board page
 * (a tile's link, the spotlight's assessment key).
 *
 * Ask Vex lives in the Vex sidebar (docs/design/R3-MINIMAL.md section 9.4),
 * and the Board is a table page where the sidebar is hidden by default. So
 * asking is three steps in one order: point the board at the token first
 * (the Ask block reads the SELECTED pool, and opening it before the pointer
 * moved would show it about another token for one commit), then open the
 * block, then show Vex, through the same store action the title bar's token
 * chip uses. Nothing here sends anything: the block hands its finished
 * question to the resident composer (`board-ask-intent.ts`).
 */

import { useUiStore } from "../../../stores/uiStore.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";

/** Ask about the pool at `poolIndex`, or about the selected one when null. */
export function openBoardAsk(poolIndex: number | null): void {
  const board = useBoardSurfaceStore.getState();
  if (poolIndex !== null) board.selectBoardPool(poolIndex);
  useBoardSurfaceStore.getState().setBoardAskOpen(true);
  useUiStore.getState().setVexOpen(true);
}
