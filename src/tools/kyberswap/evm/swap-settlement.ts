/**
 * KyberSwap swap settlement decoding — turns a mined receipt's logs into the
 * EXECUTED in/out amounts (plan §4.1: "executed amounts come ONLY from
 * receipt Transfer-delta decoding; quotes never masquerade as settlements").
 *
 * NET wallet-delta accounting, keyed on the signer's OWN address (the unified
 * contract dropped `recipient` — the wallet is always both signer and
 * recipient, per plan §11.1). "Net" (FIX2-W2a / Codex final-review finding 6,
 * C21) rather than one-directional: an ERC-20 leg's true executed amount is
 * `sum(Transfer.to = wallet) - sum(Transfer.from = wallet)` for the RECEIVED
 * leg (net inflow) and the mirror for the SPENT leg (net outflow) — a
 * one-directional sum can overcount when the SAME token also has an
 * incidental outbound/inbound leg in the same receipt (e.g. a refund, a
 * multi-hop pass-through, or dust return).
 *
 *   - the NATIVE tokenIn leg's executed amount is the SIGNED TRANSACTION's
 *     own declared value (`transactionValue`), NEVER the quote/build's
 *     requested `amountIn` — Kyber is exact-input, so a mined SUCCESS
 *     receipt proves the full signed value left the wallet (this is a
 *     certainty from the transaction itself, not a decode — no log exists
 *     for a plain native transfer). The CALLER must pass the actual signed
 *     value, not a re-derived amount.
 *   - the NATIVE tokenOut leg is decoded from the chain's wrapped-native
 *     ERC-20 contract's `Withdrawal(address indexed src, uint256 wad)`
 *     event, bound to the KNOWN router address as `src` (C21: "WETH events
 *     bound to the router/account topic") — the router unwraps WETH it is
 *     holding before forwarding native to the recipient, so `src` is the
 *     router, never an unrelated contract's incidental unwrap elsewhere in
 *     the same receipt (e.g. another pool visited mid-route). This is a
 *     best-effort heuristic (documented residual risk — see the module's
 *     consumer for the crash-recovery caveat): a missing/unbound Withdrawal
 *     event means the decoder DECLINES rather than guesses.
 *
 * Returns `null` when either leg cannot be confidently decoded — the caller
 * must never confirm a swap-role `agent_activity` event without both amounts.
 *
 * A single log with malformed/empty `data` (Codex final-review round 2,
 * finding 4 / C32 — e.g. a malicious token emitting a Transfer log that
 * matches the topic/topic-count shape but carries garbage `data`) is IGNORED,
 * not fatal: decoding continues over the remaining logs. This function never
 * throws on attacker-controlled log content — a mined receipt that already
 * confirmed on-chain must never lose its result to a decode-time exception.
 *
 * A log's `data` must be an EXACT 32-byte ABI `uint256` word — `0x` + exactly
 * 64 hex characters (round 3, finding 5 / C40): short (`0x1`), overlong, or
 * non-hex (plain decimal) data is rejected as malformed, never accepted as a
 * real amount. Topic cardinality is already exact (`!== 3` / `!== 2`, never
 * `< 3` / `< 2`), so an extra-topic log was already rejected before C40.
 */

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WETH_WITHDRAWAL_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

export interface SwapSettlementLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface SwapSettlementLeg {
  readonly isNative: boolean;
  /** ERC-20 contract address; ignored (but present) for a native leg. */
  readonly address: string;
}

export interface DecodeSwapSettlementInput {
  readonly logs: readonly SwapSettlementLog[];
  readonly walletAddress: string;
  readonly tokenIn: SwapSettlementLeg;
  readonly tokenOut: SwapSettlementLeg;
  /**
   * The SIGNED transaction's declared native value (raw wei, as a decimal
   * string) — REQUIRED to decode a native tokenIn leg. This MUST be the
   * actual value the caller signed and broadcast (e.g. Kyber's
   * `buildRoute` response's `transactionValue`), NEVER a locally
   * re-derived/requested amount (C21). Ignored when tokenIn is not native.
   */
  readonly nativeAmountInRaw?: string;
  /**
   * The chain's wrapped-native ERC-20 contract address — REQUIRED to decode a
   * native tokenOut leg's `Withdrawal` event. Ignored when tokenOut is not
   * native.
   */
  readonly wrappedNativeAddress?: string;
  /**
   * The expected `src` (indexed) address on a native tokenOut leg's Withdrawal
   * event — the router that unwraps WETH before forwarding native to the
   * recipient (C21: bind to the router/account topic, never sum every
   * Withdrawal on the contract). REQUIRED to decode a native tokenOut leg;
   * ignored otherwise.
   */
  readonly wrappedNativeWithdrawalSource?: string;
}

