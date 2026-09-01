/**
 * The VERSIONED wrap proposal digest: one canonical serialization, one SHA-256.
 *
 * ## What it covers, and why it is not a hash of the calldata
 *
 * `deposit()` calldata is the CONSTANT `0xd0e30db0` on every chain and for every
 * amount, so a digest over the payload bytes alone would be identical for a
 * one-wei wrap and a whole-balance wrap on any chain. Nothing a user consented
 * to would be bound. So the preimage covers every sign-relevant field:
 *
 *  - the digest version and the resource identity (table + intent id), so a
 *    digest can never be replayed against a different row or a different
 *    scheme, nor against a row in the generic-signing intents table;
 *  - the wallet address, the chain alias and the NUMERIC chain id: the same
 *    contract address exists on chains it was never verified on;
 *  - the direction, which decides which asset leaves the wallet;
 *  - the wrapped-native contract identity - address, symbol and decimals. The
 *    decimals are what turn the raw amount into the number a human read, so a
 *    changed `decimals` changes the consent even though the calldata is byte
 *    for byte identical;
 *  - the raw amount, and the derived `{ to, data, valueWei }` triple confirm
 *    re-derives and compares;
 *  - the mandatory gas fee bounds;
 *  - the intent expiry;
 *  - the CANONICAL CARD: the exact sentence and argument panel a human is
 *    shown. It is not an extra input - it is RENDERED HERE from the fields
 *    above, by the one renderer the prepare path uses, so it cannot carry a
 *    fact the digest does not already bind. Covering it is what makes a
 *    hand-edited `preview_json` detectable: without it, the row could describe
 *    the wrap as something else entirely and every digest check would still
 *    pass, because nothing the digest covered had moved.
 *
 * ## Canonical serialization
 *
 * Keys are emitted in sorted order at every level and every value is a string,
 * a boolean, `null`, an array or an object. There are NO numbers in the
 * preimage: a JSON number would reintroduce float formatting on the money path,
 * and the one thing a digest must not do is depend on how a runtime prints
 * `1e21`. Numeric facts travel as their decimal string.
 *
 * ## Versioning
 *
 * `WRAP_PROPOSAL_DIGEST_VERSION` is inside the preimage AND stored beside the
 * digest. Confirm refuses an unknown version by name rather than comparing a
 * digest from another serialization and reporting the mismatch as proposal
 * drift.
 */

import { createHash } from "node:crypto";

import {
  WALLET_WRAP_INTENTS_RESOURCE,
  WRAP_PROPOSAL_DIGEST_VERSION,
  type WrapContractIdentity,
  type WrapTransactionPayload,
} from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";

import type { WrapDirection } from "./calldata.js";
import {
  canonicalPreviewOfWrapIntent,
  isWrapEvmFeeBounds,
  renderWrapPreview,
  wrapPreviewsEqual,
  type RenderedWrapPreview,
  type WrapEvmFeeBounds,
} from "./preview.js";
import { accept, refuse, type WrapOutcome } from "./refusal.js";

export interface WrapProposalDigestInput {
  readonly intentId: string;
  readonly walletAddress: string;
  readonly chainAlias: string;
  readonly chainId: number;
  readonly direction: WrapDirection;
  readonly contract: WrapContractIdentity;
  /** Base units, decimal integer string. */
  readonly amountRaw: string;
  /** The derived triple, exactly as stored and as confirm re-derives it. */
  readonly payload: WrapTransactionPayload;
  readonly feeBounds: WrapEvmFeeBounds;
  readonly expiresAt: string;
}

export interface WrapProposalDigest {
  readonly version: typeof WRAP_PROPOSAL_DIGEST_VERSION;
  readonly digest: string;
}

type Canonical = string | boolean | null | readonly Canonical[] | { readonly [key: string]: Canonical };

/**
 * Deterministic JSON. Sorted keys at every depth, no numbers, no undefined.
 *
 * An absent value is the BARE token `null`, while a field holding the four
 * characters "null" is emitted quoted by `JSON.stringify`. The two must not
 * collide: "no chain alias" and "a chain alias literally spelled null" are
 * different proposals, and a digest that could not tell them apart would verify
 * one against the other.
 */
