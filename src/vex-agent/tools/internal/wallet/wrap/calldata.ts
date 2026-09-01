/**
 * The wrap transaction triple, derived locally from bound fields only.
 *
 * The model never supplies bytes on this path. `deriveWrapTransaction` is a
 * pure function of (direction, wrapped-native contract, amount), and it is
 * called TWICE: once at prepare, to build the proposal, and once at confirm,
 * from the fields the human approved, to be compared byte for byte with what
 * was stored. That is the whole reason it is pure and has no I/O.
 *
 * The comparison must cover the WHOLE triple, not the calldata:
 *
 * - `deposit()` calldata is the CONSTANT `0xd0e30db0` on every chain and for
 *   every amount. The amount lives in `value`. Comparing calldata alone would
 *   pass while the transaction moved a different quantity of the user's funds.
 * - `withdraw(uint256)` carries the amount in calldata and sends `value` 0.
 *
 * Both selectors and the zero-amount semantics were verified live, read-only,
 * on all eight registered chains (see `tools/evm-chains/wrapped-native.ts`).
 */

import type { WrappedNativeContract } from "@tools/evm-chains/wrapped-native.js";

/** `deposit()`. Takes no arguments: the amount is the transaction's `value`. */
const DEPOSIT_SELECTOR = "0xd0e30db0" as const;

/** `withdraw(uint256)`. The amount is the single ABI word; `value` is 0. */
const WITHDRAW_SELECTOR = "2e1a7d4d" as const;

/** Wrap turns native into wrapped-native; unwrap turns it back. */
export type WrapDirection = "wrap" | "unwrap";

export const WRAP_DIRECTIONS: readonly WrapDirection[] = ["wrap", "unwrap"];

export function isWrapDirection(value: unknown): value is WrapDirection {
  return value === "wrap" || value === "unwrap";
}

/**
 * The exact fields signed. `value` is a decimal integer STRING, like every
 * other raw amount on this money path: a JS number cannot hold wei.
 */
export interface WrapTransaction {
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly valueWei: string;
}

/** Left-pad an unsigned integer to one 32-byte ABI word. */
function toAbiWord(amount: bigint): string {
  return amount.toString(16).padStart(64, "0");
}

/**
 * Build the transaction for one wrap or unwrap.
 *
 * `amountRaw` is in the wrapped-native contract's own base units, which for
 * every registered chain is also the native currency's - the conversion is
 * exactly 1:1 by the contract's construction, so one amount describes both
 * legs. Callers pass a value already parsed from a validated digit string;
 * this function refuses a non-positive amount rather than building a
 * transaction that moves nothing.
 */
export function deriveWrapTransaction(input: {
  readonly direction: WrapDirection;
  readonly contract: WrappedNativeContract;
  readonly amountRaw: bigint;
}): WrapTransaction {
  return { to: input.contract.address, ...deriveWrapCallAndValue(input) };
}

/**
 * The half of the triple that is a pure function of (direction, amount) alone:
 * the calldata and the attached native value. The target is the caller's, and
 * is the only field that needs a contract.
 *
 * Split out so the FINAL PRE-SIGN GATE (`./final-request.ts`) can re-derive
 * these two fields from a durable intent - whose bound contract identity is the
 * stored `{address, symbol, decimals}` triple, not a registry entry - WITHOUT
 * either fabricating the registry fields it does not have or growing a second
 * copy of the selectors. One source of truth for the bytes, two shapes of
 * caller.
 */
export function deriveWrapCallAndValue(input: {
  readonly direction: WrapDirection;
  readonly amountRaw: bigint;
}): { readonly data: `0x${string}`; readonly valueWei: string } {
  if (input.amountRaw <= 0n) {
    throw new Error("wrap: amountRaw must be a positive integer");
  }
  if (input.direction === "wrap") {
    return { data: DEPOSIT_SELECTOR, valueWei: input.amountRaw.toString(10) };
  }
  return {
    data: `0x${WITHDRAW_SELECTOR}${toAbiWord(input.amountRaw)}`,
    valueWei: "0",
  };
}

/** Whole-triple equality. Used at confirm; a single differing field is a refusal. */
export function wrapTransactionsEqual(a: WrapTransaction, b: WrapTransaction): boolean {
  return a.to === b.to && a.data === b.data && a.valueWei === b.valueWei;
}

/**
 * Which token leg is native for a direction. A wrap spends native and receives
 * wrapped-native; an unwrap does the reverse. Kept here beside the calldata so
 * the activity legs and the transaction can never disagree about direction.
 */
export function wrapLegs(direction: WrapDirection): {
  readonly inputIsNative: boolean;
  readonly outputIsNative: boolean;
} {
  return direction === "wrap"
    ? { inputIsNative: true, outputIsNative: false }
    : { inputIsNative: false, outputIsNative: true };
}
