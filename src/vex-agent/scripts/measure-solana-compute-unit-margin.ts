/**
 * Measurement pass behind `SOLANA_COMPUTE_UNIT_SAFETY_MARGIN_PERCENT`
 * (`tools/solana-ecosystem/shared/solana-transaction/compute-budget-sufficiency.ts`).
 *
 * Run it, and record the result in
 * `tools/solana-ecosystem/shared/solana-transaction/compute-budget-margin-measurement.md`,
 * whenever the margin is questioned or changed. The margin decides whether Vex
 * signs or refuses a real transaction, so it must rest on measurement rather
 * than on a comment.
 *
 * STRICTLY READ-ONLY. It only:
 *   - asks Jupiter for a quote and a built swap transaction (free, quote-only),
 *   - decodes the `SetComputeUnitLimit` the provider baked into those bytes,
 *   - calls `simulateTransaction` repeatedly across slots (free).
 *
 * It NEVER signs, NEVER broadcasts, NEVER spends, and touches no key material —
 * the taker below is a third-party public address used purely as a quote and
 * simulation subject. It is not part of the test suite and `pnpm test` never
 * runs it: it makes live network calls and takes several minutes, because it
 * deliberately sleeps between simulations to let the slot advance.
 *
 * It answers the two questions the margin depends on:
 *   Q1 DRIFT — for the SAME transaction bytes, how far does `unitsConsumed`
 *      move across slots? That is the real gap between "we simulated it" and
 *      "it executes a slot or two later", and the margin must exceed it.
 *   Q2 SLACK — how much headroom does Jupiter itself leave between its declared
 *      limit and the units its own transaction consumes? A margin above this
 *      would refuse healthy Jupiter transactions.
 *
 * Usage:
 *   pnpm run measure:solana-cu-margin
 *   MEASURE_RPC_URL=<url> pnpm run measure:solana-cu-margin
 */

import { ComputeBudgetInstruction, ComputeBudgetProgram, VersionedTransaction } from "@solana/web3.js";

const RPC_URL = process.env.MEASURE_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const JUPITER_SWAP_API = "https://lite-api.jup.ag/swap/v1";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/**
 * A publicly documented Binance hot wallet, used ONLY as the `userPublicKey` a
 * quote is built for so the route is realistic. Read-only: no signature is ever
 * produced for it and nothing is ever sent.
 */
const READ_ONLY_TAKER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

/** Let the slot advance between simulations — the drift figure is meaningless without it. */
const SLEEP_BETWEEN_SIMULATIONS_MS = 1_200;
const SLEEP_BETWEEN_QUOTES_MS = 1_500;

interface QuoteSample {
  readonly pair: string;
  readonly quoteIndex: number;
  readonly declaredLimit: number | null;
  readonly consumed: readonly number[];
  readonly err: string | null;
}

