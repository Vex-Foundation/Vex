/**
 * The 15-point calldata verifier: every point, and the adversarial matrix.
 *
 * WHAT THIS SUITE IS FOR. The launch path signs calldata a third-party backend
 * produced, with the user's key and the user's money. The verifier is the only
 * thing standing between "the backend said so" and a signature. So the tests are
 * written as an ATTACK: build a tuple that passes every point, then tamper with
 * exactly ONE field at a time and require the verifier to name the point that
 * catches it. A check that cannot be made to fail is not a check.
 *
 * The calldata is REAL encoded bytes throughout (viem `encodeFunctionData` over
 * the verified gateway ABI), never a hand-written hex string - a verifier tested
 * against fake bytes proves nothing about the bytes it will actually see.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { POOLS_GATEWAY_ABI } from "@tools/pools-fun/abi.js";
import { POOLS_LAUNCH_SUITE_VERSION, poolsLaunchSuite } from "@tools/pools-fun/constants.js";
import {
  decodeLaunchCalldata,
  verifyPoolsLaunchCalldata,
  type PoolsMetadataDocument,
  type PoolsSimulationResults,
  type VerifyPoolsCalldataInput,
} from "@tools/pools-fun/launch/verify-calldata.js";
import type {
  PoolsChainAnchors,
  PoolsLaunchTuple,
  PoolsVerifierExpectation,
  PoolsVerifierPoint,
} from "@tools/pools-fun/launch/verifier-types.js";
import { POOLS_VERIFIER_POINTS } from "@tools/pools-fun/launch/verifier-types.js";
import type { PoolsPrepareResponse } from "@tools/pools-fun/types.js";

const SUITE = poolsLaunchSuite();
const GATEWAY = getAddress(SUITE.gateway);
const FACTORY = getAddress(SUITE.factory);
const LOCKER = getAddress(SUITE.locker);
/** The gateway's live fees-to-holders sentinels, as measured on V3. */
const HOLDERS_TOKEN = getAddress("0x968b0c1e896fB1DdB2042957Fc0614c67AB7FFc2");
const HOLDERS_PAIRED = getAddress("0x968b0c1e896Fb1DdB2042957FC0614c67AB7ffC3");
const HOLDERS_BOTH = getAddress("0x968b0c1e896fB1ddB2042957fC0614C67Ab7Ffc4");
/** The anchored block's timestamp, and a signed quote that is fresh at it. */
const BLOCK_TIME = 1_788_523_600n;
const EMPTY_ATTESTATION = {
  asset: "0x0000000000000000000000000000000000000000" as Address,
  underlyingPriceUsdE18: 0n,
  expectedUiMultiplier: 0n,
  observedAt: 0n,
  expiresAt: 0n,
  pricingEpoch: 0n,
} as const;
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SALT = `0x${"7a".repeat(32)}` as Hex;

const FEE_WEI = 1_051_674_002_092_832n;
const PREBUY_WEI = 300_000_000_000_000n;
const DEV_BUY_OUT = 112_657_539_798_287_513_447_808n;
const GAS_BOUND = 5_000_000_000_000_000n;
const VEX_FEE = 3_379_185_005_232n;

/** A tuple that passes all 13 points. Each test tampers with exactly one thing. */
function baseTuple(over: Partial<PoolsLaunchTuple> = {}): PoolsLaunchTuple {
  return {
    name: "Vex Flamingo",
    symbol: "VEXFLAM",
    metadataUri: "ipfs://bafkreifaguifkgqdrrs2cwlbjejqblrguynowkm3zb77yvq3gsydqacywm",
    userSalt: SALT,
    pairedAsset: WETH,
    expectedStartTick: -197_600,
    deadline: 1_787_054_575n,
    feeRecipient: WALLET,
    nativeDevBuyAmount: PREBUY_WEI,
    erc20DevBuyAmountIn: 0n,
    devBuyMinOut: DEV_BUY_OUT,
    expectedFeeWei: FEE_WEI,
    // The V3 tuple's last two members. A WETH launch carries the all-zero
    // attestation and an empty signature - the shape measured on every one of
    // the three live V3 prepares.
    priceAttestation: EMPTY_ATTESTATION,
    priceSignature: "0x" as Hex,
    ...over,
  };
}

/** The provider's truncated display label, e.g. `0x33eF…d2fA`. */
function shortenAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** REAL encoded calldata for a tuple - the bytes the signer would actually see. */
function encode(tuple: PoolsLaunchTuple): Hex {
  return encodeFunctionData({ abi: POOLS_GATEWAY_ABI, functionName: "launch", args: [tuple] });
}

