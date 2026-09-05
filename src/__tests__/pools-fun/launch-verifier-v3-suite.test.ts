/**
 * The V3 half of the verifier: the suite triangle (point 1), the price
 * attestation (point 14) and the fee-recipient mode (point 15).
 *
 * WHY A SECOND FILE. `launch-verifier.test.ts` is the adversarial matrix over
 * the thirteen points that predate the V3 suite, and it builds its own tuples so
 * each field can be tampered with in isolation. This file covers what V3 ADDED,
 * and it does two things the older file cannot:
 *
 *   1. it drives the verifier over the REAL captured bytes of the three live V3
 *      prepares (`launches-prepare-v3-*.json`, measured 2026-09-04), so the
 *      shapes being judged are the provider's own rather than the test's;
 *   2. it walks the pricing-mode cross-product - `NONE`, `CORE_CHAINLINK`,
 *      `CHAINLINK_STOCK`, `SIGNED_STOCK` x attestation present/absent - because
 *      the rule is a RELATION between the two, and a fixture can only ever show
 *      one cell of it.
 *
 * THE SIGNED_STOCK ATTESTATIONS ARE BUILT HERE, NOT MEASURED, and that is stated
 * rather than hidden. All three live prepares carry an EMPTY attestation: two
 * are WETH-paired and the third (NVDA) is one of the 35 `CHAINLINK_STOCK`
 * assets, which are feed-priced. No live prepare against one of the 159
 * `SIGNED_STOCK` assets was captured, so those rows use attestations this file
 * constructs. The BOUNDS they are checked against are not invented: every one is
 * transcribed from the verified `PartyFactory._signedStockTick` source, and the
 * factory's own verdict (`quoteStartTick`) is modelled as the anchor it is.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { POOLS_GATEWAY_ABI, POOLS_PRICING_MODES, type PoolsPricingMode } from "@tools/pools-fun/abi.js";
import { POOLS_LAUNCH_SUITE_VERSION, poolsLaunchSuite } from "@tools/pools-fun/constants.js";
import { validatePrepareResponse } from "@tools/pools-fun/validation.js";
import {
  decodeLaunchCalldata,
  verifyPoolsLaunchCalldata,
  POOLS_SIGNED_QUOTE_SAFETY_MARGIN_SECONDS,
  type PoolsMetadataDocument,
  type PoolsSimulationResults,
  type VerifyPoolsCalldataInput,
} from "@tools/pools-fun/launch/verify-calldata.js";
import type {
  PoolsChainAnchors,
  PoolsLaunchTuple,
  PoolsPriceAttestation,
  PoolsVerifierExpectation,
  PoolsVerifierPoint,
} from "@tools/pools-fun/launch/verifier-types.js";
import { captureResponse, CAPTURES } from "./_captures.js";

const SUITE = poolsLaunchSuite();
const GATEWAY = getAddress(SUITE.gateway);
const FACTORY = getAddress(SUITE.factory);
const LOCKER = getAddress(SUITE.locker);

const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const PRICE_SIGNER = getAddress("0xc4559C672617395292a5878D3200B9c3d46EaCc7");

/** The three sentinels the live V3 gateway reports (measured 2026-09-04). */
const HOLDERS_TOKEN = getAddress("0x968b0c1e896fB1DdB2042957Fc0614c67AB7FFc2");
const HOLDERS_PAIRED = getAddress("0x968b0c1e896Fb1DdB2042957FC0614c67AB7ffC3");
const HOLDERS_BOTH = getAddress("0x968b0c1e896fB1ddB2042957fC0614C67Ab7Ffc4");

const BLOCK_TIME = 1_788_523_600n;
const EPOCH = 197n;
/** The factory's own window for the signed-stock assets, measured: 30 s to 120 s. */
const MAX_QUOTE_AGE = 120n;

const EMPTY_ATTESTATION: PoolsPriceAttestation = {
  asset: "0x0000000000000000000000000000000000000000" as Address,
  underlyingPriceUsdE18: 0n,
  expectedUiMultiplier: 0n,
  observedAt: 0n,
  expiresAt: 0n,
  pricingEpoch: 0n,
};

/**
 * A signed quote that satisfies every bound in `_signedStockTick`: observed 20 s
 * before the anchored block, valid for 90 s of the 120 s the curve allows, on
 * the factory's current epoch.
 */