function canonicalize(value: Canonical): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as { readonly [key: string]: Canonical };
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key] as Canonical)}`).join(",")}}`;
}

/** The gas bounds, flattened into the string-only canonical vocabulary. */
function canonicalFeeBounds(bounds: WrapEvmFeeBounds): Canonical {
  if (bounds.mode === "eip1559") {
    return {
      mode: bounds.mode,
      gasLimit: bounds.gasLimit,
      maxFeePerGasWei: bounds.maxFeePerGasWei,
      maxPriorityFeePerGasWei: bounds.maxPriorityFeePerGasWei,
      maxTotalFeeWei: bounds.maxTotalFeeWei,
    };
  }
  return {
    mode: bounds.mode,
    gasLimit: bounds.gasLimit,
    gasPriceWei: bounds.gasPriceWei,
    maxTotalFeeWei: bounds.maxTotalFeeWei,
  };
}

/** The exact bytes hashed. Exported so a test can assert the preimage, not just the hash. */
export function wrapProposalDigestPreimage(input: WrapProposalDigestInput): string {
  // Rendered, never accepted. See the header: a caller-supplied card would let
  // the caller choose the sentence the digest attests to.
  const preview: RenderedWrapPreview = renderWrapPreview({
    chainAlias: input.chainAlias,
    chainId: input.chainId,
    direction: input.direction,
    contract: input.contract,
    amountRaw: input.amountRaw,
    payload: input.payload,
    feeBounds: input.feeBounds,
    expiresAt: input.expiresAt,
  });
  const body: Canonical = {
    digestVersion: WRAP_PROPOSAL_DIGEST_VERSION,
    resourceTable: WALLET_WRAP_INTENTS_RESOURCE,
    intentId: input.intentId,
    // EVM addresses are case-insensitive hex, so lowercasing canonicalizes the
    // signer. The CONTRACT address is left in its checksummed registry form:
    // it is the identity the card displays, and the card is in this preimage.
    walletAddress: input.walletAddress.toLowerCase(),
    chainAlias: input.chainAlias,
    chainId: String(input.chainId),
    direction: input.direction,
    contract: {
      address: input.contract.address,
      symbol: input.contract.symbol,
      decimals: String(input.contract.decimals),
    },
    amountRaw: input.amountRaw,
    payload: {
      to: input.payload.to,
      data: input.payload.data,
      valueWei: input.payload.valueWei,
    },
    feeBounds: canonicalFeeBounds(input.feeBounds),
    expiresAt: input.expiresAt,
    preview: { label: preview.label, criticalArgs: { ...preview.criticalArgs } },
  };
  return canonicalize(body);
}

export function computeWrapProposalDigest(input: WrapProposalDigestInput): WrapProposalDigest {
  return {
    version: WRAP_PROPOSAL_DIGEST_VERSION,
    digest: createHash("sha256").update(wrapProposalDigestPreimage(input), "utf8").digest("hex"),
  };
}

/**
 * What an approval for a prepared wrap is bound to.
 *
 * `resource` names the TABLE as well as the id: several intent tables exist and
 * a confirm must not be able to consume another one's row, so the table travels
 * with the binding rather than being inferred from the tool that happens to be
 * resuming.
 */
export interface PreparedWrapApprovalBinding {
  /** The card the approval shows, re-derived from the row's own bound fields. */
  readonly preview: RenderedWrapPreview;
  /** The INTENT's own expiry, not the enqueue path's default TTL. */
  readonly intentExpiresAt: string;
  readonly proposalDigest: string;
  readonly proposalDigestVersion: string;
  readonly resource: {
    readonly table: typeof WALLET_WRAP_INTENTS_RESOURCE;
    readonly intentId: string;
  };
}

