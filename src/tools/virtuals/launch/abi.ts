/**
 * The MINIMAL ABIs the Virtuals agent-launch lane calls, transcribed from the
 * first-party sources in `agents-colab/protocol-contracts/contracts/launchpadv2/`
 * and each exercised live on Base and Robinhood on 2026-09-04 and 2026-09-05.
 *
 * Narrow on purpose, and separate from `../curve/abi.ts` for a reason that is
 * not tidiness: the curve lane calls `buy`/`sell` and the launch lane calls
 * `preLaunch`/`cancelLaunch`, they approve DIFFERENT spenders, and putting both
 * in one table would invite a reader to assume the allowance target is shared.
 * It is not (see `./calldata.ts`).
 *
 * `launch(address)` is present as a READ ONLY - it is decoded from the keeper's
 * receipt and simulated to learn whether the token is still pre-launched. Vex
 * NEVER sends it: the measured incident on 2026-09-04 is that our own `launch()`
 * pre-empted the Virtuals keeper on Robinhood (tx `0x17e401b9`, token
 * `0xd1eF7097`) and the agent was never indexed by `api.virtuals.io`, while the
 * Base agent whose `launch()` the keeper executed itself (tx `0x9eca4cb5`) was
 * indexed as id 139289. The keeper's call is what registers the agent with the
 * platform; ours only spends gas and destroys the listing.
 */

import { parseAbi } from "viem";

/**
 * `BondingV5` - the launch entry point.
 *
 * ARGUMENT ORDER IS THE CONTRACT (`BondingV5.sol:292-306`). `urls_` is a FIXED
 * `string[4]` in twitter/telegram/youtube/website order, not a dynamic array,
 * and `extParams_` is a flags word documented on `./calldata.ts`.
 */
export const BONDING_V5_LAUNCH_ABI = parseAbi([
  "function preLaunch(string name_, string ticker_, uint8[] cores_, string desc_, string img_, string[4] urls_, uint256 purchaseAmount_, uint256 startTime_, uint8 launchMode_, uint16 airdropBips_, bool needAcf_, uint8 antiSniperTaxType_, bool isProject60days_, bytes extParams_) returns (address, address, uint256, uint256)",
  "function cancelLaunch(address tokenAddress_)",
  "function launch(address tokenAddress_) returns (address, address, uint256, uint256)",
  "function bondingConfig() view returns (address)",
  "function router() view returns (address)",
  "event PreLaunched(address indexed token, address indexed pair, uint256 virtualId, uint256 initialPurchase, (uint8 launchMode, uint16 airdropBips, bool needAcf, uint8 antiSniperTaxType, bool isProject60days) launchParams)",
  "event Launched(address indexed token, address indexed pair, uint256 virtualId, uint256 initialPurchase, uint256 initialPurchasedAmount, (uint8 launchMode, uint16 airdropBips, bool needAcf, uint8 antiSniperTaxType, bool isProject60days) launchParams)",
  "event CancelledLaunch(address indexed token, address indexed pair, uint256 virtualId, uint256 initialPurchase)",
]);

/**
 * `BondingConfig` - the launch fee table and the scheduled-launch threshold.
 *
 * `calculateLaunchFee(isScheduled, needAcf)` is the AUTHORITY on the protocol
 * fee (`BondingConfig.sol:460-471`): immediate + no ACF is 0, and that zero was
 * read live on both chains rather than assumed. `getScheduledLaunchParams()`
 * carries `startTimeDelay`, which is what decides whether a `startTime_`
 * counts as scheduled at all (`BondingV5.sol:326-333`) - the number this lane
 * must stay strictly below to remain an immediate launch.
 */
export const BONDING_CONFIG_LAUNCH_ABI = parseAbi([
  "function calculateLaunchFee(bool isScheduledLaunch_, bool needAcf_) view returns (uint256)",
  "function getScheduledLaunchParams() view returns ((uint256 startTimeDelay, uint256 normalLaunchFee, uint256 acfFee))",
  "function feeTo() view returns (address)",
  "function initialSupply() view returns (uint256)",
  "function isValidAntiSniperType(uint8 antiSniperType_) pure returns (bool)",
]);

/** `FPairV2.startTime()` - the moment `launch()` becomes callable at all. */
export const FPAIR_V2_LAUNCH_ABI = parseAbi([
  "function startTime() view returns (uint256)",
]);