function response(tuple: PoolsLaunchTuple, over: Partial<PoolsPrepareResponse> = {}): PoolsPrepareResponse {
  return {
    requiresReprepare: false,
    to: GATEWAY,
    data: encode(tuple),
    value: (tuple.expectedFeeWei + tuple.nativeDevBuyAmount).toString(),
    predictedTokenAddress: TOKEN,
    predictedPoolAddress: POOL,
    salt: tuple.userSalt,
    metadataUri: tuple.metadataUri,
    devBuyMinOut: tuple.devBuyMinOut.toString(),
    devBuyAmountIn: tuple.nativeDevBuyAmount.toString(),
    deploymentFeeWei: tuple.expectedFeeWei.toString(),
    nativeDevBuyWei: tuple.nativeDevBuyAmount.toString(),
    deadline: tuple.deadline.toString(),
    // Both of these are OBJECTS on the wire, not strings - the provider changed
    // the contract under us (see `PoolsFun.md`, 2026-08-19).
    pairedAsset: { address: WETH, kind: "weth", symbol: "WETH", decimals: 18 },
    tokenSymbol: tuple.symbol,
    feeRecipient: { address: tuple.feeRecipient, display: shortenAddress(tuple.feeRecipient) },
    ...over,
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
    gatewayDeploymentFeeWei: FEE_WEI,
    gatewayMinFeeWei: 1_000_000_000_000n,
    gatewayMaxFeeWei: 10_000_000_000_000_000n,
    gatewayWeth: WETH,
    feesToHoldersSentinels: { token: HOLDERS_TOKEN, paired: HOLDERS_PAIRED, both: HOLDERS_BOTH },
    pairedAssetAllowed: true,
    pricingMode: "CORE_CHAINLINK",
    startTick: -197_600,
    startTickLive: true,
    signedStartTick: null,
    signedStartTickError: null,
    priceSigner: getAddress("0xc4559C672617395292a5878D3200B9c3d46EaCc7"),
    pricingEpoch: 197n,
    assetMaxQuoteAgeSeconds: null,
    minSignedQuoteAgeSeconds: 30n,
    maxSignedQuoteAgeSeconds: 120n,
    computedTokenAddress: TOKEN,
    nativeBalanceWei: 10n ** 18n,
    ...over,
  };
}

function metadata(over: Partial<PoolsMetadataDocument> = {}): PoolsMetadataDocument {
  return {
    name: "Vex Flamingo",
    symbol: "VEXFLAM",
    image: "ipfs://bafkreiavjuxoyk5yoglksbl5gty2mkg74fsao6g2blr5mmjf3wr2kyosma",
    initial_deployer: { address: WALLET },
    initial_fee_recipient: { address: WALLET },
    ...over,
  };
}

function simulation(over: Partial<PoolsSimulationResults> = {}): PoolsSimulationResults {
  return {
    simulatedDevBuyOut: DEV_BUY_OUT,
    simulatedTokenAddress: TOKEN,
    finalSimulationSucceeded: true,
    ...over,
  };
}

function expectation(over: Partial<PoolsVerifierExpectation> = {}): PoolsVerifierExpectation {
  return {
    name: "Vex Flamingo",
    symbol: "VEXFLAM",
    pairedAsset: "weth",
    pairedAssetAddress: WETH,
    feeRecipient: { kind: "address", address: WALLET },
    launcher: WALLET,
    gatewayVersion: BigInt(POOLS_LAUNCH_SUITE_VERSION),
    imageUrl: "https://example.test/flamingo.jpg",
    devBuy: { mode: "native", amountWei: PREBUY_WEI },
    ...over,
  };
}

/** The whole input, valid by default. */
function input(over: Partial<VerifyPoolsCalldataInput> = {}): VerifyPoolsCalldataInput {
  const tuple = baseTuple();
  return {
    response: response(tuple),
    expectation: expectation(),
    anchors: anchors(),
    metadata: metadata(),
    simulation: simulation(),
    gasBoundWei: GAS_BOUND,
    vexFeeWei: VEX_FEE,
    gatewayAddress: GATEWAY,
    factoryAddress: FACTORY,
    lockerAddress: LOCKER,
    ...over,
  };
}

/** Assert the verifier refused, and that a NAMED point caught it. */
function expectViolation(result: ReturnType<typeof verifyPoolsLaunchCalldata>, point: PoolsVerifierPoint): void {
  expect(result.ok, "the verifier must refuse this tuple").toBe(false);
  if (result.ok) return;
  const points = result.violations.map((v) => v.point);
  expect(points, `expected ${point} to catch it; got ${points.join(", ")}`).toContain(point);
}