function freshQuote(over: Partial<PoolsPriceAttestation> = {}): PoolsPriceAttestation {
  return {
    asset: NVDA,
    underlyingPriceUsdE18: 187_420_000_000_000_000_000n,
    expectedUiMultiplier: 1_000_000_000_000_000_000n,
    observedAt: BLOCK_TIME - 20n,
    expiresAt: BLOCK_TIME + 70n,
    pricingEpoch: EPOCH,
    ...over,
  };
}

const SIGNATURE = `0x${"ab".repeat(65)}` as Hex;

function tuple(over: Partial<PoolsLaunchTuple> = {}): PoolsLaunchTuple {
  return {
    name: "Vex Probe Token",
    symbol: "VEXPROBETO",
    metadataUri: "ipfs://bafkreiboonrsjbhp4kzm65ej46oe27dmvledx4wajubbjvj4s7lakfzala",
    userSalt: `0x${"6d".repeat(32)}` as Hex,
    pairedAsset: WETH,
    expectedStartTick: -200_600,
    deadline: 1_788_523_677n,
    feeRecipient: WALLET,
    nativeDevBuyAmount: 0n,
    erc20DevBuyAmountIn: 0n,
    devBuyMinOut: 0n,
    expectedFeeWei: 1_051_674_002_092_832n,
    priceAttestation: EMPTY_ATTESTATION,
    priceSignature: "0x" as Hex,
    ...over,
  };
}

function encode(t: PoolsLaunchTuple): Hex {
  return encodeFunctionData({ abi: POOLS_GATEWAY_ABI, functionName: "launch", args: [t] });
}

function response(t: PoolsLaunchTuple) {
  return {
    requiresReprepare: false,
    to: GATEWAY,
    data: encode(t),
    value: (t.expectedFeeWei + t.nativeDevBuyAmount).toString(),
    predictedTokenAddress: getAddress("0x09453339E7d5f97B4C723EBA1db6569Bd326bc6b"),
    predictedPoolAddress: getAddress("0x3BeA15b06bF7b6f5c23F1BCf6F4E65900b6DBAE2"),
    salt: t.userSalt,
    metadataUri: t.metadataUri,
    devBuyMinOut: t.devBuyMinOut.toString(),
    devBuyAmountIn: t.erc20DevBuyAmountIn.toString(),
    deploymentFeeWei: t.expectedFeeWei.toString(),
    nativeDevBuyWei: t.nativeDevBuyAmount.toString(),
    deadline: t.deadline.toString(),
    pairedAsset: { address: t.pairedAsset, kind: "weth" as const, symbol: "WETH", decimals: 18 },
    tokenSymbol: t.symbol,
    // The provider's own display label. NEVER an input to any check - the
    // holders capture shows it as the literal string "Token holders".
    feeRecipient: { address: t.feeRecipient, display: "whatever the provider likes" },
  };
}

function anchors(over: Partial<PoolsChainAnchors> = {}): PoolsChainAnchors {
  return {
    blockNumber: 39_620_464n,
    blockTimestamp: BLOCK_TIME,
    gatewayVersion: BigInt(POOLS_LAUNCH_SUITE_VERSION),
    gatewayFactory: FACTORY,
    factoryLocker: LOCKER,
    gatewayPaused: false,
    gatewayDeploymentFeeWei: 1_051_674_002_092_832n,
    gatewayMinFeeWei: 1_000_000_000_000n,
    gatewayMaxFeeWei: 10_000_000_000_000_000n,
    gatewayWeth: WETH,
    feesToHoldersSentinels: { token: HOLDERS_TOKEN, paired: HOLDERS_PAIRED, both: HOLDERS_BOTH },
    pairedAssetAllowed: true,
    pricingMode: "CORE_CHAINLINK",
    startTick: -200_600,
    startTickLive: true,
    signedStartTick: null,
    signedStartTickError: null,
    priceSigner: PRICE_SIGNER,
    pricingEpoch: EPOCH,
    assetMaxQuoteAgeSeconds: null,
    minSignedQuoteAgeSeconds: 30n,
    maxSignedQuoteAgeSeconds: MAX_QUOTE_AGE,
    computedTokenAddress: getAddress("0x09453339E7d5f97B4C723EBA1db6569Bd326bc6b"),
    nativeBalanceWei: 10n ** 18n,
    ...over,
  };
}

