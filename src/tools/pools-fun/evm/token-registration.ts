/**
 * The on-chain half of `pools.token` and every claim: WHICH pools.fun contract
 * suite a token belongs to, and what that suite says about it.
 *
 * THE DEFECT THIS MODULE WAS REBUILT AROUND. pools.fun redeployed its whole
 * contract triple twice in three days and kept every generation live. While the
 * locker address was a single pinned constant, `getPoolInfo` on the V1 locker
 * returned all zeroes for every post-migration token, and the zeroes were
 * faithfully reported as "not registered - expected for a token launched by the
 * older sushi launcher". Measured on 2026-09-04: a V3 token (DICK) and a
 * holder-rewards token (FLOAT) both got that verdict, and `pools.claim_fees`
 * refused their claims with the same wrong reason. The tri-state was sound; the
 * ADDRESS was wrong, and a wrong address makes a sound tri-state lie precisely.
 *
 * SO SUITE DETECTION ASKS EVERY SUITE, AT ONE BLOCK, IN ONE MULTICALL - two
 * questions each, and the two questions answer DIFFERENT things:
 *
 *   `locker.getPoolInfo(token)`  populated only on the suite that HOLDS its LP.
 *                                This is the REGISTRATION, and it is the money
 *                                authority: the locker owns `getPoolSplits`,
 *                                the `claimable*` mappings and `collectAndClaim`.
 *   `gateway.launcherOf(token)`  the wallet that launched it THROUGH THE GATEWAY,
 *                                and zero for a token launched directly against
 *                                the factory. This is ATTRIBUTION, not
 *                                registration.
 *
 * THE LOCKER LEADS, AND THAT IS A MEASURED DECISION, not a simplification. An
 * earlier revision of this module required BOTH to be non-zero before calling a
 * token registered. Run live on 2026-09-04 it reported `ambiguous` for sushicat
 * - a perfectly ordinary V1 token that has traded for three weeks - because the
 * V1 locker holds its LP (`pool 0x50136D41...`) while the V1 gateway names no
 * launcher for it: it was launched directly through the factory, which most
 * pools.fun tokens are. Demanding gateway agreement would have turned the
 * majority of the launchpad into "we cannot tell", which is a worse lie than the
 * one it replaced. Measured evidence, all three at the same block:
 *
 *   sushicat  V1 locker HOLDS, V1 gateway names none  -> registered on V1
 *   VEXFLAM   V1 locker HOLDS, V1 gateway names us    -> registered on V1, ours
 *   THONG     V3 locker HOLDS, V3 gateway names its creator -> registered on V3
 *
 * The gateway still has teeth in the direction where it means something: a
 * gateway that NAMES a launcher while its own locker holds nothing is a real
 * contradiction (a launch that never registered, or two suites disagreeing), and
 * that is reported as `ambiguous` rather than resolved.
 *
 * FOUR OUTCOMES, NOT TWO, AND NEVER FIRST-MATCH-WINS (rule 90, decline over
 * guess; v3 plan section 9):
 *
 *   registered    exactly one suite matched. A fact, and it names the suite.
 *   unregistered  every suite ANSWERED and none matched. Also a fact: this token
 *                 is not registered with any pools.fun suite Vex knows.
 *   ambiguous     more than one suite matched, or one suite's two contracts
 *                 disagreed. Something is true that this model does not describe,
 *                 and picking one would be a guess wearing a verdict's clothes.
 *   unavailable   at least one suite could not be fully asked. NOTHING was
 *                 proven; in particular this is NOT "unregistered".
 *
 * The old code's `unregistered` note said the token was "launched by the older
 * sushi launcher". That sentence is now reserved for a row the API itself labels
 * `platform: "sushi"`; inferring a launcher from an absence is exactly the
 * inference that produced the wrong verdict, and the API row is the only
 * evidence for it.
 *
 * PIN-NOTE, viem multicall `allowFailure` on a return-type mismatch (measured
 * 2026-09-04, live V3 locker; full note and numbers in `../launch/anchors.ts`):
 * a wrong ABI does NOT reliably yield `status: "failure"` - `getPoolInfo`
 * declared as a single `uint256` came back `status: "success", result: 0n`,
 * indistinguishable from a legitimate zero. That measurement is why registration
 * is decided by comparing DECODED VALUES across two contracts rather than by
 * trusting that a call which "succeeded" reached the contract we meant.
 *
 * The Robinhood chain wiring is NOT duplicated here: `evm-chains/registry.ts`
 * owns the RPC, the user's RPC override and the Multicall3 address, exactly as
 * kyberswap and uniswap consume it.
 */

