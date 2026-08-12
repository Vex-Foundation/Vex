/**
 * Trench Express curve settlement decoder (pure — receipt logs → executed truth).
 *
 * Honesty-first (rule 90): a decoder that cannot PROVE what happened declines
 * (returns a null amount) rather than guessing, so an undecodable-but-confirmed
 * trade leaves the amount pending instead of asserting a fabricated number.
 *
 * BUY: the wallet's received tokens are read from the ERC-20 `Transfer(to=wallet)`
 * log on the token contract — the ground truth of what was acquired — and a
 * `Bought` event (a == wallet) must be present as proof this was a curve buy.
 *
 * SELL: the tokens spent are read from the ERC-20 `Transfer(from=wallet)` log.
 * The ETH received is decoded from the `Sold` event ONLY when its token-leg
 * argument equals THAT summed receipt transfer, bounded above by the amount the
 * plan asked to sell — that cross-check is the proof that the event's positional
 * arguments mean what we think; without it the ETH amount is declined (the
 * `Sold` argument names are `a/b/v1/v2/v3` in the verified ABI, so the ETH leg is
 * trusted only after the token leg proves the mapping against the chain).
 */

import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { TRENCH_DIAMOND_ABI } from "../abi.js";

export interface DecodedLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

const ERC20_TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** Sum of ERC-20 `Transfer.value` on `token` matching the from/to predicate. */
function sumTransfers(
  logs: readonly DecodedLog[],
  token: Address,
  predicate: (from: Address, to: Address) => boolean,
): bigint | null {
  let total: bigint | null = null;
  for (const log of logs) {
    if (!sameAddress(log.address, token)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: ERC20_TRANSFER_EVENT_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    const { from, to, value } = decoded.args;
    if (!predicate(getAddress(from), getAddress(to))) continue;
    total = (total ?? 0n) + value;
  }
  return total;
}

/** Decode a `Bought`/`Sold` Diamond event whose buyer/seller (`a`) is the wallet. */
function findCurveEvent(
  logs: readonly DecodedLog[],
  diamond: Address,
  wallet: Address,
  eventName: "Bought" | "Sold",
): { v1: bigint; v2: bigint } | null {
  for (const log of logs) {
    if (!sameAddress(log.address, diamond)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: TRENCH_DIAMOND_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== eventName) continue;
    const args = decoded.args as { a: string; b: string; v1: bigint; v2: bigint };
    if (!sameAddress(args.a, wallet)) continue;
    return { v1: args.v1, v2: args.v2 };
  }
  return null;
}

/**
 * Decode a confirmed curve BUY. Returns the tokens the wallet received (from the
 * ERC-20 Transfer to the wallet), or null when it cannot be proven (no Bought
 * proof, or no matching Transfer).
 */
export function decodeCurveBuy(input: {
  readonly logs: readonly DecodedLog[];
  readonly diamond: Address;
  readonly wallet: Address;
  readonly token: Address;
}): { readonly tokensOutRaw: bigint } | null {
  const bought = findCurveEvent(input.logs, input.diamond, input.wallet, "Bought");
  if (!bought) return null;
  const received = sumTransfers(input.logs, input.token, (_from, to) => sameAddress(to, input.wallet));
  if (received === null || received <= 0n) return null;
  return { tokensOutRaw: received };
}

/**
 * Decode a confirmed curve SELL. Returns the tokens spent (proven from the
 * Transfer out of the wallet) and the ETH received — the latter ONLY when the
 * `Sold` event's token-leg argument (`v2`) equals that summed receipt transfer
 * and the transfer is within `amountInRaw`, which proves the event's positional
 * mapping; otherwise `ethOutRaw` is null (declined).
 */
export function decodeCurveSell(input: {
  readonly logs: readonly DecodedLog[];
  readonly diamond: Address;
  readonly wallet: Address;
  readonly token: Address;
  readonly amountInRaw: bigint;
}): { readonly tokensInRaw: bigint | null; readonly ethOutRaw: bigint | null } | null {
  const sold = findCurveEvent(input.logs, input.diamond, input.wallet, "Sold");
  if (!sold) return null;
  const spent = sumTransfers(input.logs, input.token, (from) => sameAddress(from, input.wallet));
  // The ETH leg (`v1`) is trusted only after the token leg (`v2`) proves the
  // positional mapping against WHAT THE RECEIPT SHOWS LEAVING THE WALLET, with
  // the planned amount as an absolute upper bound.
  //
  // Comparing `v2` to the PLANNED amount instead was the defect: the plan is
  // what we asked for, so a receipt whose actual token leg differs (a partial
  // fill, a fee-on-transfer token) would have had its ETH proceeds accepted on
  // the strength of a match against a number the chain never confirmed - and a
  // receipt that agrees with itself but not with the plan would be refused even
  // though it proves the mapping.
  const ethOutRaw = spent !== null && spent > 0n && sold.v2 === spent && spent <= input.amountInRaw
    ? sold.v1
    : null;
  return { tokensInRaw: spent, ethOutRaw };
}