function metadata(over: Partial<PoolsMetadataDocument> = {}): PoolsMetadataDocument {
  return {
    name: "Vex Probe Token",
    symbol: "VEXPROBETO",
    initial_deployer: { address: WALLET },
    initial_fee_recipient: { address: WALLET },
    ...over,
  };
}

function simulation(over: Partial<PoolsSimulationResults> = {}): PoolsSimulationResults {
  return {
    simulatedDevBuyOut: 0n,
    simulatedTokenAddress: getAddress("0x09453339E7d5f97B4C723EBA1db6569Bd326bc6b"),
    finalSimulationSucceeded: true,
    ...over,
  };
}

function expectation(over: Partial<PoolsVerifierExpectation> = {}): PoolsVerifierExpectation {
  return {
    name: "Vex Probe Token",
    symbol: "VEXPROBETO",
    pairedAsset: "weth",
    pairedAssetAddress: WETH,
    feeRecipient: { kind: "address", address: WALLET },
    launcher: WALLET,
    gatewayVersion: BigInt(POOLS_LAUNCH_SUITE_VERSION),
    ...over,
  };
}

function input(over: Partial<VerifyPoolsCalldataInput> = {}): VerifyPoolsCalldataInput {
  return {
    response: response(tuple()),
    expectation: expectation(),
    anchors: anchors(),
    metadata: metadata(),
    simulation: simulation(),
    gasBoundWei: 5_000_000_000_000_000n,
    vexFeeWei: 2_629_185_005_232n,
    gatewayAddress: GATEWAY,
    factoryAddress: FACTORY,
    lockerAddress: LOCKER,
    ...over,
  };
}

function expectViolation(
  result: ReturnType<typeof verifyPoolsLaunchCalldata>,
  point: PoolsVerifierPoint,
): void {
  expect(result.ok, "the verifier must refuse this tuple").toBe(false);
  if (result.ok) return;
  const points = result.violations.map((v) => v.point);
  expect(points, `expected ${point}; got ${points.join(", ")}`).toContain(point);
}

// ── The real captured V3 bytes ──────────────────────────────────────

