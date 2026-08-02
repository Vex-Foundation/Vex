/**
 * TurnIsland public gate. The island's ONE public contract is the component
 * `StreamingBubble` mounts; the state derivation (`islandTurnState.ts`) is a
 * module-internal detail that its own unit tests import directly, so it is
 * deliberately not re-exported here.
 */

export { TurnIsland } from "./TurnIsland.js";
