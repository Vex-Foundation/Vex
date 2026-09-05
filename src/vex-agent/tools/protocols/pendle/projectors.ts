/**
 * Pendle READ projectors - the public contract.
 *
 * BARREL: the implementation is split by responsibility into `./projectors/*` -
 * market rows for `pendle.yields`, position legs for `pendle.position.value`.
 * The two change for different reasons and share only the token primitive in
 * `./projectors/_shared.ts`, which is intentionally NOT re-exported.
 *
 * The ONLY consumers are the read handlers (`handlers/yields.ts`,
 * `handlers/positions.ts` - verified by grep across `src/`), so these output
 * shapes are free to change with the read tools that own them. Nothing here is
 * consumed by a mutating handler, by valuation, or by sync.
 */

export {
  compareMarketRows,
  projectMarketRow,
  withExternalProtocols,
  type ProjectedMarketRow,
  type ProjectedToken,
} from "./projectors/market-rows.js";

export {
  positionState,
  projectPositionLeg,
  projectSyLeg,
  totalPositionValue,
  type PendlePositionState,
  type ProjectedAccrued,
  type ProjectedAccruedItem,
  type ProjectedPositionLeg,
} from "./projectors/position-legs.js";