describe("the live V3 prepares decode as the fourteen-member tuple", () => {
  const cases = [
    ["plain WETH", CAPTURES.prepareV3Weth, WETH],
    ["fees to holders, BOTH mode", CAPTURES.prepareV3HoldersBoth, WETH],
    ["a CHAINLINK_STOCK pair (NVDA)", CAPTURES.prepareV3StockNvda, NVDA],
  ] as const;

  it.each(cases)("%s carries the V3 selector 0x3cc0226c", (_label, capture) => {
    const parsed = validatePrepareResponse(captureResponse(capture));
    expect(parsed.data.slice(0, 10)).toBe("0x3cc0226c");
    expect(parsed.to).toBe(SUITE.gateway);
  });

  it.each(cases)("%s decodes, and its attestation is EMPTY with no signature", (_label, capture, pair) => {
    // All three live prepares carry an all-zero attestation: two WETH pairs and
    // one FEED-priced stock. This is the measurement that says a signed quote is
    // the exception, not the rule.
    const parsed = validatePrepareResponse(captureResponse(capture));
    const decoded = decodeLaunchCalldata(parsed.data as Hex);
    expect(decoded).not.toBeNull();
    expect(getAddress(decoded!.pairedAsset)).toBe(pair);
    expect(decoded!.priceSignature).toBe("0x");
    expect(decoded!.priceAttestation.underlyingPriceUsdE18).toBe(0n);
    expect(decoded!.priceAttestation.observedAt).toBe(0n);
  });

  it("the holders capture's recipient is the BOTH sentinel, and its display string is a lie waiting to happen", () => {
    const parsed = validatePrepareResponse(captureResponse(CAPTURES.prepareV3HoldersBoth));
    const decoded = decodeLaunchCalldata(parsed.data as Hex)!;
    expect(getAddress(decoded.feeRecipient)).toBe(HOLDERS_BOTH);
    // The provider renders this. It is human text about an address, from the
    // party whose claims the verifier exists to check.
    expect(parsed.feeRecipient.display).toBe("Token holders");
  });

  it("the live WETH prepare clears every point EXCEPT the recipient the provider zeroed", () => {
    // END TO END over the provider's own bytes: decode the capture, describe the
    // chain state it was made against, and see what the verifier says. Before the
    // repair this response was `calldata_undecodable` and no point ran at all.
    //
    // A MEASURED PROVIDER DEFECT, PINNED HERE. The probe asked for fee recipient
    // 0x...dEaD; the response ECHOES 0x...dEaD and the CALLDATA carries the ZERO
    // address (verified by decoding the committed bytes - the holders capture,
    // by contrast, mirrors its sentinel exactly). That is the "show one thing,
    // sign another" shape point 4 exists for, and the verifier catches it on the
    // provider's real bytes without any tampering by this test. Whether it also
    // happens for an ordinary wallet is a LIVE question, answered in the lane's
    // live acceptance, not guessed at here.
    const parsed = validatePrepareResponse(captureResponse(CAPTURES.prepareV3Weth));
    const decoded = decodeLaunchCalldata(parsed.data as Hex)!;
    expect(decoded.feeRecipient).toBe("0x0000000000000000000000000000000000000000");
    expect(parsed.feeRecipient.address).toBe("0x000000000000000000000000000000000000dEaD");

    const result = verifyPoolsLaunchCalldata(
      input({
        response: parsed,
        expectation: expectation({ name: decoded.name, symbol: decoded.symbol }),
        anchors: anchors({
          startTick: decoded.expectedStartTick,
          gatewayDeploymentFeeWei: decoded.expectedFeeWei,
          computedTokenAddress: getAddress(parsed.predictedTokenAddress),
        }),
        metadata: metadata({ name: decoded.name, symbol: decoded.symbol }),
        simulation: simulation({ simulatedTokenAddress: getAddress(parsed.predictedTokenAddress) }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // EXACTLY the recipient points, and nothing else. Every structural,
    // suite, pricing, dev-buy, value and balance check passed on these bytes -
    // which is the real assertion here, because it is what "the V3 tuple decodes
    // and the whole verifier runs against it" means.
    expect([...new Set(result.violations.map((v) => v.point))].sort()).toEqual([
      "fee_recipient_mode",
      "response_mirrors_calldata",
    ]);
  });

  it("the same bytes pass in full once the recipient the provider signed is the intended one", () => {
    // The control for the case above: hold the launch to the recipient that is
    // actually IN the calldata, and every one of the fifteen points passes. So
    // the refusal above is about that one field, not about V3 support.
    const parsed = validatePrepareResponse(captureResponse(CAPTURES.prepareV3HoldersBoth));
    const decoded = decodeLaunchCalldata(parsed.data as Hex)!;
    const result = verifyPoolsLaunchCalldata(
      input({
        response: parsed,
        expectation: expectation({
          name: decoded.name,
          symbol: decoded.symbol,
          feeRecipient: { kind: "holders", mode: "both" },
        }),
        anchors: anchors({
          startTick: decoded.expectedStartTick,
          gatewayDeploymentFeeWei: decoded.expectedFeeWei,
          computedTokenAddress: getAddress(parsed.predictedTokenAddress),
        }),
        metadata: metadata({
          name: decoded.name,
          symbol: decoded.symbol,
          initial_fee_recipient: undefined,
        }),
        simulation: simulation({ simulatedTokenAddress: getAddress(parsed.predictedTokenAddress) }),
      }),
    );
    expect(result.ok, result.ok ? "" : JSON.stringify(result.violations, null, 1)).toBe(true);
  });
});

// ── Point 1: the suite triangle ─────────────────────────────────────

describe("point 1 - the suite must close as a triangle", () => {
  it("refuses a gateway whose factory is not this suite's", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ gatewayFactory: STRANGER }) })),
      "gateway_identity",
    );
  });

  it("refuses when the factory's locker is not this suite's - the triangle does not close", () => {
    // The check the old code did not have. A gateway at the right address,
    // naming the right factory, whose factory registers into somebody else's
    // locker, would send this token's fee stream somewhere the launch never
    // named - and nothing else in the verifier looks at the locker.
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ factoryLocker: STRANGER }) })),
      "gateway_identity",
    );
  });

  it("refuses a gateway at a version Vex does not launch against, by name", () => {
    const result = verifyPoolsLaunchCalldata(
      input({
        anchors: anchors({ gatewayVersion: 4n }),
        expectation: expectation({ gatewayVersion: 4n }),
      }),
    );
    expectViolation(result, "gateway_identity");
    if (result.ok) return;
    const detail = result.violations.map((v) => v.detail).join(" ");
    // "Newer" is not "compatible": a V4 tuple would decode wrong, so the refusal
    // has to say so rather than shrug and proceed.
    expect(detail).toContain("VERSION 4");
    expect(detail).toContain(`V${POOLS_LAUNCH_SUITE_VERSION}`);
  });

  it("refuses when the gateway upgraded between the quote and the check", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ expectation: expectation({ gatewayVersion: 2n }) })),
      "gateway_identity",
    );
  });
});

