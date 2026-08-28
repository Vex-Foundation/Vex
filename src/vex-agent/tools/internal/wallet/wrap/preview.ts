/**
 * The approval card for a native <-> wrapped-native conversion.
 *
 * ## What the card has to say, and why it says it POSITIVELY
 *
 * A wrap looks like a swap to a reader: two assets, an amount in and an amount
 * out. It is not one, and the differences are exactly the things a swap card
 * warns about. So this card STATES them rather than omitting them: the rate is
 * 1:1, there is no slippage, there is no route, and the recipient is the signer.
 * An absent line teaches a reader that the section failed to render; a present
 * line that says "none, and here is why" is a fact they can act on.
 *
 * ## No fee line, of any kind
 *
 * There is no Vex fee on this path and no field anywhere in the wrap lane that
 * could carry one. The card therefore renders NO fee line except the network
 * gas ceilings the user authorizes, which are the chain's charge and not Vex's.
 * Adding one here would require adding it to the durable contract, migration 096
 * and the digest preimage together; that is the intended cost.
 *
 * ## Naming
 *
 * User-facing copy says "wrapped-native contract" and never "WETH9". The
 * registry holds WBNB, WPOL and WAVAX alongside WETH, and the symbol shown is
 * the one the live contract returned, never a convention.
 *
 * ## Precision
 *
 * Every value is a STRING. The human-readable amount is derived from the raw
 * digit string and the contract's own `decimals` by integer and string
 * arithmetic ONLY: no `Number`, no `parseFloat`, no division. A wei amount does
 * not survive an IEEE-754 double, and the card is the last place a user can
 * catch a wrong quantity.
 */

import type {
  WalletWrapFeeBounds,
  WrapContractIdentity,
  WrapPreview,
  WrapTransactionPayload,
} from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";

import type { WrapDirection } from "./calldata.js";
import { accept, refuse, type WrapOutcome } from "./refusal.js";

/**
 * The EVM arms of the shared fee-bounds union.
 *
 * The wrap lane is EVM-only, but it reuses the transaction lane's fee-bounds
 * vocabulary, which also carries a Solana arm. Rather than render a card with a
 * missing gas section for a shape prepare never writes, the renderer accepts
 * only the arms that HAVE gas ceilings and the durable-row entry point refuses
 * the other one by name.
 */
export type WrapEvmFeeBounds = Extract<
  WalletWrapFeeBounds,
  { mode: "eip1559" } | { mode: "legacy" }
>;

export function isWrapEvmFeeBounds(bounds: WalletWrapFeeBounds): bounds is WrapEvmFeeBounds {
  return bounds.mode === "eip1559" || bounds.mode === "legacy";
}

/**
 * Render a base-unit integer string as a decimal string, exactly.
 *
 * String and BigInt arithmetic only. The fractional part is the last
 * `decimals` digits of the zero-padded raw value, so no rounding, truncation or
 * float formatting can occur: every digit of the raw amount is still present in
 * the output, and trailing fractional zeros are the only thing dropped.
 */
