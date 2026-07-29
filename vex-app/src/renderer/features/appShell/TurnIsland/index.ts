/**
 * TurnIsland public gate. `StreamingBubble` mounts `TurnIsland`; the state
 * derivation is exported for tests and for any surface that needs to reason
 * about the turn without rendering it. Everything else here is internal.
 */

export { TurnIsland } from "./TurnIsland.js";
export {
  resolveTurnIslandView,
  STREAM_ERROR_LABEL,
  type TurnIslandState,
  type TurnIslandView,
} from "./islandTurnState.js";
