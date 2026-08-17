/**
 * Leg-by-leg decode and verification of a Morpho vault transaction.
 *
 * THE RULE THIS IMPLEMENTS, verbatim from rules/90: "A provider's number is a
 * hint, never a floor. Where the provider returns opaque calldata, decode and
 * verify it against that bound before signing." The Morpho SDK is the provider
 * here. It is a good one, and it carries its own spender allowlist - and neither
 * fact is a reason to sign bytes Vex has not read.
 *
 * REFUSE, NEVER DOWNGRADE. Every failure below throws. There is no "verified:
 * false" field, no warning list a caller can proceed past, and no partial pass.
 * An UNDECODABLE leg is a refusal on exactly the same footing as a hostile one,
 * because the two are indistinguishable from here and the safe reading of "I
 * cannot tell what this call does" on a money path is no.
 *
 * WHAT IS CHECKED, in order:
 *   1. The entry point matches the SHAPE the direction requires - the pinned
 *      Bundler3 for a deposit, the intent's OWN vault for a withdrawal.
 *   2. The outer selector is the one allowed for that shape.
 *   3. The outer transaction moves no native value.
 *   4. Every inner leg decodes, targets a contract holding a ROLE IN THIS
 *      INTENT, carries an allowlisted selector, moves no value, and is not
 *      marked `skipRevert` or given a reentrancy callback.
 *   5. The amounts, the vault, and the recipient inside the legs match the
 *      intent rather than merely resembling it.
 *   6. A deposit carries a `maxSharePrice` guard, and that guard is at or below
 *      the ceiling the caller computed from the fresh share price and the
 *      declared slippage.
 *
 * The comparison in (6) is ABSOLUTE, not a percentage of anything, so it cannot
 * scale with trade size and hide a real loss (rules/90).
 */

import { decodeFunctionData, isAddressEqual, type Address, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { MORPHO_CONTRACTS } from "../constants.js";
import {
  MORPHO_ALLOWED_BUNDLE_LEGS,
  MORPHO_BUNDLER_ENTRY_CALL,
  MORPHO_VAULT_WITHDRAW_CALL,
  allowedLegSelectors,
  findAllowedLeg,
  type MorphoBundleTargetRole,
} from "./allowlist.js";
import type { MorphoBundleReport, MorphoDecodedLeg, MorphoVaultIntent } from "./types.js";

/** The transaction shape the SDK hands back. Deliberately structural, not the SDK's type. */
export interface MorphoBuiltTransaction {
  readonly to: string;
  readonly data: string;
  readonly value?: bigint | undefined;
}

/** What the caller must supply so the decoder can bound the price guard. */
export interface MorphoBundleBounds {
  /**
   * The highest `maxSharePrice` this deposit may carry, computed by the caller
   * from a FRESH share price and the declared slippage. Omitted for a
   * withdrawal, which has no such leg.
   */
  readonly maxSharePriceCeilingRaw?: bigint;
}

function reject(message: string, hint: string): never {
  throw new VexError(ErrorCodes.MORPHO_BUNDLE_REJECTED, message, hint);
}

const REJECT_HINT =
  "Nothing was signed and nothing was sent. Re-read the vault and re-build the operation; if the same "
  + "transaction comes back, report it rather than retrying, because a build that does not match the intent "
  + "does not become correct on a second attempt.";

/** Every address that holds a role in THIS intent, lower-cased, role-tagged. */
function intentRoles(intent: MorphoVaultIntent): Map<string, MorphoBundleTargetRole> {
  const contracts = MORPHO_CONTRACTS[intent.chainId];
  if (contracts === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_CONTRACT_UNAVAILABLE,
      `Vex has no pinned Morpho contract addresses for chain ${intent.chainId}, so it cannot verify what a `
      + "transaction built for that chain would touch.",
      "Adding a chain means re-extracting the pinned registry into `src/tools/morpho/constants.ts` with dated "
      + "provenance, never guessing a deployment.",
    );
  }
  const roles = new Map<string, MorphoBundleTargetRole>();
  // Order matters only for reporting: the intent-scoped entries are the ones a
  // reader most needs named, and a later set would otherwise overwrite them.
  if (contracts.bundler3 !== null) roles.set(contracts.bundler3.toLowerCase(), "bundler3");
  if (contracts.generalAdapter1 !== null) roles.set(contracts.generalAdapter1.toLowerCase(), "generalAdapter1");
  if (contracts.permit2 !== null) roles.set(contracts.permit2.toLowerCase(), "permit2");
  roles.set(intent.vaultAddress.toLowerCase(), "vault");
  roles.set(intent.assetAddress.toLowerCase(), "asset");
  return roles;
}