export interface DecodedSwapAmounts {
  readonly amountInRaw: string;
  readonly amountOutRaw: string;
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function paddedAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/**
 * A mined log's ABI-encoded `uint256` data word is ALWAYS exactly 32 bytes —
 * `0x` followed by exactly 64 hex characters, left-zero-padded. Anything
 * shorter (`0x1`, `0x01`), longer (overlong), or non-hex (plain decimal
 * `"123"`) is not a genuine EVM log word and must be rejected outright
 * (Codex final-review round 3, finding 5 / C40: a permissive `BigInt(...)`
 * parse previously accepted all of these as a real settlement amount).
 */
const UINT256_HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Parse a log's `data` field as an unsigned amount. Malformed/empty data
 * (Codex final-review round 2, finding 4 / C32: a malicious token can emit a
 * Transfer log matching the topic/topic-count shape with garbage `data`; C40:
 * or a shape that BigInt would happily parse but is not a real 32-byte
 * uint256 word) returns `null` so the CALLER can ignore that single log and
 * keep summing the rest, rather than the whole decode throwing and losing a
 * receipt that already confirmed on-chain.
 */
function parseLogAmount(data: string): bigint | null {
  if (!UINT256_HEX_WORD_RE.test(data)) return null;
  try {
    const value = BigInt(data);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * Net ERC-20 wallet delta for `tokenAddress`: `sum(to=wallet) - sum(from=wallet)`.
 * Positive = net received; negative = net sent. Only well-formed ERC-20
 * Transfer logs (topic0 match, exactly 3 topics — no indexed value, i.e. not
 * an ERC-721 Transfer) are counted.
 */
function netTransferDelta(
  logs: readonly SwapSettlementLog[],
  tokenAddress: string,
  wallet: string,
): bigint {
  const walletPadded = paddedAddress(wallet);
  let received = 0n;
  let sent = 0n;
  for (const log of logs) {
    if (!addressesEqual(log.address, tokenAddress)) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3) continue; // ERC-20 Transfer: topic0 + from + to (no indexed value)
    const amount = parseLogAmount(log.data);
    if (amount === null) continue; // malformed/empty data — ignore this log, keep summing the rest (C32)
    const from = log.topics[1]?.toLowerCase();
    const to = log.topics[2]?.toLowerCase();
    if (to === walletPadded) received += amount;
    if (from === walletPadded) sent += amount;
  }
  return received - sent;
}

/**
 * Sum of WETH `Withdrawal(address indexed src, uint256 wad)` events on
 * `wrappedNativeAddress` whose indexed `src` equals `expectedSource` (the
 * router) — never an unbound sum across every Withdrawal in the receipt.
 */
function sumBoundWethWithdrawals(
  logs: readonly SwapSettlementLog[],
  wrappedNativeAddress: string,
  expectedSource: string,
): bigint {
  const sourcePadded = paddedAddress(expectedSource);
  let total = 0n;
  for (const log of logs) {
    if (!addressesEqual(log.address, wrappedNativeAddress)) continue;
    if (log.topics[0] !== WETH_WITHDRAWAL_TOPIC) continue;
    if (log.topics.length !== 2) continue; // Withdrawal: topic0 + indexed src
    if (log.topics[1]?.toLowerCase() !== sourcePadded) continue;
    const amount = parseLogAmount(log.data);
    if (amount === null) continue; // malformed/empty data — ignore this log, keep summing the rest (C32)
    total += amount;
  }
  return total;
}

/**
 * Decode the executed in/out amounts from a mined swap receipt's logs.
 * Returns `null` when either leg cannot be confidently determined — the
 * caller must treat this exactly like "no decoder" (leave the row pending).
 */
export function decodeKyberSwapSettlement(input: DecodeSwapSettlementInput): DecodedSwapAmounts | null {
  const amountIn = input.tokenIn.isNative
    ? decodeNativeIn(input.nativeAmountInRaw)
    : negateToPositive(netTransferDelta(input.logs, input.tokenIn.address, input.walletAddress));

  const amountOut = input.tokenOut.isNative
    ? decodeNativeOut(input.logs, input.wrappedNativeAddress, input.wrappedNativeWithdrawalSource)
    : positiveOnly(netTransferDelta(input.logs, input.tokenOut.address, input.walletAddress));

  if (amountIn === null || amountOut === null) return null;

  return { amountInRaw: amountIn.toString(), amountOutRaw: amountOut.toString() };
}

/** The SPENT leg's net delta is negative (net outflow) — the executed spend is its magnitude. */
function negateToPositive(netDelta: bigint): bigint | null {
  const spent = -netDelta;
  return spent > 0n ? spent : null;
}

/** The RECEIVED leg's net delta must be positive (net inflow) to be a confident decode. */
function positiveOnly(netDelta: bigint): bigint | null {
  return netDelta > 0n ? netDelta : null;
}

function decodeNativeIn(nativeAmountInRaw: string | undefined): bigint | null {
  if (nativeAmountInRaw === undefined) return null;
  try {
    const value = BigInt(nativeAmountInRaw);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

function decodeNativeOut(
  logs: readonly SwapSettlementLog[],
  wrappedNativeAddress: string | undefined,
  expectedSource: string | undefined,
): bigint | null {
  if (wrappedNativeAddress === undefined || expectedSource === undefined) return null;
  const withdrawn = sumBoundWethWithdrawals(logs, wrappedNativeAddress, expectedSource);
  return withdrawn > 0n ? withdrawn : null;
}