import type { Address, Chain, PublicClient, Transport } from "viem";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { PARTY_LOCKER_ABI, PARTY_TOKEN_ABI, POOLS_GATEWAY_ABI } from "../abi.js";
import {
  POOLS_CHAIN_ID,
  POOLS_SUITES,
  type PoolsContractSuite,
  type PoolsSuiteVersion,
} from "../constants.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Fee split of the pool's 1% fee, in basis points, as the locker reports it. */
export interface PoolsFeeSplitBps {
  creator: number;
  platform: number;
  buyback: number;
  community: number;
  /** Stock-paired curves split differently: creator vs protocol, no community leg. */
  stockCreator: number;
  stockProtocol: number;
}

/** What the locker knows about a token it registered. */
export interface PoolsLockerInfo {
  pairedAssetAddress: string;
  pool: string;
  creator: string;
  feeRecipient: string;
  /** LP position ids the locker holds forever for this token. */
  lockedPositionIds: string[];
  /**
   * Tri-state, for the same reason the registration is: the splits are a
   * SECOND call and can fail while `getPoolInfo` succeeds. `null` here means
   * that call did not answer, and the handler says so rather than implying the
   * token has no fee split.
   */
  feeSplitBps: PoolsFeeSplitBps | null;
  feeSplitAvailable: boolean;
}

/** One read that either produced a value or explicitly did not. */
export type PoolsRead<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "unavailable" };

/**
 * The suite verdict for one token.
 *
 * `registered` carries the suite so every downstream call - the claim's locker,
 * the settlement decoder's emitters, the holder-rewards deployer - uses the SAME
 * addresses this verdict was established from, instead of re-deriving them.
 */
export type PoolsLockerRegistration =
  | {
      readonly status: "registered";
      readonly suite: PoolsContractSuite;
      /**
       * The wallet that launched it THROUGH THE GATEWAY, or `null` when the
       * token was launched directly against the factory (measured: most
       * pools.fun tokens, sushicat among them). Never `null` for a failed read -
       * a read that did not answer produces `unavailable` instead.
       */
      readonly launcher: string | null;
      readonly info: PoolsLockerInfo;
    }
  | { readonly status: "unregistered" }
  | {
      readonly status: "ambiguous";
      /** What was contradictory, in words a refusal can print verbatim. */
      readonly detail: string;
    }
  | {
      readonly status: "unavailable";
      /** Which suites could not be fully asked. Never a generic "RPC error". */
      readonly detail: string;
    };

/**
 * The on-chain snapshot for one token, pinned to `blockNumber`.
 *
 * Every member is independently tri-state because every member is an
 * independent call inside the batch: `allowFailure` is on so one reverting
 * contract cannot take the others down, which means "the others succeeded" and
 * "this one failed" must both be representable.
 */
export interface PoolsOnChainSnapshot {
  blockNumber: string;
  locker: PoolsLockerRegistration;
  decimals: PoolsRead<number>;
  /** `ok` with `null` means the contract answered with no URI; `unavailable` means it did not answer. */
  metadataUri: PoolsRead<string | null>;
}

function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}

/** The Robinhood public client, from the shared registry. Throws if 4663 is missing. */
function poolsPublicClient(): PublicClient<Transport, Chain> {
  const config = getLocalChain(POOLS_CHAIN_ID);
  if (config === undefined) {
    throw new Error(`Local chain ${POOLS_CHAIN_ID} (Robinhood) is not registered.`);
  }
  return getLocalPublicClient(config);
}

/** The three calls each suite is asked, in the order they appear in the batch. */
const CALLS_PER_SUITE = 3;

/**
 * Read the suite registration, fee splits, decimals and metadata URI for one
 * token, all at the same pinned block.
 *
 * ONE MULTICALL for every suite rather than a probe-until-hit loop: a loop would
 * make "which suite" depend on iteration order, would read different suites at
 * different blocks, and could not tell a second match from the first one. One
 * batch at one block gives every suite the same question at the same moment, so
 * a contradiction is visible instead of being resolved by luck.
 *
 * A THROWN error from this function means the batch itself could not be sent
 * (no chain, no node); a per-call failure inside the batch is reported as
 * `unavailable` on that member instead.
 */
