/**
 * `pendle.rewards.merkle` — merkle-distributed rewards accrued to the session
 * wallet, which no Vex tool could see before (G-10).
 *
 * READ-ONLY, AND NOT BY POLICY ALONE. `/v1/dashboard/merkle-rewards/{user}`
 * returns `{user, token, merkleRoot, chainId, assetId, amount, fromTimestamp,
 * toTimestamp}` and NOTHING else — no `proof` array, no `verifyCallData`. That
 * was settled by a live probe on 2026-07-27 against a wallet holding seven
 * pending rewards, correcting the API enumeration that claimed otherwise. A
 * claim transaction cannot be built from this endpoint, so the tool says so in
 * one fixed sentence rather than leaving the agent to discover it by failing.
 *
 * PRIVACY. There is no wallet parameter, by design: the address comes from the
 * session's wallet resolution, the same path `pendle.position.value` uses.
 * Accepting one from model output would make this a third-party balance probe.
 *
 * MONEY FORMAT. Reward amounts are raw base units of arbitrary reward tokens and
 * this endpoint publishes no decimals. Each is resolved through the injected
 * asset lookup or shipped explicitly `unreadable` — never at an assumed 18. A
 * USD figure exists only for a row whose decimals AND price both resolved, and
 * the total names how many rows it had to leave out.
 */

import { getPendleReadClient } from "@tools/pendle/read/client.js";
import type { PendleReadMerkleReward } from "@tools/pendle/read/types.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  PENDLE_UNREADABLE_AMOUNT_NOTE,
  readableAmount,
  resolveAssetFacts,
  type PendleReadAmount,
  type PendleReadAssetFactsByAddress,
  type PendleReadAssetFactsLookup,
} from "../asset-decimals.js";
import { sumUsdStrings, usdString } from "../money-format.js";
import { PENDLE_PRICES_MAX_IDS, parsePendleMerkleRewardsParams } from "../market-read-params.js";
import { trustedIsoTimestamp } from "../trusted-fields.js";
import { failureDetail } from "./read-shared.js";

const TOOL_ID = "pendle.rewards.merkle";

/** Fixed text, asserted by a test — see the module header. */
const CANNOT_CLAIM_NOTE =
  "Pendle's public API does not publish the merkle proof, so Vex cannot execute this claim. Claim at app.pendle.finance.";

/** Rows shown per list. Beyond this the counts still report the truth. */
const MAX_REWARD_ROWS = 100;

interface ProjectedReward {
  chain: string | null;
  chainId: number;
  token: { address: string; symbol: string | null; decimals: number | null };
  amount: PendleReadAmount;
  /** Null whenever decimals or price were missing — never a zero standing in for unknown. */
  valueUsd: string | null;
  window: { from: string | null; to: string | null };
}

/**
 * Price-map key. A bare token address is NOT unique: the same address exists on
 * several chains with different prices, so keying marks by address alone let one
 * chain's mark overwrite another's and value a reward at a price never quoted
 * for it. The chain travels with the address at both ends of the map.
 */
function priceKey(chainId: number, token: string): string {
  return `${chainId}-${token}`;
}

function projectReward(
  reward: PendleReadMerkleReward,
  facts: PendleReadAssetFactsByAddress,
  priceUsdByKey: ReadonlyMap<string, number>,
): ProjectedReward {
  const known = facts.get(reward.token);
  const decimals = known?.decimals ?? null;
  const amount = readableAmount(reward.amountRaw, decimals);
  return {
    chain: pendleChainSlug(reward.chainId) ?? null,
    chainId: reward.chainId,
    token: { address: reward.token, symbol: known?.symbol ?? null, decimals },
    amount,
    valueUsd: valueUsdFor(amount, priceUsdByKey.get(priceKey(reward.chainId, reward.token))),
    window: {
      from: trustedIsoTimestamp(reward.fromTimestamp),
      to: trustedIsoTimestamp(reward.toTimestamp),
    },
  };
}

/**
 * The one place a float legitimately enters: the provider's USD mark. The human
 * amount is already exact, the product is converted ONCE into a decimal string,
 * and every later sum is integer arithmetic on those strings (`sumUsdStrings`).
 */
