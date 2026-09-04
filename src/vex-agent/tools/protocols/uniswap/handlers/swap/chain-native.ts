/**
 * Native-coin spellings and display symbols for the Uniswap venue.
 *
 * The routed address is ALWAYS the deployment's WETH - the symbol here is
 * display only, so a Polygon swap does not tell the agent it spent "ETH".
 */

import { NATIVE_TOKEN_ADDRESS } from "@tools/uniswap/execute.js";

/** Native symbol per chain (display only - the routed address is always WETH). */
const NATIVE_SYMBOL: Record<number, string> = { 137: "POL", 56: "BNB" };

export function nativeSymbolFor(chainId: number): string {
  return NATIVE_SYMBOL[chainId] ?? "ETH";
}

export function isNativeInput(input: string): boolean {
  const lower = input.toLowerCase();
  return lower === "native" || lower === "eth" || lower === NATIVE_TOKEN_ADDRESS.toLowerCase();
}