// ── Point 14: the attestation, per pricing mode ─────────────────────

describe("point 14 - an attestation is bound to the pair's pricing mode", () => {
  /** The mode cross-product: an empty attestation is right in three modes of four. */
  const emptyAllowed: Record<PoolsPricingMode, boolean> = {
    NONE: false, // refused, but by point 6 - NONE is not a launchable pair at all
    CORE_CHAINLINK: true,
    CHAINLINK_STOCK: true,
    SIGNED_STOCK: false,
  };

  it.each(POOLS_PRICING_MODES.filter((m) => m !== "NONE"))(
    "an EMPTY attestation is %s on mode %s",
    (mode) => {
      const result = verifyPoolsLaunchCalldata(
        input({
          anchors: anchors({
            pricingMode: mode,
            // A SIGNED_STOCK pair has no feed tick at all: `startTickFor`
            // reverts there, which is why this is null rather than a number.
            ...(mode === "SIGNED_STOCK"
              ? { startTick: null, startTickLive: false, assetMaxQuoteAgeSeconds: MAX_QUOTE_AGE }
              : {}),
          }),
        }),
      );
      if (emptyAllowed[mode]) {
        expect(result.ok, result.ok ? "" : JSON.stringify(result.violations)).toBe(true);
      } else {
        expectViolation(result, "price_attestation");
      }
    },
  );

  it("a SIGNED attestation on a feed-priced pair is refused: the factory would reject it", () => {
    const signed = tuple({ priceAttestation: freshQuote({ asset: WETH }), priceSignature: SIGNATURE });
    expectViolation(
      verifyPoolsLaunchCalldata(
        input({
          response: response(signed),
          anchors: anchors({ pricingMode: "CHAINLINK_STOCK", signedStartTick: -200_600 }),
        }),
      ),
      "price_attestation",
    );
  });

  it("an attestation with numbers but NO signature is refused - unsigned numbers price nothing", () => {
    const halfFilled = tuple({ priceAttestation: freshQuote(), priceSignature: "0x" as Hex });
    expectViolation(
      verifyPoolsLaunchCalldata(input({ response: response(halfFilled) })),
      "price_attestation",
    );
  });

  describe("on a SIGNED_STOCK pair, every bound the factory enforces", () => {
    /**
     * A signed-stock launch the verifier should accept.
     *
     * `signedStartTick` models the factory ANSWERING `quoteStartTick`, which is
     * the factory's own statement that the epoch, the window and the ECDSA
     * signer all passed. The tuple's tick equals it, so point 6 passes too.
     */
    function signedInput(
      over: { attestation?: Partial<PoolsPriceAttestation>; anchors?: Partial<PoolsChainAnchors> } = {},
    ): VerifyPoolsCalldataInput {
      const attestation = freshQuote(over.attestation);
      const signedTuple = tuple({
        pairedAsset: NVDA,
        expectedStartTick: -142_360,
        priceAttestation: attestation,
        priceSignature: SIGNATURE,
      });
      return input({
        response: response(signedTuple),
        expectation: expectation({ pairedAsset: "weth", pairedAssetAddress: NVDA }),
        anchors: anchors({
          pricingMode: "SIGNED_STOCK",
          gatewayWeth: NVDA,
          startTick: null,
          startTickLive: false,
          signedStartTick: -142_360,
          assetMaxQuoteAgeSeconds: MAX_QUOTE_AGE,
          ...over.anchors,
        }),
      });
    }

    it("accepts a fresh, in-epoch, factory-approved quote", () => {
      const result = verifyPoolsLaunchCalldata(signedInput());
      expect(result.ok, result.ok ? "" : JSON.stringify(result.violations, null, 1)).toBe(true);
    });

    it("refuses a quote for a different asset than the pair", () => {
      expectViolation(signedVerdict({ attestation: { asset: WETH } }), "price_attestation");
    });

    it("refuses a zero underlying price", () => {
      expectViolation(signedVerdict({ attestation: { underlyingPriceUsdE18: 0n } }), "price_attestation");
    });

    it("refuses a stale pricing epoch - a curve changed since it was signed", () => {
      expectViolation(signedVerdict({ attestation: { pricingEpoch: EPOCH - 1n } }), "price_attestation");
    });

    it("refuses a quote observed in the future", () => {
      expectViolation(
        signedVerdict({ attestation: { observedAt: BLOCK_TIME + 5n, expiresAt: BLOCK_TIME + 95n } }),
        "price_attestation",
      );
    });

    it("refuses a quote that has already expired", () => {
      expectViolation(
        signedVerdict({ attestation: { observedAt: BLOCK_TIME - 200n, expiresAt: BLOCK_TIME - 1n } }),
        "price_attestation",
      );
    });

    it("refuses a quote whose expiry is INSIDE the safety margin, not merely expired", () => {
      // The margin is the difference between "valid now" and "valid when this is
      // actually included". A quote with a few seconds left is a deployment fee
      // spent on a guaranteed revert.
      const barely = BLOCK_TIME + POOLS_SIGNED_QUOTE_SAFETY_MARGIN_SECONDS - 1n;
      expectViolation(
        signedVerdict({ attestation: { observedAt: BLOCK_TIME - 20n, expiresAt: barely } }),
        "price_attestation",
      );
      // ...and one second the other side of the line is accepted, so the bound
      // is a real boundary rather than a blanket refusal.
      const enough = BLOCK_TIME + POOLS_SIGNED_QUOTE_SAFETY_MARGIN_SECONDS;
      expect(
        verifyPoolsLaunchCalldata(
          signedInput({ attestation: { observedAt: BLOCK_TIME - 20n, expiresAt: enough } }),
        ).ok,
      ).toBe(true);
    });

    it("refuses a validity window wider than THIS PAIR's curve allows", () => {
      // The per-asset `maxQuoteAge`, not the global MIN/MAX constants: the
      // constants only bound what the owner may configure the asset to.
      expectViolation(
        signedVerdict({
          attestation: { observedAt: BLOCK_TIME - 10n, expiresAt: BLOCK_TIME + MAX_QUOTE_AGE },
        }),
        "price_attestation",
      );
    });

    it("refuses a quote observed longer ago than the curve's window", () => {
      expectViolation(
        signedVerdict({
          anchors: { assetMaxQuoteAgeSeconds: 30n },
          attestation: { observedAt: BLOCK_TIME - 31n, expiresAt: BLOCK_TIME + 20n },
        }),
        "price_attestation",
      );
    });

    it("refuses when the FACTORY itself rejected the quote, and repeats its reason", () => {
      // The signature check we do NOT reimplement: the factory recovers the
      // EIP-712 signer against its own domain separator, so a revert from
      // `quoteStartTick` is the authoritative "this signature is not the price
      // signer's".
      const result = verifyPoolsLaunchCalldata(
        signedInput({
          anchors: {
            signedStartTick: null,
            signedStartTickError: "the factory refused this signed quote (ContractFunctionExecutionError)",
          },
        }),
      );
      expectViolation(result, "price_attestation");
      if (result.ok) return;
      const detail = result.violations.map((v) => v.detail).join(" ");
      expect(detail).toContain(PRICE_SIGNER);
    });

    it("refuses when the factory's price signer could not be read", () => {
      expectViolation(signedVerdict({ anchors: { priceSigner: null } }), "price_attestation");
    });

    it("refuses when the tuple's tick does not equal the tick the factory derives from the quote", () => {
      // Point 6's signed-stock branch: the attestation IS the price, so the
      // number the tuple pins has to be the number those signed bytes produce.
      const result = verifyPoolsLaunchCalldata(signedInput({ anchors: { signedStartTick: -142_361 } }));
      expectViolation(result, "start_tick_agrees");
    });

    function signedVerdict(
      over: { attestation?: Partial<PoolsPriceAttestation>; anchors?: Partial<PoolsChainAnchors> },
    ): ReturnType<typeof verifyPoolsLaunchCalldata> {
      return verifyPoolsLaunchCalldata(signedInput(over));
    }
  });
});

