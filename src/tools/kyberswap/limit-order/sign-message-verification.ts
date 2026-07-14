/**
 * Cross-check KyberSwap Limit Order EIP-712 sign-messages against locally
 * computed intent BEFORE signing (fail-closed guard against blind-signing).
 *
 * The maker create / gasless-cancel sign-message is fetched from the KyberSwap
 * API and then signed with the user's key. Provider output is untrusted input:
 * a tampered `verifyingContract` could redirect a valid signature to a
 * malicious protocol, and tampered amounts/assets/maker could sign an order the
 * user never intended. These guards throw `VexError` (no signature produced) on
 * any mismatch.
 *
 * Docs context: DSLOProtocol — the current double-signature Limit Order
 * Protocol — is the only accepted `verifyingContract`, deployed at the same
 * address on every LO-supported chain. The legacy single-signature protocol
 * (0x227B0c196eA8db17A665EA6824D972A64202E936) must NOT be accepted for new
 * orders. `chainId` is asserted against the requested chain so a signature can
 * never be produced for a different chain than intended.
 */

import { getAddress, type Address } from "viem";
import { VexError, ErrorCodes } from "../../../errors.js";
import { DSLO_PROTOCOL } from "../constants.js";
import type { LimitOrderEip712Message } from "./types.js";

/** Locally computed create-order intent, bound field-by-field to the message. */
export interface CreateOrderIntent {
  readonly chainId: number;
  readonly maker: Address;
  readonly makerAsset: Address;
  readonly takerAsset: Address;
  readonly makingAmount: string;
  readonly takingAmount: string;
  readonly expiredAt: number;
}

/** Cancel-order intent — the cancel request only carries the chain. */
export interface CancelOrderIntent {
  readonly chainId: number;
}

function refuse(field: string): never {
  throw new VexError(
    ErrorCodes.KYBER_LO_SIGN_FAILED,
    `Refusing to sign limit-order EIP-712 message: ${field} does not match the requested order.`,
    "The signing payload returned by KyberSwap does not match your intent — no signature was produced.",
  );
}

/** Case-insensitive checksum-normalized address equality; refuses on non-address input. */
function assertSameAddress(actual: unknown, expected: Address, field: string): void {
  if (typeof actual !== "string") refuse(field);
  let normalized: string;
  try {
    normalized = getAddress(actual);
  } catch {
    refuse(field);
  }
  if (normalized !== getAddress(expected)) refuse(field);
}

/** Exact string equality (amounts are compared as exact uint256 strings). */
function assertSameString(actual: unknown, expected: string, field: string): void {
  if (typeof actual !== "string" || actual !== expected) refuse(field);
}

/**
 * Expiry is NOT a top-level message field on the DSLO Order struct
 * ([salt, makerAsset, takerAsset, maker, receiver, allowedSender, makingAmount,
 * takingAmount, feeConfig, makerAssetData, takerAssetData, getMakerAmount,
 * getTakerAmount, predicate, interaction]). It is ABI-encoded inside `predicate`
 * as a `timestampBelow(uint256)` call — selector 0x63592c2b followed by the
 * 32-byte expiry word. Verified against a live sign-message (chainId 42161):
 * the predicate contains `63592c2b` and the padded word `…6a5d4f20`, where
 * 0x6a5d4f20 === 1784500000 === the requested expiredAt. A missing selector or a
 * mismatched expiry word means the order would expire at a time we did not
 * request → fail closed.
 */
function assertExpiryInPredicate(predicate: unknown, expiredAt: number, field: string): void {
  if (typeof predicate !== "string") refuse(field);
  const haystack = predicate.toLowerCase();
  const expiryWord = expiredAt.toString(16).padStart(64, "0");
  if (!haystack.includes("63592c2b")) refuse(field);
  if (!haystack.includes(expiryWord)) refuse(field);
}

/** DSLOProtocol verifyingContract allowlist + requested-chain binding. */
function assertDomain(eip712: LimitOrderEip712Message, chainId: number): void {
  assertSameAddress(eip712.domain.verifyingContract, DSLO_PROTOCOL, "domain.verifyingContract");
  if (eip712.domain.chainId !== chainId) refuse("domain.chainId");
}

/**
 * Verify an unsigned create-order EIP-712 message equals the locally computed
 * order before it is signed. Throws on any mismatch — no signature is produced.
 */
export function verifyCreateOrderSignMessage(eip712: LimitOrderEip712Message, intent: CreateOrderIntent): void {
  assertDomain(eip712, intent.chainId);
  const message = eip712.message;
  assertSameAddress(message.maker, intent.maker, "message.maker");
  assertSameAddress(message.makerAsset, intent.makerAsset, "message.makerAsset");
  assertSameAddress(message.takerAsset, intent.takerAsset, "message.takerAsset");
  assertSameString(message.makingAmount, intent.makingAmount, "message.makingAmount");
  assertSameString(message.takingAmount, intent.takingAmount, "message.takingAmount");
  // Our create flow never requests a custom receiver, so the API must default it
  // to the maker; binding it closes an output-redirect vector. (If a custom
  // receiver is ever supported, add it to CreateOrderIntent and bind that.)
  assertSameAddress(message.receiver, intent.maker, "message.receiver");
  assertExpiryInPredicate(message.predicate, intent.expiredAt, "message.predicate");
}

/**
 * Verify an unsigned gasless-cancel EIP-712 message targets the allowlisted
 * DSLOProtocol on the requested chain before it is signed. The cancel request
 * carries only the chain, so only the domain is bindable. Throws on mismatch.
 */
export function verifyCancelOrderSignMessage(eip712: LimitOrderEip712Message, intent: CancelOrderIntent): void {
  assertDomain(eip712, intent.chainId);
}