describe("the happy path passes every point", () => {
  it("verifies a well-formed launch and returns the decoded tuple", () => {
    const result = verifyPoolsLaunchCalldata(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tuple.symbol).toBe("VEXFLAM");
    expect(result.tuple.feeRecipient).toBe(WALLET);
  });

  it("checks ALL 15 points, with none silently skipped", () => {
    const result = verifyPoolsLaunchCalldata(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The checklist is the acceptance criterion: a point that stops running is
    // a point that stops protecting, and nothing else would notice.
    expect([...result.checked].sort()).toEqual([...POOLS_VERIFIER_POINTS].sort());
  });
});

describe("point 1 - gateway identity, liveness, fee and bounds", () => {
  it("refuses calldata aimed at a FOREIGN target", () => {
    const tuple = baseTuple();
    expectViolation(
      verifyPoolsLaunchCalldata(input({ response: response(tuple, { to: STRANGER }) })),
      "gateway_identity",
    );
  });

  it("refuses a gateway whose VERSION moved since the quote was prepared", () => {
    // Same address, new code: the tuple was encoded for the old contract and its
    // meaning is no longer proven. Read into the anchors from the start and, for
    // a while, never compared.
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ gatewayVersion: 2n }) })),
      "gateway_identity",
    );
  });

  it("refuses a gateway pointing at a factory other than the pinned PartyFactory", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ gatewayFactory: STRANGER }) })),
      "gateway_identity",
    );
  });

  it("refuses when the gateway is paused", () => {
    expectViolation(verifyPoolsLaunchCalldata(input({ anchors: anchors({ gatewayPaused: true }) })), "gateway_identity");
  });

  it("refuses a STALE fee quote - the fee is dynamic and moved 4x in a day", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ gatewayDeploymentFeeWei: 263_000_000_000_000n }) })),
      "gateway_identity",
    );
  });

  it("refuses a fee outside the gateway's own MIN/MAX bounds", () => {
    const tuple = baseTuple({ expectedFeeWei: 50_000_000_000_000_000n });
    expectViolation(
      verifyPoolsLaunchCalldata(
        input({
          response: response(tuple),
          anchors: anchors({ gatewayDeploymentFeeWei: 50_000_000_000_000_000n }),
        }),
      ),
      "gateway_identity",
    );
  });
});

describe("point 2 - the provider's own staleness flag", () => {
  it("refuses when requiresReprepare is set", () => {
    const tuple = baseTuple();
    expectViolation(
      verifyPoolsLaunchCalldata(input({ response: response(tuple, { requiresReprepare: true }) })),
      "requires_reprepare",
    );
  });
});

describe("point 3 - selector and canonical encoding", () => {
  it("refuses calldata that is not a launch call at all", () => {
    const tuple = baseTuple();
    expectViolation(
      verifyPoolsLaunchCalldata(input({ response: response(tuple, { data: "0xdeadbeef" }) })),
      "selector_and_encoding",
    );
  });

  it("refuses calldata carrying trailing bytes the decode does not show", () => {
    const tuple = baseTuple();
    const smuggled = `${encode(tuple)}${"ff".repeat(32)}` as Hex;
    expectViolation(
      verifyPoolsLaunchCalldata(input({ response: response(tuple, { data: smuggled }) })),
      "selector_and_encoding",
    );
  });

  it("decodeLaunchCalldata returns null rather than throwing on rubbish", () => {
    expect(decodeLaunchCalldata("0x1234" as Hex)).toBeNull();
  });
});