// ── Point 15: the fee recipient, including the holders sentinels ────

describe("point 15 - where the fee stream goes", () => {
  it("accepts the intended wallet", () => {
    expect(verifyPoolsLaunchCalldata(input()).ok).toBe(true);
  });

  const modes = [
    ["token", HOLDERS_TOKEN],
    ["paired", HOLDERS_PAIRED],
    ["both", HOLDERS_BOTH],
  ] as const;

  it.each(modes)("accepts the live sentinel for holders mode %s", (mode, sentinel) => {
    const holders = tuple({ feeRecipient: sentinel });
    const result = verifyPoolsLaunchCalldata(
      input({
        response: response(holders),
        expectation: expectation({ feeRecipient: { kind: "holders", mode } }),
        // A holders launch pins no personal recipient in the metadata.
        metadata: metadata({ initial_fee_recipient: undefined }),
      }),
    );
    expect(result.ok, result.ok ? "" : JSON.stringify(result.violations, null, 1)).toBe(true);
  });

  it.each(modes)("refuses the WRONG sentinel for holders mode %s", (mode, sentinel) => {
    // The three sentinels differ by one byte (`...ffc2/ffc3/ffc4`), and they pay
    // three different assets. A verifier that accepted "any sentinel" would let
    // a launch pay holders in a mode the user did not choose.
    const wrong = sentinel === HOLDERS_TOKEN ? HOLDERS_BOTH : HOLDERS_TOKEN;
    expectViolation(
      verifyPoolsLaunchCalldata(
        input({
          response: response(tuple({ feeRecipient: wrong })),
          expectation: expectation({ feeRecipient: { kind: "holders", mode } }),
          metadata: metadata({ initial_fee_recipient: undefined }),
        }),
      ),
      "fee_recipient_mode",
    );
  });

  it("refuses a WALLET when holders mode was intended", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(
        input({ expectation: expectation({ feeRecipient: { kind: "holders", mode: "token" } }) }),
      ),
      "fee_recipient_mode",
    );
  });

  it("refuses a SENTINEL when a wallet was intended", () => {
    // The dangerous direction: an agent launch pins the session wallet, and a
    // provider that quietly turned holder rewards on would divert the whole fee
    // stream to a contract the user never chose.
    expectViolation(
      verifyPoolsLaunchCalldata(input({ response: response(tuple({ feeRecipient: HOLDERS_BOTH })) })),
      "fee_recipient_mode",
    );
  });

  it("refuses a holders mode this suite has no sentinel for", () => {
    // V2's gateway answers `FEES_TO_HOLDERS` and reverts on the other two
    // (measured). A missing sentinel is a capability fact, and the refusal says
    // so instead of comparing against a null.
    const result = verifyPoolsLaunchCalldata(
      input({
        response: response(tuple({ feeRecipient: HOLDERS_PAIRED })),
        expectation: expectation({ feeRecipient: { kind: "holders", mode: "paired" } }),
        anchors: anchors({
          feesToHoldersSentinels: { token: HOLDERS_TOKEN, paired: null, both: null },
        }),
        metadata: metadata({ initial_fee_recipient: undefined }),
      }),
    );
    expectViolation(result, "fee_recipient_mode");
    if (result.ok) return;
    expect(result.violations.map((v) => v.detail).join(" ")).toContain("does not expose a sentinel");
  });

  it("never consults feeRecipient.display, whatever the provider writes there", () => {
    // The provider labels the holders sentinel "Token holders". If `display`
    // could influence a verdict, that string is where an attacker would put
    // "your wallet".
    const lying = {
      ...response(tuple({ feeRecipient: STRANGER })),
      feeRecipient: { address: STRANGER, display: WALLET },
    };
    expectViolation(verifyPoolsLaunchCalldata(input({ response: lying })), "fee_recipient_mode");
  });

  it("still refuses the zero address, on either intent", () => {
    // Point 4 owns this one, and it survived the split.
    expectViolation(
      verifyPoolsLaunchCalldata(
        input({
          response: response(tuple({ feeRecipient: "0x0000000000000000000000000000000000000000" as Address })),
        }),
      ),
      "response_mirrors_calldata",
    );
  });
});
