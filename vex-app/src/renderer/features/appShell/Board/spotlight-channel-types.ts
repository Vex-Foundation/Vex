/**
 * THE PANEL TYPES, derived from the wire contract rather than restated.
 *
 * The spotlight schemas export their OUTCOME unions (panel or unavailable),
 * which is the right shape to receive but an awkward one to render: a section
 * that has already handled its absence wants the panel alone. These aliases
 * pull the panel arm out of each union with `Extract`, so they cannot drift
 * from `shared/schemas/board-spotlight.ts` - adding a field there adds it
 * here, and renaming an arm breaks this file rather than silently producing a
 * `never`.
 */

import type {
  BoardMomentumOutcome,
  BoardOtherPoolsOutcome,
  BoardSpotlightContextOutcome,
  BoardTapeOutcome,
  BoardTopTradersOutcome,
} from "@shared/schemas/board-spotlight.js";

export type BoardTopTradersPanel = Extract<
  BoardTopTradersOutcome,
  { kind: "traders" }
>;
export type BoardMomentumPanel = Extract<
  BoardMomentumOutcome,
  { kind: "momentum" }
>;
export type BoardOtherPoolsPanel = Extract<
  BoardOtherPoolsOutcome,
  { kind: "other-pools" }
>;
export type BoardSpotlightContextPanel = Extract<
  BoardSpotlightContextOutcome,
  { kind: "context" }
>;
export type BoardTapeTick = Extract<BoardTapeOutcome, { kind: "tape" }>;

export type {
  BoardNarrative,
  BoardOtherPool,
  BoardSpotlightSubject,
  BoardTapeRow,
  BoardTopTrader,
} from "@shared/schemas/board-spotlight.js";
