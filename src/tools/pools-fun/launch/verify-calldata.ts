/**
 * The pools.fun calldata verifier - all 15 points, PURE.
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
import { POOLS_LAUNCH_SUITE_VERSION, poolsLaunchSuite } from "../constants.js";
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
  /**
   * The suite addresses the launch is held to. Defaults to
   * {@link poolsLaunchSuite}; injectable for tests only.
   *
   * NEVER the provider's `response.to`. The whole point of the suite table is
   * that the address a launch targets comes from Vex, and the provider's value
   * is the CLAIM being checked - a verifier that defaulted the expected gateway
   * to whatever the response named would prove `x === x`.
   */
  readonly gatewayAddress?: Address | undefined;
  readonly factoryAddress?: Address | undefined;
  readonly lockerAddress?: Address | undefined;
  /**
   * The safety margin, in seconds, a signed quote must still have left at the
   * anchored block. Signing a quote that expires while the transaction is in
   * flight burns the fee for a guaranteed revert, so the verifier requires
   * headroom rather than mere non-expiry.
   */
  readonly signedQuoteSafetyMarginSeconds?: bigint | undefined;
}

/**
 * How much of a signed quote's life must remain at the anchored block.
 *
 * The factory's own window is 30-120 s (`MIN/MAX_SIGNED_QUOTE_AGE`, measured),
 * and a launch still has to be authorized, signed and included inside it. Ten
 * seconds is the floor below which the remaining work cannot plausibly finish;
 * it is an ABSOLUTE number, not a percentage of the window, because a percentage
 * would shrink exactly when the window is shortest.
 */