export async function readPoolsOnChainSnapshot(token: Address): Promise<PoolsOnChainSnapshot> {
  const client = poolsPublicClient();
  const blockNumber = await client.getBlockNumber();

  const suiteCalls = POOLS_SUITES.flatMap((suite) => [
    {
      address: suite.locker as Address,
      abi: PARTY_LOCKER_ABI,
      functionName: "getPoolInfo" as const,
      args: [token] as const,
    },
    {
      address: suite.locker as Address,
      abi: PARTY_LOCKER_ABI,
      functionName: "getPoolSplits" as const,
      args: [token] as const,
    },
    {
      address: suite.gateway as Address,
      abi: POOLS_GATEWAY_ABI,
      functionName: "launcherOf" as const,
      args: [token] as const,
    },
  ]);

  const results = await client.multicall({
    allowFailure: true,
    blockNumber,
    contracts: [
      ...suiteCalls,
      { address: token, abi: PARTY_TOKEN_ABI, functionName: "decimals" },
      { address: token, abi: PARTY_TOKEN_ABI, functionName: "metadataUri" },
    ],
  });

  const tokenCallsAt = POOLS_SUITES.length * CALLS_PER_SUITE;
  const decimals = results[tokenCallsAt];
  const metadataUri = results[tokenCallsAt + 1];

  return {
    blockNumber: blockNumber.toString(),
    locker: resolveSuite(results.slice(0, tokenCallsAt) as readonly MulticallResult<unknown>[]),
    decimals:
      decimals !== undefined && decimals.status === "success"
        ? { status: "ok", value: Number(decimals.result) }
        : { status: "unavailable" },
    // An empty string is the contract answering "no URI", which is a fact and is
    // reported as `ok` with `null`. Only a failed call is `unavailable`.
    metadataUri:
      metadataUri !== undefined && metadataUri.status === "success"
        ? { status: "ok", value: metadataUri.result === "" ? null : (metadataUri.result as string) }
        : { status: "unavailable" },
  };
}

/**
 * One token's ERC-20 decimals, read from the token itself.
 *
 * Separate from the snapshot above because the launch path needs exactly this
 * one number, on a client it already holds, for a token that came into existence
 * seconds ago - and it must be READ rather than assumed. A raw amount without
 * its decimals is unreadable (rule 90), so a caller that cannot read them says
 * so instead of rendering a number at a guessed scale.
 *
 * THROWS when the call does not answer. The caller decides what an unreadable
 * display means; this function never invents a scale.
 */
export async function readPoolsTokenDecimals(
  client: PublicClient<Transport, Chain>,
  token: Address,
): Promise<number> {
  const decimals = await client.readContract({
    address: token,
    abi: PARTY_TOKEN_ABI,
    functionName: "decimals",
  });
  return Number(decimals);
}

type MulticallResult<T> = { status: "success"; result: T } | { status: "failure" };
type PoolInfo = readonly [string, string, string, string, readonly bigint[]];
type Splits = readonly [number, number, number, number, number, number];

/** One suite's three answers, already classified. */
interface SuiteProbe {
  readonly suite: PoolsContractSuite;
  /** `null` when `getPoolInfo` did not answer at all. */
  readonly lockerHolds: boolean | null;
  /** `null` when `launcherOf` did not answer at all. */
  readonly gatewayLauncher: string | null;
  readonly poolInfo: PoolInfo | null;
  readonly splits: Splits | null;
}

/**
 * Turn every suite's answers into ONE verdict.
 *
 * The order of the checks is the order of certainty: a partial read means
 * nothing was proven and is reported first; then a genuine contradiction; then
 * the single match; then the honest "none of them".
 */
