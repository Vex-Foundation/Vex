/**
 * The VERSIONED proposal digest: one canonical serialization, one SHA-256.
 *
 * ## What it covers, and why it is not a hash of the payload
 *
 * A digest over the calldata or the message bytes alone binds WHAT would be
 * signed and nothing about WHO signs it, on which chain, under what fee
 * authority, or until when. All of those are fields an attacker or a bug could
 * move without touching a byte of the payload, and every one of them changes
 * what the user consented to. So the preimage covers every sign-relevant field:
 *
 *  - the digest version and the resource identity (table + intent id), so a
 *    digest can never be replayed against a different row or a different scheme;
 *  - family, wallet address, chain alias and numeric chain id;
 *  - the canonical payload (EVM `to`/`data`/`valueWei`, or the Solana canonical
 *    message bytes and fee payer);
 *  - the DECODED effects, so a decoder change that alters what the user was
 *    shown invalidates the approval instead of silently re-describing it;
 *  - the mandatory fee bounds;
 *  - the Solana blockhash evidence;
 *  - the intent expiry;
 *  - the CANONICAL PREVIEW: the exact sentence and argument panel a human is
 *    shown. It is not an extra input - it is RENDERED HERE from the fields
 *    above, by the one renderer the prepare path uses, so it cannot carry a
 *    fact the digest does not already bind. Covering it is what makes a
 *    hand-edited `preview_json` detectable: without it, the row could describe
 *    the transaction as something else entirely and every digest check would
 *    still pass, because nothing the digest covered had moved.
 *
 * ## Versioning history
 *
 * v2 (2026-08-24) added the canonical preview to the preimage. A v1 digest was
 * computed over a serialization that never saw it, so it CANNOT be re-verified
 * on this build; v1 is refused BY NAME wherever a digest is compared. This is a
 * deliberate pre-release wire-format change with no migration: an in-flight
 * intent expires in minutes, and re-preparing is both cheap and safe.
 *
 * ## Canonical serialization
 *
 * Keys are emitted in sorted order at every level and every value is a string,
 * a boolean, `null`, an array or an object. There are no numbers in the
 * preimage: a JSON number would reintroduce float formatting on the money path,
 * and the one thing a digest must not do is depend on how a runtime prints
 * `1e21`. Numeric facts travel as their decimal string.
 *
 * ## Versioning
 *
 * `PROPOSAL_DIGEST_VERSION` is inside the preimage AND stored beside the digest.
 * Confirm refuses an unknown version by name rather than comparing a `v1` digest
 * against a `v2` serialization and reporting the mismatch as proposal drift.
 */

import { createHash } from "node:crypto";

import {
  PROPOSAL_DIGEST_VERSION,
  type DecodedWalletTransaction,
  type WalletTransactionFamily,
  type WalletTransactionFeeBounds,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";

import { canonicalTransactionPreview } from "./preview.js";

/** The durable table the digest is bound to. Part of the preimage. */
export const WALLET_TRANSACTION_INTENTS_RESOURCE = "wallet_transaction_intents" as const;

export interface ProposalDigestInput {
  readonly intentId: string;
  readonly family: WalletTransactionFamily;
  readonly walletAddress: string;
  readonly chainAlias: string | null;
  readonly chainId: number | null;
  /** EVM: `{ to, data, valueWei }`. Solana: `{ messageBase64, feePayer }`. */
  readonly payload: Readonly<Record<string, string>>;
  readonly decoded: DecodedWalletTransaction;
  readonly feeBounds: WalletTransactionFeeBounds;
  readonly recentBlockhash: string | null;
  readonly lastValidBlockHeight: number | null;
  readonly expiresAt: string;
}

export interface ProposalDigest {
  readonly version: typeof PROPOSAL_DIGEST_VERSION;
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

/** The decoded effects, flattened into the string-only canonical vocabulary. */
function canonicalDecoded(decoded: DecodedWalletTransaction): Canonical {
  if (decoded.family === "eip155") {
    return {
      family: decoded.family,
      role: decoded.role,
      standard: decoded.standard,
      functionName: decoded.functionName,
      contract: decoded.contract,
      criticalArgs: decoded.criticalArgs,
      unlimitedApproval: decoded.unlimitedApproval,
      warnings: [...decoded.warnings],
    };
  }
  return {
    family: decoded.family,
    role: decoded.role,
    addressTableLookupsResolved: decoded.addressTableLookupsResolved,
    accountKeys: [...decoded.accountKeys],
    instructions: decoded.instructions.map((one) => ({
      program: one.program,
      variant: one.variant,
      programId: one.programId,
      criticalArgs: one.criticalArgs,
    })),
    warnings: [...decoded.warnings],
  };
}

/** The exact bytes hashed. Exported so a test can assert the preimage, not just the hash. */
export function proposalDigestPreimage(input: ProposalDigestInput): string {
  // Rendered, never accepted. See the header: a caller-supplied preview would
  // let the caller choose the sentence the digest attests to.
  const preview = canonicalTransactionPreview({
    family: input.family,
    chainAlias: input.chainAlias,
    decoded: input.decoded,
    feeBounds: input.feeBounds,
  });
  const body: Canonical = {
    digestVersion: PROPOSAL_DIGEST_VERSION,
    resourceTable: WALLET_TRANSACTION_INTENTS_RESOURCE,
    intentId: input.intentId,
    family: input.family,
    // EVM addresses are case-insensitive hex, so lowercasing canonicalizes them.
    // A Solana address is base58 and CASE-SENSITIVE: lowercasing it would
    // corrupt the pubkey and let two distinct wallets share one digest, so the
    // case is preserved for that family.
    walletAddress:
      input.family === "eip155" ? input.walletAddress.toLowerCase() : input.walletAddress,
    chainAlias: input.chainAlias,
    chainId: input.chainId === null ? null : String(input.chainId),
    payload: input.payload,
    decoded: canonicalDecoded(input.decoded),
    feeBounds: { ...input.feeBounds },
    recentBlockhash: input.recentBlockhash,
    lastValidBlockHeight:
      input.lastValidBlockHeight === null ? null : String(input.lastValidBlockHeight),
    expiresAt: input.expiresAt,
    preview: { label: preview.label, criticalArgs: { ...preview.criticalArgs } },
  };
  return canonicalize(body);
}

export function computeProposalDigest(input: ProposalDigestInput): ProposalDigest {
  return {
    version: PROPOSAL_DIGEST_VERSION,
    digest: createHash("sha256").update(proposalDigestPreimage(input), "utf8").digest("hex"),
  };
}
