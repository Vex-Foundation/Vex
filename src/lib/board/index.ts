/**
 * Public gate for the BoardSpec v1 contract.
 *
 * Named re-exports rather than `export *`, so the surface every consumer may
 * rely on is visible in one place and a module-private helper cannot leak into
 * four packages by accident.
 *
 * Consumers:
 *  - agent runtime: `../../lib/board/index.js` (relative; the repo root has no
 *    `@vex-lib` alias);
 *  - Electron shared/main/renderer: `@vex-lib/board/index.js`, admitted by
 *    `vex-app/scripts/check-process-boundaries.mjs`'s pure-module allowlist.
 */

export {
  BOARD_ANALYSIS_RULE,
  BOARD_ANNOTATION_LABEL_RULE,
  BOARD_CAPTION_RULE,
  BOARD_CHART_RESOLUTIONS,
  BOARD_DECIMAL_MAX_CHARS,
  BOARD_ICON_ID_PATTERN,
  BOARD_MARKER_MAX_MS,
  BOARD_MARKER_MIN_MS,
  BOARD_MAX_ANNOTATIONS,
  BOARD_MAX_CANDLES,
  BOARD_MAX_NOTES,
  BOARD_MAX_POOLS,
  BOARD_NOTE_RULE,
  BOARD_SPEC_MAX_BYTES,
  BOARD_STALE_AFTER_MS,
  BOARD_TITLE_RULE,
  boardAnnotationSchema,
  boardCandleSchema,
  boardCandleSeriesSchema,
  boardChartInputSchema,
  boardComposeInputSchema,
  boardHydratedRowSchema,
  boardHydrationSchema,
  boardLevelAnnotationSchema,
  boardMarkerAnnotationSchema,
  boardPoolInputSchema,
  boardProvenanceSchema,
  boardSpecV1Schema,
  boardText,
  boardZoneAnnotationSchema,
  checkBoardSpecByteBudget,
  compareDecimalStrings,
  describeBoardByteBudgetFailure,
} from "./spec.js";

export type {
  BoardAnnotation,
  BoardByteBudgetResult,
  BoardCandle,
  BoardCandleSeries,
  BoardChartInput,
  BoardChartResolution,
  BoardComposeInput,
  BoardHydratedRow,
  BoardHydration,
  BoardPoolInput,
  BoardSpecV1,
} from "./spec.js";

export {
  checkBoardText,
  describeBoardTextFailure,
  findForbiddenTextClass,
  textLength,
} from "./board-text.js";

export type {
  BoardTextFailure,
  BoardTextRule,
  ForbiddenTextClass,
} from "./board-text.js";