function valueUsdFor(amount: PendleReadAmount, priceUsd: number | undefined): string | null {
  if (amount.exact === null || priceUsd === undefined) return null;
  const human = Number(amount.exact);
  if (!Number.isFinite(human)) return null;
  return usdString(human * priceUsd);
}

/**
 * Price every distinct reward token, in batches within the endpoint's id cap.
 *
 * The cap is a REQUEST limit, not a limit on what may be answered: slicing the
 * token list to the first fifty would have priced some rows and left the rest
 * silently unvalued, which is the shape of a total that reads as complete and is
 * not. Batches run sequentially through the same client so the read lane's
 * compute-unit budget still governs them.
 *
 * A failing batch stops the walk but KEEPS what earlier batches collected: a
 * partially priced answer is worth more than none, provided the reason is named
 * — which it is, and which the total's own note then repeats.
 */
async function priceRewardTokens(
  rewards: readonly PendleReadMerkleReward[],
): Promise<{ priceUsdByKey: Map<string, number>; failure: string | null }> {
  const byChain = new Map<number, Set<string>>();
  for (const reward of rewards) {
    const tokens = byChain.get(reward.chainId) ?? new Set<string>();
    tokens.add(reward.token);
    byChain.set(reward.chainId, tokens);
  }

  const priceUsdByKey = new Map<string, number>();
  const client = getPendleReadClient();
  for (const [chainId, tokens] of byChain) {
    const ids = [...tokens].map((token) => priceKey(chainId, token));
    for (let start = 0; start < ids.length; start += PENDLE_PRICES_MAX_IDS) {
      const batch = ids.slice(start, start + PENDLE_PRICES_MAX_IDS);
      try {
        const prices = await client.getAssetPrices({ chainId, ids: batch });
        for (const price of prices.prices) {
          priceUsdByKey.set(priceKey(price.chainId, price.address), price.priceUsd);
        }
      } catch (err) {
        return { priceUsdByKey, failure: failureDetail(TOOL_ID, err) };
      }
    }
  }
  return { priceUsdByKey, failure: null };
}

