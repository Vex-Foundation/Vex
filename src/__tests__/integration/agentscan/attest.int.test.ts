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
import type {
  AttestOutcome,
  AttestVerdictOutcome,
} from "../../../vex-agent/agentscan/attest-client.js";
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
    return this.outcomes.shift() ?? { kind: "accepted", verifyStatus: "unverified" };
  };
}

/**
 * The verdict half of the lane, scripted the same way. The DEFAULT is `absent`,
 * which is the server's honest answer for a token it holds no candidate for -
 * so a test that says nothing about verdicts leaves every row unsettled instead
 * of accidentally proving one.
 */
class ScriptedVerdict {
  readonly calls: Parameters<AgentscanAttestDeps["readVerdict"]>[0][] = [];
  outcomes: AttestVerdictOutcome[] = [];
  readonly fn: AgentscanAttestDeps["readVerdict"] = async (input) => {
    this.calls.push(input);
    return this.outcomes.shift() ?? { kind: "absent" };
  };
}

/** Both halves of the dependency, so a submission test never has to name the other. */
function deps(
  attest: AgentscanAttestDeps["attest"],
  readVerdict: AgentscanAttestDeps["readVerdict"] = async () => ({ kind: "absent" }),
): AgentscanAttestDeps {
  return { attest, readVerdict };
}

describe("agentscan attest sweep — gate (AC3)", () => {
  it("disabled URL: a full no-op, no claim, no HTTP", async () => {
    mockAgentscanApiUrl = "";
    const seeded = await seedLaunchedToken({ withSignature: true });
    const scripted = new ScriptedAttest();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest(deps(scripted.fn));

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
    scripted.outcomes = [{ kind: "accepted", verifyStatus: "unverified" }];
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest(deps(scripted.fn));

    // The POST NAMES its launchpad: the server dispatches one creation proof on
    // that value rather than trying every decoder, so an omitted or wrong
    // launchpad is a definitive refusal, not a lenient fallback.
    expect(scripted.calls).toEqual([
      {
        chainId: TRENCH_CHAIN_ID,
        launchpad: "trench",
        tokenAddress: seeded.tokenAddress,
        attestSignature: SIGNATURE,
        txHash: seeded.txHash,
      },
    ]);
    expect(result).toMatchObject({ skipped: false, checked: 1, attested: 1, invalid: 0, retryable: 0 });

    const row = await queryOne<{
      agentscan_attested_at: Date | null;
      agentscan_verify_status: string | null;
      agentscan_verified_at: Date | null;
    }>(
      `SELECT agentscan_attested_at, agentscan_verify_status, agentscan_verified_at
         FROM launched_tokens WHERE id = $1`,
      [seeded.id],
    );
    // SUBMITTED, and NOTHING ELSE. The POST is the submission arrow of the state
    // machine and writes no verdict: the status the response named is not
    // authority (a duplicate POST is answered with the row's EXISTING status,
    // `verified` included), so it is logged and left to the GET read-back, which
    // writes the status and its stamp together.
    expect(row?.agentscan_attested_at).not.toBeNull();
    expect(row?.agentscan_verify_status).toBeNull();
    expect(row?.agentscan_verified_at).toBeNull();
  });

  it("a second sweep finds no candidates once attested", async () => {
    await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const first = new ScriptedAttest();
    first.outcomes = [{ kind: "accepted", verifyStatus: "unverified" }];
    await lane.runAgentscanAttest(deps(first.fn));

    const second = new ScriptedAttest();
    const result = await lane.runAgentscanAttest(deps(second.fn));

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

    const result = await lane.runAgentscanAttest(deps(scripted.fn));

    expect(result.checked).toBe(0);
    expect(scripted.calls).toHaveLength(0);
  });

  it("an invalid outcome stamps the attempt but does NOT mark attested, and is held out by the retry window", async () => {
    const seeded = await seedLaunchedToken({ withSignature: true });
    const scripted = new ScriptedAttest();
    scripted.outcomes = [{ kind: "invalid", detail: "HTTP 400 invalid_signature" }];
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest(deps(scripted.fn));

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
    const second = await lane.runAgentscanAttest(deps(immediateRetry.fn));
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

    const result = await lane.runAgentscanAttest(deps(scripted.fn));

    expect(result).toMatchObject({ checked: 1, attested: 0, retryable: 1 });
  });

  it("rows without a stored signature are never candidates", async () => {
    await seedLaunchedToken({ withSignature: false });
    const scripted = new ScriptedAttest();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    const result = await lane.runAgentscanAttest(deps(scripted.fn));

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
      return { kind: "accepted", verifyStatus: "unverified" };
    };

    const result = await lane.runAgentscanAttest(deps(throwing));

    expect(result).toMatchObject({ checked: 2, attested: 1, retryable: 1 });
  });
});

