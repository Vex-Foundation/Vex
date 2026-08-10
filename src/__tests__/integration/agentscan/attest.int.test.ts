/**
 * AgentScan token-attestation sweep — end-to-end against real Postgres with a
 * scripted `attest` dependency (the HTTP client has its own unit suite in
 * `attest-client.test.ts`; this proves the LANE's claim/POST/mark state
 * machine over real SQL). Cloned architecture from the trench attribution
 * sweep's own integration coverage pattern — see `sync/launch-attribution.ts`
 * and `sync/agentscan-attest.ts`.
 *
 * Acceptance criteria pinned here:
 *   AC2 — a seeded, signed `launched_tokens` row → the sweep claims it, POSTs
 *         once with the creation tx hash, marks `agentscan_attested_at`; a
 *         second sweep finds no candidates; an already-attested row is never
 *         re-claimed; an `invalid` outcome stamps the attempt but does NOT
 *         mark attested (held out by the retry window, not re-claimed
 *         immediately); a row with no stored signature is never a candidate.
 *   AC3 — a disabled (unconfigured) AgentScan URL is a full no-op: no claim,
 *         no HTTP.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

let mockAgentscanApiUrl = "https://agentscan.test";
vi.mock("../../../config/store.js", () => ({
  loadConfig: () => ({ services: { agentscanApiUrl: mockAgentscanApiUrl } }),
}));

import { execute, queryOne } from "@vex-agent/db/client.js";
import { record, stampAttestSignature } from "@vex-agent/db/repos/launched-tokens.js";
import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import type { AttestOutcome } from "../../../vex-agent/agentscan/attest-client.js";
import type { AgentscanAttestDeps } from "../../../vex-agent/sync/agentscan-attest.js";

const SIGNATURE = `0x${"ab".repeat(65)}`;

const seededIds: number[] = [];

afterEach(async () => {
  mockAgentscanApiUrl = "https://agentscan.test";
  if (seededIds.length > 0) {
    const ids = seededIds.splice(0, seededIds.length);
    await execute(`DELETE FROM launched_tokens WHERE id = ANY($1::bigint[])`, [ids]);
  }
});

function randomHex(byteLen: number): string {
  let out = "";
  for (let i = 0; i < byteLen * 2; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

async function seedLaunchedToken(
  input: { withSignature: boolean },
): Promise<{ id: number; tokenAddress: string; txHash: string }> {
  const tokenAddress = `0x${randomHex(20)}`;
  const txHash = `0x${randomHex(32)}`;
  const { row } = await record({
    walletAddress: `0x${randomHex(20)}`,
    chainId: TRENCH_CHAIN_ID,
    tokenAddress,
    name: "Attest Coin",
    symbol: "ATTEST",
    createTxHash: txHash,
  });
  seededIds.push(row.id);
  if (input.withSignature) {
    const stamped = await stampAttestSignature({
      chainId: TRENCH_CHAIN_ID,
      tokenAddress,
      attestSignature: SIGNATURE,
    });
    expect(stamped).toBe(true);
  }
  return { id: row.id, tokenAddress, txHash };
}

/** Records every call and answers from a programmable queue, defaulting to accepted. */
class ScriptedAttest {
  readonly calls: Parameters<AgentscanAttestDeps["attest"]>[0][] = [];
  outcomes: AttestOutcome[] = [];
  readonly fn: AgentscanAttestDeps["attest"] = async (input) => {
    this.calls.push(input);
    return this.outcomes.shift() ?? { kind: "accepted" };
  };
}

describe("agentscan attest sweep — gate (AC3)", () => {
  it("disabled URL: a full no-op, no claim, no HTTP", async () => {
    mockAgentscanApiUrl = "";
    const seeded = await seedLaunchedToken({ withSignature: true });
    const scripted = new ScriptedAttest();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest({ attest: scripted.fn });

    expect(result.skipped).toBe(true);
    expect(scripted.calls).toHaveLength(0);

    const row = await queryOne<{ agentscan_attest_attempted_at: Date | null }>(
      `SELECT agentscan_attest_attempted_at FROM launched_tokens WHERE id = $1`,
      [seeded.id],
    );
    expect(row?.agentscan_attest_attempted_at).toBeNull();
  });
});

