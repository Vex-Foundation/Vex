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
 *   - the NATIVE tokenOut leg has TWO independent proofs, tried in this order
 *     (R2 stage F2). Either establishes the amount; neither guesses.
 *
 *     1. CORRELATED (preferred, and the only one that may use a widened
 *        unwrap): exactly ONE `Swapped` emitted BY the verified router, whose
 *        `sender`/`dstReceiver` are our wallet, whose `srcToken` is our input
 *        token and whose `dstToken` is the native sentinel. Its `returnAmount`
 *        is the output, REQUIRING corroboration by exactly one same-value
 *        unwrap of the wrapped native — a `Withdrawal` from ANY source, or a
 *        burn `Transfer(src -> 0x0)`. Corroboration is required because it is
 *        NOT verified from Kyber's source that `Swapped` implies delivery.
 *        Two real receipts forced this rule into existence: the owner's own
 *        Robinhood swap (no `Withdrawal` at all — the WETH clone burns) and a
 *        Base receipt whose `Withdrawal` came from the EXECUTOR, not the
 *        router. The old rule returned `null` for both.
 *     2. ROUTER-BOUND `Withdrawal` (the original): a `Withdrawal(address
 *        indexed src, uint256 wad)` whose `src` IS the verified router (C21:
 *        "WETH events bound to the router/account topic"). RETAINED because it
 *        is unsound only in the false-negative direction — it is the posture
 *        this repository has shipped, and deleting it would stop decoding
 *        receipt shapes that decode correctly today. Its documented residual
 *        risk is unchanged: a multi-hop route where the router unwraps for an
 *        intermediate step.
 *
 *     A leg no proof establishes DECLINES rather than guessing.
 *
 *     `Swapped.spentAmount` is NEVER the executed INPUT: the Vex fee is a
 *     component of the input, so `spentAmount` under-reports what the user
 *     actually paid by exactly that fee. The input leg stays wallet-relative
 *     net delta. Do not re-propose this.
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
  /**
   * The VERIFIED router for this row — the address whose `Swapped` event is the
   * proof of a native output leg. REQUIRED to decode a native tokenOut leg;
   * ignored otherwise.
   *
   * "Verified" means it came from the row's persisted `settlementDecode`
   * provenance or from this venue's own registry keyed by the row's chain id —
   * never from a log, and never from model input.
   */
  readonly routerAddress?: string;
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
    ? decodeNativeOut(input.logs, input)
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

/**
 * THE NATIVE OUTPUT LEG — one rule, correlated and corroborated (R2 stage F2).
 *
 * The previous rule accepted only a canonical `Withdrawal` bound to the ROUTER
 * as `src`. Two REAL receipts on two chains defeat that binding, which is why it
 * is gone rather than merely extended:
 *
 * - Robinhood 4663 (the owner's own swap, the transaction this whole workstream
 *   exists for): no `Withdrawal` at all — the WETH clone BURNS, i.e.
 *   `Transfer(src -> 0x0)`.
 * - Base 8453 (tx 0x70d2…ed65): a canonical `Withdrawal` whose `src` is the
 *   Kyber EXECUTOR, not the router.
 *
 * So the PROOF is the router's own `Swapped` event, fully correlated to this
 * row, and the unwrap is CORROBORATION rather than evidence in itself:
 *
 *   1. exactly ONE `Swapped` emitted BY the verified router;
 *   2. `sender` and `dstReceiver` are our wallet, `srcToken` is our input token,
 *      `dstToken` is the native sentinel;
 *   3. `returnAmount` is the executed output;
 *   4. exactly ONE same-value unwrap of the wrapped native — a `Withdrawal`
 *      from ANY source, or a burn `Transfer(src -> 0x0)`;
 *   5. anything else declines.
 *
 * WHY CORROBORATION IS REQUIRED, not optional: it has NOT been verified from
 * Kyber's contract source that `Swapped` is emitted only after `returnAmount` is
 * actually delivered to `dstReceiver`. Rule 4 is what makes this safe without
 * that proof. Do not relax it to "optional" without obtaining it.
 *
 * Widening the unwrap's source is safe precisely BECAUSE of rule 1: an
 * unrelated contract's incidental unwrap elsewhere in the receipt cannot match
 * both the exact `returnAmount` of a router event naming our wallet AND be the
 * only such unwrap. Ambiguity declines.
 */
function decodeNativeOut(
  logs: readonly SwapSettlementLog[],
  input: DecodeSwapSettlementInput,
): bigint | null {
  const { wrappedNativeAddress } = input;
  if (wrappedNativeAddress === undefined) return null;
  // The handler has always passed the verified router under the older name, so
  // this keeps the happy path working without a venue-handler edit.
  const routerAddress = input.routerAddress ?? input.wrappedNativeWithdrawalSource;
  if (routerAddress === undefined) return null;

  const correlated = decodeCorrelatedNativeOut(logs, input, wrappedNativeAddress, routerAddress);
  if (correlated !== null) return correlated;

  // SECOND, INDEPENDENT PROOF — the original strictly-router-bound `Withdrawal`.
  //
  // Deliberately RETAINED rather than replaced. The correlated rule above exists
  // because router-binding produces FALSE NEGATIVES (it returned `null` for the
  // owner's own swap and for the Base receipt whose executor emitted the
  // unwrap), not because it is unsound: it binds `src` to the verified router,
  // which is the posture this repository has shipped and relied on. Deleting it
  // would stop decoding receipt shapes that decode correctly TODAY — a
  // regression on the money path, dressed as a tightening.
  //
  // The widenings — an unwrap from the EXECUTOR, or a burn instead of a
  // `Withdrawal` — are available ONLY through the correlated rule, which is what
  // keeps them safe. Its documented residual risk is unchanged: a multi-hop
  // route where the router unwraps for an intermediate step.
  const withdrawn = sumBoundWethWithdrawals(logs, wrappedNativeAddress, routerAddress);
  return withdrawn > 0n ? withdrawn : null;
}