function requirePinned(intent: MorphoVaultIntent, role: "bundler3"): Address {
  const address = MORPHO_CONTRACTS[intent.chainId]?.[role];
  if (address === null || address === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_CONTRACT_UNAVAILABLE,
      `The pinned registry has no ${role} address on chain ${intent.chainId}, so Vex cannot confirm that a `
      + "bundled Morpho action would enter through the contract it is supposed to.",
      "A bundled deposit is refused on a chain whose Bundler3 Vex has not pinned. Re-extract the registry to add one.",
    );
  }
  return address;
}

function selectorOf(data: string): string {
  if (!data.startsWith("0x") || data.length < 10) {
    reject(
      `Refusing a Morpho ${"transaction"} whose calldata is ${data.length} characters long and carries no readable `
      + "function selector. Vex does not sign bytes it cannot read.",
      REJECT_HINT,
    );
  }
  return data.slice(0, 10).toLowerCase();
}

/** The `(target, data, value, skipRevert, callbackHash)` tuple Bundler3 takes. */
interface RawCall {
  to: Address;
  data: Hex;
  value: bigint;
  skipRevert: boolean;
  callbackHash: Hex;
}

const ZERO_CALLBACK_HASH = `0x${"0".repeat(64)}`;

function decodeOuterBundle(data: Hex): readonly RawCall[] {
  let decoded: { args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: MORPHO_BUNDLER_ENTRY_CALL.abi, data });
  } catch {
    reject(
      "Refusing a Morpho deposit: the Bundler3 call did not decode as `multicall` against the pinned Bundler3 ABI, "
      + "so Vex cannot see which contracts it would call.",
      REJECT_HINT,
    );
  }
  const bundle = decoded.args?.[0];
  if (!Array.isArray(bundle)) {
    reject(
      "Refusing a Morpho deposit: the Bundler3 `multicall` payload did not decode into a list of calls.",
      REJECT_HINT,
    );
  }
  return bundle as readonly RawCall[];
}

function amountMismatch(field: string, saw: bigint, expected: bigint): never {
  reject(
    `Refusing a Morpho transaction: its ${field} is ${saw} raw units, but the intent Vex approved is ${expected}. `
    + "The transaction does not do what was asked.",
    REJECT_HINT,
  );
}

function addressMismatch(field: string, saw: string, expected: string): never {
  reject(
    `Refusing a Morpho transaction: its ${field} is ${saw}, but the intent Vex approved names ${expected}.`,
    REJECT_HINT,
  );
}

interface LegVerification {
  summary: string;
  maxSharePriceRaw?: bigint;
  verifiedAmountRaw?: bigint;
  verifiedRecipient?: string;
}