describe("agentscan attest sweep — claim/POST/mark (AC2)", () => {
  it("claims a signed row, POSTs once with the creation tx hash, marks attested", async () => {
    const seeded = await seedLaunchedToken({ withSignature: true });
    const scripted = new ScriptedAttest();
    scripted.outcomes = [{ kind: "accepted" }];
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest({ attest: scripted.fn });

    expect(scripted.calls).toEqual([
      {
        chainId: TRENCH_CHAIN_ID,
        tokenAddress: seeded.tokenAddress,
        attestSignature: SIGNATURE,
        txHash: seeded.txHash,
      },
    ]);
    expect(result).toMatchObject({ skipped: false, checked: 1, attested: 1, invalid: 0, retryable: 0 });

    const row = await queryOne<{ agentscan_attested_at: Date | null }>(
      `SELECT agentscan_attested_at FROM launched_tokens WHERE id = $1`,
      [seeded.id],
    );
    expect(row?.agentscan_attested_at).not.toBeNull();
  });

  it("a second sweep finds no candidates once attested", async () => {
    await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const first = new ScriptedAttest();
    first.outcomes = [{ kind: "accepted" }];
    await lane.runAgentscanAttest({ attest: first.fn });

    const second = new ScriptedAttest();
    const result = await lane.runAgentscanAttest({ attest: second.fn });

    expect(result.checked).toBe(0);
    expect(second.calls).toHaveLength(0);
  });

  it("an already-attested row is never re-claimed, even once its attempt stamp is old", async () => {
    const seeded = await seedLaunchedToken({ withSignature: true });
    await execute(
      `UPDATE launched_tokens
          SET agentscan_attested_at = NOW(), agentscan_attest_attempted_at = NOW() - INTERVAL '1 hour'
        WHERE id = $1`,
      [seeded.id],
    );
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const scripted = new ScriptedAttest();

    const result = await lane.runAgentscanAttest({ attest: scripted.fn });

    expect(result.checked).toBe(0);
    expect(scripted.calls).toHaveLength(0);
  });

  it("an invalid outcome stamps the attempt but does NOT mark attested, and is held out by the retry window", async () => {
    const seeded = await seedLaunchedToken({ withSignature: true });
    const scripted = new ScriptedAttest();
    scripted.outcomes = [{ kind: "invalid", detail: "HTTP 400 invalid_signature" }];
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest({ attest: scripted.fn });

    expect(result).toMatchObject({ checked: 1, attested: 0, invalid: 1 });

    const row = await queryOne<{
      agentscan_attested_at: Date | null;
      agentscan_attest_attempted_at: Date | null;
    }>(
      `SELECT agentscan_attested_at, agentscan_attest_attempted_at FROM launched_tokens WHERE id = $1`,
      [seeded.id],
    );
    expect(row?.agentscan_attested_at).toBeNull();
    expect(row?.agentscan_attest_attempted_at).not.toBeNull();

    const immediateRetry = new ScriptedAttest();
    const second = await lane.runAgentscanAttest({ attest: immediateRetry.fn });
    expect(second.checked).toBe(0);
    expect(immediateRetry.calls).toHaveLength(0);
  });

  it("a retryable outcome stamps the attempt, marks nothing, and is held out by the retry window", async () => {
    await seedLaunchedToken({ withSignature: true });
    const scripted = new ScriptedAttest();
    scripted.outcomes = [
      { kind: "retryable", status: 503, retryAfterSeconds: 30, detail: "HTTP 503" },
    ];
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest({ attest: scripted.fn });

    expect(result).toMatchObject({ checked: 1, attested: 0, retryable: 1 });
  });

  it("rows without a stored signature are never candidates", async () => {
    await seedLaunchedToken({ withSignature: false });
    const scripted = new ScriptedAttest();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest({ attest: scripted.fn });

    expect(result.checked).toBe(0);
    expect(scripted.calls).toHaveLength(0);
  });

  it("contains a throwing dependency — one bad row never aborts the batch and is treated as retryable", async () => {
    await seedLaunchedToken({ withSignature: true });
    await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    let calls = 0;
    const throwing: AgentscanAttestDeps["attest"] = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { kind: "accepted" };
    };

    const result = await lane.runAgentscanAttest({ attest: throwing });

    expect(result).toMatchObject({ checked: 2, attested: 1, retryable: 1 });
  });
});