/**
 * RECOMPUTE the digest from a durable row's OWN bound fields.
 *
 * The one function that can answer "does the digest stored beside this row
 * still describe it". `bindingFromDurableWrapIntent` deliberately reports the
 * STORED digest, because the binding's job is to say what an approval will be
 * bound to; comparing that value against the row it came from would compare a
 * value to itself and prove nothing. Confirm calls this instead, and refuses
 * on a difference.
 *
 * Refuses a non-EVM fee-bounds row by name rather than digesting a shape
 * prepare never writes.
 */
export function recomputeWrapProposalDigest(intent: WalletWrapIntent): WrapOutcome<string> {
  if (!isWrapEvmFeeBounds(intent.feeBounds)) {
    return refuse(
      "invalid_input",
      `Refusing to sign: wrap intent ${intent.intentId} carries ${intent.feeBounds.mode} fee bounds, `
      + "and a wrap is an EVM transaction, so the digest that was approved cannot be recomputed. "
      + "Nothing was signed and no funds moved. Prepare the wrap again.",
      { intentId: intent.intentId, feeBoundsMode: intent.feeBounds.mode },
    );
  }
  return accept(
    computeWrapProposalDigest({
      intentId: intent.intentId,
      walletAddress: intent.walletAddress,
      chainAlias: intent.chainAlias,
      chainId: intent.chainId,
      direction: intent.direction,
      contract: intent.contract,
      amountRaw: intent.amountRaw,
      payload: intent.payload,
      feeBounds: intent.feeBounds,
      expiresAt: intent.expiresAt,
    }).digest,
  );
}

/**
 * Build the binding from a durable wrap intent row.
 *
 * Refuses an unknown digest version BY NAME. A row written by a future build
 * under a different serialization cannot be compared against this build's
 * digest, and reporting that as "the proposal changed" would send an operator
 * looking for an attack that did not happen.
 */
export function bindingFromDurableWrapIntent(
  intent: WalletWrapIntent,
): WrapOutcome<PreparedWrapApprovalBinding> {
  if (intent.proposalDigestVersion !== WRAP_PROPOSAL_DIGEST_VERSION) {
    return refuse(
      "invalid_input",
      `Refusing to bind an approval: wrap intent ${intent.intentId} carries proposal digest version `
      + `"${intent.proposalDigestVersion}", and this build computes "${WRAP_PROPOSAL_DIGEST_VERSION}". `
      + "A digest from a different serialization cannot be compared, so this is refused rather than "
      + "reported as proposal drift. Prepare the wrap again on this build.",
      {
        intentId: intent.intentId,
        storedVersion: intent.proposalDigestVersion,
        supportedVersion: WRAP_PROPOSAL_DIGEST_VERSION,
      },
    );
  }

  // THE CARD IS RE-DERIVED, and the stored one is checked against it. The
  // digest covers the canonical card, so a row whose `preview_json` was edited
  // still recomputes its digest correctly - what changed is the sentence a
  // human would be shown, and only this comparison sees it. Refusing here means
  // the edit is caught BEFORE the approval is enqueued, so no card describing a
  // wrap incorrectly ever reaches a person.
  const canonical = canonicalPreviewOfWrapIntent(intent);
  if (!canonical.ok) return canonical;
  if (!wrapPreviewsEqual(intent.preview, canonical.value)) {
    return refuse(
      "invalid_input",
      `Refusing to bind an approval: the stored preview on wrap intent ${intent.intentId} is not `
      + "the preview its own direction, contract, amount, fee bounds and chain produce, so the "
      + "description a user would read was changed after the wrap was prepared. Nothing was signed "
      + "and no funds moved. Prepare the wrap again.",
      { intentId: intent.intentId },
    );
  }

  return accept<PreparedWrapApprovalBinding>({
    preview: canonical.value,
    intentExpiresAt: intent.expiresAt,
    proposalDigest: intent.proposalDigest,
    proposalDigestVersion: intent.proposalDigestVersion,
    resource: {
      table: WALLET_WRAP_INTENTS_RESOURCE,
      intentId: intent.intentId,
    },
  });
}
