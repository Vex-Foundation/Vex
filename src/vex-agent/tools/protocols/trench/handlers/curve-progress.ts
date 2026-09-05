/**
 * `trench.tokens` curve-progress enrichment (READ-ONLY, opt-in).
 *
 * Turns "how close is this token to graduating?" into a number the hunting flow
 * can filter on. Everything is read from chain - no provider field, and no
 * hard-coded denominator.
 *
 * AUTHORITATIVE + PINNED. One block number is pinned per call and used for BOTH
 * the `ethMcapThreshold` storage read and every `fakepool_stats` batch, so the
 * whole page is internally consistent and the number is auditable (the block is
 * echoed in the response). Each token's denominator uses ITS OWN same-block
 * `fakeEth` (the third `fakepool_stats` member) rather than a global default:
 *   graduationEthReserve_i = sqrt(ethMcapThreshold × fakeEth_i) − fakeEth_i
 *   progress_i             = ethReserve_i / graduationEthReserve_i × 100
 *
 * FAIL CLOSED. If the authoritative threshold cannot be read, the filter is
 * refused with a reason - it never falls back to the anchored 7.5 ETH constant.
 * A hunting filter quietly denominated by a stale constant is the rule-90 trap.
 *
 * BOUNDED BATCH. `walkTokens` can return up to 600 rows (20 pages × 30), so the
 * batch is chunked at `CURVE_BATCH_CHUNK` (30, the provider's own page size) per
 * multicall instead of sending one unbounded call.
 *
 * Rule 90: the result is display/hunting-grade. A token can graduate between
 * this read and any trade.
 */

import type { Address, Chain, PublicClient, Transport } from "viem";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { curveProgressPctAgainst } from "@tools/trench-express/evm/curve-reader.js";
import {
  readEthMcapThresholdWei,
  deriveGraduationEthReserveWei,
} from "@tools/trench-express/evm/graduation-threshold.js";
import type { TokenRow } from "./list.js";

const ROBINHOOD_CHAIN_ID = 4663;
const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;

/** Max tokens per multicall - mirrors the provider's 30-row page cap. */
export const CURVE_BATCH_CHUNK = 30;

/** One token's same-block curve read: reserve + its own fakeEth, or an explicit miss. */
export interface FakepoolRead {
  readonly status: "success" | "failure";
  readonly ethReserveWei?: bigint;
  readonly fakeEthWei?: bigint;
}

export interface CurveProgressBounds {
  readonly min: number | null;
  readonly max: number | null;
}

/** Everything the page-consistent read produced, pinned to one block. */
export interface CurveSnapshot {
  readonly blockNumber: bigint;
  readonly ethMcapThresholdWei: bigint;
  readonly reads: readonly FakepoolRead[];
}

export interface CurveEnrichment {
  readonly rows: TokenRow[];
  /** Curve tokens whose on-chain read reverted/failed - dropped. */
  readonly unreadable: number;
  /** Readable rows dropped because they fell outside the min/max band. */
  readonly filtered: number;
}

/**
 * Pin a block, read the authoritative threshold at it, then batch-read
 * `fakepool_stats` for every token at the SAME block in chunks of
 * {@link CURVE_BATCH_CHUNK}. `allowFailure` keeps a reverting (graduated) curve
 * from aborting its chunk. Throws if the threshold is unreadable (fail closed).
 */
export async function readCurveSnapshot(tokens: readonly Address[]): Promise<CurveSnapshot> {
  const config = getLocalChain(ROBINHOOD_CHAIN_ID);
  if (config === undefined) {
    throw new Error(`Local chain ${ROBINHOOD_CHAIN_ID} (Robinhood) is not registered.`);
  }
  const client = getLocalPublicClient(config);
  const blockNumber = await client.getBlockNumber();
  const ethMcapThresholdWei = await readEthMcapThresholdWei(client, blockNumber);
  const reads = await readFakepoolStatsBatch(client, tokens, blockNumber);
  return { blockNumber, ethMcapThresholdWei, reads };
}

async function readFakepoolStatsBatch(
  client: PublicClient<Transport, Chain>,
  tokens: readonly Address[],
  blockNumber: bigint,
): Promise<FakepoolRead[]> {
  const reads: FakepoolRead[] = [];
  for (let start = 0; start < tokens.length; start += CURVE_BATCH_CHUNK) {
    const chunk = tokens.slice(start, start + CURVE_BATCH_CHUNK);
    const results = await client.multicall({
      allowFailure: true,
      blockNumber,
      contracts: chunk.map((token) => ({
        address: DIAMOND,
        abi: TRENCH_DIAMOND_ABI,
        functionName: "fakepool_stats" as const,
        args: [token] as const,
      })),
    });
    for (const r of results) {
      reads.push(
        r.status === "success"
          ? { status: "success", ethReserveWei: r.result[0], fakeEthWei: r.result[2] }
          : { status: "failure" },
      );
    }
  }
  return reads;
}

/**
 * Attach `curveProgressPct` to each row and apply the optional min/max band.
 *
 * Graduated rows are 100 (past the curve; their `fakepool_stats` reverts by
 * design). A curve row with a good read is measured against its OWN same-block
 * denominator; a curve row whose read failed is UNREADABLE and dropped.
 * `snapshot.reads[i]` is positionally aligned with `rows[i]`. Pure - all I/O
 * lives in {@link readCurveSnapshot}.
 */
export function applyCurveProgress(
  rows: readonly TokenRow[],
  snapshot: Pick<CurveSnapshot, "ethMcapThresholdWei" | "reads">,
  bounds: CurveProgressBounds,
): CurveEnrichment {
  const kept: TokenRow[] = [];
  let unreadable = 0;
  let filtered = 0;

  rows.forEach((row, i) => {
    let progress: number;
    if (row.status === "graduated") {
      progress = 100;
    } else {
      const read = snapshot.reads[i];
      if (read?.status !== "success" || read.ethReserveWei === undefined || read.fakeEthWei === undefined) {
        unreadable += 1;
        return;
      }
      const graduationWei = deriveGraduationEthReserveWei(snapshot.ethMcapThresholdWei, read.fakeEthWei);
      if (graduationWei <= 0n) {
        unreadable += 1;
        return;
      }
      progress = curveProgressPctAgainst(read.ethReserveWei, graduationWei);
    }
    if (bounds.min !== null && progress < bounds.min) {
      filtered += 1;
      return;
    }
    if (bounds.max !== null && progress > bounds.max) {
      filtered += 1;
      return;
    }
    kept.push({ ...row, curveProgressPct: progress });
  });

  return { rows: kept, unreadable, filtered };
}
