/**
 * Measures the priority fee a Solana transaction can be made to carry —
 * `SetComputeUnitPrice x effective compute-unit limit` — from two independent
 * directions:
 *
 *   1. WHAT A PROVIDER ACTUALLY ATTACHES. Ask Jupiter to build real swaps at
 *      each documented priority level with a deliberately generous
 *      `maxLamports`, then DECODE the ComputeBudget instructions out of the
 *      returned transaction. This is the honest upper end of normal behaviour:
 *      the provider was given room to spend and chose what it chose.
 *   2. WHAT THE NETWORK IS CHARGING. `getRecentPrioritizationFees` for the
 *      hottest accounts, which reports the minimum prioritization fee among
 *      transactions that landed in each recent slot touching that account. The
 *      worst of these, applied at Solana's transaction-wide max compute-unit
 *      limit, is the worst exposure a congestion-driven price can construct.
 *
 * Evidence for the shared priority-fee ceiling — see
 * `src/tools/solana-ecosystem/shared/solana-transaction/priority-fee-exposure-measurement.md`
 * for the results table and the derivation.
 *
 * READ-ONLY AND FREE. `/quote`, `/swap` and `getRecentPrioritizationFees` all
 * cost nothing. This script never signs, never broadcasts, never spends, and
 * holds no key material. The taker address is a PUBLIC, well-known account used
 * only as a quote subject — nothing is ever sent to or from it.
 *
 *     pnpm run measure:solana-priority-fee
 *     MEASURE_RPC_URL=… pnpm run measure:solana-priority-fee
 */

import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

/** Jupiter's keyless tier — the same endpoint the CU-margin measurement uses. */
const JUPITER_LITE_API = "https://lite-api.jup.ag/swap/v1";
const RPC_URL = process.env.MEASURE_RPC_URL ?? "https://api.mainnet-beta.solana.com";

/** Publicly documented Binance hot wallet, used READ-ONLY as a quote subject. */
const TAKER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

/** Solana's transaction-wide compute-unit ceiling — the worst-case multiplier. */
const MAX_COMPUTE_UNITS = 1_400_000n;

/**
 * Deliberately far above anything we expect, so the provider is never the one
 * clamped — the point is to observe what it CHOOSES, not what we allowed.
 */
const GENEROUS_MAX_LAMPORTS = 100_000_000;

const PRIORITY_LEVELS = ["medium", "high", "veryHigh"] as const;

const HOT_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ["USDC mint", USDC],
  ["Jupiter v6 aggregator", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
  ["Jupiter Lend lending", "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9"],
];

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Decode the compute-budget directives straight out of the transaction bytes. */
function decodeComputeBudget(tx: VersionedTransaction): {
  readonly limit: number | null;
  readonly priceMicroLamports: bigint | null;
} {
  const accountKeys = tx.message.staticAccountKeys;
  let limit: number | null = null;
  let priceMicroLamports: bigint | null = null;

  for (const compiled of tx.message.compiledInstructions) {
    const programId = accountKeys[compiled.programIdIndex];
    if (!programId || !programId.equals(ComputeBudgetProgram.programId)) continue;
    const instruction = new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(compiled.data),
    });
    try {
      const kind = ComputeBudgetInstruction.decodeInstructionType(instruction);
      if (kind === "SetComputeUnitLimit") {
        limit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(instruction).units;
      } else if (kind === "SetComputeUnitPrice") {
        priceMicroLamports = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(instruction).microLamports);
      }
    } catch {
      // A variant this web3.js cannot decode tells us nothing about exposure.
    }
  }
  return { limit, priceMicroLamports };
}

async function measureProviderChoice(inputMint: string, outputMint: string, amount: string, priorityLevel: string) {
  const quote = await fetch(
    `${JUPITER_LITE_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`,
  ).then((r) => r.json());

  const build = await fetch(`${JUPITER_LITE_API}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: TAKER,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: GENEROUS_MAX_LAMPORTS, priorityLevel, global: false },
      },
    }),
  }).then((r) => r.json()) as { swapTransaction?: string; prioritizationFeeLamports?: number };

  if (!build.swapTransaction) return null;
  const tx = VersionedTransaction.deserialize(Buffer.from(build.swapTransaction, "base64"));
  const { limit, priceMicroLamports } = decodeComputeBudget(tx);
  const effectiveLimit = limit === null ? MAX_COMPUTE_UNITS : BigInt(limit);
  const decodedLamports = priceMicroLamports === null ? 0n : ceilDiv(effectiveLimit * priceMicroLamports, 1_000_000n);

  return {
    priorityLevel,
    limit,
    priceMicroLamports,
    decodedLamports,
    /** Jupiter's own arithmetic for the same transaction — a cross-check on our decode. */
    providerReportedLamports: build.prioritizationFeeLamports ?? null,
  };
}

async function recentPrioritizationFees(account: string): Promise<number[]> {
  const raw = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRecentPrioritizationFees", params: [[account]] }),
  }).then((r) => r.json()) as { result?: ReadonlyArray<{ prioritizationFee: number }> };
  return (raw.result ?? []).map((entry) => entry.prioritizationFee).sort((a, b) => a - b);
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

console.log("## 1. What Jupiter actually attaches (maxLamports headroom: "
  + `${GENEROUS_MAX_LAMPORTS.toLocaleString("en-US")} lamports)\n`);
console.log("| pair | priority level | CU limit | price (µLamports/CU) | decoded lamports | provider-reported |");
console.log("|---|---|---|---|---|---|");

let worstProviderLamports = 0n;
for (const [label, inputMint, outputMint, amount] of [
  ["SOL→USDC 1 SOL", SOL, USDC, "1000000000"],
  ["SOL→JUP 1 SOL", SOL, JUP, "1000000000"],
] as const) {
  for (const level of PRIORITY_LEVELS) {
    const row = await measureProviderChoice(inputMint, outputMint, amount, level);
    if (!row) {
      console.log(`| ${label} | ${level} | — | — | build unavailable | — |`);
      continue;
    }
    if (row.decodedLamports > worstProviderLamports) worstProviderLamports = row.decodedLamports;
    console.log(
      `| ${label} | ${row.priorityLevel} | ${row.limit ?? "none"} | ${row.priceMicroLamports ?? "none"} | `
        + `${row.decodedLamports} | ${row.providerReportedLamports ?? "—"} |`,
    );
  }
}
console.log(`\nworst provider-chosen priority fee observed: ${worstProviderLamports} lamports`);

console.log("\n## 2. What the network is charging (getRecentPrioritizationFees, 150 slots)\n");
console.log("| account | p50 | p90 | p95 | p99 | max | max × 1,400,000 CU (lamports) |");
console.log("|---|---|---|---|---|---|---|");

let worstNetworkLamports = 0n;
for (const [label, account] of HOT_ACCOUNTS) {
  const fees = await recentPrioritizationFees(account);
  if (fees.length === 0) {
    console.log(`| ${label} | — | — | — | — | — | no data |`);
    continue;
  }
  const max = fees[fees.length - 1] ?? 0;
  const atMaxCu = ceilDiv(BigInt(max) * MAX_COMPUTE_UNITS, 1_000_000n);
  if (atMaxCu > worstNetworkLamports) worstNetworkLamports = atMaxCu;
  console.log(
    `| ${label} | ${percentile(fees, 0.5)} | ${percentile(fees, 0.9)} | ${percentile(fees, 0.95)} | `
      + `${percentile(fees, 0.99)} | ${max} | ${atMaxCu} |`,
  );
}
console.log(`\nworst congestion-constructed exposure at max CU: ${worstNetworkLamports} lamports`);
