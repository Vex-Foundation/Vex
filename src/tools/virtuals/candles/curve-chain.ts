/**
 * Bonding-curve candles built from the PAIR'S OWN `Swap` LOGS.
 *
 * The deepest and most exact source, and on Robinhood the ONLY one. A bonding
 * agent there has no trade tape at all (the provider's own SDK numbers BASE = 0
 * and SOLANA = 1 and nothing else, and a live Robinhood bonding agent returns
 * an empty tape while its pair carries real swaps), and no OHLCV provider
 * indexes an `FPairV2` curve on an EVM chain. So for that population the chain
 * itself is the market data, and this module reads it.
 *
 * WHY IT IS ALSO THE DEEP SOURCE ON BASE, not merely a fallback. The tape has
 * no cursor of any kind and a provider-enforced ceiling of 1000 rows
 * (`curve-tape.ts` records the probes), so an agent past 1000 curve trades has
 * history the tape can never reach. A pair's logs have no such ceiling: the
 * only bound is how far back the caller asks and how much scanning that costs,
 * both of which are reported rather than silently applied.
 *
 * THE EVENT, AND WHY DECODING IT IS UNAMBIGUOUS.
 *
 *   event Swap(uint256 amount0In, uint256 amount0Out, uint256 amount1In, uint256 amount1Out)
 *
 * All four words are NON-INDEXED and the event carries no sender or recipient
 * topic, so topic0 alone selects it and the data is exactly four words. Index 0
 * is `tokenA` and index 1 is `tokenB`, in the order the pair's constructor
 * stored them.
 *
 * THE TOKEN ORDER IS READ FROM THE PAIR, NEVER ASSUMED. Both pairs measured on
 * 2026-09-05 put the agent token at index 0 and VIRTUAL at index 1 (Base
 * 0x3e11e685...84a, Robinhood 0x0f3Ff518...C2D), but a series priced upside
 * down looks exactly as authoritative as a correct one - the sibling
 * DexScreener reader carries a live-measured inversion footgun for precisely
 * this reason - so this module calls `tokenA()` and compares it against the
 * agent's own bonding token and REFUSES a pair it cannot orient. It never
 * falls back to a positional guess.
 *
 * PRICE IS EXACT. Both sides are 18-decimal ERC-20s, so the quotient of the two
 * raw integers is already whole-token VIRTUAL per agent token, computed in
 * `bigint` and rendered once. Cross-checked live against the provider's tape on
 * CULTOS: the tape's newest trade `0x42b74f0a...` reports the VIRTUAL amount as
 * "0.8766472852825719" while the log carries 876647285282571920 wei exactly -
 * the tape rounded at the sixteenth significant digit, this source does not.
 *
 * BOUNDS ARE MEASURED PER RPC, not chosen (2026-09-05):
 *
 *   base.drpc.org             "ranges over 10000 blocks are not supported on free plan"
 *   mainnet.base.org          "eth_getLogs is limited to a 10,000 range"
 *   rpc.mainnet.chain.robinhood.com   no range cap; a heavy query answers "log query timed out"
 *
 * so Base is windowed at the range cap the two usable endpoints BOTH state, and
 * Robinhood is windowed to bound query COST rather than range. Per-log block
 * timestamps are read in JSON-RPC batches; the smallest batch cap measured was
 * `mainnet.base.org`'s "maximum 10 calls in 1 batch", so 10 is the batch size
 * everywhere.
 */