/** The correlated `Swapped` + corroborating-unwrap proof. `null` = not established. */
function decodeCorrelatedNativeOut(
  logs: readonly SwapSettlementLog[],
  input: DecodeSwapSettlementInput,
  wrappedNativeAddress: string,
  routerAddress: string,
): bigint | null {
  const swapped = findSoleRouterSwapped(logs, routerAddress);
  if (swapped === null) return null;
  if (!addressesEqual(swapped.sender, input.walletAddress)) return null;
  if (!addressesEqual(swapped.dstReceiver, input.walletAddress)) return null;
  if (!addressesEqual(swapped.dstToken, NATIVE_SENTINEL)) return null;
  // The input leg's own token must match the row's, or this `Swapped` describes
  // a different swap than the one we are decoding.
  if (!input.tokenIn.isNative && !addressesEqual(swapped.srcToken, input.tokenIn.address)) {
    return null;
  }
  if (swapped.returnAmount <= 0n) return null;

  return countMatchingUnwraps(logs, wrappedNativeAddress, swapped.returnAmount) === 1
    ? swapped.returnAmount
    : null;
}

/** Kyber's native pseudo-token address, as it appears in `Swapped.dstToken`. */
const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/**
 * `Swapped(address sender, address srcToken, address dstToken, address
 * dstReceiver, uint256 spentAmount, uint256 returnAmount)` — ALL NON-INDEXED,
 * so the six words live in `data` and topic0 is the only topic.
 */
const KYBER_SWAPPED_TOPIC = "0xd6d4f5681c246c9f42c203e287975af1601f8df8035a9251f79aab5c8f09e2f8";

interface SwappedEvent {
  readonly sender: string;
  readonly srcToken: string;
  readonly dstToken: string;
  readonly dstReceiver: string;
  readonly returnAmount: bigint;
}

/**
 * The ONE `Swapped` this router emitted, or `null` when there is none — or more
 * than one, which is ambiguity and must never be resolved by picking a
 * favourite.
 */
function findSoleRouterSwapped(
  logs: readonly SwapSettlementLog[],
  routerAddress: string,
): SwappedEvent | null {
  let found: SwappedEvent | null = null;
  for (const log of logs) {
    if (!addressesEqual(log.address, routerAddress)) continue;
    if (log.topics[0]?.toLowerCase() !== KYBER_SWAPPED_TOPIC) continue;
    if (log.topics.length !== 1) continue;
    const decoded = decodeSwappedData(log.data);
    if (decoded === null) continue;
    if (found !== null) return null; // two candidates — ambiguous, decline
    found = decoded;
  }
  return found;
}

/** Six ABI words, or `null` for anything that is not exactly that. */
function decodeSwappedData(data: string): SwappedEvent | null {
  if (!/^0x[0-9a-fA-F]{384}$/.test(data)) return null;
  const word = (index: number): string => data.slice(2 + index * 64, 2 + (index + 1) * 64);
  const asAddress = (raw: string): string => `0x${raw.slice(24)}`;
  const returnAmount = parseLogAmount(`0x${word(5)}`);
  if (returnAmount === null) return null;
  return {
    sender: asAddress(word(0)),
    srcToken: asAddress(word(1)),
    dstToken: asAddress(word(2)),
    dstReceiver: asAddress(word(3)),
    returnAmount,
  };
}

/**
 * How many unwraps of the wrapped native carry EXACTLY this value — a canonical
 * `Withdrawal` from any source, or a burn `Transfer(src -> 0x0)`.
 *
 * The caller requires exactly one. Zero means the delivery is uncorroborated;
 * two or more means we cannot tell which unwrap belongs to this leg, and a
 * money decode may not choose.
 */
function countMatchingUnwraps(
  logs: readonly SwapSettlementLog[],
  wrappedNativeAddress: string,
  expected: bigint,
): number {
  let matches = 0;
  for (const log of logs) {
    if (!addressesEqual(log.address, wrappedNativeAddress)) continue;
    const amount = parseLogAmount(log.data);
    if (amount === null || amount !== expected) continue;
    const isWithdrawal = log.topics[0] === WETH_WITHDRAWAL_TOPIC && log.topics.length === 2;
    const isBurn = log.topics[0] === ERC20_TRANSFER_TOPIC
      && log.topics.length === 3
      && log.topics[2] === ZERO_ADDRESS_TOPIC;
    if (isWithdrawal || isBurn) matches++;
  }
  return matches;
}

/** `to = 0x0` in an ERC-20 Transfer's indexed topic — the burn that stands in for a Withdrawal. */
const ZERO_ADDRESS_TOPIC = `0x${"0".repeat(64)}`;
