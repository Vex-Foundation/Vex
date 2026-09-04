/**
 * What a confirmed curve trade ACTUALLY moved, decoded from the receipt.
 *
 * ## Why the receipt and not the quote
 *
 * The quote is a prediction; the receipt is what happened. On a sell the
 * difference is the whole point: the router's gross output is what the contract
 * bounded, and the wallet's real proceeds are that gross minus a protocol tax
 * and possibly an anti-sniper tax applied INSIDE the transaction. Vex's sell fee
 * is 25 bps of the proven proceeds, so a decoder that guessed would be charging
 * a fee on a number nobody observed.
 *
 * ## The method
 *
 * ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)`
 * logs, filtered to the two token contracts this trade concerns and to the
 * wallet on one side. Sums, not first-match: a curve trade emits several
 * transfers of the same token in one receipt (pair, tax vault, anti-sniper
 * vault), and only the ones that touch the wallet are the wallet's.
 *
 * Proven against the real receipts of the curve trades made on 2026-09-04 -
 * Robinhood BLOOPA buy `0xc39cb2e2...` and sell, Base CULTOS buy
 * `0xd2fb25c2...` and sell - whose logs are committed as fixtures.
 */

import { decodeEventLog, getAddress, type Address, type Hex } from "viem";

import { CURVE_ERC20_ABI } from "./abi.js";

/** The minimum a receipt log must carry for this decoder. */
export interface DecodableLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface CurveSettlement {
  /** Raw units of the token the wallet SPENT, summed over its own transfers. */
  readonly executedInRaw: bigint;
  /** Raw units of the token the wallet RECEIVED. */
  readonly executedOutRaw: bigint;
  /** True when at least one transfer on each side was found. */
  readonly decoded: boolean;
  /**
   * Why the decode is incomplete, when it is. Bounded and log-safe; never
   * provider text.
   */
  readonly undecodedReason?: "no_wallet_inflow" | "no_wallet_outflow" | "no_transfers";
}

/**
 * Decode one curve trade's settlement.
 *
 * `spendToken` is VIRTUAL on a buy and the agent token on a sell;
 * `receiveToken` is the reverse. Both are compared case-insensitively, because
 * a receipt spells addresses lowercase and the deployment table spells them
 * checksummed - refusing on that difference would report a settled trade as
 * undecodable.
 */
export function decodeCurveSettlement(input: {
  readonly logs: readonly DecodableLog[];
  readonly wallet: Address;
  readonly spendToken: Address;
  readonly receiveToken: Address;
}): CurveSettlement {
  const wallet = getAddress(input.wallet).toLowerCase();
  const spendToken = getAddress(input.spendToken).toLowerCase();
  const receiveToken = getAddress(input.receiveToken).toLowerCase();

  let executedInRaw = 0n;
  let executedOutRaw = 0n;
  let sawTransfer = false;

  for (const log of input.logs) {
    const token = log.address.toLowerCase();
    if (token !== spendToken && token !== receiveToken) continue;
    const transfer = decodeTransfer(log);
    if (transfer === null) continue;
    sawTransfer = true;
    if (token === spendToken && transfer.from === wallet) executedInRaw += transfer.value;
    if (token === receiveToken && transfer.to === wallet) executedOutRaw += transfer.value;
  }

  const undecodedReason = !sawTransfer
    ? ("no_transfers" as const)
    : executedOutRaw === 0n
      ? ("no_wallet_inflow" as const)
      : executedInRaw === 0n
        ? ("no_wallet_outflow" as const)
        : undefined;

  return {
    executedInRaw,
    executedOutRaw,
    decoded: undecodedReason === undefined,
    ...(undecodedReason === undefined ? {} : { undecodedReason }),
  };
}

function decodeTransfer(
  log: DecodableLog,
): { readonly from: string; readonly to: string; readonly value: bigint } | null {
  try {
    const decoded = decodeEventLog({
      abi: CURVE_ERC20_ABI,
      eventName: "Transfer",
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data as Hex,
    });
    const args = decoded.args as unknown as { from: Address; to: Address; value: bigint };
    return { from: args.from.toLowerCase(), to: args.to.toLowerCase(), value: args.value };
  } catch {
    // A non-Transfer log from one of the two token contracts (Approval, or a
    // token-specific event). Not an error: it simply carries no settlement.
    return null;
  }
}