import {
  createPublicClient,
  defineChain,
  http,
  parseAbiItem,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { getLocalChain, getLocalChainRpcUrl, toLocalViemChain } from "@tools/evm-chains/registry.js";
import type { VirtualsChain } from "../types.js";
import {
  AMOUNT_DECIMALS,
  bucketSpanSeconds,
  bucketTradesIntoCandles,
  priceFromRawAmounts,
  type CurveCandle,
  type CurveTimeframe,
  type NormalizedCurveTrade,
} from "./bucketing.js";

/** `FPairV2.Swap`. All four words non-indexed; topic0 is the whole filter. */
const SWAP_EVENT = parseAbiItem(
  "event Swap(uint256 amount0In, uint256 amount0Out, uint256 amount1In, uint256 amount1Out)",
);

/** `FPairV2.tokenA()` - index 0 of every `Swap`. */
const TOKEN_A_ABI = parseAbiItem("function tokenA() view returns (address)");
/** `FPairV2.tokenB()` - index 1 of every `Swap`. */
const TOKEN_B_ABI = parseAbiItem("function tokenB() view returns (address)");

/** Per-chain facts for the two chains that run an EVM bonding curve. */
interface CurveChainConfig {
  readonly chainId: number;
  readonly name: string;
  /** Used only when the local chain registry does not know the chain. */
  readonly defaultRpcUrl: string;
  /**
   * Blocks per `eth_getLogs` window.
   *
   * Base: the 10,000 both usable public endpoints state in their own
   * rejections. Robinhood: no range cap exists there, so this bounds query COST
   * against the measured "log query timed out" instead.
   */
  readonly logWindowBlocks: number;
}

const CURVE_CHAINS: Partial<Record<VirtualsChain, CurveChainConfig>> = {
  BASE: {
    chainId: 8453,
    name: "base",
    // Same endpoint and the same measured reason as `tools/uniswap/deployments.ts`
    // and the creator-fee reader: publicnode refuses archive-class methods and
    // mainnet.base.org rate limits early.
    defaultRpcUrl: "https://base.drpc.org",
    logWindowBlocks: 10_000,
  },
  ROBINHOOD: {
    chainId: 4663,
    name: "robinhood",
    defaultRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    // MEASURED 2026-09-05: Robinhood enforces NO range cap (a full 0..latest
    // query for a light pair answered in 0.30 s) and its blocks land about
    // every 0.1 s, so ten days is roughly 8.6 million blocks. A Base-sized
    // window would spend the whole budget on a single day. The bound that does
    // exist there is a query TIMEOUT on a heavy pair, which `scanWindow`
    // absorbs by halving rather than by failing the read.
    logWindowBlocks: 500_000,
  },
};

/** JSON-RPC batch size. The smallest cap measured across the endpoints. */
const BLOCK_BATCH_SIZE = 10;

/**
 * `eth_getLogs` windows one call may walk.
 *
 * A bound on WORK, not on the answer: when it stops the walk the coverage block
 * says so by name and hands back the cursor that resumes exactly there, so a
 * caller can always reach further by asking again.
 */
export const MAX_LOG_WINDOWS = 40;

/** Per-log block-header reads one call may make, under the same contract. */
export const MAX_BLOCK_TIMESTAMP_READS = 600;

export type ChainStopReason =
  /** The requested window was fully scanned. Nothing older was asked for. */
  | "window_covered"
  /** The scan reached block 0. There is no earlier history on this chain. */
  | "chain_genesis"
  /** The log-window budget ran out before the window was covered. */
  | "log_window_budget"
  /** The block-timestamp budget ran out. Some scanned swaps could not be dated. */
  | "block_read_budget"
  /** The endpoint refused a window even at the smallest size tried. */
  | "rpc_refused";

export interface ChainCandlesCoverage {
  readonly source: "curve_swap_logs";
  readonly stopReason: ChainStopReason;
  readonly chainId: number;
  readonly pairAddress: string;
  /** The block range actually scanned, inclusive. */
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly blocksScanned: number;
  /** Work actually done, against the bounds above. */
  readonly logWindowsUsed: number;
  readonly logWindowBlocks: number;
  readonly blockTimestampReads: number;
  readonly swapsFound: number;
  readonly swapsInWindow: number;
  readonly oldestTradeSeconds: number | null;
  readonly newestTradeSeconds: number | null;
  /**
   * How the scan's start block was estimated from the requested start time, and
   * how far off it landed. The anchor is an ESTIMATE from measured average
   * block time; candles are filtered by real block timestamps afterwards, so
   * anchor error changes how much was scanned, never which bars are returned.
   */
  readonly anchorBlockTimeSeconds: string;
  readonly requestedFromSeconds: number;
  readonly scannedFromSeconds: number | null;
  readonly truncated: boolean;
  /** The endpoint's own words when it refused a window, so the cause is not guessed. */
  readonly rpcRefusal: string | null;
  readonly note: string;
}

export interface ChainCandlesFound {
  readonly available: true;
  readonly candles: CurveCandle[];
  readonly coverage: ChainCandlesCoverage;
}

export interface ChainCandlesUnavailable {
  readonly available: false;
  readonly reason: string;
}

export type ChainCandlesResult = ChainCandlesFound | ChainCandlesUnavailable;

export interface BuildChainCandlesParams {
  readonly chain: VirtualsChain;
  /** The `FPairV2` curve pair. */
  readonly pairAddress: string;
  /** The agent's bonding token, used to ORIENT the pair. */
  readonly agentTokenAddress: string;
  readonly timeframe: CurveTimeframe;
  readonly aggregate: number;
  readonly limit: number;
  /** Return only buckets strictly BEFORE this unix-seconds mark. */
  readonly beforeTimestampSeconds?: number;
}

/** Whether this chain has an EVM bonding curve this module can read. */
export function curveChainConfig(chain: VirtualsChain): CurveChainConfig | undefined {
  return CURVE_CHAINS[chain];
}

/**
 * A read-only client for one curve chain.
 *
 * Where the LOCAL chain registry knows the chain (Robinhood 4663) it is
 * deferred to, so a user's own RPC override is honoured - the policy this
 * repository already settled in `tools/uniswap/evm-client.ts` and reused by the
 * creator-fee reader. Batching is ON because this module's per-log block-header
 * reads are exactly the workload it exists for.
 */
function curvePublicClient(config: CurveChainConfig): PublicClient<Transport, Chain> {
  const local = getLocalChain(config.chainId);
  const rpcUrl = local ? getLocalChainRpcUrl(local) : config.defaultRpcUrl;
  const chain = local
    ? toLocalViemChain(local)
    : defineChain({
        id: config.chainId,
        name: config.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
  return createPublicClient({
    chain,
    transport: http(rpcUrl, {
      timeout: 30_000,
      retryCount: 2,
      batch: { batchSize: BLOCK_BATCH_SIZE, wait: 16 },
    }),
  });
}

/**
 * Average seconds per block, MEASURED over a recent span rather than assumed.
 *
 * Two header reads. Used only to turn a requested start TIME into a start
 * BLOCK; the resulting candles are filtered by real timestamps, so an
 * inaccurate estimate costs extra scanning and is reported, never a wrong bar.
 */
async function measureBlockTime(
  client: PublicClient<Transport, Chain>,
  latestNumber: bigint,
  latestSeconds: number,
): Promise<{ secondsPerBlock: number; sampleBlocks: number }> {
  const sampleBlocks = latestNumber > 20_000n ? 20_000 : Number(latestNumber);
  if (sampleBlocks <= 0) return { secondsPerBlock: 2, sampleBlocks: 0 };
  const earlier = await client.getBlock({
    blockNumber: latestNumber - BigInt(sampleBlocks),
    includeTransactions: false,
  });
  const elapsed = latestSeconds - Number(earlier.timestamp);
  if (elapsed <= 0) return { secondsPerBlock: 2, sampleBlocks };
  return { secondsPerBlock: elapsed / sampleBlocks, sampleBlocks };
}

/** Read every distinct block's timestamp, in batches, under an explicit bound. */
async function readBlockTimestamps(
  client: PublicClient<Transport, Chain>,
  blockNumbers: readonly bigint[],
): Promise<{ timestamps: Map<string, number>; reads: number; exhausted: boolean }> {
  const timestamps = new Map<string, number>();
  const bounded = blockNumbers.slice(0, MAX_BLOCK_TIMESTAMP_READS);
  const remember = (block: { number: bigint | null; timestamp: bigint }): void => {
    timestamps.set(block.number!.toString(), Number(block.timestamp));
  };
  for (let i = 0; i < bounded.length; i += BLOCK_BATCH_SIZE) {
    const slice = bounded.slice(i, i + BLOCK_BATCH_SIZE);
    try {
      // The fast path: concurrent reads that the transport merges into one
      // JSON-RPC batch.
      const blocks = await Promise.all(
        slice.map((n) => client.getBlock({ blockNumber: n, includeTransactions: false })),
      );
      for (const block of blocks) remember(block);
    } catch {
      // MEASURED 2026-09-05: base.drpc.org answered HTTP 500 to a four-call
      // `eth_getBlockByNumber` batch whose every block it served individually
      // moments later (a two-call batch of the same blocks also succeeded), so
      // a batch refusal on the free tier says nothing about the blocks. Reading
      // them one at a time costs more round trips and always works, which is
      // the right trade for a timestamp a bar depends on.
      for (const number of slice) {
        remember(await client.getBlock({ blockNumber: number, includeTransactions: false }));
      }
    }
  }
  return {
    timestamps,
    reads: bounded.length,
    exhausted: blockNumbers.length > bounded.length,
  };
}

/**
 * Build candles for one bonding agent from its pair's `Swap` logs.
 *
 * @returns `{ available: false, reason }` when the chain runs no EVM curve this
 * module can read, or when the pair cannot be ORIENTED against the agent's own
 * token - never a silently inverted series.
 */
export async function buildChainCandles(
  params: BuildChainCandlesParams,
): Promise<ChainCandlesResult> {
  const config = CURVE_CHAINS[params.chain];
  if (config === undefined) {
    return {
      available: false,
      reason:
        `Virtuals runs its EVM bonding curve on base and robinhood; ${params.chain.toLowerCase()} `
        + "has no FPairV2 curve pair whose Swap logs could be read, so there is no on-chain candle "
        + "source for it.",
    };
  }

  const client = curvePublicClient(config);
  const pairAddress = params.pairAddress as Address;

  // ORIENT THE PAIR FIRST. A series priced upside down is indistinguishable
  // from a correct one at a glance, so the ordering is read, not assumed.
  const [tokenA, tokenB] = await Promise.all([
    client.readContract({ address: pairAddress, abi: [TOKEN_A_ABI], functionName: "tokenA" }),
    client.readContract({ address: pairAddress, abi: [TOKEN_B_ABI], functionName: "tokenB" }),
  ]);
  const agent = params.agentTokenAddress.toLowerCase();
  const agentIsIndexZero = tokenA.toLowerCase() === agent;
  if (!agentIsIndexZero && tokenB.toLowerCase() !== agent) {
    return {
      available: false,
      reason:
        `The curve pair ${params.pairAddress} on ${config.name} holds ${tokenA} and ${tokenB}, `
        + `neither of which is the agent's bonding token ${params.agentTokenAddress}. Refusing to `
        + "price a series against a pair that cannot be oriented: a chart built on the wrong side "
        + "of a pair looks exactly as authoritative as a correct one.",
    };
  }

  const latest = await client.getBlock({ blockTag: "latest", includeTransactions: false });
  const latestNumber = latest.number!;
  const latestSeconds = Number(latest.timestamp);
  const { secondsPerBlock } = await measureBlockTime(client, latestNumber, latestSeconds);

  const span = bucketSpanSeconds(params.timeframe, params.aggregate);
  const toSeconds = params.beforeTimestampSeconds ?? latestSeconds;
  // One extra span of head room so the oldest requested bucket is whole rather
  // than clipped by the anchor landing inside it.
  const requestedFromSeconds = toSeconds - span * (params.limit + 1);

  const blocksBehind = (seconds: number): bigint => {
    const behind = Math.max(0, Math.ceil((latestSeconds - seconds) / secondsPerBlock));
    const candidate = latestNumber - BigInt(behind);
    return candidate < 0n ? 0n : candidate;
  };
  const toBlock = params.beforeTimestampSeconds === undefined ? latestNumber : blocksBehind(toSeconds);
  const targetFromBlock = blocksBehind(requestedFromSeconds);

  // Walk BACKWARDS in windows, newest first, so the budget is always spent on
  // the bars the caller actually asked for.
  const logs: { blockNumber: bigint; logIndex: number; txHash: string; words: readonly bigint[] }[] = [];
  let windowsUsed = 0;
  let cursor = toBlock;
  let stopReason: ChainStopReason = "window_covered";
  let rpcRefusal: string | null = null;
  while (cursor >= targetFromBlock) {
    if (windowsUsed >= MAX_LOG_WINDOWS) {
      stopReason = "log_window_budget";
      break;
    }
    const windowStartCandidate = cursor - BigInt(config.logWindowBlocks - 1);
    const windowStart =
      windowStartCandidate < targetFromBlock ? targetFromBlock : windowStartCandidate;
    // AN ENDPOINT REFUSAL MUST NOT LOSE THE WHOLE READ. Measured failure modes
    // are a public-tier 500 on Base and a "log query timed out" on a heavy
    // Robinhood pair, both of which a smaller window usually survives. One
    // halving is tried; if that also fails the walk STOPS and says so with the
    // endpoint's own message, rather than throwing away the bars already read.
    const readWindow = async (from: bigint): Promise<boolean> => {
      const found = await client.getLogs({
        address: pairAddress,
        event: SWAP_EVENT,
        fromBlock: from,
        toBlock: cursor,
      });
      for (const log of found) {
        logs.push({
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          txHash: log.transactionHash!,
          words: [log.args.amount0In!, log.args.amount0Out!, log.args.amount1In!, log.args.amount1Out!],
        });
      }
      return true;
    };

    let effectiveStart = windowStart;
    try {
      await readWindow(windowStart);
      windowsUsed += 1;
    } catch {
      const halved = cursor - BigInt(Math.floor(config.logWindowBlocks / 2));
      effectiveStart = halved < targetFromBlock ? targetFromBlock : halved;
      try {
        await readWindow(effectiveStart);
        windowsUsed += 1;
      } catch (second) {
        rpcRefusal = second instanceof Error ? second.message : String(second);
        stopReason = "rpc_refused";
        break;
      }
    }
    if (effectiveStart !== windowStart) {
      if (effectiveStart <= targetFromBlock) break;
      cursor = effectiveStart - 1n;
      continue;
    }
    if (windowStart <= targetFromBlock) break;
    if (windowStart === 0n) {
      stopReason = "chain_genesis";
      break;
    }
    cursor = windowStart - 1n;
  }
  const scannedFromBlock =
    stopReason === "log_window_budget" || stopReason === "rpc_refused" ? cursor : targetFromBlock;

  // One timestamp per DISTINCT block, newest first so the budget buys the most
  // recent bars if it runs out.
  const distinctBlocks = [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) =>
    a > b ? -1 : a < b ? 1 : 0,
  );
  const dated = await readBlockTimestamps(client, distinctBlocks);
  if (dated.exhausted) stopReason = "block_read_budget";

  const seen = new Set<string>();
  const trades: NormalizedCurveTrade[] = [];
  for (const log of logs) {
    // A window seam can return the same log twice; identity is the log's own.
    const identity = `${log.txHash}:${log.logIndex}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const timestampSeconds = dated.timestamps.get(log.blockNumber.toString());
    if (timestampSeconds === undefined) continue;
    const [amount0In, amount0Out, amount1In, amount1Out] = log.words;
    const baseRaw = agentIsIndexZero ? amount0In! + amount0Out! : amount1In! + amount1Out!;
    const quoteRaw = agentIsIndexZero ? amount1In! + amount1Out! : amount0In! + amount0Out!;
    const priceScaled = priceFromRawAmounts(quoteRaw, baseRaw);
    if (priceScaled === null) continue;
    // A BUY sends the quote asset IN and takes the agent token OUT.
    const isBuy = agentIsIndexZero ? amount1In! > 0n : amount0In! > 0n;
    trades.push({
      timestampSeconds,
      priceScaled,
      baseAmountScaled: baseRaw,
      quoteAmountScaled: quoteRaw,
      isBuy,
    });
  }

  const windowed = trades.filter(
    (t) =>
      t.timestampSeconds < toSeconds
      && (params.beforeTimestampSeconds === undefined || t.timestampSeconds < params.beforeTimestampSeconds),
  );
  const every = bucketTradesIntoCandles(windowed, span);
  const candles = every.slice(-params.limit);
  const timestamps = windowed.map((t) => t.timestampSeconds);
  const scannedFromSeconds =
    timestamps.length === 0 ? null : Math.min(...timestamps);
  const truncated = stopReason !== "window_covered" || every.length > candles.length;

  return {
    available: true,
    candles,
    coverage: {
      source: "curve_swap_logs",
      stopReason,
      chainId: config.chainId,
      pairAddress: params.pairAddress,
      fromBlock: Number(scannedFromBlock),
      toBlock: Number(toBlock),
      blocksScanned: Number(toBlock - scannedFromBlock) + 1,
      logWindowsUsed: windowsUsed,
      logWindowBlocks: config.logWindowBlocks,
      blockTimestampReads: dated.reads,
      swapsFound: logs.length,
      swapsInWindow: windowed.length,
      oldestTradeSeconds: timestamps.length === 0 ? null : Math.min(...timestamps),
      newestTradeSeconds: timestamps.length === 0 ? null : Math.max(...timestamps),
      anchorBlockTimeSeconds: secondsPerBlock.toFixed(3),
      requestedFromSeconds,
      scannedFromSeconds,
      truncated,
      rpcRefusal,
      note:
        stopReason === "rpc_refused"
          ? `The chain endpoint refused a log window and refused it again at half the size, so the `
            + `scan stopped at block ${Number(scannedFromBlock)} with what it had already read. The `
            + "bars above are real and complete for the range that WAS scanned; older ones were not "
            + "reached. Retry, or ask for a shorter period, or point this chain at your own RPC."
          : stopReason === "log_window_budget"
          ? `The scan stopped after ${windowsUsed} log windows of ${config.logWindowBlocks} blocks `
            + `at block ${Number(scannedFromBlock)}, before reaching the start of the requested `
            + "period. Nothing was dropped without saying so: ask again with "
            + "beforeTimestampSeconds set to the oldest bucket returned to continue further back, "
            + "or use a coarser timeframe so one scan covers more time."
          : stopReason === "block_read_budget"
            ? `More than ${MAX_BLOCK_TIMESTAMP_READS} distinct blocks carried swaps in this window, `
              + "so the oldest of them could not be dated and are absent from these bars. Ask for a "
              + "shorter period or a coarser timeframe."
            : stopReason === "chain_genesis"
              ? "The scan reached the start of the chain, so there is no earlier history."
              : `Every block of the requested period was scanned (${Number(toBlock - scannedFromBlock) + 1} `
                + `blocks in ${windowsUsed} windows). Buckets with no trades are absent rather than `
                + "zero-filled: a curve that did not trade has no price, and a zero bar would assert one.",
    },
  };
}
