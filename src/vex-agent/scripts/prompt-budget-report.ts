#!/usr/bin/env tsx
/**
 * prompt-budget:report - what the model actually reads, in bytes, per mode.
 *
 * Usage: pnpm prompt-budget:report [--json]
 *
 * WHY THIS EXISTS. Batch 3 rebuilds the system prompt along the task-shape
 * axis, and the claim it rests on - "roughly two thirds of what the model reads
 * is protocol inventory" - has to be a measurement before and after, or it is
 * an assertion. An earlier draft of that claim counted TypeScript source bytes,
 * which include code, imports and comments the model never sees, and was wrong
 * as a result. This script measures the ASSEMBLED prompt: the exact strings
 * `buildPromptStack` hands to `buildTurnEnvelope`.
 *
 * WHAT IT MEASURES, AND WHAT IT DOES NOT.
 *
 * Bytes are UTF-8 bytes of assembled layer text, and they are EXACT: the layer
 * builders are pure and synchronous, so re-running this on the same tree and
 * the same env gives the same numbers.
 *
 * It does NOT report provider tokens. The repository ships no tokenizer
 * (`engine/core/context-band.ts:16` states that running one is out of scope,
 * and the only tokenizer on disk is an undeclared transitive dependency), and
 * the sole authoritative token count is `usage.prompt_tokens` from a real
 * provider call - which needs credentials, spends quota, and is not
 * reproducible offline. Reporting a bytes/4 guess as a "token count" would be
 * the same defect this batch is fixing elsewhere: a specific, quantitative,
 * unenforced number. When a token figure is needed, take it from a real
 * `usage_log` row for a turn in the mode concerned and record the model id
 * alongside it.
 *
 * It also does NOT measure the whole request body. Injected tool JSON schemas
 * are a large part of what the provider receives and are NOT part of the prompt
 * stack; `engine/core/inference-envelope-bytes.ts` measures that object, and it
 * needs a live visibility context. Prompt-layer bytes are what a prompt rebuild
 * moves, so they are what this reports.
 *
 * ENV SENSITIVITY, which is the main way to misread the output. Several layers
 * are gated on API keys being present: an absent `JUPITER_API_KEY` collapses
 * the Solana namespace block, an absent `TAVILY_API_KEY` drops the WebResearch
 * shapes from `# Research`, and the user-profile block in `# Identity` is empty
 * until configured. The report prints the env posture it measured under, and
 * `resetProtocolsPromptCache()` runs first because `buildProtocolsPrompt` is
 * memoized on an env fingerprint. Compare two runs only when their posture
 * lines match.
 *
 * TURN LAYERS are reported as the constant floor only - the runtime clock and
 * the safety re-anchor. The volatile banners (memory, tool map, context
 * pressure, own-token, mission capital, resume packet) are built by
 * `buildTurnPromptStack`, which reads Postgres and calls providers; this script
 * stays pure and offline on purpose, so its floor is a LOWER BOUND on turn-state
 * bytes and is labelled as such.
 */

import type { EngineContext } from "@vex-agent/engine/types.js";
import {
  buildPromptStack,
  resetProtocolsPromptCache,
} from "@vex-agent/engine/prompts/index.js";
import { listMissingCapabilities } from "@vex-agent/engine/prompts/capability-availability.js";

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/** `buildTurnEnvelope` joins each segment with this exact separator. */
const LAYER_SEPARATOR = "\n\n---\n\n";

interface PromptMode {
  readonly name: string;
  readonly context: EngineContext;
}

function baseContext(overrides: Partial<EngineContext>): EngineContext {
  return {
    sessionId: "prompt-budget-report",
    sessionKind: "agent",
    sessionPermission: "restricted",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map(),
    ...overrides,
  } as EngineContext;
}

/**
 * The mode matrix.
 *
 * Mode is selected entirely from the context, never from an argument:
 * `sessionKind` plus `missionRunId` picks the mode-core layer, and
 * `sessionPermission` picks one of the six execution-policy variants. Both
 * permissions are measured for every mode because the FULL variants are
 * materially longer, and "the autonomous loop" is not a separate mode - it is
 * the full-permission variant plus the wake-scheduling flag.
 */
