/**
 * The anchored chain reads the calldata verifier judges against.
 *
 * ONE BLOCK, EVERY READ. The gateway's fee moves (measured 4x inside a day), the
 * factory's start tick tracks a price feed, an allowlist is a live setting, and
 * a signed stock quote is valid for between 30 and 120 seconds; reading them at
 * whatever block each call happened to land on would produce a verdict about no
 * single state of the chain. So the block is pinned first and every read is made
 * `at` it, exactly the way `evm/token-registration.ts` pins the token snapshot.
 * The block's TIMESTAMP is pinned with it, because the attestation's own bounds
 * are compared against the chain's clock, not the host's.
 *
 * DECLINE OVER GUESS. `allowFailure` is on, because one reverting call must not
 * take the batch down - but a MISSING read is never substituted with a default.
 * Each failure is named ("the gateway's paused flag could not be read"), and the
 * caller refuses the launch rather than signing against a fact it does not have.
 * A zero fee, a false `paused`, or an all-zero token address invented from a
 * failed call would each be a signature obtained under a wrong belief.
 *
 * WHICH FAILURES ARE REAL FACTS. Three reads are allowed to fail without
 * refusing, because their failure is a capability statement rather than an
 * outage, and each is carried as an explicit `null` the verifier must handle:
 *   - `FEES_TO_HOLDERS_PAIRED` / `_BOTH` revert on V2 (measured): that suite has
 *     token-mode holder rewards only.
 *   - `startTickFor` reverts `PriceAttestationRequired` on a `SIGNED_STOCK` pair
 *     (verified source): that pair's tick comes from the attestation instead.
 *   - `quoteStartTick` reverts when the factory itself rejects the quote, which
 *     is the single most important thing point 14 can learn.
 *
 * PIN-NOTE, viem `multicall` with `allowFailure: true` on a RETURN-TYPE
 * MISMATCH (measured 2026-09-04 against the live V3 locker `0xd64C1f0f`,
 * archived in `live-chain/suite_probe_2026-09-04.json`):
 *
 *   `weth()` declared as `uint256`          -> status "success", result
 *                                              67611942442155685878309345127505071630355049843
 *                                              (the address's bytes, read as a number)
 *   `getPoolInfo()` (5 outputs) as `uint256`-> status "success", result 0
 *   `weth()` declared as `(address,address)`-> status "failure" ("Position 63 is
 *                                              out of bounds")
 *   a selector the contract lacks           -> status "failure" (reverted)
 *
 * So a WRONG ABI does NOT reliably produce a failure: viem decodes the leading
 * word and reports success with a meaningless value, and the second case is
 * indistinguishable from a legitimate zero. The consequence, applied here and in
 * `evm/token-registration.ts`: "the call succeeded" is never treated as evidence
 * that the right contract answered. Identity is established by comparing DECODED
 * VALUES across contracts (the suite triangle), never by the absence of a
 * multicall failure.
 *
 * The FACTORY reads are made against the SUITE's factory rather than against the
 * `factory` this batch reads out of the gateway: a gateway that names a
 * different factory is exactly what the verifier's point 1 refuses, and reading
 * the allowlist out of the contract under suspicion would launder the answer.
 */

import type { Address, Chain, Hex, PublicClient, Transport } from "viem";

import {
  POOLS_FACTORY_READ_ABI,
  POOLS_GATEWAY_ABI,
  poolsPricingModeFromWire,
  type PoolsPricingMode,
} from "../abi.js";
import { poolsLaunchSuite } from "../constants.js";
import type { PoolsChainAnchors, PoolsPriceAttestation } from "./verifier-types.js";

/** What the anchored reads need to know before they can be made. */
export interface ReadPoolsAnchorsInput {
  readonly publicClient: PublicClient<Transport, Chain>;
  /** The address the tuple pairs against, whose allowlist, mode and tick are read. */
  readonly pairedAssetAddress: Address;
  /** The launching wallet: `computeTokenAddress` is keyed on it, and its balance is read. */
  readonly launcher: Address;
  readonly userSalt: Hex;
  readonly name: string;
  readonly symbol: string;
  readonly metadataUri: string;
  /**
   * The attestation and signature the TUPLE carries.
   *
   * Passed in rather than constructed here so the tick the factory derives is
   * derived from the exact bytes that will be signed. A signature of `0x` means
   * the tuple carries none, and the signed-quote read is skipped: asking the
   * factory to validate an empty signature would produce a revert that says
   * nothing.
   */
  readonly priceAttestation: PoolsPriceAttestation;
  readonly priceSignature: Hex;
  /** The gateway to interrogate. Defaults to the launch suite's; injectable for tests. */
  readonly gatewayAddress?: Address | undefined;
  /** The factory to interrogate. Defaults to the launch suite's; injectable for tests. */
  readonly factoryAddress?: Address | undefined;
}

export type ReadPoolsAnchorsResult =
  | { readonly ok: true; readonly anchors: PoolsChainAnchors }
  | { readonly ok: false; readonly reason: string };

