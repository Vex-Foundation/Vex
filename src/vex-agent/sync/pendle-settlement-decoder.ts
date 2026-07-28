/**
 * Pendle settlement decoding — turns a mined EVM receipt's ERC-20 Transfer
 * logs into the executed amounts of one `agent_activity` row whose
 * `protocol = 'pendle'` (kind `'yield'`).
 *
 * SAME DOCTRINE AS THE KYBERSWAP DECODER (`tools/kyberswap/evm/swap-settlement.ts`):
 * executed amounts come ONLY from NET wallet-delta accounting over the
 * receipt's own logs — `sum(Transfer.to = wallet) - sum(Transfer.from = wallet)`
 * per token — never from a quote, never from the intent. A leg that cannot be
 * proven declines the WHOLE decode (`null`), which the repair sweep treats
 * exactly like "no registered decoder": the row stays `pending`. This module
 * NEVER guesses.
 *
 * It lives in `sync/` (next to the Solana decoders) rather than inside a
 * handler because the Pendle handlers are split per instrument (pt/yt/py/lp/
 * claim) and the decode rule is per ROLE, not per handler — one owner for the
 * whole role table beats five copies. The small ERC-20 net-delta primitive
 * below is deliberately NOT imported from the kyberswap venue module: that
 * copy is owned by that venue (it also carries native/WETH-unwrap rules Pendle
 * has none of), and reaching into another venue's internals for a 20-line
 * primitive is the coupling this repo's boundary rules forbid.
 *
 * PER-ROLE CONFIRMED-LEG PREDICATE (the vocabulary is shared across the whole
 * Pendle activity spine — do not diverge from it here):
 *   - `yield_claim`  — the executed OUTPUT credit only. A claim spends no
 *     principal, so requiring an input leg would leave every claim pending.
 *   - `yield_pt` / `yield_yt` — one-in-one-out: a proven outflow AND a proven
 *     inflow.
 *   - `yield_py` — BOTH Option-C legs on the populated side: a mint (PT+YT
 *     out) must prove both OUT legs, a redeem (PT+YT in) must prove both IN
 *     legs. A row with no second leg populated degrades to one-in-one-out.
 *   - `yield_lp` — dual invariants apply ONLY where the dual columns are
 *     populated; a single-sided LP row is one-in-one-out.
 *   - every other role (including the REUSED `allowance` /`allowance_reset`
 *     rows a Pendle execution writes) moves no decodable value here and is
 *     DECLINED — an approval transfers nothing, so there is no net delta that
 *     could honestly confirm it.
 *
 * ROUTER-FALLBACK REDEEM (`deliveredPath = 'router_fallback_redeemPyToSy'`):
 * that path pays SY, not the market's underlying, so the OUT leg must be
 * matched against the SY contract. When the row's provenance carries that
 * discriminant, this decoder matches the SY address from the same provenance
 * and REFUSES (`null`) if the provenance does not name one — decoding the
 * underlying's (absent) transfer would either decline noisily or, worse, pick
 * up an unrelated token movement.
 */

import { registerSettlementDecoder, type DecodedSettlement, type SettlementDecoderInput } from "./settlement-decoders.js";

export const PENDLE_SETTLEMENT_PROTOCOL = "pendle";

/** `deliveredPath` value the PT-redeem handler records when it exits through the pinned Router instead of the Convert API. */
export const PENDLE_ROUTER_FALLBACK_DELIVERED_PATH = "router_fallback_redeemPyToSy";

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** A mined log's ABI `uint256` word is ALWAYS `0x` + exactly 64 hex chars. Anything else is not a real amount (kyber C40). */
const UINT256_HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface TransferLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