export function formatWrapAmountHuman(amountRaw: string, decimals: number): string {
  const digits = amountRaw.replace(/^0+(?=\d)/, "");
  if (decimals <= 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * The rendered card, with `criticalArgs` narrowed to STRING values.
 *
 * The durable `WrapPreview` schema tolerates numbers and booleans because a row
 * read back from PostgreSQL is external input and the parser must describe what
 * can arrive. What this renderer PRODUCES is narrower on purpose: the digest
 * preimage admits no JS numbers, and a card assembled here can never introduce
 * one. `RenderedWrapPreview` is assignable to `WrapPreview`, so the durable
 * writer takes it unchanged.
 */
export interface RenderedWrapPreview {
  readonly label: string;
  readonly criticalArgs: Readonly<Record<string, string>>;
}

/** The exact contract function each direction calls. Named, never shown as raw calldata. */
function wrapFunctionName(direction: WrapDirection): string {
  return direction === "wrap" ? "deposit()" : "withdraw(uint256)";
}

/** The fields the card is allowed to read. Every one of them is digest-bound. */
export interface RenderWrapPreviewInput {
  /** The chain's own alias in this repository's slug vocabulary. */
  readonly chainAlias: string;
  readonly chainId: number;
  readonly direction: WrapDirection;
  /** Address, symbol and decimals as frozen into the intent from the verified registry. */
  readonly contract: WrapContractIdentity;
  /** Base units, decimal integer string. */
  readonly amountRaw: string;
  /** The derived `{ to, data, valueWei }` triple. Shown by function name and value, never as a hex blob. */
  readonly payload: WrapTransactionPayload;
  readonly feeBounds: WrapEvmFeeBounds;
  readonly expiresAt: string;
}

/**
 * THE renderer. One producer, three consumers - the durable `preview_json`, the
 * digest preimage, and the approval binding - so a stored card that disagrees
 * with this function is provably an edit rather than a rendering difference.
 */
export function renderWrapPreview(input: RenderWrapPreviewInput): RenderedWrapPreview {
  const human = formatWrapAmountHuman(input.amountRaw, input.contract.decimals);
  const wrapped = `${input.contract.symbol} (${input.contract.address})`;
  const native = `the native currency of ${input.chainAlias}`;

  // The whole contract address is carried in the LABEL as well as in the panel
  // below it. An elided address is what an address-poisoning lookalike is
  // ground to defeat, and this sentence is the one a human authorizes from.
  const label =
    input.direction === "wrap"
      ? `Wrap ${human} of ${input.chainAlias}'s native currency into ${human} `
        + `${input.contract.symbol} at the wrapped-native contract ${input.contract.address} `
        + `on ${input.chainAlias} (chain id ${input.chainId})`
      : `Unwrap ${human} ${input.contract.symbol} back into ${human} of ${input.chainAlias}'s `
        + `native currency at the wrapped-native contract ${input.contract.address} `
        + `on ${input.chainAlias} (chain id ${input.chainId})`;

  const criticalArgs: Record<string, string> = {
    chain: input.chainAlias,
    chainId: String(input.chainId),
    direction: input.direction,
    wrappedNativeContract: input.contract.address,
    wrappedNativeSymbol: input.contract.symbol,
    wrappedNativeDecimals: String(input.contract.decimals),
    amountRaw: input.amountRaw,
    amountHuman: human,
    amountDecimals: String(input.contract.decimals),
    youSend: input.direction === "wrap" ? `${human} of ${native}` : `${human} ${wrapped}`,
    youReceive: input.direction === "wrap" ? `${human} ${wrapped}` : `${human} of ${native}`,
    rate:
      "exactly 1:1. The wrapped-native contract mints and burns one base unit for one base unit, "
      + "in both directions, so the amount received is the amount sent.",
    slippage:
      "none. This is not a trade: there is no price, no quote and no amount-out that could move "
      + "between now and the moment this transaction is mined.",
    route:
      "none. The transaction calls the wrapped-native contract directly. No router, aggregator, "
      + "pool or intermediate token is involved.",
    recipient:
      "you, the signer of this transaction. The wrapped-native contract credits and pays out to "
      + "the caller only, so these funds cannot be sent to any other address.",
    contractFunction: wrapFunctionName(input.direction),
    callTo: input.payload.to,
    callValueWei: input.payload.valueWei,
    expiresAt: input.expiresAt,
  };

  if (input.feeBounds.mode === "eip1559") {
    criticalArgs.maxTotalNetworkFeeWei = input.feeBounds.maxTotalFeeWei;
    criticalArgs.gasLimit = input.feeBounds.gasLimit;
    criticalArgs.maxFeePerGasWei = input.feeBounds.maxFeePerGasWei;
    criticalArgs.maxPriorityFeePerGasWei = input.feeBounds.maxPriorityFeePerGasWei;
  } else {
    criticalArgs.maxTotalNetworkFeeWei = input.feeBounds.maxTotalFeeWei;
    criticalArgs.gasLimit = input.feeBounds.gasLimit;
    criticalArgs.gasPriceWei = input.feeBounds.gasPriceWei;
  }

  return { label, criticalArgs };
}

/**
 * The canonical card for a durable row: rendered from the row's OWN bound
 * fields, by the same function the digest preimage and the prepare path use.
 *
 * The stored `preview_json` is never read to produce it. The stored value is a
 * CACHE of this computation, and the only useful thing to do with a cache on
 * the money path is to check it.
 *
 * DEVIATION from the transaction lane's `canonicalPreviewOfIntent`, which
 * returns a card directly: the durable fee-bounds column can hold a Solana
 * shape that has no gas ceilings, so this returns an outcome and refuses that
 * row BY NAME instead of rendering a card with a missing gas section.
 */
export function canonicalPreviewOfWrapIntent(
  intent: WalletWrapIntent,
): WrapOutcome<RenderedWrapPreview> {
  if (!isWrapEvmFeeBounds(intent.feeBounds)) {
    return refuse(
      "missing_fee_bounds",
      `Refusing to render the approval card for wrap intent ${intent.intentId}: its stored fee `
      + `bounds are in the "${intent.feeBounds.mode}" shape, which carries no EVM gas ceilings, and `
      + "a wrap is an EVM transaction. Nothing was signed and no funds moved. Prepare the wrap "
      + "again.",
      { intentId: intent.intentId, feeBoundsMode: intent.feeBounds.mode },
    );
  }
  return accept<RenderedWrapPreview>(
    renderWrapPreview({
      chainAlias: intent.chainAlias,
      chainId: intent.chainId,
      direction: intent.direction,
      contract: intent.contract,
      amountRaw: intent.amountRaw,
      payload: intent.payload,
      feeBounds: intent.feeBounds,
      expiresAt: intent.expiresAt,
    }),
  );
}

/**
 * An approval card as it comes back OUT of durable storage: the value store
 * admits scalars this lane's renderer never emits. Declared so the comparison
 * below can take it without an assertion.
 */
export interface StoredApprovalCard {
  readonly label: string;
  readonly criticalArgs: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Whole-card equality: the sentence AND every argument, with no key allowed to
 * appear or vanish on either side.
 *
 * A subset comparison would let an added key through, and an added key is
 * exactly the shape a misleading card takes - the true facts still present,
 * with one more line the user reads as authoritative.
 *
 * `a` is the card as STORED on the approval envelope, so it is typed as the
 * wider shape that store admits rather than as this lane's rendered card: it is
 * untrusted input, and narrowing it by assertion would hide exactly the drift
 * this function exists to catch. A stored `"18"` and a rendered 18 are not
 * equal here, which is the intended answer - the renderer only ever emits
 * strings, so a number on that side is already evidence of an edit.
 */
export function wrapPreviewsEqual(a: StoredApprovalCard, b: WrapPreview): boolean {
  if (a.label !== b.label) return false;
  const aKeys = Object.keys(a.criticalArgs).sort();
  const bKeys = Object.keys(b.criticalArgs).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key, index) => key === bKeys[index] && a.criticalArgs[key] === b.criticalArgs[key],
  );
}
