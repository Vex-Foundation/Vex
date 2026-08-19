/**
 * The pools.fun calldata verifier - all 13 points, PURE.
 *
 * Pure on purpose: every input (the provider response, the decoded tuple, the
 * anchored chain reads, the metadata document, the simulation results) is passed
 * in, so each point can be tested directly, including the adversarial cases
 * where exactly one field of an otherwise-valid tuple is tampered with. The
 * caller owns the I/O; this module owns the judgement.
 *
 * EVERY POINT IS REQUIRED. There is no partial pass, no warn-and-continue, and
 * no "the provider is usually right" path. The function returns either a
 * verified tuple or the complete list of violations, and the launch handler
 * signs only on `ok: true`.
 *
 * ALL VIOLATIONS ARE COLLECTED rather than short-circuited at the first one.
 * A refusal that names one problem invites a retry that hits the next; naming
 * every failed point in one answer is what lets a caller (or a human reading the
 * refusal) understand the actual state.
 */

import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { POOLS_GATEWAY_ABI } from "../abi.js";
import { POOLS_FACTORY_ADDRESS, POOLS_GATEWAY_ADDRESS } from "../constants.js";
import type {
  PoolsChainAnchors,
  PoolsLaunchTuple,
  PoolsVerifierExpectation,
  PoolsVerifierPoint,
  PoolsVerifierResult,
  PoolsVerifierViolation,
} from "./verifier-types.js";
import type { PoolsPrepareResponse } from "../types.js";

/** The metadata document a launch pins, as the verifier reads it. */
export interface PoolsMetadataDocument {
  readonly name?: unknown;
  readonly symbol?: unknown;
  readonly image?: unknown;
  readonly initial_deployer?: unknown;
  readonly initial_fee_recipient?: unknown;
}

/** The results of the two simulations the verifier depends on. */
export interface PoolsSimulationResults {
  /** `eth_call` of the launch with `devBuyMinOut = 0`: the deterministic fill. */
  readonly simulatedDevBuyOut: bigint;
  /** The token address that same call returned. */
  readonly simulatedTokenAddress: Address;
  /** Whether the FINAL calldata (minOut pinned to the fill) still simulates. */
  readonly finalSimulationSucceeded: boolean;
  /** Failure reason when it did not, for the refusal text. */
  readonly finalSimulationError?: string | undefined;
}

