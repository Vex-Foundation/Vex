/**
 * Uniswap settlement receipt decoding (plan §4.2/§8.2) — the executed-truth
 * counterpart to `quote.ts`'s pre-trade estimate.
 *
 * Authority: NET ERC-20 `Transfer` delta for the wallet address, summed over
 * every log for a given token contract in the receipt. This is correct even
 * for a fee-on-transfer token — a quote's `amountOut` can overstate what a FoT
 * token actually delivers, but the wallet's own balance delta cannot lie about
 * what it received or spent. A native leg has no ERC-20 Transfer log at all,
 * so it is read from the WETH `Deposit`/`Withdrawal` event the router itself
 * emits when wrapping/unwrapping (see `execute.ts`'s native-leg routing):
 *   - native INPUT  → the router's `deposit{value: amountIn}()` emits
 *     `Deposit(router, wad)`; `wad` IS the full amount wrapped (native tokens
 *     have no transfer-fee concept, so requested == executed by construction).
 *   - native OUTPUT → the router's `withdraw(amountOut)` emits
 *     `Withdrawal(router, wad)` BEFORE the router's own low-level
 *     `call{value: wad}("")` forwards the ETH — `wad` is exactly what left the
 *     router for the user (a plain value-call cannot partially deliver).
 * Both events fire on the WETH CONTRACT's own log stream (`log.address ==
 * deployment.weth`) AND are bound to the indexed `dst`/`src` account topic
 * matching one of the chain's REGISTERED routers (C21, Codex final-review
 * round 1 finding 6) — an unrelated Deposit/Withdrawal elsewhere in the same
 * receipt (e.g. a batched/multicall transaction) can never be mistaken for
 * this swap's native leg. The router set is resolved from the SAME verified
 * deployment registry as the WETH address.
 *
 * Pool `Swap` events (V2 pair / V3 pool) are recognized ONLY so a caller can
 * tell "this receipt really touched a Uniswap pool" — their amount fields are
 * NEVER read as settlement truth (a Swap event can under-report a
 * fee-on-transfer leg the same way a quote can).
 *
 * Every event topic0 below was independently verified by computing
 * `keccak256` of the canonical event signature locally (matches the values
 * used throughout `execute.ts`'s ABI-driven call sites) rather than trusted
 * from memory.
 */

import { getAddress, hexToBigInt, type Address, type Hex } from "viem";

import { getUniswapDeployment } from "./deployments.js";

/** `Transfer(address,address,uint256)` — shared by every ERC-20 (and WETH itself). */
export const TRANSFER_TOPIC0: Hex =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** `Deposit(address,uint256)` — WETH wrap (native input leg). */
export const WETH_DEPOSIT_TOPIC0: Hex =
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
/** `Withdrawal(address,uint256)` — WETH unwrap (native output leg). */
export const WETH_WITHDRAWAL_TOPIC0: Hex =
  "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
/** `Swap(address,uint256,uint256,uint256,uint256,address)` — Uniswap V2 pair. Provenance only. */
export const V2_POOL_SWAP_TOPIC0: Hex =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
/** `Swap(address,address,int256,int256,uint160,uint128,int24)` — Uniswap V3 pool. Provenance only. */
export const V3_POOL_SWAP_TOPIC0: Hex =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/** Minimal receipt-log shape this module needs — matches viem's `TransactionReceipt['logs'][number]` structurally. */
export interface UniswapDecodableLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** Minimal receipt shape this module needs — matches viem's `TransactionReceipt` structurally. */
export interface UniswapDecodableReceipt {
  readonly logs: readonly UniswapDecodableLog[];
}

export interface DecodeUniswapLegsInput {
  readonly receipt: UniswapDecodableReceipt;
  readonly chainId: number;
  readonly walletAddress: string;
  /** Non-native tokenIn contract address, or `null`/`undefined` for a native input leg. */
  readonly tokenInAddress?: string | null;
  /** Non-native tokenOut contract address, or `null`/`undefined` for a native output leg. */
  readonly tokenOutAddress?: string | null;
}

export interface DecodedUniswapLegs {
  readonly executedAmountInRaw?: bigint;
  readonly executedAmountOutRaw?: bigint;
}

function topicToAddress(topic: string): Address | undefined {
  if (topic.length < 42) return undefined;
  try {
    return getAddress(`0x${topic.slice(-40)}`);
  } catch {
    return undefined;
  }
}

/**
 * A `uint256` ABI-encoded event data field is ALWAYS exactly 32 bytes (64 hex
 * characters after the `0x` prefix) — that is what a fixed-size EVM word IS.
 * A short form (`0x1`), a decimal string with no `0x` prefix, or an overlong
 * value are never a genuine, standards-conforming ERC-20 `Transfer`/WETH
 * `Deposit`/`Withdrawal` log (C40, Codex final-review round 3 finding 5) —
 * accepting them leniently is exactly the kind of malformed-log spoofing a
 * crafted/non-standard contract (or a compromised RPC) could exploit to make
 * an unrelated event masquerade as this swap's settlement. Rejected outright,
 * never leniently parsed.
 */
const UINT256_DATA_RE = /^0x[0-9a-fA-F]{64}$/;

function parseUint256Data(data: string): bigint | undefined {
  if (!UINT256_DATA_RE.test(data)) return undefined;
  try {
    return hexToBigInt(data as Hex);
  } catch {
    return undefined;
  }
}

/**
 * Net `Transfer` delta for `wallet` over one ERC-20 contract's logs in this
 * receipt: sum(received) - sum(sent). Correct for fee-on-transfer tokens on
 * EITHER leg — the wallet's own balance movement is read directly from the
 * logs the token contract itself emitted, never from a requested/quoted
 * amount.
 */