/** Check ONE decoded deposit leg against the intent and describe it. */
function verifyDepositLeg(
  functionName: string,
  args: readonly unknown[],
  intent: MorphoVaultIntent,
  bounds: MorphoBundleBounds,
): LegVerification {
  if (functionName === "erc20TransferFrom") {
    const [asset, receiver, amount] = args as [Address, Address, bigint];
    if (!isAddressEqual(asset, intent.assetAddress)) {
      addressMismatch("pulled token", asset.toLowerCase(), intent.assetAddress.toLowerCase());
    }
    if (amount !== intent.amountRaw) amountMismatch("pulled amount", amount, intent.amountRaw);
    return {
      summary:
        `pulls ${amount} raw units of the vault's asset ${asset.toLowerCase()} from the wallet into `
        + `the adapter ${receiver.toLowerCase()}`,
    };
  }

  const [vault, assets, maxSharePrice, receiver] = args as [Address, bigint, bigint, Address];
  if (!isAddressEqual(vault, intent.vaultAddress)) {
    addressMismatch("deposit target vault", vault.toLowerCase(), intent.vaultAddress.toLowerCase());
  }
  if (assets !== intent.amountRaw) amountMismatch("deposited amount", assets, intent.amountRaw);
  if (!isAddressEqual(receiver, intent.recipient)) {
    addressMismatch("share recipient", receiver.toLowerCase(), intent.recipient.toLowerCase());
  }
  if (maxSharePrice <= 0n) {
    reject(
      "Refusing a Morpho deposit: it carries no positive `maxSharePrice`, so nothing on-chain would stop the "
      + "deposit from minting at any share price at all. That guard is the deposit's entire price protection.",
      REJECT_HINT,
    );
  }
  const ceiling = bounds.maxSharePriceCeilingRaw;
  if (ceiling === undefined) {
    reject(
      "Refusing a Morpho deposit: Vex computed no `maxSharePrice` ceiling of its own to check the built one "
      + "against, so the guard in the transaction is unverified.",
      REJECT_HINT,
    );
  }
  if (maxSharePrice > ceiling) {
    reject(
      `Refusing a Morpho deposit: its on-chain price guard allows a share price of ${maxSharePrice}, above the `
      + `${ceiling} Vex derived from the vault's current share price at the requested slippage. The transaction `
      + "would tolerate a worse price than was authorised.",
      REJECT_HINT,
    );
  }
  return {
    summary:
      `deposits ${assets} raw asset units into vault ${vault.toLowerCase()} for ${receiver.toLowerCase()}, `
      + `refusing on-chain any share price above ${maxSharePrice}`,
    maxSharePriceRaw: maxSharePrice,
    verifiedAmountRaw: assets,
    verifiedRecipient: receiver.toLowerCase(),
  };
}