const MODES: readonly PromptMode[] = [
  { name: "agent / restricted", context: baseContext({}) },
  { name: "agent / full", context: baseContext({ sessionPermission: "full" }) },
  { name: "mission setup / restricted", context: baseContext({ sessionKind: "mission" }) },
  {
    name: "mission setup / full",
    context: baseContext({ sessionKind: "mission", sessionPermission: "full" }),
  },
  {
    name: "mission run / restricted",
    context: baseContext({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1" }),
  },
  {
    name: "mission run / full",
    context: baseContext({
      sessionKind: "mission",
      missionId: "m-1",
      missionRunId: "r-1",
      sessionPermission: "full",
    }),
  },
];

/**
 * The layer's own H1, which is how a reader maps a row back to a module. Layers
 * are identified by their rendered heading rather than by builder name because
 * that is what appears in the prompt and in every test that parses it.
 */
function layerLabel(layer: string, index: number): string {
  const heading = layer.split("\n").find((line) => line.startsWith("# "));
  return heading ? heading.slice(2).trim() : `(layer ${index + 1}, no H1)`;
}

interface LayerRow {
  readonly label: string;
  readonly bytes: number;
}

interface ModeReport {
  readonly mode: string;
  readonly staticBytes: number;
  readonly staticJoinedBytes: number;
  readonly turnFloorBytes: number;
  readonly staticLayers: readonly LayerRow[];
  readonly turnLayers: readonly LayerRow[];
}

function measure(mode: PromptMode): ModeReport {
  const stack = buildPromptStack(mode.context, {});
  const staticLayers = stack.staticLayers.map((layer, index) => ({
    label: layerLabel(layer, index),
    bytes: bytes(layer),
  }));
  const turnLayers = stack.turnLayers.map((layer, index) => ({
    label: layerLabel(layer, index),
    bytes: bytes(layer),
  }));
  return {
    mode: mode.name,
    staticBytes: staticLayers.reduce((sum, row) => sum + row.bytes, 0),
    staticJoinedBytes: bytes(stack.staticLayers.join(LAYER_SEPARATOR)),
    turnFloorBytes: turnLayers.reduce((sum, row) => sum + row.bytes, 0),
    staticLayers,
    turnLayers,
  };
}

function kb(value: number): string {
  return `${(value / 1024).toFixed(1)} KB`;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

function renderText(reports: readonly ModeReport[]): string {
  const lines: string[] = [];
  const missing = listMissingCapabilities();
  lines.push("# Assembled prompt budget");
  lines.push("");
  lines.push(
    missing.length === 0
      ? "Env posture: every gated capability is configured."
      : `Env posture: MISSING ${missing.map((entry) => entry.envVar).sort().join(", ")}`
        + " - gated layers render their reduced variant. Comparable only with a run"
        + " under the same posture.",
  );
  lines.push("");
  lines.push("Static-prefix bytes are what a prompt rebuild moves. Turn-state is a FLOOR:");
  lines.push("only the constant layers (runtime clock, safety re-anchor) are measured here;");
  lines.push("the volatile banners need database and provider reads.");
  lines.push("");

  for (const report of reports) {
    lines.push(`## ${report.mode}`);
    lines.push("");
    lines.push(
      `Static prefix ${report.staticBytes.toLocaleString()} B (${kb(report.staticBytes)}) `
      + `across ${report.staticLayers.length} layers; `
      + `${report.staticJoinedBytes.toLocaleString()} B joined with separators. `
      + `Turn-state floor ${report.turnFloorBytes.toLocaleString()} B.`,
    );
    lines.push("");
    lines.push("| Layer | Bytes | Share of static prefix |");
    lines.push("| --- | ---: | ---: |");
    for (const row of report.staticLayers) {
      lines.push(`| ${row.label} | ${row.bytes.toLocaleString()} | ${pct(row.bytes, report.staticBytes)} |`);
    }
    lines.push(`| **static total** | **${report.staticBytes.toLocaleString()}** | 100% |`);
    lines.push("");
    lines.push("| Turn layer (constant floor) | Bytes |");
    lines.push("| --- | ---: |");
    for (const row of report.turnLayers) {
      lines.push(`| ${row.label} | ${row.bytes.toLocaleString()} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  // `buildProtocolsPrompt` memoizes on an env fingerprint; clear it so the run
  // measures this process's posture rather than a cached earlier one.
  resetProtocolsPromptCache();

  const reports = MODES.map(measure);
  const asJson = process.argv.includes("--json");
  const output = asJson
    ? JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        missingCapabilities: listMissingCapabilities().map((entry) => entry.envVar).sort(),
        modes: reports,
      },
      null,
      2,
    )
    : renderText(reports);
  process.stdout.write(`${output}\n`);
}

main();