/**
 * D4: ACCEPTED IS NOT VERIFIED.
 *
 * `agentscan_attested_at` means the server took the claim into its verify queue.
 * Whether the creation proof holds is decided later by its verify job and read
 * back from `GET /v1/tokens/:chainId/:address`, and until this sweep existed the
 * local state had no way to say which of the two had happened.
 */
describe("agentscan attest sweep: the verdict read-back (D4)", () => {
  async function submitted(): Promise<{ id: number; tokenAddress: string }> {
    const seeded = await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const scripted = new ScriptedAttest();
    scripted.outcomes = [{ kind: "accepted", verifyStatus: "unverified" }];
    await lane.runAgentscanAttest(deps(scripted.fn));
    // The submission run also polls, and the default answer is `absent`, so the
    // row is left exactly where the submission put it. The poll stamp is cleared
    // for EVERY row this test seeded, not just the newest: the read-back window
    // is half an hour, so a row stamped by an earlier call would otherwise sit
    // out the run under test.
    await execute(
      `UPDATE launched_tokens SET agentscan_verify_checked_at = NULL WHERE id = ANY($1::bigint[])`,
      [seededIds],
    );
    return seeded;
  }

  async function verifyRow(id: number) {
    return queryOne<{
      agentscan_verify_status: string | null;
      agentscan_verified_at: Date | null;
      agentscan_verify_checked_at: Date | null;
    }>(
      `SELECT agentscan_verify_status, agentscan_verified_at, agentscan_verify_checked_at
         FROM launched_tokens WHERE id = $1`,
      [id],
    );
  }

  it("asks for the verdict of a submitted row and records `verified` with its stamp", async () => {
    const seeded = await submitted();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const verdict = new ScriptedVerdict();
    verdict.outcomes = [{ kind: "verdict", status: "verified" }];

    const result = await lane.runAgentscanAttest(deps(new ScriptedAttest().fn, verdict.fn));

    expect(verdict.calls).toEqual([
      { chainId: TRENCH_CHAIN_ID, tokenAddress: seeded.tokenAddress },
    ]);
    expect(result).toMatchObject({ verdictsChecked: 1, verdictsSettled: 1 });

    const row = await verifyRow(seeded.id);
    expect(row?.agentscan_verify_status).toBe("verified");
    expect(row?.agentscan_verified_at).not.toBeNull();
  });

  it("records a `mismatch` verdict WITHOUT a verified stamp, and stops asking", async () => {
    const seeded = await submitted();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const verdict = new ScriptedVerdict();
    verdict.outcomes = [{ kind: "verdict", status: "mismatch" }];
    await lane.runAgentscanAttest(deps(new ScriptedAttest().fn, verdict.fn));

    const row = await verifyRow(seeded.id);
    expect(row?.agentscan_verify_status).toBe("mismatch");
    // Migration 102's stamp CHECK: only `verified` may carry the timestamp, so
    // the two can never tell different stories about the same row.
    expect(row?.agentscan_verified_at).toBeNull();

    // Terminal: an answer that cannot change by asking again leaves the set.
    await execute(
      `UPDATE launched_tokens SET agentscan_verify_checked_at = NULL WHERE id = $1`,
      [seeded.id],
    );
    const again = new ScriptedVerdict();
    const second = await lane.runAgentscanAttest(deps(new ScriptedAttest().fn, again.fn));
    expect(second.verdictsChecked).toBe(0);
    expect(again.calls).toHaveLength(0);
  });

  it("keeps an `unverified` row in the set: a queue state settles nothing", async () => {
    const seeded = await submitted();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const verdict = new ScriptedVerdict();
    verdict.outcomes = [{ kind: "verdict", status: "unverified" }];

    const result = await lane.runAgentscanAttest(deps(new ScriptedAttest().fn, verdict.fn));
    expect(result).toMatchObject({ verdictsChecked: 1, verdictsSettled: 0 });

    await execute(
      `UPDATE launched_tokens SET agentscan_verify_checked_at = NULL WHERE id = $1`,
      [seeded.id],
    );
    const again = new ScriptedVerdict();
    await lane.runAgentscanAttest(deps(new ScriptedAttest().fn, again.fn));
    expect(again.calls).toHaveLength(1);
  });

  it("treats a 404 as ABSENT, not as a verdict and not as a failure", async () => {
    const seeded = await submitted();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const verdict = new ScriptedVerdict();
    verdict.outcomes = [{ kind: "absent" }];

    const result = await lane.runAgentscanAttest(deps(new ScriptedAttest().fn, verdict.fn));
    expect(result).toMatchObject({ verdictsChecked: 1, verdictsSettled: 0 });

    const row = await verifyRow(seeded.id);
    // `absent` is not a verdict, so the status is still whatever the read-back
    // last stored - nothing, because only a verdict may write it.
    expect(row?.agentscan_verify_status).toBeNull();
    expect(row?.agentscan_verify_checked_at).not.toBeNull();
  });

  it("never asks for a verdict on a row that was never submitted", async () => {
    await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    const attest = new ScriptedAttest();
    attest.outcomes = [{ kind: "invalid", detail: "HTTP 400 invalid_signature" }];
    const verdict = new ScriptedVerdict();

    const result = await lane.runAgentscanAttest(deps(attest.fn, verdict.fn));

    expect(result).toMatchObject({ attested: 0, verdictsChecked: 0 });
    expect(verdict.calls).toHaveLength(0);
  });

  it("contains a throwing verdict dependency: one bad row never aborts the batch", async () => {
    await submitted();
    await submitted();
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    let calls = 0;
    const throwing: AgentscanAttestDeps["readVerdict"] = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { kind: "verdict", status: "verified" };
    };

    const result = await lane.runAgentscanAttest(deps(new ScriptedAttest().fn, throwing));
    expect(result).toMatchObject({ verdictsChecked: 2, verdictsSettled: 1 });
  });
});