export interface VerifyPoolsCalldataInput {
  readonly response: PoolsPrepareResponse;
  readonly expectation: PoolsVerifierExpectation;
  readonly anchors: PoolsChainAnchors;
  readonly metadata: PoolsMetadataDocument | null;
  readonly simulation: PoolsSimulationResults;
  /** Upper bound on gas cost, and the Vex fee, both inside the authorized max spend. */
  readonly gasBoundWei: bigint;
  readonly vexFeeWei: bigint;
  /** The gateway Vex pins. Defaults to the constant; injectable for tests. */
  readonly gatewayAddress?: Address | undefined;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Case-insensitive address equality that also refuses a malformed input. */
function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Decode the calldata into the named tuple.
 *
 * A decode failure is itself a verdict: calldata that does not decode as
 * `launch` cannot be reasoned about at all, so the caller gets a violation
 * rather than an exception.
 */
export function decodeLaunchCalldata(data: Hex): PoolsLaunchTuple | null {
  try {
    const decoded = decodeFunctionData({ abi: POOLS_GATEWAY_ABI, data });
    if (decoded.functionName !== "launch") return null;
    const [params] = decoded.args as readonly [PoolsLaunchTuple];
    return params;
  } catch {
    return null;
  }
}

/** Re-encode a tuple, for the canonical-encoding proof. */
function encodeLaunchTuple(tuple: PoolsLaunchTuple): Hex {
  return encodeFunctionData({ abi: POOLS_GATEWAY_ABI, functionName: "launch", args: [tuple] });
}

/** Pull an address out of a metadata sub-object shaped `{address}`. */
function metadataAddress(value: unknown): string | null {
  if (value !== null && typeof value === "object" && "address" in value) {
    const address = (value as { address?: unknown }).address;
    return typeof address === "string" ? address : null;
  }
  return typeof value === "string" ? value : null;
}

export function verifyPoolsLaunchCalldata(input: VerifyPoolsCalldataInput): PoolsVerifierResult {
  const { response, expectation, anchors, metadata, simulation } = input;
  const gateway = (input.gatewayAddress ?? POOLS_GATEWAY_ADDRESS) as Address;
  const violations: PoolsVerifierViolation[] = [];
  const checked: PoolsVerifierPoint[] = [];

  const fail = (point: PoolsVerifierPoint, detail: string): void => {
    violations.push({ point, detail });
  };
  const pass = (point: PoolsVerifierPoint): void => {
    checked.push(point);
  };

  // ── 1. Gateway identity, liveness, fee and bounds ─────────────────
  //
  // The fee is checked against the CONTRACT's own current value AND its
  // MIN/MAX bounds, not just against `/launches/config`: the fee is dynamic
  // (measured moving 4x in a day), so a response quoting yesterday's fee is a
  // guaranteed revert, and a response quoting a fee outside the contract's own
  // bounds is a response the contract itself would refuse.
  {
    let ok = true;
    if (!sameAddress(response.to, gateway)) {
      fail("gateway_identity", `calldata targets ${response.to}, not the pinned gateway ${gateway}`);
      ok = false;
    }
    // IDENTITY, not just address. `VERSION` and `factory` were being READ into
    // the anchors and never compared, which made point 1's "match pinned
    // expectations" half true: an upgraded gateway (same address, new code and
    // possibly a new tuple meaning) or one pointing at a different factory would
    // have passed. Both are compared here, against the version the quote was
    // built for and against the pinned PartyFactory.
    if (anchors.gatewayVersion !== expectation.gatewayVersion) {
      fail(
        "gateway_identity",
        `the gateway is at VERSION ${anchors.gatewayVersion} but this launch was prepared against version `
          + `${expectation.gatewayVersion}; the calldata was built for different code`,
      );
      ok = false;
    }
    if (!sameAddress(anchors.gatewayFactory, POOLS_FACTORY_ADDRESS)) {
      fail(
        "gateway_identity",
        `the gateway's factory is ${anchors.gatewayFactory}, not the pinned PartyFactory `
          + `${POOLS_FACTORY_ADDRESS}`,
      );
      ok = false;
    }
    if (anchors.gatewayPaused) {
      fail("gateway_identity", "the gateway is PAUSED at the anchored block; a launch would revert");
      ok = false;
    }
    if (anchors.gatewayDeploymentFeeWei.toString() !== response.deploymentFeeWei) {
      fail(
        "gateway_identity",
        `the gateway's live deployment fee is ${anchors.gatewayDeploymentFeeWei} wei but the response quotes `
          + `${response.deploymentFeeWei} wei; this fee is dynamic and a stale quote reverts`,
      );
      ok = false;
    }
    const quotedFee = BigInt(response.deploymentFeeWei);
    if (quotedFee < anchors.gatewayMinFeeWei || quotedFee > anchors.gatewayMaxFeeWei) {
      fail(
        "gateway_identity",
        `the quoted fee ${quotedFee} wei is outside the gateway's own bounds `
          + `[${anchors.gatewayMinFeeWei}, ${anchors.gatewayMaxFeeWei}]`,
      );
      ok = false;
    }
    if (ok) pass("gateway_identity");
  }

  // ── 2. The provider's own staleness flag ──────────────────────────
  if (response.requiresReprepare) {
    fail("requires_reprepare", "the provider set requiresReprepare: this quote is stale and must be redone");
  } else {
    pass("requires_reprepare");
  }

  // ── 3. Selector and canonical re-encoding ─────────────────────────
  //
  // Re-encoding proves there is no trailing garbage, no alternative encoding,
  // and no field the decoder ignored: if the tuple we BELIEVE we are signing
  // re-encodes to bytes other than the ones we were handed, the difference is
  // something we did not see.
  const tuple = decodeLaunchCalldata(response.data as Hex);
  if (tuple === null) {
    fail("selector_and_encoding", "the calldata does not decode as PoolsFunLaunchGateway.launch");
    // Every remaining point reads the tuple, so there is nothing further to say.
    return { ok: false, violations };
  }
  {
    const reencoded = encodeLaunchTuple(tuple);
    if (reencoded.toLowerCase() !== response.data.toLowerCase()) {
      fail(
        "selector_and_encoding",
        "the decoded tuple does not re-encode to the calldata byte-for-byte, so the bytes carry something "
          + "the decode did not show",
      );
    } else {
      pass("selector_and_encoding");
    }
  }

  // ── 4. Mirrored response fields agree with the calldata ───────────
  //
  // The response repeats values that are ALSO inside the calldata. The repeats
  // are what a UI shows and what a human approves, so a disagreement between
  // the two is precisely the shape of an attack: show one thing, sign another.
  {
    let ok = true;
    const mirror = (label: string, fromResponse: string, fromCalldata: string): void => {
      if (fromResponse.toLowerCase() !== fromCalldata.toLowerCase()) {
        fail("response_mirrors_calldata", `${label}: response says ${fromResponse}, calldata says ${fromCalldata}`);
        ok = false;
      }
    };
    mirror("salt", response.salt, tuple.userSalt);
    mirror("metadataUri", response.metadataUri, tuple.metadataUri);
    mirror("deadline", response.deadline, tuple.deadline.toString());
    mirror("devBuyMinOut", response.devBuyMinOut, tuple.devBuyMinOut.toString());
    mirror("nativeDevBuyWei", response.nativeDevBuyWei, tuple.nativeDevBuyAmount.toString());
    mirror("deploymentFeeWei", response.deploymentFeeWei, tuple.expectedFeeWei.toString());
    mirror("tokenSymbol", response.tokenSymbol, tuple.symbol);
    // The response states the recipient as `{address, display}`. The ADDRESS is
    // what must agree with the tuple: `display` is a truncated label and could
    // never be compared to a full address.
    if (!sameAddress(response.feeRecipient.address, tuple.feeRecipient)) {
      fail(
        "response_mirrors_calldata",
        `feeRecipient: response says ${response.feeRecipient.address}, calldata says ${tuple.feeRecipient}`,
      );
      ok = false;
    }
    // The name is not mirrored in the response, so it is checked against what
    // the CALLER asked for - the only other place it can be proven.
    if (tuple.name !== expectation.name) {
      fail("response_mirrors_calldata", `name: requested "${expectation.name}", calldata says "${tuple.name}"`);
      ok = false;
    }
    // THE RECIPIENT IS EXACT, AND ZERO IS REJECTED. The gateway does treat zero
    // as msg.sender, but signing a tuple that does not say who is paid means a
    // later gateway change silently redirects the fee stream.
    if (sameAddress(tuple.feeRecipient, ZERO_ADDRESS)) {
      fail(
        "response_mirrors_calldata",
        "feeRecipient is the zero address; Vex always sends the recipient EXPLICITLY so the signed tuple "
          + "states where the fee stream goes",
      );
      ok = false;
    } else if (!sameAddress(tuple.feeRecipient, expectation.feeRecipient)) {
      fail(
        "response_mirrors_calldata",
        `feeRecipient is ${tuple.feeRecipient} but this launch intends ${expectation.feeRecipient}`,
      );
      ok = false;
    }
    if (ok) pass("response_mirrors_calldata");
  }

  // ── 5. The pair maps to that address AND is allowlisted ───────────
  {
    let ok = true;
    if (!sameAddress(tuple.pairedAsset, expectation.pairedAssetAddress)) {
      fail(
        "paired_asset_allowlisted",
        `the tuple pairs against ${tuple.pairedAsset}, but "${expectation.pairedAsset}" is `
          + `${expectation.pairedAssetAddress}`,
      );
      ok = false;
    }
    // A `weth` pair has an on-chain definition, so it is held to it rather than
    // to a constant: the gateway's own `weth` is the address its native-prebuy
    // guard compares against, and a pair the caller CALLS weth but which is a
    // different token would trade against something else entirely.
    if (expectation.pairedAsset === "weth" && !sameAddress(tuple.pairedAsset, anchors.gatewayWeth)) {
      fail(
        "paired_asset_allowlisted",
        `the tuple pairs against ${tuple.pairedAsset}, but the gateway's own WETH is ${anchors.gatewayWeth}`,
      );
      ok = false;
    }
    if (!anchors.pairedAssetAllowed) {
      fail(
        "paired_asset_allowlisted",
        `allowedPairedAsset(${tuple.pairedAsset}) is false at block ${anchors.blockNumber}; the factory would `
          + "refuse this pair",
      );
      ok = false;
    }
    if (ok) pass("paired_asset_allowlisted");
  }

  // ── 6. Start tick, including the live/fallback flag ───────────────
  //
  // The flag matters as much as the number: a tuple pinned while the price feed
  // was live, executed when the factory has fallen back (or the reverse), is a
  // launch at a different opening price than the one approved.
  {
    if (tuple.expectedStartTick !== anchors.startTick) {
      fail(
        "start_tick_agrees",
        `the tuple pins startTick ${tuple.expectedStartTick} but the factory would use ${anchors.startTick} `
          + `at block ${anchors.blockNumber}`,
      );
    } else if (!anchors.startTickLive) {
      fail(
        "start_tick_agrees",
        "the factory's start tick is currently the FALLBACK, not the live feed; the opening price would not be "
          + "the one this launch was priced against",
      );
    } else {
      pass("start_tick_agrees");
    }
  }

  // ── 7. The metadata says what was requested ───────────────────────
  //
  // The metadata is what the world sees. It is also where the provider's image
  // trap lives: `image` in the REQUEST is silently dropped and only `imageUrl`
  // lands, so a launch can otherwise succeed with a blank token.
  {
    let ok = true;
    if (metadata === null) {
      fail("metadata_matches_request", "the metadata document could not be fetched within its size/time bounds");
      ok = false;
    } else {
      if (metadata.name !== expectation.name) {
        fail("metadata_matches_request", `metadata name is ${JSON.stringify(metadata.name)}, requested "${expectation.name}"`);
        ok = false;
      }
      if (metadata.symbol !== tuple.symbol) {
        fail("metadata_matches_request", `metadata symbol is ${JSON.stringify(metadata.symbol)}, tuple says "${tuple.symbol}"`);
        ok = false;
      }
      const recipient = metadataAddress(metadata.initial_fee_recipient);
      if (recipient !== null && !sameAddress(recipient, expectation.feeRecipient)) {
        fail("metadata_matches_request", `metadata fee recipient ${recipient} is not the intended ${expectation.feeRecipient}`);
        ok = false;
      }
      const deployer = metadataAddress(metadata.initial_deployer);
      if (deployer !== null && !sameAddress(deployer, expectation.launcher)) {
        fail("metadata_matches_request", `metadata deployer ${deployer} is not the launching wallet ${expectation.launcher}`);
        ok = false;
      }
      if (expectation.imageUrl !== undefined && typeof metadata.image !== "string") {
        fail(
          "metadata_matches_request",
          "an image was requested but the pinned metadata carries none. The provider accepts `image` and "
            + "silently drops it - only `imageUrl` lands",
        );
        ok = false;
      }
    }
    if (ok) pass("metadata_matches_request");
  }

  // ── 8. Three derivations of the token address agree ───────────────
  //
  // The provider's prediction, the gateway's own `computeTokenAddress`, and the
  // address an `eth_call` of this very launch returns. The user approves an
  // address; all three must be it.
  {
    const predicted = response.predictedTokenAddress;
    if (!sameAddress(predicted, anchors.computedTokenAddress)) {
      fail(
        "token_address_agrees",
        `the provider predicts ${predicted} but the gateway computes ${anchors.computedTokenAddress}`,
      );
    } else if (!sameAddress(predicted, simulation.simulatedTokenAddress)) {
      fail(
        "token_address_agrees",
        `the provider predicts ${predicted} but simulating the launch produces ${simulation.simulatedTokenAddress}`,
      );
    } else {
      pass("token_address_agrees");
    }
  }

  // ── 9. Dev-buy modes exclusive, amounts in the caller's units ─────
  {
    let ok = true;
    if (tuple.nativeDevBuyAmount > 0n && tuple.erc20DevBuyAmountIn > 0n) {
      fail("dev_buy_consistent", "both a native and an ERC-20 dev buy are set; the modes are mutually exclusive");
      ok = false;
    }
    // The gateway's own precondition, checked BEFORE signing rather than
    // discovered as a revert: `NativeDevBuyRequiresWeth` (verified source line
    // 140). A native prebuy against USDG burns gas and launches nothing.
    if (tuple.nativeDevBuyAmount > 0n && !sameAddress(tuple.pairedAsset, anchors.gatewayWeth)) {
      fail(
        "dev_buy_consistent",
        `a native (ETH) prebuy is only possible against the gateway's WETH ${anchors.gatewayWeth}, but this `
          + `launch pairs against ${tuple.pairedAsset}; the gateway would revert NativeDevBuyRequiresWeth`,
      );
      ok = false;
    }
    const intended = expectation.devBuy;
    if (intended === undefined) {
      if (tuple.nativeDevBuyAmount > 0n || tuple.erc20DevBuyAmountIn > 0n) {
        fail("dev_buy_consistent", "no prebuy was requested but the tuple carries one");
        ok = false;
      }
    } else if (intended.mode === "native") {
      if (tuple.nativeDevBuyAmount !== intended.amountWei) {
        fail(
          "dev_buy_consistent",
          `native prebuy is ${tuple.nativeDevBuyAmount} wei, requested ${intended.amountWei} wei`,
        );
        ok = false;
      }
      if (tuple.erc20DevBuyAmountIn !== 0n) {
        fail("dev_buy_consistent", "a native prebuy was requested but the tuple also sets an ERC-20 amount");
        ok = false;
      }
    } else {
      if (tuple.erc20DevBuyAmountIn !== intended.amountRaw) {
        fail(
          "dev_buy_consistent",
          `ERC-20 prebuy is ${tuple.erc20DevBuyAmountIn} raw units, requested ${intended.amountRaw}`,
        );
        ok = false;
      }
      if (tuple.nativeDevBuyAmount !== 0n) {
        fail("dev_buy_consistent", "an ERC-20 prebuy was requested but the tuple also sets a native amount");
        ok = false;
      }
    }
    // The floor is the EXACT simulated fill - a deterministic first swap, so an
    // absolute value, never a percentage band (rule 90: a tolerance on a money
    // comparison must not scale with size).
    if (intended !== undefined && tuple.devBuyMinOut !== simulation.simulatedDevBuyOut) {
      fail(
        "dev_buy_consistent",
        `devBuyMinOut is ${tuple.devBuyMinOut} but the simulated fill is exactly `
          + `${simulation.simulatedDevBuyOut}; the floor is pinned to the simulation, not to a band`,
      );
      ok = false;
    }
    if (ok) pass("dev_buy_consistent");
  }

  // ── 10. The FINAL calldata still simulates ────────────────────────
  //
  // Replacing `devBuyMinOut` changes the bytes that get signed, so the earlier
  // simulation no longer describes them. Simulating again is the only way to
  // know the transaction that will actually be broadcast succeeds.
  if (!simulation.finalSimulationSucceeded) {
    fail(
      "final_simulation",
      `the final calldata does not simulate: ${simulation.finalSimulationError ?? "no reason reported"}`,
    );
  } else {
    pass("final_simulation");
  }

  // ── 11. `value` is EXACTLY fee + native prebuy ────────────────────
  //
  // Exact, not "at least": any excess is native value leaving the wallet with
  // nothing accounting for it.
  {
    const expectedValue = tuple.expectedFeeWei + tuple.nativeDevBuyAmount;
    if (BigInt(response.value) !== expectedValue) {
      fail(
        "value_exact",
        `value is ${response.value} wei but fee (${tuple.expectedFeeWei}) + native prebuy `
          + `(${tuple.nativeDevBuyAmount}) is ${expectedValue}`,
      );
    } else {
      pass("value_exact");
    }
  }

  // ── 12. The wallet can pay value + gas bound + the Vex fee ────────
  //
  // The Vex fee is INCLUDED even though it is a separate later transaction: a
  // balance check that ignored a charge Vex itself imposes would be a
  // misleading check.
  {
    const total = BigInt(response.value) + input.gasBoundWei + input.vexFeeWei;
    if (anchors.nativeBalanceWei < total) {
      fail(
        "balance_covers_total",
        `the wallet holds ${anchors.nativeBalanceWei} wei but this launch needs up to ${total} `
          + `(value ${response.value} + gas bound ${input.gasBoundWei} + Vex fee ${input.vexFeeWei})`,
      );
    } else {
      pass("balance_covers_total");
    }
  }

  // ── 13. Fingerprint binding ───────────────────────────────────────
  //
  // The verifier's own contribution is that the tuple it PROVED is the tuple the
  // caller carries forward. The caller derives the authorization fingerprint
  // from the returned tuple and the response's own (to, data, value); returning
  // the decoded tuple rather than a boolean is what makes that possible without
  // re-deriving anything.
  pass("fingerprint_binding");

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, tuple, checked };
}
