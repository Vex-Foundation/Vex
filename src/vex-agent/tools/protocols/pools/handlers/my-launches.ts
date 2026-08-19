/**
 * `pools.my_launches` handler - the session wallet's own pools.fun launches
 * (READ-ONLY).
 *
 * The evidence is the launchpad's own `deployer` index, queried server-side for
 * the session's wallet. The wallet is RESOLVED from the session, never taken
 * from a parameter: a read tool that let the model name the wallet would let it
 * read another wallet's launch history, so there is no parameter to pass.
 *
 * Unlike `trench.my_launches` this reads the provider rather than a local index,
 * because pools.fun exposes a deployer filter and Vex has no launch rows of its
 * own here yet.
 *
 * GATEWAY LAUNCHES DO APPEAR HERE - measured, not assumed. The concern was that
 * a launch routed through the PoolsFunLaunchGateway would be indexed under the
 * gateway's address (it IS the on-chain `creator` on that path) and vanish from
 * this list. It does not: the owner's gateway-launched token VEXFLAM
 * (`0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb`) comes back from
 * `/discover?platform=poolsfun&deployer=0x33eF…d2fA` with `deployerAddress` set
 * to the EOA, not the gateway - bankr's indexer resolves the true launcher
 * through the gateway. The capture is
 * `src/__tests__/pools-fun/fixtures/live-captures/discover-deployer-gateway-launch.json`.
 *
 * What an empty list therefore means is simply "the launchpad has nothing
 * indexed under this wallet", which is still not the same as "you launched
 * nothing" - a token created outside this launchpad, or not yet indexed, would
 * also be absent.
 */

import { getAddress, type Address } from "viem";

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import {
  readPoolsClaimContext,
  simulatePoolsClaim,
} from "@tools/pools-fun/claim/read-claim.js";
import type { PoolsPlatform } from "@tools/pools-fun/constants.js";
import { POOLS_CHAIN_SLUG, POOLS_DISCOVER_LIMIT_CAP, POOLS_PLATFORMS } from "@tools/pools-fun/constants.js";
import { resolveSelectedAddressForRead } from "../../../internal/wallet/resolve.js";
import { ok, fail } from "../../handler-helpers.js";
import { readEnum, readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import { poolsFailureDetail } from "./failure.js";
import { applyOwnLaunchFlag, projectToken } from "./project.js";
import { readCursor } from "./list.js";
import type { ProtocolExecutionContext } from "../../types.js";

const MY_LAUNCHES_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: POOLS_DISCOVER_LIMIT_CAP },
};

const DEFAULT_LIMIT = 25;

/**
 * How many rows `includeClaimable` will simulate.
 *
 * Bounded because each row costs TWO round trips that cannot be batched: the
 * claim simulation must run AS THE SESSION WALLET (`collectAndClaim` pays the
 * caller), and routing it through Multicall3 would simulate the multicall
 * contract claiming, which is a different question with a different answer.
 * Ten keeps a list read responsive; rows past it report `claimable: null`,
 * which means NOT MEASURED and says so.
 */
const CLAIMABLE_ENRICH_LIMIT = 10;

