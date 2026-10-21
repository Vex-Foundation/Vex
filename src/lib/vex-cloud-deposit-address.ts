/**
 * The Vex Cloud deposit address this build sends VEX to (plan 15.6): ONE
 * resolver, read by the deposit prepare AND again by the pre-sign gate, so a
 * change between the two refuses the signature instead of redirecting it.
 *
 * The shipped value is the built-in `VEX_CLOUD_DEPOSIT_ADDRESS` (empty until
 * the production key exists). Development may name a local deposit address
 * through `VEX_DEV_CLOUD_DEPOSIT_ADDRESS`, honoured only when main allowed the
 * development overrides at boot (`!app.isPackaged`): the SAME gate as the API
 * URL (`allowVexCloudDevOverride` in `./vex-cloud-endpoint.ts`), so a packaged
 * build ignores both together and there is no second switch to forget.
 *
 * The answer is checksummed, or `null` when no address is pinned. A
 * malformed override is NOT trimmed into an address: it resolves to `null`
 * (deposits stay closed) rather than to the shipped constant, because a
 * developer who set one meant a specific destination and silently sending
 * elsewhere would be the worse surprise.
 */

import { getAddress } from "viem";
import { VEX_CLOUD_DEPOSIT_ADDRESS } from "../config/store.js";
import { isVexCloudDevOverrideAllowed } from "./vex-cloud-endpoint.js";

/** Development-only override; a packaged build ignores it. */
export const VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV = "VEX_DEV_CLOUD_DEPOSIT_ADDRESS";

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;

function checksummed(raw: string): string | null {
  if (!ADDRESS_SHAPE.test(raw) || ZERO_ADDRESS.test(raw)) return null;
  return getAddress(raw.toLowerCase());
}

/** The pinned deposit address in effect, checksummed, or `null` when deposits are not open in this build. */
export function resolveVexCloudDepositAddress(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (isVexCloudDevOverrideAllowed()) {
    const raw = env[VEX_CLOUD_DEV_DEPOSIT_ADDRESS_ENV]?.trim();
    if (raw !== undefined && raw.length > 0) return checksummed(raw);
  }
  const shipped: string = VEX_CLOUD_DEPOSIT_ADDRESS;
  return shipped.length === 0 ? null : checksummed(shipped);
}
