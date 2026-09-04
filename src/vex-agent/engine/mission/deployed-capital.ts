/**
 * The ONE normalizer for a mission's typed deployed-capital declaration.
 *
 * Three call sites consume it and none of them may have its own copy:
 *   - `contract-hash.ts` (what the user's acceptance is bound to),
 *   - `mapper.ts` (what a stored row projects into the domain draft),
 *   - `patch-parser.ts` (what an untrusted model write is allowed to persist).
 *
 * A second implementation is the bug class this module exists to prevent: the
 * C6 launch ceiling had to be hand-mirrored between the hash and the mapper,
 * and a divergence there would let a draft hash as one thing and read as
 * another. One function, one set of rules, three importers.
 *
 * New declarations carry SIX parts, including structural `assetKind`. Legacy
 * five-field declarations retain `assetKind: null`; that preserves their hash
 * material while forcing ambiguous native/wrapped identities to fail closed.
 * Any other missing or malformed part yields `null`, which is
 * byte-identical material to a mission that never declared capital at all. That
 * is the fail-closed state: absent means "not declared", and a partial
 * declaration must never read as a usable denominator.
 *
 * `amountRaw` stays a STRING and is never coerced through a number: a wei-scale
 * amount exceeds `Number.MAX_SAFE_INTEGER`, the same reasoning that already
 * applies to `startingCapital` and `maxLaunchValueRaw`.
 *
 * ZERO IS NOT A DENOMINATOR. An all-zeros `amountRaw` normalizes to `null`. A
 * declared zero would satisfy the "is it declared" check while giving every
 * relative measurement a zero divisor, which is worse than an honest absence.
 *
 * ASSET IDENTITY IS FAMILY-AWARE, because case means different things per family:
 *   - EVM (every chain id except Solana's): a 20-byte `0x` hex address or the
 *     native sentinel, canonicalized to LOWERCASE. EVM addresses are
 *     case-insensitive and the mixed case is only an EIP-55 checksum, so a
 *     checksum rewrite must not dirty an acceptance.
 *   - Solana: a base58 mint, case PRESERVED. Base58 case IS identity there, and
 *     lowercasing a mint would produce an address that matches no balance row.
 *     The mission contract's canonical native-SOL representation is `SOL_MINT`
 *     (`So11111111111111111111111111111111111111112`, see
 *     `@tools/solana-ecosystem/shared/solana-constants.ts`), which is itself a
 *     valid base58 mint. It remains the approval, hash and route identity.
 *     `proj_balances` uses a separate database-only native storage key so a
 *     wSOL holding can coexist. `assetKind` decides which row the baseline
 *     reads; the address and display symbol never make that decision.
 *
 * `assetSymbol` is bounded to a strict charset with no whitespace, newlines or
 * markdown. It is model-written text that reaches the system prompt AND the
 * acceptance hash, so it is an injection surface; a symbol is a short ticker,
 * and anything that is not one is rejected rather than sanitized. Its case is
 * PRESERVED and it IS hashed: letting it drift after acceptance would let the
 * prompt name a different asset than the one the user accepted.
 */

import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../constants/solana-chain.js";
import { DEPLOYED_CAPITAL_BOUNDS, type DeployedCapital } from "../types.js";

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ASSET_SYMBOL_PATTERN = /^[A-Za-z0-9_.$-]{1,32}$/;
const NON_ZERO_INTEGER_PATTERN = /^\d+$/;

const EVM_NATIVE_SENTINEL = NATIVE_TOKEN_ADDRESS.toLowerCase();

/**
 * Canonicalize the asset identity for its chain family, or `null` when it is
 * not a well-formed identity on that family.
 */
function normalizeAssetAddress(chainId: number, address: string): string | null {
  if (chainId === SOLANA_SYNTHETIC_CHAIN_ID) {
    return SOLANA_MINT_PATTERN.test(address) ? address : null;
  }
  const lowered = address.toLowerCase();
  if (lowered === EVM_NATIVE_SENTINEL) return EVM_NATIVE_SENTINEL;
  return EVM_ADDRESS_PATTERN.test(address) ? lowered : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize an untrusted deployed-capital declaration as an INSEPARABLE WHOLE.
 *
 * Accepts `unknown` because all three call sites are boundaries: a DB blob, a
 * model patch, and a draft assembled from either. Never throws; any failure is
 * `null`.
 */
export function normalizeDeployedCapital(value: unknown): DeployedCapital | null {
  if (!isPlainObject(value)) return null;

  const { amountRaw, decimals, chainId, assetAddress, assetKind, assetSymbol } = value;

  if (typeof amountRaw !== "string") return null;
  const trimmedAmount = amountRaw.trim();
  if (trimmedAmount.length === 0) return null;
  if (trimmedAmount.length > DEPLOYED_CAPITAL_BOUNDS.AMOUNT_RAW_MAX_CHARS) return null;
  if (!NON_ZERO_INTEGER_PATTERN.test(trimmedAmount)) return null;
  // Zero is not a denominator: an all-zeros amount reads as absent, so it
  // cannot suppress a measurability warning it does not actually answer.
  if (!/[1-9]/.test(trimmedAmount)) return null;

  if (typeof decimals !== "number" || !Number.isInteger(decimals)) return null;
  if (decimals < DEPLOYED_CAPITAL_BOUNDS.DECIMALS_MIN) return null;
  if (decimals > DEPLOYED_CAPITAL_BOUNDS.DECIMALS_MAX) return null;

  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) return null;
  if (chainId < DEPLOYED_CAPITAL_BOUNDS.CHAIN_ID_MIN) return null;

  if (typeof assetAddress !== "string") return null;
  const trimmedAddress = assetAddress.trim();
  if (trimmedAddress.length === 0) return null;
  if (trimmedAddress.length > DEPLOYED_CAPITAL_BOUNDS.ASSET_ADDRESS_MAX) return null;
  const canonicalAddress = normalizeAssetAddress(chainId, trimmedAddress);
  if (canonicalAddress === null) return null;

  const normalizedAssetKind = assetKind === undefined || assetKind === null
    ? null
    : assetKind === "native" || assetKind === "token"
      ? assetKind
      : null;
  if (assetKind !== undefined && assetKind !== null && normalizedAssetKind === null) return null;
  if (normalizedAssetKind === "native") {
    const isCanonicalNative = chainId === SOLANA_SYNTHETIC_CHAIN_ID
      ? canonicalAddress === SOL_MINT
      : canonicalAddress === EVM_NATIVE_SENTINEL;
    if (!isCanonicalNative) return null;
  }
  if (normalizedAssetKind === "token" && chainId !== SOLANA_SYNTHETIC_CHAIN_ID) {
    if (canonicalAddress === EVM_NATIVE_SENTINEL) return null;
  }

  if (typeof assetSymbol !== "string") return null;
  const trimmedSymbol = assetSymbol.trim();
  if (!ASSET_SYMBOL_PATTERN.test(trimmedSymbol)) return null;

  return {
    amountRaw: trimmedAmount,
    decimals,
    chainId,
    assetAddress: canonicalAddress,
    assetKind: normalizedAssetKind,
    assetSymbol: trimmedSymbol,
  };
}
