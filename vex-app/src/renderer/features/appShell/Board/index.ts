/**
 * BOARD - the public gate of the transcript's board surface.
 *
 * `BoardBlock` is the ONE entry point other features compose (the transcript
 * row renders it beside the assistant body). Everything else in this
 * directory - the chart adapter, the primitive, the formatters, the view
 * model - is an implementation detail owned here, reachable by colocated
 * tests and by nothing else.
 */

export { BoardBlock, type BoardBlockProps } from "./BoardBlock.js";

/**
 * BOARD SURFACES (v3). `BoardModalHost` is the shell-level host; the store and
 * the contracts are the seam every later surface codes against.
 *
 * `BoardPreviewCardProps` is exported ahead of its component on purpose: it
 * is the shape the transcript row's one-line change site will pass, frozen
 * here so that change needs no negotiation with this directory.
 */
export { BoardModalHost, type BoardModalHostProps } from "./BoardModalHost.js";

/**
 * BOARD SURFACES (v3), the product side. `BoardRowCard` is the transcript's
 * one-line mount; `BoardModalChrome` and `BoardGrid` are the components the
 * shell hands the host as its header and grid slots. Everything below them -
 * the card, the chip, the sparkline, the data-notes disclosure, the derived
 * model - is an implementation detail owned in this directory.
 */
export { BoardRowCard, type BoardRowCardProps } from "./BoardRowCard.js";
export {
  BoardPreviewCard,
  BOARD_PREVIEW_PENDING_CONCLUSION,
} from "./BoardPreviewCard.js";
export { BoardGrid, boardGridLabel } from "./BoardGrid.js";
export { BoardSubtitle } from "./BoardSubtitle.js";
/**
 * ASK VEX (T3). The panel is the host's `askSlot`; the intent channel is the
 * seam the RESIDENT composer consumes from. Nothing here submits a turn.
 */
export { AskVexPanel, BOARD_ASK_SENT_NOTICE } from "./AskVexPanel.js";
export {
  nextBoardAskIntentId,
  useBoardAskIntentStore,
} from "./board-ask-intent.js";
export {
  BoardModalChrome,
  BOARD_LIVE_HELPER_OFF,
  BOARD_LIVE_HELPER_ON,
} from "./BoardModalChrome.js";
export {
  boardLiveReadout,
  isBoardLiveHeld,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
  BOARD_LIVE_READOUT_SNAPSHOT,
  type BoardLivePublication,
} from "./board-live-overlay.js";
export {
  useBoardSafetyVerdicts,
  boardDetailsFreshnessMs,
  BOARD_DETAILS_MIN_REFRESH_MS,
  BOARD_DETAILS_RETRY_MS,
  BOARD_SAFETY_EVIDENCE_UNREAD,
} from "./board-safety-surface.js";
export {
  useBoardSparklines,
  boardSparklineDataFrom,
  BOARD_SPARKLINE_PENDING,
  BOARD_SPARKLINE_RESOLUTION,
} from "./board-sparkline-source.js";
/**
 * BOARD SPOTLIGHT (v3, T2). The modal's second view: one pool at full size.
 * `BoardSpotlightChartSlotProps` is the seam the live chart mounts through -
 * the chart owns its own series, channel and teardown, so the surface hands it
 * a subject rather than data.
 */
export {
  BoardSpotlight,
  SPOTLIGHT_ASSESSMENT_TITLE,
  SPOTLIGHT_BACK_LABEL,
  SPOTLIGHT_LIVE_LABEL,
  SPOTLIGHT_NO_ANALYSIS,
  SPOTLIGHT_PILL_LABEL,
  type BoardSpotlightChartSlotProps,
  type BoardSpotlightProps,
} from "./BoardSpotlight.js";
export { BoardSpotlightWithChart } from "./BoardSpotlightWithChart.js";
export {
  SpotlightChart,
  SPOTLIGHT_CHART_DEFAULT_PILL,
  SPOTLIGHT_PILLS,
} from "./SpotlightChart.js";

export {
  boardSubtitle,
  buildBoardAuthoredContent,
  type BoardAuthoredContent,
} from "./boardModel.js";

export {
  BOARD_FILTER_NONE,
  boardArrivalOf,
  countBoardSurfaceTeardowns,
  readBoardTeardownFailures,
  registerBoardSurfaceTeardown,
  selectBoardLiveOwnerKey,
  selectSpotlightChannelsActive,
  useBoardSurfaceStore,
  type BoardExitIntent,
  type BoardFilter,
  type BoardSurfaceState,
  type BoardTeardownFailure,
  type BoardTeardownScope,
} from "./board-surface-store.js";

export {
  BOARD_ASK_QUICK_QUESTIONS,
  BOARD_LIVE_MAX_IN_FLIGHT,
  BOARD_SAFETY_CHIP,
  BOARD_SAFETY_STATES,
  boardKeyOf,
  boardRefOf,
  boardSafetyVerdict,
  buildBoardAskMessage,
  pairSubjectFromPool,
  pairSubjectKey,
  type BoardArrival,
  type BoardAskContext,
  type BoardAskIntent,
  type BoardAskSlotProps,
  type BoardExitReason,
  type BoardGridSlotProps,
  type BoardHeaderSlotProps,
  type BoardKey,
  type BoardLiveChannelDescriptor,
  type BoardLiveChannelId,
  type BoardLiveChannelOwner,
  type BoardLiveReadout,
  type BoardPreviewCardProps,
  type BoardRef,
  type BoardSafetyBucket,
  type BoardSafetyCheck,
  type BoardSafetyDetails,
  type BoardSafetyAttempt,
  type BoardSafetyEvidence,
  type BoardSafetyFailure,
  type BoardSafetyLastGood,
  type BoardSafetyState,
  type BoardSafetyTone,
  type BoardSafetyVerdict,
  type BoardSpotlightSlotProps,
  type BoardSubtitleSlotProps,
  type BoardSurfaceSlot,
  type BoardSurfaceView,
  type ClassifyBoardSafety,
  type PairOrientation,
  type PairSubject,
} from "./board-surface-contracts.js";