/**
 * THE DUPLICATE POST AFTER A CRASH, and the CHECK it used to violate forever.
 *
 * The server's `token-attestations-repo.ts` answers a duplicate POST with the
 * row's EXISTING `verifyStatus` - which, once its verify job has run, is
 * `verified`. The canonical way to send one is ordinary: this install POSTs, the
 * server commits the attestation, and the process dies before
 * `markAgentscanAttested` lands. The row is still unattested locally, so the
 * next sweep claims it and POSTs again.
 *
 * While the POST path copied that word onto the row, the UPDATE wrote
 * `agentscan_verify_status = 'verified'` with `agentscan_verified_at` still
 * NULL, which migration 102's `launched_tokens_agentscan_verified_stamp` CHECK
 * forbids. The statement aborted, the row was never marked attested, and it
 * came back on every sweep from then on - a permanent loop out of an ordinary
 * crash. The POST is submission only now, so the retry simply succeeds.
 */
describe("agentscan attest sweep: a duplicate POST after a crash before the local mark", () => {
  it("marks the retry attested instead of aborting on the verified-stamp CHECK", async () => {
    const seeded = await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");

    // The crash: the server committed the attestation, this install did not.
    // The row is therefore still unattested and comes back as a candidate.
    const retry = new ScriptedAttest();
    retry.outcomes = [{ kind: "accepted", verifyStatus: "verified" }];

    const result = await lane.runAgentscanAttest(deps(retry.fn));

    expect(result).toMatchObject({ checked: 1, attested: 1, invalid: 0, retryable: 0 });
    const row = await queryOne<{
      agentscan_attested_at: Date | null;
      agentscan_verify_status: string | null;
      agentscan_verified_at: Date | null;
    }>(
      `SELECT agentscan_attested_at, agentscan_verify_status, agentscan_verified_at
         FROM launched_tokens WHERE id = $1`,
      [seeded.id],
    );
    expect(row?.agentscan_attested_at).not.toBeNull();
    // The server's word travelled no further than a log line: the row records
    // SUBMITTED and waits for the GET, which writes the status and the stamp
    // together and can therefore never contradict the CHECK.
    expect(row?.agentscan_verify_status).toBeNull();
    expect(row?.agentscan_verified_at).toBeNull();

    // And the row has left the submission set for good.
    const second = new ScriptedAttest();
    await lane.runAgentscanAttest(deps(second.fn));
    expect(second.calls).toHaveLength(0);
  });

  it("the verdict path stamps status and verified_at together, so the CHECK holds", async () => {
    const seeded = await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    await lane.runAgentscanAttest(deps(new ScriptedAttest().fn));
    await execute(
      `UPDATE launched_tokens SET agentscan_verify_checked_at = NULL WHERE id = $1`,
      [seeded.id],
    );

    const verdict = new ScriptedVerdict();
    verdict.outcomes = [{ kind: "verdict", status: "verified" }];
    const result = await lane.runAgentscanAttest(deps(new ScriptedAttest().fn, verdict.fn));

    expect(result).toMatchObject({ verdictsChecked: 1, verdictsSettled: 1 });
    const row = await queryOne<{
      agentscan_verify_status: string | null;
      agentscan_verified_at: Date | null;
    }>(
      `SELECT agentscan_verify_status, agentscan_verified_at FROM launched_tokens WHERE id = $1`,
      [seeded.id],
    );
    expect(row?.agentscan_verify_status).toBe("verified");
    expect(row?.agentscan_verified_at).not.toBeNull();
  });
});

