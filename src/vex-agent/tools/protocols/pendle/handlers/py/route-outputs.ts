/**
 * Reading a Convert route's output legs by TOKEN, never positionally: the
 * provider's `outputs` order is its own canonical order and does not echo the
 * request, so a positional read is how a raw amount ends up attributed to the
 * wrong token.
 */

import type { PendleTokenAmount } from "@tools/pendle/types.js";

/** Find a Convert route output amount (raw) for `address`; "0" when absent. */
export function outputAmountFor(outputs: readonly PendleTokenAmount[], address: string): string {
  const lower = address.toLowerCase();
  return outputs.find((o) => o.token.toLowerCase() === lower)?.amount ?? "0";
}