describe("point 4 - the response must mirror the calldata (show one thing, sign another)", () => {
  it.each([
    ["salt", { salt: `0x${"11".repeat(32)}` }],
    ["metadataUri", { metadataUri: "ipfs://something-else" }],
    ["deadline", { deadline: "1999999999" }],
    ["devBuyMinOut", { devBuyMinOut: "1" }],
    ["nativeDevBuyWei", { nativeDevBuyWei: "1" }],
    ["deploymentFeeWei", { deploymentFeeWei: "1" }],
    ["tokenSymbol", { tokenSymbol: "NOTTHIS" }],
    // The ADDRESS is the half that must agree; `display` is a UI label.
    ["feeRecipient", { feeRecipient: { address: STRANGER, display: shortenAddress(STRANGER) } }],
  ])("refuses when the response's %s disagrees with the signed calldata", (_label, over) => {
    const tuple = baseTuple();
    expectViolation(
      verifyPoolsLaunchCalldata(input({ response: response(tuple, over as Partial<PoolsPrepareResponse>) })),
      "response_mirrors_calldata",
    );
  });

  it("refuses a tuple whose NAME is not the one requested", () => {
    const tuple = baseTuple({ name: "Not What You Asked For" });
    expectViolation(verifyPoolsLaunchCalldata(input({ response: response(tuple) })), "response_mirrors_calldata");
  });

  it("refuses a ZERO fee recipient on the agent path, despite the gateway's msg.sender substitution", () => {
    // The substitution is real, but a signed tuple that does not state who is
    // paid would let a later gateway change silently redirect the fee stream.
    const tuple = baseTuple({ feeRecipient: ZERO });
    expectViolation(verifyPoolsLaunchCalldata(input({ response: response(tuple) })), "response_mirrors_calldata");
  });

  it("refuses a recipient that is a STRANGER rather than the intended wallet", () => {
    // MOVED FROM POINT 4 TO POINT 15 with the V3 suite, deliberately. A tuple
    // recipient may now legitimately be a fees-to-holders SENTINEL, which is not
    // a wallet anyone owns, so "is this the recipient we intended" stopped being
    // an address comparison and became a question about the caller's INTENT.
    // Point 4 still owns the mirror (response versus calldata) and the zero
    // rejection; point 15 owns which non-zero recipient is right. The refusal is
    // as strict as before - only its name changed.
    const tuple = baseTuple({ feeRecipient: STRANGER });
    expectViolation(verifyPoolsLaunchCalldata(input({ response: response(tuple) })), "fee_recipient_mode");
  });
});

describe("point 5 - paired asset maps and is allowlisted", () => {
  it("refuses a tuple paired against a different asset than the symbol names", () => {
    const tuple = baseTuple({ pairedAsset: STRANGER });
    expectViolation(verifyPoolsLaunchCalldata(input({ response: response(tuple) })), "paired_asset_allowlisted");
  });

  it("refuses when allowedPairedAsset is false at the anchored block", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ pairedAssetAllowed: false }) })),
      "paired_asset_allowlisted",
    );
  });
});

describe("point 6 - start tick, including the live/fallback flag", () => {
  it("refuses a STALE tick", () => {
    expectViolation(verifyPoolsLaunchCalldata(input({ anchors: anchors({ startTick: -190_000 }) })), "start_tick_agrees");
  });

  it("refuses when the factory is serving the FALLBACK tick, even if the number matches", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ startTickLive: false }) })),
      "start_tick_agrees",
    );
  });
});

describe("point 7 - the metadata says what was requested", () => {
  it("refuses when the metadata could not be fetched", () => {
    expectViolation(verifyPoolsLaunchCalldata(input({ metadata: null })), "metadata_matches_request");
  });

  it("refuses metadata naming a different token", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ metadata: metadata({ name: "Someone Else's Coin" }) })),
      "metadata_matches_request",
    );
  });

  it("refuses metadata whose fee recipient is not ours", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ metadata: metadata({ initial_fee_recipient: { address: STRANGER } }) })),
      "metadata_matches_request",
    );
  });

  it("CATCHES THE IMAGE TRAP: an image was requested but the metadata carries none", () => {
    // This is the measured provider defect - `image` is accepted and dropped,
    // only `imageUrl` lands. Without this point a launch succeeds and renders
    // blank forever.
    const result = verifyPoolsLaunchCalldata(input({ metadata: metadata({ image: undefined }) }));
    expectViolation(result, "metadata_matches_request");
    if (result.ok) return;
    expect(result.violations.map((v) => v.detail).join(" ")).toContain("imageUrl");
  });

  it("accepts metadata with no image when no image was requested", () => {
    const result = verifyPoolsLaunchCalldata(
      input({ metadata: metadata({ image: undefined }), expectation: expectation({ imageUrl: undefined }) }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("point 8 - three derivations of the token address agree", () => {
  it("refuses when the gateway computes a different address than the provider predicts", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ computedTokenAddress: STRANGER }) })),
      "token_address_agrees",
    );
  });

  it("refuses when SIMULATING the launch produces a different address", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ simulation: simulation({ simulatedTokenAddress: STRANGER }) })),
      "token_address_agrees",
    );
  });
});