function resolveSuite(results: readonly MulticallResult<unknown>[]): PoolsLockerRegistration {
  const probes: SuiteProbe[] = POOLS_SUITES.map((suite, index) => {
    const base = index * CALLS_PER_SUITE;
    const poolInfo = successOf<PoolInfo>(results[base]);
    const splits = successOf<Splits>(results[base + 1]);
    const launcher = successOf<string>(results[base + 2]);
    return {
      suite,
      lockerHolds: poolInfo === null ? null : !isZeroAddress(poolInfo[1]),
      gatewayLauncher: launcher === null ? null : launcher,
      poolInfo,
      splits,
    };
  });

  // 1. SILENCE FIRST. A suite that did not fully answer cannot be excluded, so
  //    no verdict about "which suite" is available at all - including the
  //    negative one. Reporting `unregistered` here is the exact collapse that
  //    made this module lie before.
  const silent = probes.filter((p) => p.lockerHolds === null || p.gatewayLauncher === null);
  if (silent.length > 0) {
    const names = silent
      .map((p) => `V${p.suite.version} (${p.lockerHolds === null ? "locker" : "gateway"} silent)`)
      .join(", ");
    return {
      status: "unavailable",
      detail:
        `these pools.fun suites did not answer at this block: ${names}. Whether this token is registered with `
        + "any suite was NOT determined - this is a failed read, not a token without a registration.",
    };
  }

  // 2. THE REGISTRATION: which suites' LOCKERS hold this token's LP.
  const holding = probes.filter((p) => p.lockerHolds === true);
  const named = probes.filter(
    (p) => p.gatewayLauncher !== null && !isZeroAddress(p.gatewayLauncher),
  );

  // Two lockers cannot both hold one token's LP. Something is true that this
  // model does not describe, and picking one would be a guess wearing a
  // verdict's clothes.
  if (holding.length > 1) {
    return {
      status: "ambiguous",
      detail:
        `${holding.length} pools.fun suites (${holding.map((p) => `V${p.suite.version}`).join(", ")}) each hold `
        + "this token's LP. One token cannot belong to two suites, so nothing here is reported as fact.",
    };
  }

  // A GATEWAY NAMING A LAUNCHER WHOSE LOCKER HOLDS NOTHING is the contradiction
  // that still matters: a launch the gateway recorded and the locker never
  // registered, or two suites disagreeing about one token. The reverse - a
  // locker row with no gateway launcher - is NOT a contradiction, it is a token
  // launched directly through the factory, which is the common case.
  const orphanGateways = named.filter(
    (p) => holding.length === 0 || p.suite.version !== holding[0]!.suite.version,
  );
  if (orphanGateways.length > 0) {
    const detail = orphanGateways
      .map((p) => `V${p.suite.version}'s gateway names launcher ${p.gatewayLauncher} but its locker holds no LP`)
      .join("; ");
    return {
      status: "ambiguous",
      detail:
        `this token's pools.fun records disagree (${detail}${holding.length === 1 ? `; V${holding[0]!.suite.version}'s locker does hold it` : ""}). `
        + "A gateway that recorded a launch the locker never registered does not establish which suite owns it.",
    };
  }

  // 3. THE SINGLE REGISTRATION.
  const hit = holding[0];
  if (hit !== undefined && hit.poolInfo !== null) {
    const [pairedAssetAddress, pool, creator, feeRecipient, tokenIds] = hit.poolInfo;
    return {
      status: "registered",
      suite: hit.suite,
      // `null` means "launched directly through the factory, not through the
      // gateway" - a fact about the launch, never a failed read. The reads that
      // could fail were already turned into `unavailable` above.
      launcher:
        hit.gatewayLauncher !== null && !isZeroAddress(hit.gatewayLauncher) ? hit.gatewayLauncher : null,
      info: {
        pairedAssetAddress,
        pool,
        creator,
        feeRecipient,
        lockedPositionIds: tokenIds.map((id) => id.toString()),
        feeSplitAvailable: hit.splits !== null,
        feeSplitBps:
          hit.splits === null
            ? null
            : {
              creator: Number(hit.splits[0]),
              platform: Number(hit.splits[1]),
              buyback: Number(hit.splits[2]),
              community: Number(hit.splits[3]),
              stockCreator: Number(hit.splits[4]),
              stockProtocol: Number(hit.splits[5]),
            },
      },
    };
  }

  // 4. EVERY SUITE ANSWERED, NO LOCKER HOLDS IT. A fact about the token.
  return { status: "unregistered" };
}

/** The suite versions this build knows, for a refusal that names them. */
export function knownPoolsSuiteVersions(): readonly PoolsSuiteVersion[] {
  return POOLS_SUITES.map((suite) => suite.version);
}

/** The sentence every "no suite" refusal uses, so the wording has one owner. */
export const POOLS_UNREGISTERED_SENTENCE =
  `not registered with any pools.fun suite Vex knows (${knownPoolsSuiteVersions()
    .map((v) => `V${v}`)
    .join(", ")})`;

function successOf<T>(call: unknown): T | null {
  if (call === null || call === undefined || typeof call !== "object") return null;
  const result = call as { status?: unknown; result?: unknown };
  return result.status === "success" ? (result.result as T) : null;
}