function netTransferDelta(
  logs: readonly UniswapDecodableLog[],
  token: Address,
  wallet: Address,
): bigint {
  const tokenLower = token.toLowerCase();
  const walletLower = wallet.toLowerCase();
  let delta = 0n;
  for (const log of logs) {
    if (log.topics[0] !== TRANSFER_TOPIC0) continue;
    if (log.address.toLowerCase() !== tokenLower) continue;
    // C40: `Transfer(address indexed,address indexed,uint256)` has EXACTLY 3
    // topics (topic0 + 2 indexed params) — an extra topic is never a genuine
    // Transfer log, so `< 3` (accepting extras) is too lenient.
    if (log.topics.length !== 3) continue;
    const from = topicToAddress(log.topics[1]!);
    const to = topicToAddress(log.topics[2]!);
    if (!from || !to) continue;
    const amount = parseUint256Data(log.data);
    if (amount === undefined) continue;
    if (to.toLowerCase() === walletLower) delta += amount;
    if (from.toLowerCase() === walletLower) delta -= amount;
  }
  return delta;
}

/**
 * Sum of a WETH wrap/unwrap event's `wad` amount across every matching log on
 * the WETH contract WHOSE INDEXED account topic is one of `routers` (C21,
 * Codex final-review round 1 finding 6): binding to the router that actually
 * calls `deposit()`/`withdraw()` in OUR OWN swap flow means an unrelated
 * Deposit/Withdrawal event elsewhere in the same receipt (a batched/
 * multicall transaction touching WETH for a different reason) can never be
 * mistaken for this swap's native leg.
 */
function sumWethEvent(
  logs: readonly UniswapDecodableLog[],
  weth: Address,
  topic0: Hex,
  routers: ReadonlySet<string>,
): bigint | undefined {
  const wethLower = weth.toLowerCase();
  let total = 0n;
  let found = false;
  for (const log of logs) {
    if (log.topics[0] !== topic0) continue;
    if (log.address.toLowerCase() !== wethLower) continue;
    // C40: `Deposit(address indexed,uint256)`/`Withdrawal(address indexed,uint256)`
    // have EXACTLY 2 topics (topic0 + 1 indexed param) — an extra topic is
    // never a genuine WETH event, so `< 2` (accepting extras) is too lenient.
    if (log.topics.length !== 2) continue;
    const account = topicToAddress(log.topics[1]!);
    if (!account || !routers.has(account.toLowerCase())) continue;
    const amount = parseUint256Data(log.data);
    if (amount === undefined) continue;
    total += amount;
    found = true;
  }
  return found ? total : undefined;
}

/**
 * Decode the executed in/out raw amounts for a Uniswap swap from its mined
 * receipt. Returns `undefined` for a leg this receipt does not evidence
 * (e.g. no matching Transfer log at all) — callers must treat a missing leg
 * as "cannot confirm yet", never silently zero.
 */
/** The chain's registered router addresses — the only accounts that legitimately wrap/unwrap WETH in our own swap flow. */
function routerAddressesFor(deployment: ReturnType<typeof getUniswapDeployment>): ReadonlySet<string> {
  const routers = new Set<string>();
  if (deployment?.v2) routers.add(deployment.v2.router02.toLowerCase());
  if (deployment?.v3) routers.add(deployment.v3.swapRouter02.toLowerCase());
  return routers;
}

export function decodeUniswapExecutedLegs(input: DecodeUniswapLegsInput): DecodedUniswapLegs {
  const deployment = getUniswapDeployment(input.chainId);
  const wallet = getAddress(input.walletAddress);
  const logs = input.receipt.logs;
  const routers = routerAddressesFor(deployment);

  const executedAmountInRaw = input.tokenInAddress
    ? nonZeroOrUndefined(netTransferDelta(logs, getAddress(input.tokenInAddress), wallet) * -1n)
    : deployment && routers.size > 0
      ? sumWethEvent(logs, getAddress(deployment.weth), WETH_DEPOSIT_TOPIC0, routers)
      : undefined;

  const executedAmountOutRaw = input.tokenOutAddress
    ? nonZeroOrUndefined(netTransferDelta(logs, getAddress(input.tokenOutAddress), wallet))
    : deployment && routers.size > 0
      ? sumWethEvent(logs, getAddress(deployment.weth), WETH_WITHDRAWAL_TOPIC0, routers)
      : undefined;

  return {
    ...(executedAmountInRaw !== undefined ? { executedAmountInRaw } : {}),
    ...(executedAmountOutRaw !== undefined ? { executedAmountOutRaw } : {}),
  };
}

/** A net delta of exactly zero (or negative, for a leg that should only ever gain) is not evidence — treat as unread. */
function nonZeroOrUndefined(value: bigint): bigint | undefined {
  return value > 0n ? value : undefined;
}

/**
 * True iff this receipt's logs include a recognized Uniswap V2/V3 pool `Swap`
 * event — route-provenance signal ONLY (confirms a Uniswap pool was actually
 * touched). Never used to derive executed amounts: a Swap event's own amount
 * fields are pool-side deltas, which can diverge from the wallet's own
 * balance movement under a fee-on-transfer token the same way a quote can.
 */
export function receiptTouchesUniswapPool(receipt: UniswapDecodableReceipt): boolean {
  return receipt.logs.some(
    (log) => log.topics[0] === V2_POOL_SWAP_TOPIC0 || log.topics[0] === V3_POOL_SWAP_TOPIC0,
  );
}
