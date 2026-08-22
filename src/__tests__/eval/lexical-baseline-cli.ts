#!/usr/bin/env tsx
/**
 * Lexical retrieval baseline gate.
 *
 *   pnpm test:eval:lexical                              # --check (default, read-only)
 *   pnpm test:eval:lexical --update                     # recapture both lexical baselines
 *   pnpm test:eval:lexical --update --target seed       # recapture one baseline only
 *
 * A CLI rather than a vitest test on purpose: vitest owns its own argv, so
 * `--update` could not be passed through to a test file without being parsed
 * as a vitest flag. The lexical lane needs no Postgres, no embedding endpoint
 * and no credentials, so this command is runnable in any environment.
 *
 * One baseline per dataset in the shared registry (`eval-targets.ts`): the
 * canonical 116-query seed dataset, the supplemental Pendle/Relay/Virtuals
 * coverage dataset, and every per-namespace dataset whose file exists. Any one
 * of them drifting exits non-zero. `--target` accepts `seed`, `supplemental`,
 * `all`, or a namespace name.
 */

import { applyRequiresEnvSentinels, describeAppliedSentinels } from "./requires-env-sentinels.js";
import { resolveBaselineMode, runBaselineTarget, type BaselineTarget } from "./baseline.js";
import {
  CANONICAL_DATASET_ID,
  evalDatasets,
  lexicalTarget,
  type EvalDataset,
} from "./eval-targets.js";
import { namespaceDatasetId } from "./namespace-dataset.js";
import { SUPPLEMENTAL_DATASET_ID } from "./supplemental-dataset.js";

/**
 * Unconditional, and BEFORE any candidate set is built.
 *
 * This command is a baseline writer, so it may only ever measure the full
 * catalog. `buildDiscoveryCandidates()` applies the runtime env availability
 * gate, so without the eval-only sentinels a machine with no `JUPITER_API_KEY`
 * silently drops 34 solana tools and the lane records their absence as quality:
 * that is how `baselines/lexical-solana.json` was captured with all 68 rows at
 * zero recall, coverage and MRR. There is no opt-in flag here because there is
 * no legitimate run of this command against a reduced catalog. The lexical lane
 * touches no database, no endpoint and no handler, so the sentinel presence
 * cannot reach a provider.
 */
const appliedSentinels = applyRequiresEnvSentinels();

/**
 * Which baselines this invocation touches. Exists so a recapture can be scoped
 * to ONE baseline: the canonical seed baseline, the supplemental coverage
 * baseline and each per-namespace baseline move for different reasons and are
 * owned by different changes.
 *
 * The target list is derived from the shared dataset registry, so a namespace
 * dataset becomes selectable the moment its file exists, with no edit here.
 */
function selectDatasets(argv: readonly string[]): EvalDataset[] {
  const datasets = evalDatasets();
  const index = argv.indexOf("--target");
  if (index === -1) return datasets;

  const value = argv[index + 1];
  if (value === "all") return datasets;
  const selected = value === undefined ? undefined : datasets.find(
    (dataset) => dataset.datasetId === targetToDatasetId(value),
  );
  if (selected === undefined) {
    throw new Error(
      `--target requires one of: ${targetNames(datasets).join(", ")} `
      + `(received ${value === undefined ? "nothing" : `"${value}"`}).`,
    );
  }
  return [selected];
}

/** "seed" and "supplemental" are the established aliases; otherwise a namespace. */
function targetToDatasetId(value: string): string {
  if (value === "seed") return CANONICAL_DATASET_ID;
  if (value === "supplemental") return SUPPLEMENTAL_DATASET_ID;
  return namespaceDatasetId(value);
}

function targetNames(datasets: readonly EvalDataset[]): string[] {
  return [
    "all",
    ...datasets.map((dataset) => {
      if (dataset.datasetId === CANONICAL_DATASET_ID) return "seed";
      if (dataset.datasetId === SUPPLEMENTAL_DATASET_ID) return "supplemental";
      return dataset.datasetId.replace("tool-discovery-", "");
    }),
  ];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const mode = resolveBaselineMode(argv, process.env);
  const targetIndex = argv.indexOf("--target");
  const requested = targetIndex === -1 ? "all" : argv[targetIndex + 1] ?? "all";
  const datasets = selectDatasets(argv);
  process.stdout.write(
    `Lexical retrieval baselines - mode: --${mode}, target: ${requested}\n`
    + `${describeAppliedSentinels(appliedSentinels)}\n\n`,
  );

  const targets: BaselineTarget[] = datasets.map(lexicalTarget);

  let failed = false;
  for (const target of targets) {
    const outcome = await runBaselineTarget(target, mode);
    process.stdout.write(`${outcome.report}\n\n`);
    if (!outcome.ok) failed = true;
  }

  if (failed) {
    process.stdout.write("Lexical baseline gate FAILED. No file was written.\n");
    return 1;
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
