/**
 * Integration: both compaction branches run against the session's CURRENT
 * effective endpoint, not the operator's stale pin (owner decision 4).
 *
 * WHY THIS MATTERS: a session switches endpoints precisely because the pinned
 * one ran out of capacity. A background branch that kept using the pin would
 * keep failing for a reason the session had already solved, and would burn its
 * three attempts doing it.
 *
 * WHERE THE SWITCH LIVES — worth stating, because it is easy to test the wrong
 * thing. Routing state is the IN-MEMORY session map inside the failover module;
 * `session_endpoint_switches` (migration 059) is the DURABLE AUDIT record and
 * is explicitly NOT what `resolveSessionInferenceConfig` reads. So the switch
 * is committed through the real failover state here, and the audit row is
 * written through the real repo alongside it to show the two are independent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  getSwitchedEndpointTag,
  resetAllSessionEndpointState,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
// Not re-exported by the module gate: production commits a switch from INSIDE
// the failover policy, so no other producer exists. A test that needs a
// switched session has to reach the state seam itself.
import { commitEndpointSwitch } from "@vex-agent/inference/openrouter/endpoint-failover/session-endpoint-state.js";
import {
  listEndpointSwitches,
  recordEndpointSwitch,
} from "@vex-agent/db/repos/session-endpoint-switches.js";
import type { EndpointCandidate, InferenceConfig } from "@vex-agent/inference/types.js";
import type { JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import {
  buildPreparationCorpus,
  fingerprintPreparationCorpus,
  serializePreparationCorpus,
} from "@vex-agent/engine/compaction-prep/index.js";
import { runSummaryBranchTick } from "@vex-agent/engine/compaction/branch-a-summary-worker.js";
import { runChunksBranchTick } from "@vex-agent/engine/compaction/branch-b-chunks-worker.js";
import type { MessageWithId } from "@vex-agent/db/repos/messages/types.js";

import { makeSession, resetDb } from "../setup/fixtures.js";
import { forkPreparation, makeDue } from "../repos/compaction-preparation-fixtures.js";

const PINNED_TAG = "deepinfra/fp4";
const SWITCHED_TAG = "baidu/fp8";

const SWITCHED_CANDIDATE: EndpointCandidate = {
  tag: SWITCHED_TAG,
  contextLength: 120_000,
  inputPricePerM: 0.4,
  outputPricePerM: 0.9,
  cachePricePerM: null,
  cacheWritePricePerM: null,
  reasoningPricePerM: null,
} as EndpointCandidate;

function pinnedConfig(): InferenceConfig {
  return {
    provider: "openrouter",
    model: "vendor/memory-model",
    contextLimit: 200_000,
    endpointTag: PINNED_TAG,
    maxOutputTokens: 4_000,
    inputPricePerM: 1,
    outputPricePerM: 2,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
  } as InferenceConfig;
}

/** Records the config the provider was actually called with. */
function recordingProvider(content: string): {
  factory: () => Promise<JudgeProvider>;
  used: () => InferenceConfig | null;
} {
  let used: InferenceConfig | null = null;
  return {
    factory: async () => ({
      loadConfig: async () => pinnedConfig(),
      chatCompletionSimple: async (_messages, config) => {
        used = config as InferenceConfig;
        return { content, usage: { cost: 0.0001 } };
      },
    }),
    used: () => used,
  };
}

const SUMMARY_OUT = JSON.stringify({
  conversation_summary: "The user asked about routing and prefers Solana.",
});
const CHUNKS_OUT = JSON.stringify({
  chunks: [
    {
      theme: "user_prefers_solana_routes",
      happened_md: "the user asked to avoid bridges",
    },
  ],
});