export async function poolsMyLaunchesHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const platformRead = readEnum<PoolsPlatform>(p, "platform", POOLS_PLATFORMS, "all");
  if (!platformRead.ok) return fail(platformRead.reason);
  const limitRead = readNumber(p, "limit", MY_LAUNCHES_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  const cursor = readCursor(p);
  const includeClaimable = p.includeClaimable === true;

  // The STRICT resolver, not the degrading one the discovery lists use: this
  // tool's entire answer is "yours", so an unresolvable wallet must fail loudly
  // rather than return somebody's rows unmarked.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddressForRead(
      context.walletResolution,
      context.walletPolicy,
      "eip155",
    );
  } catch (err) {
    return fail(`pools.my_launches: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const page = await getPoolsFunClient().discover(
      {
        platform: platformRead.value,
        deployerAddress: walletAddress,
        sortBy: "deployedAt",
        order: "desc",
        limit: limitRead.value ?? DEFAULT_LIMIT,
        ...(cursor !== null ? { cursor } : {}),
      },
      { signal: context.abortSignal },
    );
    const now = Date.now();
    const rows = applyOwnLaunchFlag(
      page.results.map((row) => projectToken(row, now)),
      walletAddress.toLowerCase(),
    );

    const enriched = includeClaimable
      ? await enrichWithClaimable(rows, walletAddress)
      : rows;

    return ok({
      chain: POOLS_CHAIN_SLUG,
      wallet: walletAddress,
      platform: platformRead.value,
      count: enriched.length,
      nextCursor: page.nextCursor,
      source: "the pools.fun launchpad's deployer index, queried for this wallet",
      // Measured 2026-08-18 against a real gateway-launched token: the indexer
      // credits the EOA, so this list is NOT missing gateway launches.
      note: "An empty list means the launchpad has nothing indexed against this wallet as deployer, which is "
        + "not the same as 'you have launched nothing' - a token launched outside pools.fun, or one not yet "
        + "indexed, would also be absent. Launches routed through the pools.fun gateway DO appear here: the "
        + "launchpad credits the launching wallet, not the gateway contract. Page on with nextCursor.",
      ...(includeClaimable
        ? {
          claimableNote:
            "`claimable` is a SIMULATION of collectAndClaim from this wallet at the block named on each row - "
            + "what a claim would pay right now, in two separate assets, each with its own decimals. `null` "
            + `means NOT MEASURED (only the first ${CLAIMABLE_ENRICH_LIMIT} rows are simulated, and a row whose `
            + "pool could not be read stays null); it never means 'nothing to claim'. Claim with "
            + "pools.claim_fees.",
        }
        : {}),
      launches: enriched,
    });
  } catch (err) {
    return fail(`pools.my_launches unavailable (${poolsFailureDetail("pools.my_launches", err)})`);
  }
}

/**
 * Attach what a claim would PAY to the first {@link CLAIMABLE_ENRICH_LIMIT}
 * rows.
 *
 * ABSENT MEANS NOT MEASURED, never "nothing to claim" - a row past the limit, a
 * token the locker never registered, and a node that would not answer all leave
 * `claimable: null`, and the note above says so out loud. The alternative, a
 * zero, would read as a fact about the pool that nobody established.
 *
 * The simulation is the only honest source here for the same reason it is in
 * `pools.claim_fees`: the locker's `claimable*` mappings hold fees ALREADY
 * collected, and they read zero while real fees are still waiting in the pool.
 */
async function enrichWithClaimable<T extends { token?: string | null }>(
  rows: readonly T[],
  walletAddress: string,
): Promise<(T & { claimable?: unknown })[]> {
  const chainConfig = getLocalChain(POOLS_CHAIN_ID);
  if (!chainConfig) return rows.map((row) => ({ ...row, claimable: null }));
  const client = getLocalPublicClient(chainConfig);

  let account: Address;
  try {
    account = getAddress(walletAddress);
  } catch {
    return rows.map((row) => ({ ...row, claimable: null }));
  }

  const out: (T & { claimable?: unknown })[] = [];
  for (const [index, row] of rows.entries()) {
    if (index >= CLAIMABLE_ENRICH_LIMIT || typeof row.token !== "string") {
      out.push({ ...row, claimable: null });
      continue;
    }
    let token: Address;
    try {
      token = getAddress(row.token);
    } catch {
      out.push({ ...row, claimable: null });
      continue;
    }

    const context = await readPoolsClaimContext(client, token, account);
    if (!context.ok) {
      out.push({ ...row, claimable: null });
      continue;
    }
    const simulation = await simulatePoolsClaim(client, {
      account,
      token,
      blockNumber: context.context.blockNumber,
    });
    if (simulation.kind === "unavailable") {
      out.push({ ...row, claimable: null });
      continue;
    }
    // A `nothing_to_claim` revert IS an established fact - the locker said so -
    // so it is reported as zeros rather than as "not measured".
    const tokenRaw = simulation.kind === "would_pay" ? simulation.tokenAmountRaw : 0n;
    const pairedRaw = simulation.kind === "would_pay" ? simulation.pairedAmountRaw : 0n;
    out.push({
      ...row,
      claimable: {
        tokenLeg: {
          assetAddress: token,
          amountRaw: tokenRaw.toString(),
          decimals: context.context.tokenDecimals,
        },
        pairedLeg: {
          assetAddress: context.context.pairedAsset,
          amountRaw: pairedRaw.toString(),
          decimals: context.context.pairedDecimals,
        },
        measuredAtBlock: context.context.blockNumber.toString(),
      },
    });
  }
  return out;
}
