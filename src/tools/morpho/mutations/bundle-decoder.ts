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
 *   4. A deposit's bundle carries EXACTLY the captured legs, in EXACTLY the
 *      captured order, every one of them on the pinned GeneralAdapter1.
 *   5. Every inner leg decodes, carries an allowlisted selector, moves no
 *      value, and is not marked `skipRevert` or given a reentrancy callback.
 *   6. The amounts, the vault, the PULL DESTINATION and the recipient inside
 *      the legs match the intent rather than merely resembling it.
 *   7. A deposit carries a `maxSharePrice` guard, and that guard is at or below
 *      the ceiling the caller computed from the fresh share price and the
 *      declared slippage.
 *
 * WHY (4) IS A COUNT AND AN ORDER RATHER THAN A SET. An earlier version of this
 * file accepted any non-empty list of individually allowlisted legs and asked
 * only that SOME deposit had occurred. Each leg was legal in isolation and the
 * bundle as a whole was not: TWO `erc20TransferFrom` legs plus one deposit is
 * two pulls against one deposit, and a pre-existing allowance large enough to
 * cover both (a state `./allowance-plan.ts` explicitly supports) makes the
 * second pull succeed and strand its amount in the adapter. Reordering passed
 * for the same reason. The captured build is two legs in one order, so that is
 * the contract, matching the market decoder's shape in
 * `./market-bundle-decoder.ts`.
 *
 * WHY THE PULL DESTINATION IS ASSERTED. `erc20TransferFrom(asset, receiver,
 * amount)` moves the user's money, and the earlier version checked the token
 * and the amount but never the RECEIVER. A leg pulling the right token in the
 * right amount to the wrong address is a total loss of that amount, so the
 * receiver is pinned to the GeneralAdapter1 the deposit leg then spends from.
 *
 * The comparison in (7) is a bound DERIVED FROM THE APPROVED SLIPPAGE and is
 * the same bound the vault enforces on-chain through `maxSharePrice`. It is
 * compared as an absolute share-price ceiling rather than as a percentage
 * re-derived here, so the decoder cannot quietly authorise a worse price than
 * the caller approved. It is not size-independent: a ceiling derived from a
 * per-share price necessarily applies to whatever size is deposited, exactly as
 * the on-chain guard does.
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

/**
 * The legs a captured vault deposit carries, in the order it carries them.
 *
 * PROVENANCE: `agents_dm/morpho-e3/fixtures/base-vault-bundles.json`, captured
 * 2026-08-17 on Base. Both the V2 and the V1 deposit decode to exactly these
 * two legs, in this order, both on GeneralAdapter1. A bundle of any other
 * length or order is refused rather than read optimistically.
 */
const EXPECTED_DEPOSIT_LEGS = ["erc20TransferFrom", "erc4626Deposit"] as const;

function requirePinned(intent: MorphoVaultIntent, role: "bundler3" | "generalAdapter1"): Address {
  const address = MORPHO_CONTRACTS[intent.chainId]?.[role];
  if (address === null || address === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_CONTRACT_UNAVAILABLE,
      `The pinned registry has no ${role} address on chain ${intent.chainId}, so Vex cannot confirm that a `
      + "bundled Morpho action would enter through, and move funds through, the contracts it is supposed to.",
      `A bundled deposit is refused on a chain whose ${role} Vex has not pinned. Re-extract the registry to add one.`,
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
  generalAdapter1: Address,
): LegVerification {
  if (functionName === "erc20TransferFrom") {
    const [asset, receiver, amount] = args as [Address, Address, bigint];
    if (!isAddressEqual(asset, intent.assetAddress)) {
      addressMismatch("pulled token", asset.toLowerCase(), intent.assetAddress.toLowerCase());
    }
    if (amount !== intent.amountRaw) amountMismatch("pulled amount", amount, intent.amountRaw);
    // The destination of the user's money. Checking the token and the amount
    // while leaving this free would let a leg pull exactly the right asset in
    // exactly the right size to an address that simply keeps it.
    if (!isAddressEqual(receiver, generalAdapter1)) {
      addressMismatch("pull destination", receiver.toLowerCase(), generalAdapter1.toLowerCase());
    }
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

  const generalAdapter1 = requirePinned(intent, "generalAdapter1");
  const calls = decodeOuterBundle(tx.data as Hex);
  if (calls.length !== EXPECTED_DEPOSIT_LEGS.length) {
    reject(
      `Refusing a Morpho deposit: its Bundler3 bundle carries ${calls.length} legs where the captured build for a `
      + `vault deposit carries exactly ${EXPECTED_DEPOSIT_LEGS.length} `
      + `(${EXPECTED_DEPOSIT_LEGS.join(", ")}). A leg count Vex has never observed is refused rather than read `
      + "optimistically: an extra pull leg is a second debit of the wallet against a single deposit.",
      REJECT_HINT,
    );
  }

  const legs: MorphoDecodedLeg[] = [];
  let maxSharePriceRaw: bigint | null = null;
  let verifiedAmountRaw: bigint | null = null;
  let verifiedRecipient: string | null = null;

  calls.forEach((call, index) => {
    if (!isAddressEqual(call.to, generalAdapter1)) {
      reject(
        `Refusing a Morpho deposit: leg ${index} calls ${call.to.toLowerCase()}, which is not the pinned `
        + `GeneralAdapter1 ${generalAdapter1.toLowerCase()} for chain ${intent.chainId}. Every leg of every captured `
        + "vault deposit targets the adapter and nothing else.",
        REJECT_HINT,
      );
    }
    const targetRole = "generalAdapter1" as const;
    const legSelector = selectorOf(call.data);
    const allowedCall = findAllowedLeg(legSelector);
    if (allowedCall === undefined) {
      reject(
        `Refusing a Morpho deposit: leg ${index} carries the unknown selector ${legSelector}. Vex signs a vault `
        + `deposit only when every leg is one of: ${allowedLegSelectors().join("; ")}.`,
        REJECT_HINT,
      );
    }
    const expectedName = EXPECTED_DEPOSIT_LEGS[index];
    if (allowedCall.functionName !== expectedName) {
      reject(
        `Refusing a Morpho deposit: leg ${index} is ${allowedCall.functionName} where the captured build has `
        + `${expectedName}. The leg ORDER is part of the shape: it is what makes exactly one pull precede exactly `
        + "one deposit, so a reordered or duplicated leg cannot debit the wallet twice.",
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
    const verification = verifyDepositLeg(
      decoded.functionName,
      decoded.args ?? [],
      intent,
      bounds,
      generalAdapter1,
    );
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

  // The leg count and leg order checked above already guarantee an
  // `erc4626Deposit` at index 1, which is what sets all three. This narrows
  // those values for the report and refuses rather than reporting a partial
  // verdict if that invariant is ever broken by a future edit.
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
