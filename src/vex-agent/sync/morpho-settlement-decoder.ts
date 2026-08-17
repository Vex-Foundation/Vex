/**
 * Morpho settlement decoding - turns a mined EVM receipt's ERC-20 Transfer logs
 * into the executed amounts of one `agent_activity` row whose
 * `protocol = 'morpho'` (kind `'lend'`).
 *
 * SAME DOCTRINE AS THE PENDLE AND KYBERSWAP DECODERS: executed amounts come ONLY
 * from NET wallet-delta accounting over the receipt's OWN logs -
 * `sum(Transfer.to = wallet) - sum(Transfer.from = wallet)` per token - never
 * from the quote and never from the intent. A leg that cannot be proven declines
 * the WHOLE decode (`null`) and the caller records no amounts. This module NEVER
 * guesses.
 *
 * ── WHY A VAULT SHARE MINT AND BURN ARE READABLE THIS WAY ───────────────────
 *
 * An ERC-4626 vault share is an ordinary ERC-20 and its mint and burn are
 * ordinary `Transfer` events with the zero address on one side. The wallet is on
 * the OTHER side of both, so the same net-delta rule that reads a swap reads a
 * share mint without needing to know anything about minting: a deposit is a net
 * OUTFLOW of the asset and a net INFLOW of the share token, and a withdrawal is
 * the reverse. Nothing here parses a vault-specific event, which is what keeps
 * it working across both vault generations and across the two different
 * transaction SHAPES the two directions use (a Bundler3 multicall for a deposit,
 * a direct vault call for a withdrawal).
 *
 * The GeneralAdapter1 hop is invisible to this rule for the same reason: the
 * asset may travel wallet -> adapter -> vault inside one transaction, but the
 * wallet's own net delta over the whole receipt is still exactly what left it.
 *
 * ── BOUNDED BY THE INTENT, IN BOTH DIRECTIONS ───────────────────────────────
 *
 * Every proven leg is held against the amount the row itself recorded before
 * broadcasting. Both operations are EXACT on their asset side - a deposit spends
 * the amount asked for, a withdrawal delivers the amount asked for - so a proven
 * asset leg that EXCEEDS the intent is not a settlement, it is evidence the
 * decode read something that was not this operation, and it declines. The bound
 * is a hard inequality against the row's own number, never a percentage and
 * never a tolerance that could grow with size (rules/90).
 *
 * The SHARE leg carries no such bound and deliberately so: the share count is
 * the market-dependent side of the trade and the whole reason the amounts are
 * decoded rather than echoed. It must be a strict, proven movement in the right
 * direction and nothing more. Whether it matches what was quoted is a separate
 * question, answered by `@tools/morpho/mutations.js`'s absolute-tolerance
 * comparison and reported to the user; it is not a condition of recording the
 * truth.
 *
 * ── WHAT DECLINES, AND WHY IT IS NAMED ──────────────────────────────────────
 *
 * `allowance` and `allowance_reset` rows decline: an approval transfers nothing,
 * so no net delta could honestly confirm one. Every role this venue does not
 * write declines too, rather than falling through to a generic reading. A
 * decline leaves the row `pending` with its amounts unknown, which is the honest
 * state - rules/90: a decoder that cannot prove what happened must decline and
 * leave the row pending.
 *
 * CONSUMERS: the Morpho broadcast path
 * (`tools/protocols/morpho/handlers/signed-broadcast.ts`), which decodes its own
 * receipt immediately after mining, and the pending-fallback lane through
 * `sync/executed-amount-fallback/venue-dispatch.ts`. One rule, two callers, no
 * second copy.
 */

export interface MorphoDecodedSettlement {
  readonly executedAmountInRaw: string;
  readonly executedAmountOutRaw: string;
}

export interface MorphoSettlementLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface MorphoSettlementDecoderInput {
  readonly logs: readonly MorphoSettlementLog[];
  readonly walletAddress: string;
  /**
   * The row's `event_role` VERBATIM. Deliberately a plain string, not the
   * `AgentActivityEventRole` union: this decoder switches on the roles ITS venue
   * writes and DECLINES a role it does not own rather than guessing.
   */
  readonly eventRole: string;
  /** The token that LEFT the wallet: the asset on a deposit, the shares on a withdrawal. */
  readonly tokenInAddress: string | null;
  /** The token that ARRIVED: the shares on a deposit, the asset on a withdrawal. */
  readonly tokenOutAddress: string | null;
  /**
   * The row's own `amount_in_raw` - what the handler RECORDED before
   * broadcasting. The BOUND on a deposit's asset leg, never its answer.
   */
  readonly amountInRaw: string | null;
  /** The row's own `amount_out_raw` - the BOUND on a withdrawal's asset leg. */
  readonly amountOutRaw: string | null;
}