type Call =
  | { status: "success"; result: unknown }
  | { status: "failure"; error?: unknown };

export async function readPoolsChainAnchors(
  input: ReadPoolsAnchorsInput,
): Promise<ReadPoolsAnchorsResult> {
  const client = input.publicClient;
  const suite = poolsLaunchSuite();
  const gateway = input.gatewayAddress ?? (suite.gateway as Address);
  const factory = input.factoryAddress ?? (suite.factory as Address);

  let blockNumber: bigint;
  let blockTimestamp: bigint;
  try {
    // The block is fetched WHOLE rather than by number alone: the attestation's
    // freshness is judged against the chain's clock, and a timestamp read from a
    // second call could describe a different block.
    const block = await client.getBlock();
    blockNumber = block.number;
    blockTimestamp = block.timestamp;
  } catch (err) {
    return { ok: false, reason: `the chain's current block could not be read (${errorName(err)})` };
  }

  const hasSignature = input.priceSignature !== "0x" && input.priceSignature.length > 2;

  let results: readonly Call[];
  let nativeBalanceWei: bigint;
  try {
    const [batch, balance] = await Promise.all([
      client.multicall({
        allowFailure: true,
        blockNumber,
        contracts: [
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "VERSION" },
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "factory" },
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "paused" },
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "deploymentFeeWei" },
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "MIN_DEPLOYMENT_FEE_WEI" },
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "MAX_DEPLOYMENT_FEE_WEI" },
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "weth" },
          {
            address: gateway,
            abi: POOLS_GATEWAY_ABI,
            functionName: "computeTokenAddress",
            args: [input.launcher, input.userSalt, input.name, input.symbol, input.metadataUri],
          },
          { address: factory, abi: POOLS_FACTORY_READ_ABI, functionName: "locker" },
          {
            address: factory,
            abi: POOLS_FACTORY_READ_ABI,
            functionName: "allowedPairedAsset",
            args: [input.pairedAssetAddress],
          },
          {
            address: factory,
            abi: POOLS_FACTORY_READ_ABI,
            functionName: "startTickFor",
            args: [input.pairedAssetAddress],
          },
          // ── Reads whose FAILURE is a fact, not an outage ────────────
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "FEES_TO_HOLDERS" },
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "FEES_TO_HOLDERS_PAIRED" },
          { address: gateway, abi: POOLS_GATEWAY_ABI, functionName: "FEES_TO_HOLDERS_BOTH" },
          {
            address: factory,
            abi: POOLS_FACTORY_READ_ABI,
            functionName: "pricingModeFor",
            args: [input.pairedAssetAddress],
          },
          {
            address: factory,
            abi: POOLS_FACTORY_READ_ABI,
            functionName: "getPairedAssetCurve",
            args: [input.pairedAssetAddress],
          },
          { address: factory, abi: POOLS_FACTORY_READ_ABI, functionName: "priceSigner" },
          { address: factory, abi: POOLS_FACTORY_READ_ABI, functionName: "pricingEpoch" },
          { address: factory, abi: POOLS_FACTORY_READ_ABI, functionName: "MIN_SIGNED_QUOTE_AGE" },
          { address: factory, abi: POOLS_FACTORY_READ_ABI, functionName: "MAX_SIGNED_QUOTE_AGE" },
        ],
      }),
      // The balance is read AT THE SAME BLOCK: a balance from a later block
      // could clear a gate the anchored state would not.
      client.getBalance({ address: input.launcher, blockNumber }),
    ]);
    results = batch as readonly Call[];
    nativeBalanceWei = balance;
  } catch (err) {
    return {
      ok: false,
      reason: `the launch's on-chain facts could not be read at block ${blockNumber} (${errorName(err)})`,
    };
  }

  const missing: string[] = [];
  /** A read that MUST answer. Its absence refuses the launch. */
  const required = <T>(index: number, label: string): T | null => {
    const call = results[index];
    if (call === undefined || call.status !== "success") {
      missing.push(label);
      return null;
    }
    return call.result as T;
  };
  /** A read whose failure is a capability fact, carried as `null`. */
  const optional = <T>(index: number): T | null => {
    const call = results[index];
    return call !== undefined && call.status === "success" ? (call.result as T) : null;
  };

  const version = required<bigint>(0, "the gateway's VERSION");
  const gatewayFactory = required<Address>(1, "the gateway's factory address");
  const paused = required<boolean>(2, "the gateway's paused flag");
  const deploymentFeeWei = required<bigint>(3, "the gateway's current deployment fee");
  const minFeeWei = required<bigint>(4, "the gateway's minimum deployment fee");
  const maxFeeWei = required<bigint>(5, "the gateway's maximum deployment fee");
  const weth = required<Address>(6, "the gateway's WETH address");
  const computedTokenAddress = required<Address>(7, "the gateway's computed token address");
  const factoryLocker = required<Address>(8, "the factory's locker address");
  const pairedAssetAllowed = required<boolean>(9, "whether the factory allows this paired asset");
  const pricingModeWire = required<number>(14, "the factory's pricing mode for this pair");

  if (
    version === null
    || gatewayFactory === null
    || paused === null
    || deploymentFeeWei === null
    || minFeeWei === null
    || maxFeeWei === null
    || weth === null
    || computedTokenAddress === null
    || factoryLocker === null
    || pairedAssetAllowed === null
    || pricingModeWire === null
  ) {
    return {
      ok: false,
      reason:
        `at block ${blockNumber} these launch facts did not answer: ${missing.join("; ")}. `
        + "Nothing is assumed in their place.",
    };
  }

  const pricingMode: PoolsPricingMode | null = poolsPricingModeFromWire(Number(pricingModeWire));

  // `startTickFor` REVERTS on a SIGNED_STOCK pair, so its failure is only a
  // refusal on the modes where it is supposed to answer. Point 6 decides what
  // to do with a `null`; the anchors only report what the chain said.
  const startTickPair = optional<readonly [number, boolean]>(10);
  const startTickRequired = pricingMode === "CORE_CHAINLINK" || pricingMode === "CHAINLINK_STOCK";
  if (startTickRequired && startTickPair === null) {
    return {
      ok: false,
      reason:
        `at block ${blockNumber} the factory's start tick for this pair did not answer, although its pricing `
        + `mode (${pricingMode}) is one that derives a tick from a feed. Nothing is assumed in its place.`,
    };
  }

  const curve = optional<{ readonly maxQuoteAge: number }>(15);

  // ── The factory's own verdict on the signed quote ──────────────────
  //
  // A SEPARATE call rather than a 21st member of the batch, for two reasons:
  // viem's typed `multicall` overload caps a literal tuple at 20 contracts, and
  // this read is conditional - an empty signature is a SHAPE question point 14
  // answers without spending an RPC call. It is still pinned to the SAME block,
  // so the verdict describes the state the rest of the anchors describe.
  //
  // A REVERT HERE IS THE MOST INFORMATIVE THING THE FACTORY CAN SAY: it means
  // the epoch, the window or the ECDSA signer failed, which is exactly what
  // point 14 needs and what no local re-derivation could establish as reliably.
  let signedStartTick: number | null = null;
  let signedStartTickError: string | null = null;
  if (hasSignature) {
    try {
      const tick = await client.readContract({
        address: factory,
        abi: POOLS_FACTORY_READ_ABI,
        functionName: "quoteStartTick",
        args: [input.pairedAssetAddress, attestationArg(input.priceAttestation), input.priceSignature],
        blockNumber,
      });
      signedStartTick = Number(tick);
    } catch (err) {
      signedStartTickError = `the factory refused this signed quote (${errorName(err)})`;
    }
  }

  return {
    ok: true,
    anchors: {
      blockNumber,
      blockTimestamp,
      gatewayVersion: version,
      gatewayFactory,
      factoryLocker,
      gatewayPaused: paused,
      gatewayDeploymentFeeWei: deploymentFeeWei,
      gatewayMinFeeWei: minFeeWei,
      gatewayMaxFeeWei: maxFeeWei,
      gatewayWeth: weth,
      feesToHoldersSentinels: {
        token: optional<Address>(11),
        paired: optional<Address>(12),
        both: optional<Address>(13),
      },
      pairedAssetAllowed,
      pricingMode,
      startTick: startTickPair === null ? null : startTickPair[0],
      startTickLive: startTickPair !== null && startTickPair[1],
      signedStartTick,
      signedStartTickError,
      priceSigner: optional<Address>(16),
      pricingEpoch: optional<bigint>(17),
      assetMaxQuoteAgeSeconds: curve === null ? null : BigInt(curve.maxQuoteAge),
      minSignedQuoteAgeSeconds: nullableBigint(optional<number>(18)),
      maxSignedQuoteAgeSeconds: nullableBigint(optional<number>(19)),
      computedTokenAddress,
      nativeBalanceWei,
    },
  };
}

/** The attestation in the positional shape viem encodes a solidity struct from. */
function attestationArg(attestation: PoolsPriceAttestation): {
  asset: Address;
  underlyingPriceUsdE18: bigint;
  expectedUiMultiplier: bigint;
  observedAt: bigint;
  expiresAt: bigint;
  pricingEpoch: bigint;
} {
  return {
    asset: attestation.asset,
    underlyingPriceUsdE18: attestation.underlyingPriceUsdE18,
    expectedUiMultiplier: attestation.expectedUiMultiplier,
    observedAt: attestation.observedAt,
    expiresAt: attestation.expiresAt,
    pricingEpoch: attestation.pricingEpoch,
  };
}

function nullableBigint(value: number | bigint | null): bigint | null {
  return value === null ? null : BigInt(value);
}

/** The error's NAME only - an RPC error's message carries URLs and request bodies. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}