describe("point 9 - dev-buy modes and amounts", () => {
  it("refuses a tuple that sets BOTH dev-buy modes", () => {
    const tuple = baseTuple({ erc20DevBuyAmountIn: 5n });
    expectViolation(verifyPoolsLaunchCalldata(input({ response: response(tuple) })), "dev_buy_consistent");
  });

  it("refuses a prebuy that was never requested", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ expectation: expectation({ devBuy: undefined }) })),
      "dev_buy_consistent",
    );
  });

  it("refuses an INFLATED prebuy amount", () => {
    const tuple = baseTuple({ nativeDevBuyAmount: PREBUY_WEI * 10n });
    expectViolation(verifyPoolsLaunchCalldata(input({ response: response(tuple) })), "dev_buy_consistent");
  });

  it("refuses a devBuyMinOut that is not the EXACT simulated fill (no percentage band)", () => {
    const tuple = baseTuple({ devBuyMinOut: (DEV_BUY_OUT * 99n) / 100n });
    expectViolation(verifyPoolsLaunchCalldata(input({ response: response(tuple) })), "dev_buy_consistent");
  });

  it("refuses a minOut of ZERO, which would accept any fill at all", () => {
    const tuple = baseTuple({ devBuyMinOut: 0n });
    expectViolation(verifyPoolsLaunchCalldata(input({ response: response(tuple) })), "dev_buy_consistent");
  });
});

describe("point 10 - the FINAL calldata still simulates", () => {
  it("refuses when the pinned-minOut calldata no longer simulates", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(
        input({ simulation: simulation({ finalSimulationSucceeded: false, finalSimulationError: "StartTickChanged" }) }),
      ),
      "final_simulation",
    );
  });
});

describe("point 11 - value is EXACTLY fee + native prebuy", () => {
  it("refuses value carrying an unexplained excess", () => {
    const tuple = baseTuple();
    expectViolation(
      verifyPoolsLaunchCalldata(
        input({ response: response(tuple, { value: (FEE_WEI + PREBUY_WEI + 1n).toString() }) }),
      ),
      "value_exact",
    );
  });

  it("refuses value that is short of the fee plus prebuy", () => {
    const tuple = baseTuple();
    expectViolation(
      verifyPoolsLaunchCalldata(input({ response: response(tuple, { value: FEE_WEI.toString() }) })),
      "value_exact",
    );
  });
});

describe("point 12 - the balance covers value, gas AND the Vex fee", () => {
  it("refuses when the wallet cannot cover the total", () => {
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ nativeBalanceWei: FEE_WEI }) })),
      "balance_covers_total",
    );
  });

  it("counts the Vex fee in the total, not just value and gas", () => {
    // Exactly enough for value + gas, one wei short once the Vex fee counts.
    const justShort = FEE_WEI + PREBUY_WEI + GAS_BOUND + VEX_FEE - 1n;
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ nativeBalanceWei: justShort }) })),
      "balance_covers_total",
    );
    const exact = FEE_WEI + PREBUY_WEI + GAS_BOUND + VEX_FEE;
    expect(verifyPoolsLaunchCalldata(input({ anchors: anchors({ nativeBalanceWei: exact }) })).ok).toBe(true);
  });
});

describe("refusals are complete and diagnosable", () => {
  it("reports EVERY failed point, not just the first", () => {
    const tuple = baseTuple({ feeRecipient: STRANGER, nativeDevBuyAmount: PREBUY_WEI * 3n });
    const result = verifyPoolsLaunchCalldata(
      input({
        response: response(tuple, { requiresReprepare: true }),
        anchors: anchors({ gatewayPaused: true, startTickLive: false }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const points = new Set(result.violations.map((v) => v.point));
    // A caller told only about the first problem would fix it and meet the next.
    expect(points.size).toBeGreaterThanOrEqual(4);
    for (const violation of result.violations) {
      expect(violation.detail.length, `${violation.point} needs a real explanation`).toBeGreaterThan(20);
    }
  });
});

describe("the gateway's own WETH is the only WETH", () => {
  it("refuses a `weth` pair whose address is not the gateway's weth()", () => {
    // A token list can call anything WETH. The gateway cannot: its native-prebuy
    // guard compares against THIS address, and a pool against a different one
    // would trade the new token against something else entirely.
    expectViolation(
      verifyPoolsLaunchCalldata(input({ anchors: anchors({ gatewayWeth: STRANGER }) })),
      "paired_asset_allowlisted",
    );
  });

  it("refuses a NATIVE prebuy paired against anything but the gateway's weth", () => {
    // `NativeDevBuyRequiresWeth` (verified gateway source, line 140). Caught
    // before signing rather than discovered as a revert that burned gas.
    const tuple = baseTuple({ pairedAsset: STRANGER });
    expectViolation(
      verifyPoolsLaunchCalldata(
        input({
          response: response(tuple),
          expectation: expectation({ pairedAsset: "usdg", pairedAssetAddress: STRANGER }),
        }),
      ),
      "dev_buy_consistent",
    );
  });
});