export const MORPHO_SETTLEMENT_PROTOCOL = "morpho";

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** A mined log's ABI `uint256` word is ALWAYS `0x` + exactly 64 hex chars. Anything else is not a real amount. */
const UINT256_HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function paddedAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** Malformed or attacker-controlled log data is IGNORED (one log), never fatal. */
function parseLogAmount(data: string): bigint | null {
  if (!UINT256_HEX_WORD_RE.test(data)) return null;
  try {
    const value = BigInt(data);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

/** Net ERC-20 wallet delta for one token: positive = net received, negative = net sent. */
function netTransferDelta(
  logs: readonly MorphoSettlementLog[],
  tokenAddress: string,
  wallet: string,
): bigint {
  const walletPadded = paddedAddress(wallet);
  const token = tokenAddress.toLowerCase();
  let received = 0n;
  let sent = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    // ERC-20 Transfer only - an ERC-721 Transfer has four topics and its third
    // word is a token id, not an amount.
    if (log.topics.length !== 3) continue;
    const amount = parseLogAmount(log.data);
    if (amount === null) continue;
    const from = log.topics[1]?.toLowerCase();
    const to = log.topics[2]?.toLowerCase();
    if (to === walletPadded) received += amount;
    if (from === walletPadded) sent += amount;
  }
  return received - sent;
}

/** A SPENT leg must be a strict net OUTFLOW; its executed amount is the magnitude. */
function provenOutflow(
  logs: readonly MorphoSettlementLog[],
  token: string | null,
  wallet: string,
): bigint | null {
  if (token === null || !EVM_ADDRESS_RE.test(token)) return null;
  const spent = -netTransferDelta(logs, token, wallet);
  return spent > 0n ? spent : null;
}

/** A RECEIVED leg must be a strict net INFLOW. */
function provenInflow(
  logs: readonly MorphoSettlementLog[],
  token: string | null,
  wallet: string,
): bigint | null {
  if (token === null || !EVM_ADDRESS_RE.test(token)) return null;
  const received = netTransferDelta(logs, token, wallet);
  return received > 0n ? received : null;
}

/** The row's own recorded amount as a positive bound, or `null` when it has none. */
function bound(raw: string | null): bigint | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const value = BigInt(raw);
  return value > 0n ? value : null;
}

/**
 * Decode a Morpho `agent_activity` row's executed amounts from a mined receipt.
 * `null` whenever any required leg cannot be proven, or whenever a proven asset
 * leg falls outside the intent that authorised it.
 */
export function decodeMorphoSettlement(
  input: MorphoSettlementDecoderInput,
): MorphoDecodedSettlement | null {
  const wallet = input.walletAddress;
  if (!EVM_ADDRESS_RE.test(wallet)) return null;

  const { logs } = input;

  if (input.eventRole === "lend_deposit") {
    // Asset out, shares in. The ASSET leg is the bounded one: a deposit spends
    // exactly what was asked for, so more than the intent is not this operation.
    const assetBound = bound(input.amountInRaw);
    if (assetBound === null) return null;
    const assetOut = provenOutflow(logs, input.tokenInAddress, wallet);
    if (assetOut === null || assetOut > assetBound) return null;
    const sharesIn = provenInflow(logs, input.tokenOutAddress, wallet);
    if (sharesIn === null) return null;
    return { executedAmountInRaw: assetOut.toString(), executedAmountOutRaw: sharesIn.toString() };
  }

  if (input.eventRole === "lend_withdraw") {
    // Shares out, asset in. Here the ASSET is the OUT leg and the bounded one:
    // a withdrawal delivers exactly the assets asked for.
    const assetBound = bound(input.amountOutRaw);
    if (assetBound === null) return null;
    const assetIn = provenInflow(logs, input.tokenOutAddress, wallet);
    if (assetIn === null || assetIn > assetBound) return null;
    const sharesOut = provenOutflow(logs, input.tokenInAddress, wallet);
    if (sharesOut === null) return null;
    return { executedAmountInRaw: sharesOut.toString(), executedAmountOutRaw: assetIn.toString() };
  }

  // Includes `allowance` / `allowance_reset`: an approval moves no tokens, so no
  // net delta could honestly confirm it here.
  return null;
}