interface PendleSettlementReceipt {
  readonly logs: readonly TransferLog[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTransferLog(value: unknown): value is TransferLog {
  return (
    isRecord(value) &&
    typeof value.address === "string" &&
    Array.isArray(value.topics) &&
    value.topics.every((t) => typeof t === "string") &&
    typeof value.data === "string"
  );
}

function isPendleSettlementReceipt(value: unknown): value is PendleSettlementReceipt {
  return isRecord(value) && Array.isArray(value.logs) && value.logs.every(isTransferLog);
}

function paddedAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** Malformed/attacker-controlled log data is IGNORED (one log), never fatal (kyber C32/C40). */
function parseLogAmount(data: string): bigint | null {
  if (!UINT256_HEX_WORD_RE.test(data)) return null;
  try {
    const value = BigInt(data);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

/** Net ERC-20 wallet delta for `tokenAddress`: positive = net received, negative = net sent. */
function netTransferDelta(logs: readonly TransferLog[], tokenAddress: string, wallet: string): bigint {
  const walletPadded = paddedAddress(wallet);
  const token = tokenAddress.toLowerCase();
  let received = 0n;
  let sent = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3) continue; // ERC-20 Transfer only — an ERC-721 Transfer has 4.
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
function provenOutflow(logs: readonly TransferLog[], token: string | null | undefined, wallet: string): bigint | null {
  if (!token) return null;
  const spent = -netTransferDelta(logs, token, wallet);
  return spent > 0n ? spent : null;
}

/** A RECEIVED leg must be a strict net INFLOW. */
function provenInflow(logs: readonly TransferLog[], token: string | null | undefined, wallet: string): bigint | null {
  if (!token) return null;
  const received = netTransferDelta(logs, token, wallet);
  return received > 0n ? received : null;
}

/**
 * The OUT token this row must be decoded against.
 *
 * Normally the row's own `token_out_address`. On a router-fallback redeem the
 * wallet receives SY, so the SY address from the same provenance wins; a
 * fallback row whose provenance names no SY is refused (`undefined`).
 */
function resolveOutToken(input: SettlementDecoderInput): string | null | undefined {
  const provenance = input.routeProvenance;
  if (!isRecord(provenance)) return input.tokenOutAddress;
  if (provenance.deliveredPath !== PENDLE_ROUTER_FALLBACK_DELIVERED_PATH) return input.tokenOutAddress;
  const sy = readSyAddress(provenance);
  return sy ?? undefined;
}

/** `syAddress` as the handler records it — top level, or nested under the row's `pendle` block. Validated as an EVM address, never trusted raw. */
function readSyAddress(provenance: Record<string, unknown>): string | null {
  const nested = isRecord(provenance.pendle) ? provenance.pendle.syAddress : undefined;
  const candidate = typeof provenance.syAddress === "string" ? provenance.syAddress : nested;
  return typeof candidate === "string" && EVM_ADDRESS_RE.test(candidate) ? candidate : null;
}

/**
 * Decode a Pendle `agent_activity` row's executed amounts from a mined
 * receipt. `null` whenever any required leg cannot be proven.
 */
export function decodePendleSettlement(input: SettlementDecoderInput): DecodedSettlement | null {
  if (!isPendleSettlementReceipt(input.receipt)) return null;
  const logs = input.receipt.logs;
  const wallet = input.walletAddress;
  if (!EVM_ADDRESS_RE.test(wallet)) return null;

  const outToken = resolveOutToken(input);
  if (outToken === undefined) return null; // fallback redeem with no SY named — refuse rather than decode the wrong token.

  const hasIn2 = Boolean(input.tokenIn2Address);
  const hasOut2 = Boolean(input.tokenOut2Address);

  switch (input.eventRole) {
    case "yield_claim": {
      // Credit only. A dual claim (two reward tokens) must prove BOTH credits.
      const out = provenInflow(logs, outToken, wallet);
      if (out === null) return null;
      if (!hasOut2) return { executedAmountOutRaw: out.toString() };
      const out2 = provenInflow(logs, input.tokenOut2Address, wallet);
      if (out2 === null) return null;
      return { executedAmountOutRaw: out.toString(), executedAmountOut2Raw: out2.toString() };
    }
    case "yield_pt":
    case "yield_yt":
      return decodeLegs(logs, wallet, input.tokenInAddress, outToken, null, null);
    case "yield_py":
      // Option C: mint proves both OUT legs, redeem proves both IN legs.
      return decodeLegs(
        logs,
        wallet,
        input.tokenInAddress,
        outToken,
        hasIn2 ? input.tokenIn2Address : null,
        hasOut2 ? input.tokenOut2Address : null,
      );
    case "yield_lp":
      // Dual invariants apply only where the dual columns are populated.
      return decodeLegs(
        logs,
        wallet,
        input.tokenInAddress,
        outToken,
        hasIn2 ? input.tokenIn2Address : null,
        hasOut2 ? input.tokenOut2Address : null,
      );
    default:
      // Includes the reused `allowance` / `allowance_reset` roles: an approval
      // moves no tokens, so no net delta can honestly confirm it here.
      return null;
  }
}

function decodeLegs(
  logs: readonly TransferLog[],
  wallet: string,
  tokenIn: string | null,
  tokenOut: string | null,
  tokenIn2: string | null | undefined,
  tokenOut2: string | null | undefined,
): DecodedSettlement | null {
  const amountIn = provenOutflow(logs, tokenIn, wallet);
  const amountOut = provenInflow(logs, tokenOut, wallet);
  if (amountIn === null || amountOut === null) return null;

  let amountIn2: bigint | null = null;
  if (tokenIn2) {
    amountIn2 = provenOutflow(logs, tokenIn2, wallet);
    if (amountIn2 === null) return null;
  }
  let amountOut2: bigint | null = null;
  if (tokenOut2) {
    amountOut2 = provenInflow(logs, tokenOut2, wallet);
    if (amountOut2 === null) return null;
  }

  return {
    executedAmountInRaw: amountIn.toString(),
    executedAmountOutRaw: amountOut.toString(),
    ...(amountIn2 !== null ? { executedAmountIn2Raw: amountIn2.toString() } : {}),
    ...(amountOut2 !== null ? { executedAmountOut2Raw: amountOut2.toString() } : {}),
  };
}

registerSettlementDecoder(PENDLE_SETTLEMENT_PROTOCOL, decodePendleSettlement);