export async function pendleRewardsMerkle(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
  assets: PendleReadAssetFactsLookup,
  nowMs: number = Date.now(),
): Promise<ToolResult> {
  const parsed = parsePendleMerkleRewardsParams(p);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  let wallet: string;
  try {
    wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return fail(`Pendle merkle rewards unavailable — no EVM wallet selected (${failureDetail(TOOL_ID, err)})`);
  }

  let rewards;
  try {
    rewards = await getPendleReadClient().getMerkleRewards(wallet);
  } catch (err) {
    return fail(`Pendle merkle rewards unavailable (${failureDetail(TOOL_ID, err)})`);
  }

  const onChain = (row: PendleReadMerkleReward): boolean => q.chainId === undefined || row.chainId === q.chainId;
  const claimableRows = rewards.claimable.filter(onChain);
  const claimedRows = rewards.claimed.filter(onChain);

  const { priceUsdByKey, failure } =
    claimableRows.length === 0
      ? { priceUsdByKey: new Map<string, number>(), failure: null }
      : await priceRewardTokens(claimableRows);

  const factsByChain = new Map<number, PendleReadAssetFactsByAddress>();
  let assetFactsFailure: string | null = null;
  for (const chainId of new Set([...claimableRows, ...claimedRows].map((row) => row.chainId))) {
    const resolved = await resolveAssetFacts(assets, chainId);
    factsByChain.set(chainId, resolved.facts);
    if (resolved.failure !== null) assetFactsFailure = failureDetail(TOOL_ID, resolved.failure);
  }
  const factsFor = (chainId: number): PendleReadAssetFactsByAddress => factsByChain.get(chainId) ?? new Map();

  const claimable = claimableRows
    .slice(0, MAX_REWARD_ROWS)
    .map((row) => projectReward(row, factsFor(row.chainId), priceUsdByKey));
  const claimed = claimedRows
    .slice(0, MAX_REWARD_ROWS)
    .map((row) => projectReward(row, factsFor(row.chainId), priceUsdByKey));

  const priced = claimable.filter((row) => row.valueUsd !== null);
  const totals = sumUsdStrings(priced.map((row) => row.valueUsd));
  const totalClaimableUsd = priced.length === 0 ? null : totals.total;
  const unpricedRows = claimable.length - priced.length;
  const hiddenRows = claimableRows.length - claimable.length;
  /**
   * The total covers the rows that were both SHOWN and priceable. Whenever
   * either is short of the full set it is a floor, and it says so — an
   * unlabelled partial total is a number that reads as the whole answer.
   */
  const totalIsPartial = unpricedRows > 0 || hiddenRows > 0;
  const unreadable = claimable.some((row) => row.amount.unreadable === true);
  const chainFilter = q.chainId === undefined ? null : pendleChainSlug(q.chainId) ?? String(q.chainId);
  const note = totalNote({ unpricedRows, hiddenRows, shown: claimable.length, total: claimableRows.length, failure });

  return ok({
    summary: summarize({
      shown: claimable.length,
      total: claimableRows.length,
      chainFilter,
      totalUsd: totalClaimableUsd,
      unpricedRows,
    }),
    wallet,
    chainFilter,
    asOf: new Date(nowMs).toISOString(),
    note: CANNOT_CLAIM_NOTE,
    claimableCount: claimableRows.length,
    claimableShown: claimable.length,
    claimedCount: claimedRows.length,
    claimedShown: claimed.length,
    truncated: hiddenRows > 0 || claimedRows.length > claimed.length,
    totalClaimableUsd,
    totalIsPartial,
    pricedRows: priced.length,
    unpricedRows,
    ...(note === undefined ? {} : { totalNote: note }),
    ...(unreadable
      ? {
          amountsNote:
            assetFactsFailure === null
              ? PENDLE_UNREADABLE_AMOUNT_NOTE
              : `${PENDLE_UNREADABLE_AMOUNT_NOTE} The catalogue read itself failed: ${assetFactsFailure}.`,
        }
      : {}),
    claimable,
    claimed,
    nextStep:
      "These rewards are NOT claimable through Vex and never will be through this endpoint — Pendle publishes the " +
      "amount but not the merkle proof needed to claim it. Claim them at app.pendle.finance. For the yield Vex CAN " +
      "sweep (YT interest and LP rewards) use pendle.claim, and for position-level accruals pendle.position.value.",
  });
}

/** Every reason the total is short of "all claimable value", named together. */
function totalNote(state: {
  unpricedRows: number;
  hiddenRows: number;
  shown: number;
  total: number;
  failure: string | null;
}): string | undefined {
  const reasons: string[] = [];
  if (state.hiddenRows > 0) {
    reasons.push(
      `it covers only the ${state.shown} row(s) shown of ${state.total} claimable — the rest are beyond this tool's row cap`,
    );
  }
  if (state.unpricedRows > 0) {
    reasons.push(
      `${state.unpricedRows} shown row(s) are EXCLUDED because their decimals or USD price could not be resolved`,
    );
  }
  if (state.failure !== null) {
    reasons.push(`the Pendle price read failed part-way (${state.failure}), so some marks are missing`);
  }
  if (reasons.length === 0) return undefined;
  return (
    `totalClaimableUsd is a FLOOR, not the full claimable value: ${reasons.join("; ")}. ` +
    "The accrued amounts themselves are unaffected — only their valuation is."
  );
}

function summarize(state: {
  shown: number;
  total: number;
  chainFilter: string | null;
  totalUsd: string | null;
  unpricedRows: number;
}): string {
  const scope = state.chainFilter === null ? "across every Pendle chain" : `on ${state.chainFilter}`;
  if (state.total === 0) return `No merkle-distributed Pendle rewards are pending for this wallet ${scope}.`;
  const rows =
    state.shown === state.total
      ? `${state.total} pending merkle reward row(s)`
      : `${state.shown} of ${state.total} pending merkle reward row(s)`;
  const valued = state.totalUsd === null ? "none of which could be valued" : `worth at least ${state.totalUsd} USD`;
  return (
    `${rows} ${scope}, ${valued}` +
    (state.unpricedRows > 0 && state.totalUsd !== null ? ` (${state.unpricedRows} row(s) unvalued and excluded)` : "") +
    ". Vex cannot claim these — claim them at app.pendle.finance."
  );
}
