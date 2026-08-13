/**
 * The curve token's ticker for the trade's activity legs.
 *
 * AgentScan builds a token reference only when address, symbol and decimals are
 * all present, so a memecoin leg without its symbol is reported with a null
 * token ref and can never be priced. The launchpad token is not part of the
 * handler's params, so the ticker is read from the token contract itself,
 * alongside the `decimals()` read the trade already performs.
 *
 * The symbol is attacker-controlled data from an arbitrary contract: it is
 * normalized before it can reach a stored row or agent-facing text, and a
 * symbol that fails normalization is dropped (null) rather than repaired. A
 * missing symbol degrades reporting only; it never fails a trade.
 */

import type { Address } from "viem";
import { ERC20_READ_ABI, type Erc20ReadClient } from "@tools/evm-chains/erc20-reads.js";

/** Upper bound for an accepted ticker. A longer string is rejected, never shortened. */
export const CURVE_TOKEN_SYMBOL_MAX_LENGTH = 32;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Normalize a raw `symbol()` return into a storable ticker, or null when unusable. */
export function normalizeCurveTokenSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const symbol = raw.trim();
  if (symbol === "") return null;
  if (symbol.length > CURVE_TOKEN_SYMBOL_MAX_LENGTH) return null;
  if (CONTROL_CHARACTERS.test(symbol)) return null;
  return symbol;
}

/** `symbol()` of the curve token, normalized. Null on any read or normalization failure. */
export async function readCurveTokenSymbol(client: Erc20ReadClient, token: Address): Promise<string | null> {
  try {
    return normalizeCurveTokenSymbol(await client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "symbol" }));
  } catch {
    return null;
  }
}
