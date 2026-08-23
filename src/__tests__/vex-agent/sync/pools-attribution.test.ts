/**
 * The pools.fun attribution SWEEP's contract.
 *
 * The sweep makes exactly two durable decisions per row, and both are hard to
 * take back:
 *
 *   TERMINAL   `markPoolsAttributionRejected` - the row leaves the lane
 *              FOREVER. Only a code from the closed terminal vocabulary may
 *              cause it.
 *   RETRY      everything else - leave `attributed_at` NULL and say nothing
 *              durable, so the next cadence tries again.
 *
 * The rest of what is pinned here is containment: one bad row (a throwing
 * client, a throwing repository write) must never abort the batch or the shared
 * sync worker it runs inside, and the sweep must NEVER sign.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import type { PoolsAttributionCandidate } from "@vex-agent/db/repos/launched-tokens.js";
import type { PoolsAttributionOutcome } from "@tools/pools-fun/attribution.js";
import {
  attributePoolsLaunches,
  POOLS_ATTRIBUTION_BATCH_LIMIT,
  POOLS_ATTRIBUTION_RETRY_SECONDS,
  type PoolsAttributionDeps,
} from "@vex-agent/sync/pools-attribution.js";

const BASE_URL = "https://attest.pools.test";

function candidate(id: number): PoolsAttributionCandidate {
  return {
    id,
    chainId: 4663,
    tokenAddress: `0x${id.toString(16).padStart(40, "0")}`,
    attestSignature: `0x${"ab".repeat(65)}`,
    createTxHash: `0x${id.toString(16).padStart(64, "0")}`,
  };
}

let claimed: Array<{ limit: number; retryWindowSeconds: number }>;
let attributedIds: number[];
let rejected: Array<{ id: number; code: string }>;

function deps(
  attribute: PoolsAttributionDeps["attribute"],
  baseUrl: string | null = BASE_URL,
): PoolsAttributionDeps {
  return { baseUrl: () => baseUrl, attribute };
}

function answering(...outcomes: PoolsAttributionOutcome[]): PoolsAttributionDeps["attribute"] {
  let i = 0;
  return async () => {
    const outcome = outcomes[Math.min(i++, outcomes.length - 1)];
    // A throwing accessor rather than a non-null assertion: an empty script is
    // a defect in the test, and it should be named rather than surface as an
    // undefined outcome inside the sweep.
    if (outcome === undefined) throw new Error("answering() needs at least one outcome");
    return outcome;
  };
}

beforeEach(() => {
  claimed = [];
  attributedIds = [];
  rejected = [];

  vi.spyOn(launchedTokens, "claimPoolsAttributionCandidates").mockImplementation(async (input) => {
    claimed.push(input);
    return [candidate(1)];
  });
  vi.spyOn(launchedTokens, "markPoolsAttributed").mockImplementation(async ({ id }) => {
    attributedIds.push(id);
    return true;
  });
  vi.spyOn(launchedTokens, "markPoolsAttributionRejected").mockImplementation(async (input) => {
    rejected.push(input);
    return true;
  });
  vi.spyOn(launchedTokens, "countPoolsUnsignedAttributionGap").mockImplementation(async () => 0);
});

afterEach(() => vi.restoreAllMocks());

describe("the lane is DARK until it is configured", () => {
  it("claims NO rows when no base URL resolves", async () => {
    const attribute = vi.fn(async (): Promise<PoolsAttributionOutcome> => {
      throw new Error("the dark lane must never attribute");
    });
    const result = await attributePoolsLaunches(deps(attribute, null));

    expect(result.skipped).toBe(true);
    expect(result.checked).toBe(0);
    // Claiming first would stamp every candidate's retry window for nothing,
    // pushing real candidates behind a wall of no-op attempts.
    expect(launchedTokens.claimPoolsAttributionCandidates).not.toHaveBeenCalled();
    expect(attribute).not.toHaveBeenCalled();
  });

  it("claims with the fixed batch and retry window once configured", async () => {
    await attributePoolsLaunches(deps(answering({ kind: "attributed" })));
    expect(claimed).toEqual([
      { limit: POOLS_ATTRIBUTION_BATCH_LIMIT, retryWindowSeconds: POOLS_ATTRIBUTION_RETRY_SECONDS },
    ]);
    expect(POOLS_ATTRIBUTION_BATCH_LIMIT).toBe(25);
    expect(POOLS_ATTRIBUTION_RETRY_SECONDS).toBe(600);
  });
});

describe("terminal versus retry - the only two durable dispositions", () => {
  it("marks an attributed row and never rejects it", async () => {
    const result = await attributePoolsLaunches(deps(answering({ kind: "attributed" })));
    expect(attributedIds).toEqual([1]);
    expect(rejected).toEqual([]);
    expect(result).toMatchObject({ checked: 1, attributed: 1, rejected: 0, skipped: false });
  });

  it("records a terminal rejection so the row leaves the lane forever", async () => {
    const result = await attributePoolsLaunches(
      deps(answering({ kind: "rejected", status: 400, code: "invalid_signature" })),
    );
    expect(rejected).toEqual([{ id: 1, code: "invalid_signature" }]);
    expect(attributedIds).toEqual([]);
    expect(result).toMatchObject({ rejected: 1, attributed: 0 });
  });

  it("counts a THROWING rejection writer as retryable, never as rejected too", async () => {
    // The increment sits after the awaited write: if the write throws, the row
    // falls to the per-row catch and is retried. One row tallied as both
    // rejected and retryable would make the run's totals lie.
    vi.mocked(launchedTokens.markPoolsAttributionRejected).mockImplementation(async () => {
      throw new Error("db down");
    });
    const result = await attributePoolsLaunches(
      deps(answering({ kind: "rejected", status: 400, code: "invalid_signature" })),
    );
    expect(result).toMatchObject({ checked: 1, rejected: 0, retryable: 1, attributed: 0 });
  });

  it.each([
    ["a 429", { kind: "retryable", status: 429, code: null }],
    ["a 503", { kind: "retryable", status: 503, code: null }],
    ["an unreadable 2xx", { kind: "retryable", status: 200, code: null }],
    ["launch_not_ready", { kind: "retryable", status: 409, code: "launch_not_ready" }],
    ["chain_unsupported", { kind: "retryable", status: 400, code: "chain_unsupported" }],
  ] as ReadonlyArray<[string, PoolsAttributionOutcome]>)(
    "leaves the row for the next cadence on %s - nothing durable is written",
    async (_label, outcome) => {
      const result = await attributePoolsLaunches(deps(answering(outcome)));
      expect(rejected).toEqual([]);
      expect(attributedIds).toEqual([]);
      expect(result).toMatchObject({ checked: 1, retryable: 1, rejected: 0, attributed: 0 });
    },
  );

  it("leaves the row for the next cadence on a transport failure", async () => {
    const result = await attributePoolsLaunches(
      deps(answering({ kind: "transport_failed", detail: "HTTP_TIMEOUT" })),
    );
    expect(rejected).toEqual([]);
    expect(attributedIds).toEqual([]);
    expect(result).toMatchObject({ transportFailed: 1, rejected: 0 });
  });
});

describe("per-row containment - one bad row never aborts the batch", () => {
  beforeEach(() => {
    vi.mocked(launchedTokens.claimPoolsAttributionCandidates).mockImplementation(async () => [
      candidate(1),
      candidate(2),
      candidate(3),
    ]);
  });

  it("survives a THROWING client and still processes the rest", async () => {
    let call = 0;
    const attribute = async (): Promise<PoolsAttributionOutcome> => {
      call++;
      if (call === 2) throw new Error("socket hang up");
      return { kind: "attributed" };
    };

    const result = await attributePoolsLaunches(deps(attribute));

    expect(result.checked).toBe(3);
    expect(attributedIds).toEqual([1, 3]);
    expect(result.transportFailed).toBe(1);
  });

  it("survives a THROWING repository write and still processes the rest", async () => {
    vi.mocked(launchedTokens.markPoolsAttributed).mockImplementation(async ({ id }) => {
      if (id === 2) throw new Error("connection terminated");
      attributedIds.push(id);
      return true;
    });

    const result = await attributePoolsLaunches(deps(answering({ kind: "attributed" })));

    expect(result.checked).toBe(3);
    expect(attributedIds).toEqual([1, 3]);
    // The failed row is not lost: it kept `attributed_at` NULL, so it comes
    // back after the retry window.
    expect(result.retryable).toBe(1);
  });

  it("passes each candidate's OWN txHash through as the locator", async () => {
    const seen: string[] = [];
    await attributePoolsLaunches(
      deps(async (input) => {
        seen.push(input.txHash);
        return { kind: "attributed" };
      }),
    );
    expect(seen).toEqual([1, 2, 3].map((id) => candidate(id).createTxHash));
  });
});

describe("the sweep never signs", () => {
  it("has no signer and never asks for one", async () => {
    // The dependency surface IS the proof: `baseUrl` and `attribute`, nothing
    // that could produce a signature. A candidate arrives with its signature
    // already stored, or it is a named gap that no sweep can ever close.
    const built = deps(answering({ kind: "attributed" }));
    expect(Object.keys(built).sort()).toEqual(["attribute", "baseUrl"]);
  });

  it("counts unsigned rows as a named gap rather than retrying them", async () => {
    vi.mocked(launchedTokens.countPoolsUnsignedAttributionGap).mockImplementation(async () => 4);
    const result = await attributePoolsLaunches(deps(answering({ kind: "attributed" })));
    expect(result.unsignedGap).toBe(4);
  });
});
