/** Read-only Phase 2 canary preflight. This script cannot sign or broadcast. */

import { getAddress } from "viem";

import {
  buildLighterDepositCanaryReadiness,
} from "../wallet-funding/deposit-canary-readiness.js";
import { readLighterDepositPreflight } from "../wallet-funding/deposit-preflight.js";
import { getLighterClient } from "../client.js";
import { decimalToBaseUnits } from "../wallet-funding/onboarding-plan.js";
import {
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  LIGHTER_USDC_ASSET_INDEX,
} from "../wallet-funding/constants.js";

async function main(): Promise<void> {
  const help = process.argv.includes("--help");
  const walletArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (walletArg === undefined || help) {
    printHelp();
    if (walletArg === undefined && !help) process.exitCode = 2;
    return;
  }
  const walletAddress = getAddress(walletArg);
  const amountUnits = await readLiveMinimumTransferUnits();
  const snapshot = await readLighterDepositPreflight({
    walletAddress,
    amountUnits,
    routeType: 0,
  });
  const readiness = buildLighterDepositCanaryReadiness(snapshot);
  console.log(JSON.stringify(readiness, null, 2));
  console.log("\nReadiness only: no transaction was signed or broadcast.");
  console.log("A separate exact user approval is required before the canary may move funds.");
}

async function readLiveMinimumTransferUnits(): Promise<bigint> {
  const assets = await getLighterClient().getAssetDetails("core");
  const rows = assets.asset_details.filter((asset) => asset.asset_id === LIGHTER_USDC_ASSET_INDEX);
  const asset = rows[0];
  if (assets.code !== 200 || rows.length !== 1 || asset === undefined) {
    throw new Error("Lighter did not expose exactly one live USDC asset row.");
  }
  return decimalToBaseUnits(asset.min_transfer_amount, LIGHTER_SETTLEMENT_ASSET_DECIMALS);
}

function printHelp(): void {
  console.log("Read live Ethereum/Lighter evidence for the Phase 2 minimum-value canary.");
  console.log("This command accepts a public wallet address and cannot sign or broadcast.");
  console.log("");
  console.log("Usage:");
  console.log("  pnpm run lighter:deposit:canary-readiness -- 0xYourWalletAddress");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