function verifyDeposit(
  tx: MorphoBuiltTransaction,
  intent: MorphoVaultIntent,
  bounds: MorphoBundleBounds,
): MorphoBundleReport {
  const bundler3 = requirePinned(intent, "bundler3");
  if (!isAddressEqual(tx.to as Address, bundler3)) {
    reject(
      `Refusing a Morpho deposit: it would call ${tx.to.toLowerCase()}, which is not the Bundler3 `
      + `${bundler3.toLowerCase()} Vex has pinned for chain ${intent.chainId}.`,
      REJECT_HINT,
    );
  }
  const selector = selectorOf(tx.data);
  if (selector !== MORPHO_BUNDLER_ENTRY_CALL.selector.toLowerCase()) {
    reject(
      `Refusing a Morpho deposit: its entry selector ${selector} is not Bundler3's `
      + `${MORPHO_BUNDLER_ENTRY_CALL.selector} (${MORPHO_BUNDLER_ENTRY_CALL.signature}).`,
      REJECT_HINT,
    );
  }
  if ((tx.value ?? 0n) !== 0n) {
    reject(
      `Refusing a Morpho deposit: it would send ${tx.value} wei of native currency with the call. An ERC-20 vault `
      + "deposit moves no native value, and E3b-1 builds no native-wrapping path.",
      REJECT_HINT,
    );
  }

  const roles = intentRoles(intent);
  const calls = decodeOuterBundle(tx.data as Hex);
  if (calls.length === 0) {
    reject("Refusing a Morpho deposit: its Bundler3 bundle is empty, so it would deposit nothing.", REJECT_HINT);
  }

  const legs: MorphoDecodedLeg[] = [];
  let maxSharePriceRaw: bigint | null = null;
  let verifiedAmountRaw: bigint | null = null;
  let verifiedRecipient: string | null = null;

  calls.forEach((call, index) => {
    const targetRole = roles.get(call.to.toLowerCase());
    if (targetRole === undefined) {
      reject(
        `Refusing a Morpho deposit: leg ${index} calls ${call.to.toLowerCase()}, a contract with no role in this `
        + "operation. The only contracts a vault deposit may touch are the pinned Bundler3, GeneralAdapter1 and "
        + "Permit2 for this chain, the vault named in the request, and that vault's own asset.",
        REJECT_HINT,
      );
    }
    const legSelector = selectorOf(call.data);
    const allowedCall = findAllowedLeg(legSelector);
    if (allowedCall === undefined) {
      reject(
        `Refusing a Morpho deposit: leg ${index} carries the unknown selector ${legSelector}. Vex signs a vault `
        + `deposit only when every leg is one of: ${allowedLegSelectors().join("; ")}.`,
        REJECT_HINT,
      );
    }
    if (!allowedCall.targetRoles.includes(targetRole)) {
      reject(
        `Refusing a Morpho deposit: leg ${index} calls ${allowedCall.functionName} on the ${targetRole}, but that `
        + `function is only permitted on the ${allowedCall.targetRoles.join(" or ")}.`,
        REJECT_HINT,
      );
    }
    if (call.value !== 0n) {
      reject(
        `Refusing a Morpho deposit: leg ${index} (${allowedCall.functionName}) would move ${call.value} wei of `
        + "native currency. No leg of an ERC-20 vault deposit moves native value.",
        REJECT_HINT,
      );
    }
    if (call.skipRevert) {
      reject(
        `Refusing a Morpho deposit: leg ${index} (${allowedCall.functionName}) is marked skipRevert, so Bundler3 `
        + "would swallow its failure and carry on. A money-path leg that is allowed to fail silently is refused.",
        REJECT_HINT,
      );
    }
    if (call.callbackHash.toLowerCase() !== ZERO_CALLBACK_HASH) {
      reject(
        `Refusing a Morpho deposit: leg ${index} (${allowedCall.functionName}) declares a reentrancy callback hash. `
        + "A vault deposit needs none, and Vex does not sign a callback it has not decoded.",
        REJECT_HINT,
      );
    }

    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: allowedCall.abi, data: call.data });
    } catch {
      reject(
        `Refusing a Morpho deposit: leg ${index} matched the allowlisted selector ${legSelector} but its arguments `
        + "did not decode against the pinned ABI, so Vex cannot say what it would do.",
        REJECT_HINT,
      );
    }
    const verification = verifyDepositLeg(decoded.functionName, decoded.args ?? [], intent, bounds);
    if (verification.maxSharePriceRaw !== undefined) maxSharePriceRaw = verification.maxSharePriceRaw;
    if (verification.verifiedAmountRaw !== undefined) verifiedAmountRaw = verification.verifiedAmountRaw;
    if (verification.verifiedRecipient !== undefined) verifiedRecipient = verification.verifiedRecipient;

    legs.push({
      index,
      target: call.to.toLowerCase(),
      targetRole,
      selector: legSelector,
      functionName: allowedCall.functionName,
      signature: allowedCall.signature,
      valueRaw: call.value.toString(),
      skipRevert: call.skipRevert,
      summary: verification.summary,
    });
  });

  if (maxSharePriceRaw === null || verifiedAmountRaw === null || verifiedRecipient === null) {
    reject(
      "Refusing a Morpho deposit: its bundle contains no leg that actually deposits into the vault, so nothing in "
      + "it carries the price guard or the amount the request asked for.",
      REJECT_HINT,
    );
  }

  return {
    shape: "bundler3-multicall",
    to: tx.to.toLowerCase(),
    toRole: "bundler3",
    selector,
    functionName: MORPHO_BUNDLER_ENTRY_CALL.functionName,
    valueRaw: "0",
    legs,
    maxSharePriceRaw: (maxSharePriceRaw as bigint).toString(),
    verifiedAmountRaw: (verifiedAmountRaw as bigint).toString(),
    verifiedRecipient,
  };
}

