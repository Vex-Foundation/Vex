/**
 * Shared primitive for the Pendle read projectors: a contract paired with the
 * two things needed to read any amount denominated in it.
 *
 * `decimals` is `null` when the chain's asset catalogue does not carry the
 * token. That is a real state and it is reported, never replaced with an assumed
 * 18 - the assumption is what turned a 6-decimal balance into a 10^12 error.
 */

import type { PendleAsset } from "@tools/pendle/types.js";
import { trustedAddress, trustedText } from "../trusted-fields.js";

export interface ProjectedToken {
  address: string | null;
  symbol: string | null;
  decimals: number | null;
}

export function projectToken(
  address: string | null,
  assetByAddress: Map<string, PendleAsset>,
): ProjectedToken | null {
  const checked = trustedAddress(address);
  if (checked === null) return null;
  const asset = assetByAddress.get(checked);
  return {
    address: checked,
    symbol: trustedText(asset?.symbol ?? null),
    decimals: asset?.decimals ?? null,
  };
}