async function rpc(method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await response.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** Base64 swap transaction bytes for a FRESH quote. `dynamicComputeUnitLimit` is what makes Jupiter declare a limit. */
async function buildSwapTransaction(inputMint: string, outputMint: string, amountRaw: string): Promise<string> {
  const quoteResponse = await fetch(
    `${JUPITER_SWAP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=50`,
  );
  if (!quoteResponse.ok) throw new Error(`quote ${quoteResponse.status}: ${await quoteResponse.text()}`);
  const quote = await quoteResponse.json();

  const swapResponse = await fetch(`${JUPITER_SWAP_API}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: READ_ONLY_TAKER,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!swapResponse.ok) throw new Error(`swap ${swapResponse.status}: ${await swapResponse.text()}`);
  const swap = (await swapResponse.json()) as { swapTransaction?: unknown };
  if (typeof swap.swapTransaction !== "string" || swap.swapTransaction.length === 0) {
    throw new Error("swap response carried no swapTransaction");
  }
  return swap.swapTransaction;
}

/**
 * The limit the PROVIDER declared, read out of the bytes. Mirrors the
 * production decoder in `compute-budget-sufficiency.ts`; kept separate on
 * purpose so a measurement never depends on the code it is measuring.
 */
function declaredComputeUnitLimit(base64Tx: string): number | null {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, "base64"));
  const accountKeys = tx.message.staticAccountKeys;
  for (const compiled of tx.message.compiledInstructions) {
    const programId = accountKeys[compiled.programIdIndex];
    if (!programId || !programId.equals(ComputeBudgetProgram.programId)) continue;
    try {
      return ComputeBudgetInstruction.decodeSetComputeUnitLimit({
        programId,
        keys: [],
        data: Buffer.from(compiled.data),
      }).units;
    } catch {
      continue; // a price or heap-frame directive — keep scanning.
    }
  }
  return null;
}

async function simulateOnce(base64Tx: string): Promise<{ consumed: number | null; err: string | null }> {
  const result = (await rpc("simulateTransaction", [
    base64Tx,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" },
  ])) as { value?: { unitsConsumed?: unknown; err?: unknown } };
  const value = result?.value;
  return {
    consumed: typeof value?.unitsConsumed === "number" ? value.unitsConsumed : null,
    err: value?.err ? JSON.stringify(value.err) : null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function measurePair(
  pair: string,
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  quotes: number,
  simulationsPerQuote: number,
): Promise<QuoteSample[]> {
  const samples: QuoteSample[] = [];
  for (let quoteIndex = 0; quoteIndex < quotes; quoteIndex += 1) {
    try {
      const base64Tx = await buildSwapTransaction(inputMint, outputMint, amountRaw);
      const declaredLimit = declaredComputeUnitLimit(base64Tx);
      const consumed: number[] = [];
      let err: string | null = null;
      for (let s = 0; s < simulationsPerQuote; s += 1) {
        const simulation = await simulateOnce(base64Tx);
        if (simulation.err) err = simulation.err;
        if (simulation.consumed !== null) consumed.push(simulation.consumed);
        await sleep(SLEEP_BETWEEN_SIMULATIONS_MS);
      }
      samples.push({ pair, quoteIndex, declaredLimit, consumed, err });
      console.log(
        `[${pair} q${quoteIndex}] declaredLimit=${declaredLimit} consumed=[${consumed.join(", ")}] err=${err ?? "none"}`,
      );
    } catch (err) {
      // One pair failing must not lose the samples already collected.
      console.log(`[${pair} q${quoteIndex}] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(SLEEP_BETWEEN_QUOTES_MS);
  }
  return samples;
}

function report(samples: readonly QuoteSample[]): void {
  console.log("\n===== SUMMARY =====");
  const driftRatios: number[] = [];
  const slackRatios: number[] = [];

  for (const sample of samples) {
    if (sample.consumed.length === 0) continue;
    const min = Math.min(...sample.consumed);
    const max = Math.max(...sample.consumed);
    const drift = max / min;
    driftRatios.push(drift);
    const slack = sample.declaredLimit !== null ? sample.declaredLimit / max : Number.NaN;
    if (Number.isFinite(slack)) slackRatios.push(slack);
    console.log(
      `${sample.pair} q${sample.quoteIndex}: min=${min} max=${max} drift=${drift.toFixed(4)}x `
        + `declared=${sample.declaredLimit} declared/maxConsumed=${Number.isFinite(slack) ? slack.toFixed(4) : "n/a"}x `
        + `err=${sample.err ?? "none"}`,
    );
  }

  if (driftRatios.length > 0) {
    const worstDrift = Math.max(...driftRatios);
    console.log(
      `\nQ1 SAME-BYTES DRIFT across slots: max=${worstDrift.toFixed(4)}x over ${driftRatios.length} quotes `
        + "(the margin must EXCEED this)",
    );
  }
  if (slackRatios.length > 0) {
    const tightestSlack = Math.min(...slackRatios);
    console.log(
      `Q2 JUPITER'S OWN SLACK (declaredLimit / maxConsumed): min=${tightestSlack.toFixed(4)}x `
        + `max=${Math.max(...slackRatios).toFixed(4)}x (the margin must stay BELOW the min)`,
    );
  }
  if (driftRatios.length > 0 && slackRatios.length > 0) {
    console.log(
      `\nADMISSIBLE MARGIN WINDOW: [${Math.max(...driftRatios).toFixed(3)}, ${Math.min(...slackRatios).toFixed(3)}]`,
    );
  }

  // How much the ROUTE itself moves between quotes — the reason a margin
  // refusal is retry-with-a-fresh-quote rather than terminal.
  const consumedByPair = new Map<string, number[]>();
  for (const sample of samples) {
    if (sample.consumed.length === 0) continue;
    const list = consumedByPair.get(sample.pair) ?? [];
    list.push(...sample.consumed);
    consumedByPair.set(sample.pair, list);
  }
  for (const [pair, list] of consumedByPair) {
    const min = Math.min(...list);
    const max = Math.max(...list);
    console.log(`CROSS-QUOTE spread ${pair}: min=${min} max=${max} ratio=${(max / min).toFixed(4)}x`);
  }
}

async function main(): Promise<void> {
  console.log(`READ-ONLY measurement. rpc=${RPC_URL} taker=${READ_ONLY_TAKER}`);
  console.log("No signing, no broadcast, no spend.\n");

  const samples: QuoteSample[] = [
    ...(await measurePair("SOL->USDC 1 SOL", SOL_MINT, USDC_MINT, "1000000000", 4, 5)),
    ...(await measurePair("SOL->JUP 1 SOL", SOL_MINT, JUP_MINT, "1000000000", 3, 5)),
    ...(await measurePair("SOL->BONK 5 SOL", SOL_MINT, BONK_MINT, "5000000000", 3, 5)),
    ...(await measurePair("USDC->SOL 500", USDC_MINT, SOL_MINT, "500000000", 3, 5)),
  ];

  report(samples);
}

void main();