function verifyWithdraw(tx: MorphoBuiltTransaction, intent: MorphoVaultIntent): MorphoBundleReport {
  if (!isAddressEqual(tx.to as Address, intent.vaultAddress)) {
    reject(
      `Refusing a Morpho withdrawal: it would call ${tx.to.toLowerCase()} rather than the vault `
      + `${intent.vaultAddress.toLowerCase()} the request named. A withdrawal is a direct call on the vault itself, `
      + "so any other target is the wrong contract.",
      REJECT_HINT,
    );
  }
  const selector = selectorOf(tx.data);
  if (selector !== MORPHO_VAULT_WITHDRAW_CALL.selector.toLowerCase()) {
    reject(
      `Refusing a Morpho withdrawal: its selector ${selector} is not the vault's `
      + `${MORPHO_VAULT_WITHDRAW_CALL.selector} (${MORPHO_VAULT_WITHDRAW_CALL.signature}).`,
      REJECT_HINT,
    );
  }
  if ((tx.value ?? 0n) !== 0n) {
    reject(
      `Refusing a Morpho withdrawal: it would send ${tx.value} wei of native currency with the call. A withdrawal `
      + "sends none.",
      REJECT_HINT,
    );
  }

  let decoded: { args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: MORPHO_VAULT_WITHDRAW_CALL.abi, data: tx.data as Hex });
  } catch {
    reject(
      "Refusing a Morpho withdrawal: its calldata did not decode against the pinned vault ABI.",
      REJECT_HINT,
    );
  }
  const [assets, receiver, owner] = (decoded.args ?? []) as [bigint, Address, Address];
  if (assets !== intent.amountRaw) amountMismatch("withdrawn amount", assets, intent.amountRaw);
  if (!isAddressEqual(receiver, intent.recipient)) {
    addressMismatch("asset recipient", receiver.toLowerCase(), intent.recipient.toLowerCase());
  }
  if (!isAddressEqual(owner, intent.userAddress)) {
    addressMismatch("share owner", owner.toLowerCase(), intent.userAddress.toLowerCase());
  }

  return {
    shape: "direct-vault-call",
    to: tx.to.toLowerCase(),
    toRole: "vault",
    selector,
    functionName: MORPHO_VAULT_WITHDRAW_CALL.functionName,
    valueRaw: "0",
    legs: [
      {
        index: 0,
        target: tx.to.toLowerCase(),
        targetRole: "vault",
        selector,
        functionName: MORPHO_VAULT_WITHDRAW_CALL.functionName,
        signature: MORPHO_VAULT_WITHDRAW_CALL.signature,
        valueRaw: "0",
        skipRevert: false,
        summary:
          `burns ${owner.toLowerCase()}'s shares to withdraw ${assets} raw asset units to ${receiver.toLowerCase()}`,
      },
    ],
    maxSharePriceRaw: null,
    verifiedAmountRaw: assets.toString(),
    verifiedRecipient: receiver.toLowerCase(),
  };
}

/**
 * Decode a built Morpho vault transaction and prove it matches the intent, or
 * refuse BY NAME.
 *
 * @throws {VexError} `MORPHO_BUNDLE_REJECTED` on any mismatch, unknown target,
 * unknown selector, unexpected value, or undecodable leg. There is no
 * pass-through and no partial acceptance.
 */
export function verifyMorphoVaultTransaction(
  tx: MorphoBuiltTransaction,
  intent: MorphoVaultIntent,
  bounds: MorphoBundleBounds = {},
): MorphoBundleReport {
  return intent.direction === "deposit" ? verifyDeposit(tx, intent, bounds) : verifyWithdraw(tx, intent);
}

/** The allowlist as report material, so a quote can show what it checked against. */
export function describeMorphoBundleAllowlist(): readonly string[] {
  return [
    `entry (deposit): ${MORPHO_BUNDLER_ENTRY_CALL.signature} on the pinned Bundler3`,
    `entry (withdraw): ${MORPHO_VAULT_WITHDRAW_CALL.signature} directly on the vault`,
    ...MORPHO_ALLOWED_BUNDLE_LEGS.map((call) => `leg: ${call.signature} on the ${call.targetRoles.join("/")}`),
  ];
}
