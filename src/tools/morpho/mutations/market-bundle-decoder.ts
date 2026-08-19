/**
 * Leg-by-leg decode and verification of a Morpho BLUE MARKET transaction built
 * by the SDK, the sibling of `./bundle-decoder.ts` for the borrow lane.
 *
 * TWO SHAPES EXIST IN THIS LANE AND ONLY ONE LIVES HERE. Under the owner's
 * option-1 ruling `borrow` and `withdraw_collateral` are DIRECT Morpho Blue
 * calls with no bundle at all, and `./blue-call-decoder.ts` proves that shape.
 * `supply_collateral` and `repay` are the two the SDK still routes through
 * Bundler3, so they are the two this file reads.
 *
 * EVERY SELECTOR AND EVERY LEG ORDER BELOW IS CITED TO A CAPTURE, never to
 * documentation and never to a guess. The capture is
 * `agents_dm/morpho-e3/fixtures/base-borrow-bundles.json`, taken 2026-08-17
 * against the real Base cbBTC/USDC market on an Anvil fork:
 *
 *   supplyCollateral   captures[0]  Bundler3 0x374f435d multicall, 2 legs on
 *                                   GeneralAdapter1:
 *                                     0xd96ca0b9 erc20TransferFrom
 *                                     0xca463673 morphoSupplyCollateral
 *   repay(assets)      captures[1]  same entry, 2 legs:
 *                                     0xd96ca0b9 erc20TransferFrom
 *                                     0x4d5fcf68 morphoRepay
 *   repay(shares)      captures[2]  same entry, THREE legs:
 *                                     0xd96ca0b9 erc20TransferFrom
 *                                     0x4d5fcf68 morphoRepay
 *                                     0x3790767d erc20Transfer   (residual sweep)
 *
 * THE THIRD LEG IS WHY THIS FILE IS NOT A COPY OF THE VAULT DECODER. A
 * repayment denominated in SHARES cannot know its asset cost in advance, so the
 * SDK pulls MORE than the debt and sweeps the remainder back with a final
 * `erc20Transfer` whose amount is the MaxUint256 "send your whole balance"
 * sentinel. In the capture the debt was 500,000,001 raw USDC and the approval
 * requirement was 500,005,281. Two consequences, both enforced below:
 *
 *   1. the pull leg is measured against the TRANSFER BOUND the caller approved,
 *      not against the debt. Measuring against the debt would refuse every
 *      correct shares repayment.
 *   2. the sweep's recipient must be the user. A sweep pointing anywhere else is
 *      the entire over-transfer walking away, and it is the one leg in this lane
 *      where a single wrong address is a total loss of the excess.
 *
 * REFUSE, NEVER DOWNGRADE, exactly as the vault decoder does. Every failure
 * throws. There is no "verified: false" a caller can read past, and an
 * undecodable leg is refused on the same footing as a hostile one.
 */

import { decodeFunctionData, isAddressEqual, type Address, type Hex } from "viem";

import { allowedLegSelectors, findAllowedLeg, MORPHO_BUNDLER_ENTRY_CALL } from "./allowlist.js";
import type { MorphoBorrowIntent } from "./borrow-types.js";
import type { MorphoDecodedLeg } from "./types.js";
import {
  EXPECTED_LEGS,
  ZERO_CALLBACK_HASH,
  bundleKindOf,
  contractsFor,
  decodeOuterBundle,
  reject,
  selectorOf,
  type MorphoMarketBundleBounds,
  type MorphoMarketBundleReport,
  type MorphoMarketParamsTuple,
} from "./market-bundle-decoder/contract.js";
import { buildLegContext, verifyLeg } from "./market-bundle-decoder/legs.js";

export type {
  MorphoMarketBundleBounds,
  MorphoMarketBundleReport,
  MorphoMarketParamsTuple,
} from "./market-bundle-decoder/contract.js";