async function forkWithCorpus() {
  const sessionId = await makeSession();
  const text = serializePreparationCorpus(
    buildPreparationCorpus({
      frozenSummary: null,
      rows: [
        {
          id: 1,
          role: "user",
          content: "which route did you take",
          toolCallId: null,
          toolCalls: null,
        },
      ] as unknown as MessageWithId[],
      watermarkMessageId: 1,
    }),
  );
  const preparation = await forkPreparation(sessionId, {
    corpusText: text,
    corpusSha256: fingerprintPreparationCorpus(text),
    watermarkMessageId: 1,
  });
  await makeDue(preparation.id, "summary_next_attempt_at");
  await makeDue(preparation.id, "chunks_next_attempt_at");
  return { sessionId, preparation };
}

describe("compaction branches honour the session's switched endpoint", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.AGENT_MODEL;

  beforeEach(async () => {
    await resetDb();
    resetAllSessionEndpointState();
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.AGENT_MODEL = "vendor/memory-model";
  });

  afterEach(() => {
    resetAllSessionEndpointState();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = originalModel;
  });

  it("branch A uses the switched endpoint and re-resolves its price and window", async () => {
    const { sessionId } = await forkWithCorpus();
    commitEndpointSwitch(sessionId, SWITCHED_TAG);
    // The durable audit row is written by the same policy in production; it is
    // recorded here to pin that it does NOT drive routing.
    await recordEndpointSwitch({
      sessionId,
      model: "vendor/memory-model",
      previousEndpoint: PINNED_TAG,
      newEndpoint: SWITCHED_TAG,
      reasonClass: "rate_limited",
    });

    const provider = recordingProvider(SUMMARY_OUT);
    const outcome = await runSummaryBranchTick("summary-worker", {
      makeProvider: provider.factory,
      failoverDeps: { loadCandidates: async () => [SWITCHED_CANDIDATE] },
    });

    expect(outcome.kind).toBe("ready");
    const used = provider.used();
    expect(used?.endpointTag).toBe(SWITCHED_TAG);
    // The endpoint owns price and window, so both come from the candidate —
    // the window can only ever LOWER the configured limit.
    expect(used?.contextLimit).toBe(120_000);
    expect(used?.inputPricePerM).toBe(0.4);

    expect(await listEndpointSwitches(sessionId)).toHaveLength(1);
  });

  it("branch B uses the switched endpoint too", async () => {
    const { sessionId } = await forkWithCorpus();
    commitEndpointSwitch(sessionId, SWITCHED_TAG);

    const provider = recordingProvider(CHUNKS_OUT);
    const outcome = await runChunksBranchTick("chunks-worker", {
      makeProvider: provider.factory,
      failoverDeps: { loadCandidates: async () => [SWITCHED_CANDIDATE] },
    });

    expect(outcome.kind).toBe("landed");
    expect(provider.used()?.endpointTag).toBe(SWITCHED_TAG);
  });

  it("still honours the switch when the catalogue cannot list the endpoint", async () => {
    // The production default carries no candidate source, so this is the shape
    // the app actually runs today: ROUTING follows the switch, while price and
    // window stay at model-level values.
    const { sessionId } = await forkWithCorpus();
    commitEndpointSwitch(sessionId, SWITCHED_TAG);

    const provider = recordingProvider(SUMMARY_OUT);
    await runSummaryBranchTick("summary-worker", {
      makeProvider: provider.factory,
    });

    const used = provider.used();
    expect(used?.endpointTag).toBe(SWITCHED_TAG);
    expect(used?.contextLimit).toBe(200_000);
  });

  it("is a complete no-op for a session that never switched", async () => {
    const { sessionId } = await forkWithCorpus();
    expect(getSwitchedEndpointTag(sessionId)).toBeNull();

    const provider = recordingProvider(SUMMARY_OUT);
    await runSummaryBranchTick("summary-worker", {
      makeProvider: provider.factory,
      failoverDeps: {
        loadCandidates: async () => {
          throw new Error("must not be consulted without a switch");
        },
      },
    });

    expect(provider.used()?.endpointTag).toBe(PINNED_TAG);
  });
});
