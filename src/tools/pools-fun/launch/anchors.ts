/**
 * The anchored chain reads the calldata verifier judges against.
 *
 * ONE BLOCK, EVERY READ. The gateway's fee moves (measured 4x inside a day), the
 * factory's start tick tracks a price feed, and an allowlist is a live setting;
 * reading them at whatever block each call happened to land on would produce a
 * verdict about no single state of the chain. So the block is pinned first and
 * every read is made `at` it, exactly the way `evm/token-registration.ts` pins
 * the token snapshot.
 *
 * DECLINE OVER GUESS. `allowFailure` is on, because one reverting call must not
 * take the batch down - but a MISSING read is never substituted with a default.
 * Each failure is named ("the gateway's paused flag could not be read"), and the
 * caller refuses the launch rather than signing against a fact it does not have.
 * A zero fee, a false `paused`, or an all-zero token address invented from a
 * failed call would each be a signature obtained under a wrong belief.
 *
 * The FACTORY reads are made against the PINNED PartyFactory rather than against
 * the `factory` this batch reads out of the gateway: a gateway that names a
 * different factory is exactly what the verifier's point 1 refuses, and reading
 * the allowlist out of the contract under suspicion would launder the answer.
 */

import type { Address, Chain, Hex, PublicClient, Transport } from "viem";

import { POOLS_FACTORY_READ_ABI, POOLS_GATEWAY_ABI } from "../abi.js";
import { POOLS_FACTORY_ADDRESS, POOLS_GATEWAY_ADDRESS } from "../constants.js";
import type { PoolsChainAnchors } from "./verifier-types.js";

/** What the anchored reads need to know before they can be made. */
export interface ReadPoolsAnchorsInput {
  readonly publicClient: PublicClient<Transport, Chain>;
  /** The address the tuple pairs against, whose allowlist and tick are read. */
  readonly pairedAssetAddress: Address;
  /** The launching wallet: `computeTokenAddress` is keyed on it, and its balance is read. */
  readonly launcher: Address;
  readonly userSalt: Hex;
  readonly name: string;
  readonly symbol: string;
  readonly metadataUri: string;
  /** The gateway to interrogate. Defaults to the pinned one; injectable for tests. */
  readonly gatewayAddress?: Address | undefined;
}

export type ReadPoolsAnchorsResult =
  | { readonly ok: true; readonly anchors: PoolsChainAnchors }
  | { readonly ok: false; readonly reason: string };

type Call = { status: "success"; result: unknown } | { status: "failure" };

export async function readPoolsChainAnchors(
  input: ReadPoolsAnchorsInput,
): Promise<ReadPoolsAnchorsResult> {
  const client = input.publicClient;
  const gateway = input.gatewayAddress ?? (POOLS_GATEWAY_ADDRESS as Address);
  const factory = POOLS_FACTORY_ADDRESS as Address;

  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (err) {
    return { ok: false, reason: `the chain's current block could not be read (${errorName(err)})` };
  }

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
  const read = <T>(index: number, label: string): T | null => {
    const call = results[index];
    if (call === undefined || call.status !== "success") {
      missing.push(label);
      return null;
    }
    return call.result as T;
  };

  const version = read<bigint>(0, "the gateway's VERSION");
  const gatewayFactory = read<Address>(1, "the gateway's factory address");
  const paused = read<boolean>(2, "the gateway's paused flag");
  const deploymentFeeWei = read<bigint>(3, "the gateway's current deployment fee");
  const minFeeWei = read<bigint>(4, "the gateway's minimum deployment fee");
  const maxFeeWei = read<bigint>(5, "the gateway's maximum deployment fee");
  const weth = read<Address>(6, "the gateway's WETH address");
  const computedTokenAddress = read<Address>(7, "the gateway's computed token address");
  const pairedAssetAllowed = read<boolean>(8, "whether the factory allows this paired asset");
  const startTick = read<readonly [number, boolean]>(9, "the factory's start tick for this pair");

  if (
    version === null
    || gatewayFactory === null
    || paused === null
    || deploymentFeeWei === null
    || minFeeWei === null
    || maxFeeWei === null
    || weth === null
    || computedTokenAddress === null
    || pairedAssetAllowed === null
    || startTick === null
  ) {
    return {
      ok: false,
      reason:
        `at block ${blockNumber} these launch facts did not answer: ${missing.join("; ")}. `
        + "Nothing is assumed in their place.",
    };
  }

  return {
    ok: true,
    anchors: {
      blockNumber,
      gatewayVersion: version,
      gatewayFactory,
      gatewayPaused: paused,
      gatewayDeploymentFeeWei: deploymentFeeWei,
      gatewayMinFeeWei: minFeeWei,
      gatewayMaxFeeWei: maxFeeWei,
      gatewayWeth: weth,
      pairedAssetAllowed,
      startTick: startTick[0],
      startTickLive: startTick[1],
      computedTokenAddress,
      nativeBalanceWei,
    },
  };
}

/** The error's NAME only - an RPC error's message carries URLs and request bodies. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}