/**
 * Decode a built Morpho MARKET transaction and prove it matches the intent, or
 * refuse BY NAME.
 *
 * Accepts only the two bundled market operations. `borrow` and
 * `withdraw_collateral` are direct Blue calls and belong to
 * `verifyMorphoBlueCall` in `./blue-call-decoder.ts`.
 *
 * @throws {VexError} `MORPHO_BUNDLE_REJECTED` on any mismatch, unknown target,
 * unknown selector, unexpected leg order, unexpected value, non-empty callback,
 * or undecodable leg. There is no pass-through and no partial acceptance.
 */
export function verifyMorphoMarketBundle(
  tx: { readonly to: string; readonly data: string; readonly value?: bigint | undefined },
  intent: MorphoBorrowIntent,
  params: MorphoMarketParamsTuple,
  bounds: MorphoMarketBundleBounds = {},
): MorphoMarketBundleReport {
  const kind = bundleKindOf(intent);
  const { bundler3, generalAdapter1 } = contractsFor(intent.market.chainId);

  if (!isAddressEqual(tx.to as Address, bundler3)) {
    reject(
      `Refusing a Morpho ${intent.operation}: it would call ${tx.to.toLowerCase()}, which is not the Bundler3 `
      + `${bundler3.toLowerCase()} Vex has pinned for chain ${intent.market.chainId}.`,
    );
  }
  const selector = selectorOf(tx.data);
  if (selector !== MORPHO_BUNDLER_ENTRY_CALL.selector.toLowerCase()) {
    reject(
      `Refusing a Morpho ${intent.operation}: its entry selector ${selector} is not Bundler3's `
      + `${MORPHO_BUNDLER_ENTRY_CALL.selector} (${MORPHO_BUNDLER_ENTRY_CALL.signature}).`,
    );
  }
  if ((tx.value ?? 0n) !== 0n) {
    reject(
      `Refusing a Morpho ${intent.operation}: it would send ${tx.value} wei of native currency with the call. No `
      + "ERC-20 market operation Vex builds moves native value.",
    );
  }

  const calls = decodeOuterBundle(tx.data as Hex);
  const expected = EXPECTED_LEGS[kind];
  if (calls.length !== expected.length) {
    reject(
      `Refusing a Morpho ${intent.operation}: its bundle carries ${calls.length} legs where the captured build for `
      + `this operation carries exactly ${expected.length} (${expected.join(", ")}). A leg count Vex has never `
      + "observed is refused rather than read optimistically.",
    );
  }

  const ctx = buildLegContext(intent, params, kind, generalAdapter1, bounds);
  const legs: MorphoDecodedLeg[] = [];
  let pulledAmountRaw: bigint | null = null;
  let verifiedAmountRaw: bigint | null = null;
  let verifiedSharesRaw: bigint | null = null;
  let maxSharePriceRaw: bigint | null = null;
  let sweepRecipient: string | null = null;

  calls.forEach((call, index) => {
    if (!isAddressEqual(call.to, generalAdapter1)) {
      reject(
        `Refusing a Morpho ${intent.operation}: leg ${index} calls ${call.to.toLowerCase()}, which is not the pinned `
        + `GeneralAdapter1 ${generalAdapter1.toLowerCase()}. Every leg of every captured market bundle targets the `
        + "adapter and nothing else.",
      );
    }
    const legSelector = selectorOf(call.data);
    const allowedCall = findAllowedLeg(legSelector);
    if (allowedCall === undefined) {
      reject(
        `Refusing a Morpho ${intent.operation}: leg ${index} carries the unknown selector ${legSelector}. Vex signs a `
        + `market operation only when every leg is one of: ${allowedLegSelectors().join("; ")}.`,
      );
    }
    const expectedName = expected[index]!;
    if (allowedCall.functionName !== expectedName) {
      reject(
        `Refusing a Morpho ${intent.operation}: leg ${index} is ${allowedCall.functionName} where the captured build `
        + `has ${expectedName}. The leg ORDER is part of the shape: it is what makes the pull precede the spend and `
        + "the residual sweep follow it.",
      );
    }
    if (!allowedCall.targetRoles.includes("generalAdapter1")) {
      reject(
        `Refusing a Morpho ${intent.operation}: leg ${index} calls ${allowedCall.functionName} on the adapter, but `
        + `that function is only permitted on the ${allowedCall.targetRoles.join(" or ")}.`,
      );
    }
    if (call.value !== 0n) {
      reject(
        `Refusing a Morpho ${intent.operation}: leg ${index} (${allowedCall.functionName}) would move ${call.value} `
        + "wei of native currency. No leg of an ERC-20 market operation moves native value.",
      );
    }
    if (call.skipRevert) {
      reject(
        `Refusing a Morpho ${intent.operation}: leg ${index} (${allowedCall.functionName}) is marked skipRevert, so `
        + "Bundler3 would swallow its failure and carry on. A money-path leg allowed to fail silently is refused.",
      );
    }
    if (call.callbackHash.toLowerCase() !== ZERO_CALLBACK_HASH) {
      reject(
        `Refusing a Morpho ${intent.operation}: leg ${index} (${allowedCall.functionName}) declares a reentrancy `
        + "callback hash. No captured market bundle needs one, and Vex does not sign a callback it has not decoded.",
      );
    }

    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: allowedCall.abi, data: call.data });
    } catch {
      reject(
        `Refusing a Morpho ${intent.operation}: leg ${index} matched the allowlisted selector ${legSelector} but its `
        + "arguments did not decode against the pinned ABI, so Vex cannot say what it would do.",
      );
    }
    const verification = verifyLeg(decoded.functionName, decoded.args ?? [], ctx);
    if (verification.pulledAmountRaw !== undefined) pulledAmountRaw = verification.pulledAmountRaw;
    if (verification.verifiedAmountRaw !== undefined) verifiedAmountRaw = verification.verifiedAmountRaw;
    if (verification.verifiedSharesRaw !== undefined) verifiedSharesRaw = verification.verifiedSharesRaw;
    if (verification.maxSharePriceRaw !== undefined) {
      maxSharePriceRaw = verification.maxSharePriceRaw;
    }
    if (verification.sweepRecipient !== undefined) sweepRecipient = verification.sweepRecipient;

    legs.push({
      index,
      target: call.to.toLowerCase(),
      targetRole: "generalAdapter1",
      selector: legSelector,
      functionName: allowedCall.functionName,
      signature: allowedCall.signature,
      valueRaw: call.value.toString(),
      skipRevert: call.skipRevert,
      summary: verification.summary,
    });
  });

  if (pulledAmountRaw === null) {
    reject(
      `Refusing a Morpho ${intent.operation}: no leg of its bundle actually pulls the token from the wallet, so `
      + "nothing in it carries the amount the request asked for.",
    );
  }
  if (kind === "repay_shares" && sweepRecipient === null) {
    reject(
      "Refusing a Morpho repayment denominated in shares: its bundle has no residual sweep. The build pulls more "
      + "than the debt by design, and without a sweep the over-pull stays in the adapter rather than coming back.",
    );
  }

  return {
    shape: "bundler3-multicall",
    to: tx.to.toLowerCase(),
    toRole: "bundler3",
    selector,
    functionName: MORPHO_BUNDLER_ENTRY_CALL.functionName,
    valueRaw: "0",
    // Narrowed from the bundle KIND rather than re-derived from the intent: the
    // kind is what the leg shape was actually checked against, and a report that
    // named a different operation than the one verified would be a second,
    // softer account of the same fact.
    operation: kind === "repay_assets" || kind === "repay_shares" ? "repay" : kind,
    legs,
    pulledToken: ctx.pullToken.toLowerCase(),
    pulledAmountRaw: (pulledAmountRaw as bigint).toString(),
    verifiedAmountRaw: verifiedAmountRaw === null ? null : (verifiedAmountRaw as bigint).toString(),
    verifiedSharesRaw: verifiedSharesRaw === null ? null : (verifiedSharesRaw as bigint).toString(),
    maxSharePriceRaw:
      maxSharePriceRaw === null ? null : (maxSharePriceRaw as bigint).toString(),
    sweepRecipient,
  };
}
