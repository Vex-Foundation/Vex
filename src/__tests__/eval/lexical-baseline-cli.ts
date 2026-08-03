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
 * Two targets, two baselines: the canonical 116-query seed dataset and the
 * supplemental Pendle/Relay/Virtuals coverage dataset. Either one drifting
 * exits non-zero.
 */

import {
  resolveBaselineMode,
  runBaselineTarget,
  type BaselineTarget,
} from "./baseline.js";
import { evaluateLexicalDiscovery } from "./lexical-retrieval.js";
import { toBaselineMetrics } from "./report-metrics.js";
import { loadDataset } from "./retrieval-eval-harness.js";
import { SUPPLEMENTAL_DATASET_ID, loadSupplementalDataset } from "./supplemental-dataset.js";

const CANONICAL_DATASET_ID = "tool-discovery-seed";
const CANONICAL_DATASET_VERSION = "v3-agent-116";
const DISCOVERY_LIMIT = 5;

const TARGET_NAMES = ["seed", "supplemental", "all"] as const;
type TargetName = (typeof TARGET_NAMES)[number];

/**
 * Which baselines this invocation touches. Exists so a recapture can be scoped
 * to ONE baseline — the canonical seed baseline and the supplemental coverage
 * baseline move for different reasons and are owned by different changes.
 */
function resolveTarget(argv: readonly string[]): TargetName {
  const index = argv.indexOf("--target");
  if (index === -1) return "all";

  const value = argv[index + 1];
  if (value === undefined || !isTargetName(value)) {
    throw new Error(
      `--target requires one of: ${TARGET_NAMES.join(", ")} (received ${value === undefined ? "nothing" : `"${value}"`}).`,
    );
  }
  return value;
}

function isTargetName(value: string): value is TargetName {
  return (TARGET_NAMES as readonly string[]).includes(value);
}

function canonicalTarget(): BaselineTarget {
  const queries = loadDataset();
  return {
    name: "lexical / canonical seed dataset",
    fileName: "lexical.json",
    expectedCaseCount: queries.length,
    measure: () => ({
      mode: "lexical",
      datasetId: CANONICAL_DATASET_ID,
      datasetVersion: CANONICAL_DATASET_VERSION,
      metrics: toBaselineMetrics(evaluateLexicalDiscovery(queries, DISCOVERY_LIMIT)),
    }),
  };
}

function supplementalTarget(): BaselineTarget {
  const dataset = loadSupplementalDataset();
  return {
    name: "lexical / supplemental Pendle+Relay+Virtuals coverage",
    fileName: "lexical-supplemental.json",
    expectedCaseCount: dataset.queries.length,
    measure: () => ({
      mode: "lexical",
      datasetId: SUPPLEMENTAL_DATASET_ID,
      datasetVersion: dataset.version,
      metrics: toBaselineMetrics(evaluateLexicalDiscovery(dataset.queries, DISCOVERY_LIMIT)),
    }),
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const mode = resolveBaselineMode(argv, process.env);
  const targetName = resolveTarget(argv);
  process.stdout.write(`Lexical retrieval baselines — mode: --${mode}, target: ${targetName}\n\n`);

  const targets: BaselineTarget[] = [
    ...(targetName === "supplemental" ? [] : [canonicalTarget()]),
    ...(targetName === "seed" ? [] : [supplementalTarget()]),
  ];

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
