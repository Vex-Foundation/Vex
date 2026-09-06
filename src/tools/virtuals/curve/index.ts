/**
 * Virtuals bonding-curve trading - the venue side.
 *
 * PUBLIC GATE. The runtime side (manifests, handlers, prequote binding,
 * activity rows) lives in `vex-agent/tools/protocols/virtuals/`; everything
 * here is chain mechanics and pure arithmetic with no vex-agent dependency, so
 * the maths can be table-tested without a database, a session or a wallet.
 *
 * The pieces, in the order a trade uses them:
 *
 *  1. `./deployments.ts`   which contracts, on which chain, pinned to which
 *                          proxy implementations.
 *  2. `./proxy-identity.ts` the EIP-1967 re-read that refuses an upgraded
 *                          implementation before signing.
 *  3. `./state.ts`         the whole authority table at ONE block.
 *  4. `./quote-math.ts`    the contract's own arithmetic, in bigint.
 *  5. `./fee.ts`           Vex's 25 bps, asymmetric by side (owner F1/F2).
 *  6. `./calldata.ts`      approve / buy / sell, built locally.
 *  7. `./receipt-decoder.ts` what the trade actually moved.
 */

export {
  VIRTUALS_CURVE_CHAIN_KEYS,
  virtualsCurveDeployment,
  virtualsCurveDeploymentByChainId,
  type VirtualsCurveChainKey,
  type VirtualsCurveDeployment,
} from "./deployments.js";

export {
  EIP1967_IMPLEMENTATION_SLOT,
  checkPinnedImplementations,
  readImplementation,
  type ProxyIdentity,
  type ProxyIdentityVerdict,
} from "./proxy-identity.js";

export {
  getVirtualsCurveClients,
  getVirtualsCurvePublicClient,
  type VirtualsCurveClients,
} from "./evm-client.js";

export {
  readCurveQuote,
  readCurveState,
  type CurveAntiSniperState,
  type CurveState,
  type CurveStateRefusal,
  type CurveStateResult,
  type CurveTradeSide,
} from "./state.js";

export {
  MAX_COMBINED_TAX_PCT,
  applySlippageFloor,
  computeBuyLegs,
  computeSellFloors,
  effectiveAntiSniperPct,
  percentOf,
  rawAntiSniperPctAt,
  splitCurveTax,
  type BuyLegs,
  type CurveTaxSplit,
  type SellFloors,
} from "./quote-math.js";

export {
  VIRTUALS_CURVE_FEE_ACTIVITY_EVENT_ROLE,
  VIRTUALS_CURVE_FEE_BPS,
  VIRTUALS_CURVE_FEE_RECEIVER_EVM,
  resolveVirtualsCurveBuyFee,
  resolveVirtualsCurveSellFee,
  virtualsCurveSellFeeFromProceeds,
  type VirtualsCurveBuyFee,
  type VirtualsCurveFeeDisclosure,
  type VirtualsCurveSellFee,
} from "./fee.js";

export {
  VIRTUALS_CURVE_DEADLINE_SECONDS,
  buildCurveApproveTx,
  buildCurveBuyTx,
  buildCurveSellTx,
  curveDeadlineFrom,
  type BuiltCurveTx,
} from "./calldata.js";

export {
  decodeCurveSettlement,
  type CurveSettlement,
  type DecodableLog,
} from "./receipt-decoder.js";