/**
 * THE COMPARE-AND-SET on the verdict write. A terminal verdict is an answer that
 * cannot change by asking again, and the sweep's candidate query already says so
 * - but a response in flight when the terminal one landed would otherwise walk
 * the row backwards into the polling set, and (for `verified`) drop the
 * `verified_at` stamp the CHECK requires beside it.
 */
describe("recordAgentscanVerifyStatus: a compare-and-set from an OPEN status only", () => {
  it("refuses to downgrade a settled verdict, and leaves its stamp intact", async () => {
    const repo = await import("@vex-agent/db/repos/launched-tokens.js");
    const seeded = await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    await lane.runAgentscanAttest(deps(new ScriptedAttest().fn));

    expect(await repo.recordAgentscanVerifyStatus({ id: seeded.id, status: "verified" })).toBe(true);
    // The stale read-back, arriving after the terminal one.
    expect(await repo.recordAgentscanVerifyStatus({ id: seeded.id, status: "unverified" })).toBe(false);
    // And a second terminal verdict cannot overwrite the first either.
    expect(await repo.recordAgentscanVerifyStatus({ id: seeded.id, status: "mismatch" })).toBe(false);

    const row = await queryOne<{
      agentscan_verify_status: string | null;
      agentscan_verified_at: Date | null;
    }>(
      `SELECT agentscan_verify_status, agentscan_verified_at FROM launched_tokens WHERE id = $1`,
      [seeded.id],
    );
    expect(row?.agentscan_verify_status).toBe("verified");
    expect(row?.agentscan_verified_at).not.toBeNull();
  });

  it("accepts a verdict over the OPEN `unverified` state, which settles nothing on its own", async () => {
    const repo = await import("@vex-agent/db/repos/launched-tokens.js");
    const seeded = await seedLaunchedToken({ withSignature: true });
    const lane = await import("../../../vex-agent/sync/agentscan-attest.js");
    await lane.runAgentscanAttest(deps(new ScriptedAttest().fn));

    expect(await repo.recordAgentscanVerifyStatus({ id: seeded.id, status: "unverified" })).toBe(true);
    expect(await repo.recordAgentscanVerifyStatus({ id: seeded.id, status: "mismatch" })).toBe(true);

    const row = await queryOne<{
      agentscan_verify_status: string | null;
      agentscan_verified_at: Date | null;
    }>(
      `SELECT agentscan_verify_status, agentscan_verified_at FROM launched_tokens WHERE id = $1`,
      [seeded.id],
    );
    expect(row?.agentscan_verify_status).toBe("mismatch");
    // A non-verified verdict never carries the stamp - the other half of the CHECK.
    expect(row?.agentscan_verified_at).toBeNull();
  });
});
