/**
 * Virtuals agent LAUNCH - the venue side.
 *
 * PUBLIC GATE. The runtime side (manifests, handlers, durable intents, activity
 * rows, the keeper sweep) lives in `vex-agent/tools/protocols/virtuals/` and
 * `vex-agent/sync/`; everything here is chain mechanics and pure arithmetic with
 * no vex-agent dependency, so it can be table-tested without a database, a
 * session or a wallet.
 *
 * The pieces, in the order a launch uses them:
 *
 *  1. `./fields.ts`          what a caller may say, and the bounds Vex adds.
 *  2. `./state.ts`           the whole authority table at ONE block.
 *  3. `./fee.ts`             Vex's 25 bps, collectible only on an observed launch.
 *  4. `./calldata.ts`        approve / preLaunch / cancelLaunch, built locally.
 *  5. `./receipt-decoder.ts` what the transaction actually did.
 *  6. `./keeper-wait.ts`     watching for somebody else's `launch()`.
 *
 * The contract table itself is shared with the curve TRADE lane
 * (`../curve/deployments.ts`): same BondingV5, same VIRTUAL, same pinned
 * implementations. Only the allowance spender differs, and `./calldata.ts` says
 * why in the one place that matters.
 */

export {
  BONDING_CONFIG_LAUNCH_ABI,
  BONDING_V5_LAUNCH_ABI,
  FPAIR_V2_LAUNCH_ABI,
} from "./abi.js";

export {
  LAUNCH_CORES_MAX,
  LAUNCH_DESCRIPTION_MAX,
  LAUNCH_NAME_MAX,
  LAUNCH_TICKER_MAX,
  LAUNCH_URL_MAX,
  LAUNCH_URL_SLOTS,
  readLaunchCores,
  readLaunchDescription,
  readLaunchName,
  readLaunchTicker,
  readLaunchUrl,
  type CoresVerdict,
  type FieldVerdict,
  type LaunchUrlSlot,
} from "./fields.js";

export {
  readLaunchState,
  type LaunchState,
  type LaunchStateRefusal,
  type LaunchStateResult,
} from "./state.js";

export {
  VIRTUALS_LAUNCH_FEE_ACTIVITY_EVENT_ROLE,
  VIRTUALS_LAUNCH_FEE_BPS,
  VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
  resolveVirtualsLaunchFee,
  type VirtualsLaunchFee,
  type VirtualsLaunchFeeDisclosure,
} from "./fee.js";

export {
  VIRTUALS_NAME_SUFFIX,
  buildCancelLaunchTx,
  buildLaunchApproveTx,
  buildPreLaunchTx,
  encodeLaunchExtParams,
  launchCalldataFingerprint,
  onChainTokenName,
  preLaunchArgTuple,
  type BuiltLaunchTx,
  type PreLaunchArgs,
  type VirtualsNameSuffixChoice,
} from "./calldata.js";

export {
  decodeCancelledLaunch,
  decodeLaunched,
  decodePreLaunched,
  type DecodableLaunchLog,
  type DecodedCancelledLaunch,
  type DecodedLaunchParams,
  type DecodedLaunched,
  type DecodedPreLaunched,
} from "./receipt-decoder.js";

export {
  KEEPER_WAIT_MS,
  keeperLogReaderFrom,
  readKeeperOutcome,
  waitForKeeperLaunch,
  type KeeperLogReader,
  type KeeperLogRow,
  type KeeperObservation,
  type KeeperWaitClock,
} from "./keeper-wait.js";