export const POOLS_SIGNED_QUOTE_SAFETY_MARGIN_SECONDS = 10n;

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
  const suite = poolsLaunchSuite();
  const gateway = (input.gatewayAddress ?? suite.gateway) as Address;
  const factory = (input.factoryAddress ?? suite.factory) as Address;
  const locker = (input.lockerAddress ?? suite.locker) as Address;
  const safetyMargin =
    input.signedQuoteSafetyMarginSeconds ?? POOLS_SIGNED_QUOTE_SAFETY_MARGIN_SECONDS;
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
    // IDENTITY, not just address, and the WHOLE SUITE rather than one contract.
    //
    // THREE EQUALITIES, all required (the "suite triangle"):
    //   `gateway.VERSION()` == the version the quote was built for == the ONE
    //       version launches may target;
    //   `gateway.factory()` == the suite table's factory;
    //   `factory.locker()`  == the suite table's locker.
    //
    // Why the triangle rather than one address check: pools.fun redeployed its
    // whole triple twice in three days, and each generation stays live. An
    // address alone proves nothing about which generation answered - and the
    // multicall pin-note in `anchors.ts` shows a wrong ABI can return `success`
    // with a meaningless value, so the only sound identity proof is that the
    // decoded VALUES agree with each other.
    //
    // AN UNKNOWN VERSION IS REFUSED BY NAME. A gateway at V4 would have a tuple
    // this build cannot decode correctly, and "newer" is not "compatible".
    if (anchors.gatewayVersion !== BigInt(POOLS_LAUNCH_SUITE_VERSION)) {
      fail(
        "gateway_identity",
        `the gateway at ${gateway} reports VERSION ${anchors.gatewayVersion}, but Vex launches only against `
          + `suite V${POOLS_LAUNCH_SUITE_VERSION}. A suite Vex does not know carries a launch tuple this build `
          + "cannot decode, so no launch is attempted against it",
      );
      ok = false;
    }
    if (anchors.gatewayVersion !== expectation.gatewayVersion) {
      fail(
        "gateway_identity",
        `the gateway is at VERSION ${anchors.gatewayVersion} but this launch was prepared against version `
          + `${expectation.gatewayVersion}; the calldata was built for different code`,
      );
      ok = false;
    }
    if (!sameAddress(anchors.gatewayFactory, factory)) {
      fail(
        "gateway_identity",
        `the gateway's factory is ${anchors.gatewayFactory}, not suite V${POOLS_LAUNCH_SUITE_VERSION}'s factory `
          + `${factory}`,
      );
      ok = false;
    }
    if (!sameAddress(anchors.factoryLocker, locker)) {
      fail(
        "gateway_identity",
        `the factory's locker is ${anchors.factoryLocker}, not suite V${POOLS_LAUNCH_SUITE_VERSION}'s locker `
          + `${locker}; the suite does not close, so the fee stream would be held somewhere this launch did `
          + "not name",
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
    // ZERO IS REJECTED HERE, on every path. The gateway does treat zero as
    // msg.sender, but signing a tuple that does not say who is paid means a
    // later gateway change silently redirects the fee stream. WHICH non-zero
    // recipient is correct is point 15's question, because a legitimate answer
    // may now be a sentinel rather than a wallet.
    if (sameAddress(tuple.feeRecipient, ZERO_ADDRESS)) {
      fail(
        "response_mirrors_calldata",
        "feeRecipient is the zero address; Vex always sends the recipient EXPLICITLY so the signed tuple "
          + "states where the fee stream goes",
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
  //
  // WHICH AUTHORITY ANSWERS DEPENDS ON THE PRICING MODE, and this is not a
  // convenience branch: on a `SIGNED_STOCK` pair `startTickFor` REVERTS
  // (`PriceAttestationRequired`, verified factory source), and the tick is
  // derived by `quoteStartTick` from the attestation the tuple carries. Checking
  // such a launch against a feed tick that does not exist would refuse every
  // signed-stock launch; checking it against nothing would sign a price nobody
  // proved. So the mode picks the authority, and an unknown mode refuses.
  {
    if (anchors.pricingMode === null) {
      fail(
        "start_tick_agrees",
        `the factory reports a pricing mode for ${tuple.pairedAsset} that this build has no name for, so the `
          + "authority for this launch's opening price is unknown",
      );
    } else if (anchors.pricingMode === "NONE") {
      fail(
        "start_tick_agrees",
        `the factory prices ${tuple.pairedAsset} in mode NONE, which is not a launchable pair`,
      );
    } else if (anchors.pricingMode === "SIGNED_STOCK") {
      if (anchors.signedStartTick === null) {
        fail(
          "start_tick_agrees",
          `this pair is priced by signed attestation, and ${anchors.signedStartTickError ?? "no signed quote was supplied"}`
            + `; the opening price of this launch is not established`,
        );
      } else if (tuple.expectedStartTick !== anchors.signedStartTick) {
        fail(
          "start_tick_agrees",
          `the tuple pins startTick ${tuple.expectedStartTick} but the factory derives ${anchors.signedStartTick} `
            + `from the signed quote in this very calldata at block ${anchors.blockNumber}`,
        );
      } else {
        pass("start_tick_agrees");
      }
    } else if (anchors.startTick === null) {
      fail(
        "start_tick_agrees",
        `the factory's start tick for ${tuple.pairedAsset} did not answer at block ${anchors.blockNumber}`,
      );
    } else if (tuple.expectedStartTick !== anchors.startTick) {
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
      // The metadata's recipient is only comparable when the CALLER named an
      // address. Under a holders intent the on-chain recipient is a sentinel the
      // provider renders however it likes, and holding an off-chain document to
      // it would refuse a correct launch over a display string. Point 15 owns
      // the recipient on that path; the chain, not the metadata, is its
      // authority.
      const recipient = metadataAddress(metadata.initial_fee_recipient);
      if (
        recipient !== null
        && expectation.feeRecipient.kind === "address"
        && !sameAddress(recipient, expectation.feeRecipient.address)
      ) {
        fail(
          "metadata_matches_request",
          `metadata fee recipient ${recipient} is not the intended ${expectation.feeRecipient.address}`,
        );
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

  // ── 14. The price attestation ─────────────────────────────────────
  //
  // WHY THIS IS A MONEY POINT. On a `SIGNED_STOCK` pair the factory derives the
  // opening tick from `underlyingPriceUsdE18 * expectedUiMultiplier`
  // (`_signedStockTick`), so these six numbers ARE the launch price. On every
  // other mode the factory refuses a non-empty attestation. Either way, the
  // presence or absence of an attestation is bound to `pricingModeFor(asset)` -
  // the factory's own answer - and never to `pairedAsset.kind`, which is the
  // provider's label about its own response.
  //
  // The bounds below are the CONTRACT's, transcribed from the verified source
  // (`_signedStockTick`) rather than from the docs:
  //   asset == pairedAsset            (`InvalidPriceAttestation`)
  //   underlyingPriceUsdE18 != 0      (`InvalidPriceAttestation`)
  //   pricingEpoch == factory epoch   (`InvalidPriceAttestation`)
  //   observedAt <= now               (no future-dated quotes)
  //   expiresAt >= now                (plus Vex's own safety margin, below)
  //   expiresAt >= observedAt
  //   expiresAt - observedAt <= curve.maxQuoteAge
  //   now - observedAt <= curve.maxQuoteAge
  //   ECDSA signer == factory.priceSigner()
  //
  // THE SIGNER IS PROVEN BY THE FACTORY, NOT BY US. Rather than recovering the
  // EIP-712 signature locally - which would mean reimplementing the factory's
  // domain separator and being wrong the day it changes - the anchors ask the
  // factory to price the quote (`quoteStartTick`). A tick coming back IS the
  // factory's statement that the epoch, the window and the signature all passed,
  // and point 6 then requires that tick to equal the tuple's. The explicit
  // bounds here are the SECOND, independent check: they turn a provider mistake
  // into a named refusal instead of a revert, and they catch a quote that is
  // valid now but will not be by the time it is signed.
  {
    const attestation = tuple.priceAttestation;
    const signed = tuple.priceSignature !== "0x" && tuple.priceSignature.length > 2;
    const empty =
      sameAddress(attestation.asset, ZERO_ADDRESS)
      && attestation.underlyingPriceUsdE18 === 0n
      && attestation.expectedUiMultiplier === 0n
      && attestation.observedAt === 0n
      && attestation.expiresAt === 0n
      && attestation.pricingEpoch === 0n;
    const mode = anchors.pricingMode;
    let ok = true;

    if (!signed) {
      // No signature: the attestation must be ALL ZERO, and the pair must not be
      // one that requires a signed quote. A partially-filled attestation with no
      // signature is a tuple carrying numbers nobody vouched for.
      if (!empty) {
        fail(
          "price_attestation",
          "the calldata carries no price signature but its attestation is not all-zero; unsigned numbers "
            + "cannot price a launch",
        );
        ok = false;
      }
      if (mode === "SIGNED_STOCK") {
        fail(
          "price_attestation",
          `the factory prices ${tuple.pairedAsset} in SIGNED_STOCK mode, which requires a signed quote, but `
            + "this calldata carries none; the launch would revert PriceAttestationRequired",
        );
        ok = false;
      }
    } else {
      if (mode !== "SIGNED_STOCK") {
        fail(
          "price_attestation",
          `the calldata carries a signed price quote but the factory prices ${tuple.pairedAsset} in mode `
            + `${mode ?? "unknown"}, which takes its price from a feed and rejects an attestation`,
        );
        ok = false;
      }
      if (!sameAddress(attestation.asset, tuple.pairedAsset)) {
        fail(
          "price_attestation",
          `the signed quote prices ${attestation.asset} but this launch pairs against ${tuple.pairedAsset}`,
        );
        ok = false;
      }
      if (attestation.underlyingPriceUsdE18 === 0n) {
        fail("price_attestation", "the signed quote carries a zero underlying price, which the factory rejects");
        ok = false;
      }
      if (anchors.pricingEpoch === null) {
        fail(
          "price_attestation",
          "the factory's pricing epoch did not answer, so this signed quote cannot be shown to be current",
        );
        ok = false;
      } else if (attestation.pricingEpoch !== anchors.pricingEpoch) {
        fail(
          "price_attestation",
          `the signed quote is for pricing epoch ${attestation.pricingEpoch} but the factory is on epoch `
            + `${anchors.pricingEpoch}; a curve changed since this quote was signed`,
        );
        ok = false;
      }
      if (attestation.observedAt > anchors.blockTimestamp) {
        fail(
          "price_attestation",
          `the signed quote claims to have been observed at ${attestation.observedAt}, which is after the `
            + `anchored block's timestamp ${anchors.blockTimestamp}`,
        );
        ok = false;
      }
      if (attestation.expiresAt < attestation.observedAt) {
        fail(
          "price_attestation",
          `the signed quote expires (${attestation.expiresAt}) before it was observed (${attestation.observedAt})`,
        );
        ok = false;
      }
      // EXPIRY WITH HEADROOM, not mere non-expiry: a quote with two seconds left
      // is a fee spent on a guaranteed revert.
      if (attestation.expiresAt < anchors.blockTimestamp + safetyMargin) {
        fail(
          "price_attestation",
          `the signed quote expires at ${attestation.expiresAt}, which leaves less than ${safetyMargin}s after `
            + `the anchored block ${anchors.blockTimestamp}; it would expire while the launch is in flight`,
        );
        ok = false;
      }
      // The per-asset window is the bound the factory ACTUALLY enforces; the
      // MIN/MAX constants only bound what the owner may configure it to.
      const window = attestation.expiresAt - attestation.observedAt;
      if (anchors.assetMaxQuoteAgeSeconds === null) {
        fail(
          "price_attestation",
          "the factory's quote window for this pair did not answer, so the quote's own window cannot be "
            + "checked against it",
        );
        ok = false;
      } else {
        if (attestation.expiresAt >= attestation.observedAt && window > anchors.assetMaxQuoteAgeSeconds) {
          fail(
            "price_attestation",
            `the signed quote is valid for ${window}s but this pair's curve accepts at most `
              + `${anchors.assetMaxQuoteAgeSeconds}s`,
          );
          ok = false;
        }
        if (anchors.blockTimestamp - attestation.observedAt > anchors.assetMaxQuoteAgeSeconds) {
          fail(
            "price_attestation",
            `the signed quote was observed ${anchors.blockTimestamp - attestation.observedAt}s ago, past this `
              + `pair's ${anchors.assetMaxQuoteAgeSeconds}s limit`,
          );
          ok = false;
        }
      }
      if (
        anchors.minSignedQuoteAgeSeconds !== null
        && anchors.maxSignedQuoteAgeSeconds !== null
        && anchors.assetMaxQuoteAgeSeconds !== null
        && (anchors.assetMaxQuoteAgeSeconds < anchors.minSignedQuoteAgeSeconds
          || anchors.assetMaxQuoteAgeSeconds > anchors.maxSignedQuoteAgeSeconds)
      ) {
        fail(
          "price_attestation",
          `this pair's quote window (${anchors.assetMaxQuoteAgeSeconds}s) is outside the factory's own bounds `
            + `[${anchors.minSignedQuoteAgeSeconds}, ${anchors.maxSignedQuoteAgeSeconds}]`,
        );
        ok = false;
      }
      if (anchors.priceSigner === null) {
        fail(
          "price_attestation",
          "the factory's price signer did not answer, so the signature on this quote cannot be attributed",
        );
        ok = false;
      }
      // The factory's own verdict. `signedStartTick` is non-null only when
      // `quoteStartTick` returned, which means the factory accepted the epoch,
      // the window AND the ECDSA signer.
      if (anchors.signedStartTick === null) {
        fail(
          "price_attestation",
          `the factory did not accept this signed quote (${anchors.signedStartTickError ?? "no reason reported"}); `
            + `the signature must recover to ${anchors.priceSigner ?? "the factory's price signer"}`,
        );
        ok = false;
      }
    }
    if (ok) pass("price_attestation");
  }

  // ── 15. Where the fee stream goes, including the holders sentinels ─
  //
  // Point 4 proved the tuple's recipient is the one the response displays and is
  // not zero. This point proves it is the one the CALLER intended, and it is
  // separate because V3 gave `feeRecipient` a second legitimate meaning: one of
  // the gateway's `FEES_TO_HOLDERS*` sentinels, which is not a wallet and which
  // an address-equality check would read as a stranger.
  //
  // THE SENTINEL IS READ FROM THE GATEWAY, never from a constant here. A value
  // that decides where a fee stream goes must come from the contract that
  // interprets it - a sentinel pinned in this repository could be edited to
  // point a fee stream at a mode the user did not choose, and nothing on-chain
  // would contradict it.
  //
  // `feeRecipient.display` is NEVER consulted. The provider renders the literal
  // string "Token holders" there when holders mode is on (measured), which is
  // exactly the kind of claim this verifier exists to not believe.
  {
    const intent = expectation.feeRecipient;
    if (intent.kind === "address") {
      if (!sameAddress(tuple.feeRecipient, intent.address)) {
        fail(
          "fee_recipient_mode",
          `the fee stream is set to ${tuple.feeRecipient} but this launch intends ${intent.address}`,
        );
      } else {
        pass("fee_recipient_mode");
      }
    } else {
      const sentinel =
        intent.mode === "token"
          ? anchors.feesToHoldersSentinels.token
          : intent.mode === "paired"
            ? anchors.feesToHoldersSentinels.paired
            : anchors.feesToHoldersSentinels.both;
      if (sentinel === null) {
        fail(
          "fee_recipient_mode",
          `this launch intends to pay fees to token holders in "${intent.mode}" mode, but the gateway `
            + `${gateway} does not expose a sentinel for that mode; the suite cannot do it`,
        );
      } else if (!sameAddress(tuple.feeRecipient, sentinel)) {
        fail(
          "fee_recipient_mode",
          `this launch intends holder rewards in "${intent.mode}" mode, whose sentinel the gateway reports as `
            + `${sentinel}, but the calldata sets ${tuple.feeRecipient}`,
        );
      } else {
        pass("fee_recipient_mode");
      }
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
