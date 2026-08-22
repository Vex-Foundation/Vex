/**
 * Real-stack eval: dense-primary discover_tools.
 *
 * This file intentionally does NOT use the `.test.ts` suffix, so default
 * `pnpm test` never picks it up. Run only with:
 *
 *   pnpm test:eval:dense           # --check (default): compares, writes nothing
 *   pnpm test:eval:dense:update    # recaptures every dense baseline in the registry
 *
 * Both commands cover EVERY dataset the shared registry owns (`eval-targets.ts`):
 * the canonical seed dataset, the supplemental coverage dataset, and each
 * authored per-namespace dataset. A namespace whose dataset file does not exist
 * contributes no target.
 *
 * Required local dependencies:
 * - Postgres/pgvector with migration 010 applied
 * - populated `tool_embeddings`
 * - local embedding model endpoint from ~/.config/vex/.env
 *
 * History (2026-08-03): this runner used to rewrite `baselines/dense.json`
 * — timestamp included — on EVERY run, which meant there was no way to assert
 * that dense quality had not moved, and it never noticed that its own baseline
 * had gone stale at `v3-agent-200` while the dataset moved to `v3-agent-116`.
 * Writing is now reachable only through an explicit `--update`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProviderDotenv } from "../../providers/env-resolution.js";
import { closePool } from "../../vex-agent/db/client.js";
import { assertToolEmbeddingsReady } from "../../vex-agent/tools/protocols/embeddings/health.js";
import { resolveBaselineMode, runBaselineTarget } from "./baseline.js";
import { denseTargets } from "./eval-targets.js";
import { applyRequiresEnvSentinels, describeAppliedSentinels } from "./requires-env-sentinels.js";

loadProviderDotenv();

// Unconditional, and BEFORE any candidate set exists. This is a baseline
// writer: it may only ever measure the full catalog, so the eval-only
// `requiresEnv` sentinels are not opt-in here. Vitest imports the module before
// it runs any hook, so this must sit at module scope, above `beforeAll` and
// above the first `evaluateDiscoverTools` call. No handler runs on this path.
const appliedSentinels = applyRequiresEnvSentinels();

const REQUIRED_ENV = "VEX_REAL_DENSE_EVAL";

const realStackRequested = process.env[REQUIRED_ENV] === "1";

describe("real-stack discover_tools dense baseline", () => {
  /**
   * A misconfigured run must FAIL, not skip green. This config runs nothing
   * but this file, so reaching it without the opt-in means the caller intended
   * a dense eval and did not get one.
   */
  it("runs against the real stack", () => {
    expect(
      realStackRequested,
      `${REQUIRED_ENV}=1 is required to run the dense eval. This suite evaluates nothing without `
      + "the real embedding stack, and a silent skip would report green while measuring nothing. "
      + "Use `pnpm test:eval:dense` (check) or `pnpm test:eval:dense:update` (recapture).",
    ).toBe(true);
  });

  if (!realStackRequested) return;

  beforeAll(async () => {
    await assertToolEmbeddingsReady();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * Every dense target the shared registry owns: the canonical seed dataset,
   * the supplemental coverage dataset, and each authored per-namespace dataset.
   *
   * Nothing is hand-wired here any more. Each target validates its dataset,
   * asserts the full candidate set, asserts every row was a real dense
   * measurement and enforces the shared quality floors inside `measure`, all of
   * which `runBaselineTarget` awaits before it can reach a writer.
   *
   * ONE CASE PER TARGET, registered at collection time. Vitest runs the cases
   * of one file in order, so the single embedding sidecar still sees one query
   * stream at a time, but a target that misses its floors fails ITS case and
   * every other target still runs and reports. Each target protects its own
   * writer, so a failing dataset stays unwritable while a passing one can be
   * captured.
   */
  const mode = resolveBaselineMode(process.argv.slice(2), process.env);
  const targets = denseTargets();

  it("applied the eval-only requiresEnv sentinels before any candidate set was built", () => {
    process.stdout.write(`${describeAppliedSentinels(appliedSentinels)}\n`);
    expect(targets.length).toBeGreaterThan(0);
  });

  for (const target of targets) {
    it(`${target.name}: ${mode === "update" ? "recaptures" : "checks"} the stored baseline`, async () => {
      const outcome = await runBaselineTarget(target, mode);
      process.stdout.write(`${outcome.report}\n`);
      expect(outcome.ok, outcome.report).toBe(true);
    }, 300_000);
  }
});
