/**
 * Pure encoder for the Lighter Core L1 USDC deposit transaction.
 *
 * Produces the exact `{ to, data, value }` for a deposit that credits the
 * caller's own L1 address (sender-credit; the first deposit creates the
 * account). Every parameter is validated against verified bounds before
 * encoding — a wrong recipient, asset index, or amount would lose funds
 * irreversibly. This module signs nothing and broadcasts nothing; it only
 * builds calldata for the gated executor to sign under the privileged boundary.
 */

import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";

import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_DEPOSIT_FUNCTION_ABI,
  LIGHTER_DEPOSIT_MIN_USDC,
  LIGHTER_DEPOSIT_ROUTE_TYPE,
  LIGHTER_MAX_ASSET_INDEX,
  LIGHTER_MIN_ASSET_INDEX,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  LIGHTER_USDC_ASSET_INDEX,
} from "./constants.js";
import { decimalToBaseUnits } from "./onboarding-plan.js";

export type LighterDepositRoute = keyof typeof LIGHTER_DEPOSIT_ROUTE_TYPE;

export interface LighterDepositCalldataInput {
  /** L1 address to credit — MUST be the depositing (Vex) wallet's own address. */
  readonly to: string;
  /** Settlement amount in integer base units (6-decimal USDC). */
  readonly amountUnits: bigint;
  /** Which account the deposit funds; defaults to perps. */
  readonly route?: LighterDepositRoute;
  /** Deposit asset index; defaults to the verified USDC index. */
  readonly assetIndex?: number;
}

export interface LighterDepositCalldata {
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly assetIndex: number;
  readonly routeType: number;
  readonly amountUnits: bigint;
}

const MIN_DEPOSIT_UNITS = decimalToBaseUnits(
  LIGHTER_DEPOSIT_MIN_USDC,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
);

/** Build (never sign) the Lighter Core deposit transaction calldata. */
export function buildLighterDepositCalldata(
  input: LighterDepositCalldataInput,
): LighterDepositCalldata {
  if (!isAddress(input.to)) {
    throw new Error("Lighter deposit `to` must be a valid EVM address (the crediting wallet).");
  }
  const assetIndex = input.assetIndex ?? LIGHTER_USDC_ASSET_INDEX;
  if (!Number.isInteger(assetIndex) || assetIndex < LIGHTER_MIN_ASSET_INDEX || assetIndex > LIGHTER_MAX_ASSET_INDEX) {
    throw new Error(
      `Lighter deposit assetIndex must be an integer in [${LIGHTER_MIN_ASSET_INDEX}, ${LIGHTER_MAX_ASSET_INDEX}].`,
    );
  }
  const route: LighterDepositRoute = input.route ?? "perps";
  const routeType = LIGHTER_DEPOSIT_ROUTE_TYPE[route];
  if (routeType === undefined) {
    throw new Error(`Lighter deposit route must be one of ${Object.keys(LIGHTER_DEPOSIT_ROUTE_TYPE).join(", ")}.`);
  }
  if (input.amountUnits < MIN_DEPOSIT_UNITS) {
    throw new Error(
      `Lighter deposit amount ${input.amountUnits} is below the ${MIN_DEPOSIT_UNITS} base-unit minimum; a smaller deposit is not credited.`,
    );
  }
  if (input.amountUnits > MAX_UINT256) {
    throw new Error("Lighter deposit amount exceeds uint256.");
  }

  const to = getAddress(LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS);
  const data = encodeFunctionData({
    abi: LIGHTER_DEPOSIT_FUNCTION_ABI,
    functionName: "deposit",
    args: [getAddress(input.to), assetIndex, routeType, input.amountUnits],
  });

  return { to, data, value: 0n, assetIndex, routeType, amountUnits: input.amountUnits };
}

const MAX_UINT256 = 2n ** 256n - 1n;
