/**
 * Integration (F06): `setMissionModel` against the real `missions` table.
 *
 * The model is merged into `constraints_json` as a JSONB object next to its
 * siblings, read back through the mapper, cleared to `null`, invalidates a
 * prior acceptance, and moves the v10 contract hash. Nothing is stubbed.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { query, queryOne } from "@vex-agent/db/client.js";
import { getMission } from "@vex-agent/db/repos/missions.js";
import { setMissionModel } from "@vex-agent/engine/mission/set-model.js";
import { missionToDraft } from "@vex-agent/engine/mission/mapper.js";
import { computeContractHash } from "@vex-agent/engine/mission/contract-hash.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

const SONNET = { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" } as const;

async function seedMission(acceptedHash: string | null = null): Promise<{ sessionId: string; missionId: string }> {
  const sessionId = await makeSession();
  const missionId = `mission-${sessionId}`;
  // Acceptance columns are written together or not at all (migration 023).
  await query(
    `INSERT INTO missions (id, root_session_id, status, goal, constraints_json,
                           accepted_contract_hash, accepted_contract_at, accepted_contract_by, contract_hash_version)
     VALUES ($1, $2, 'ready', 'mission model integration', '{"reasoningEffort":"low"}'::jsonb,
             $3::text, CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END,
             CASE WHEN $3::text IS NULL THEN NULL ELSE 'host' END,
             CASE WHEN $3::text IS NULL THEN NULL ELSE 10 END)`,
    [missionId, sessionId, acceptedHash],
  );
  return { sessionId, missionId };
}

async function constraints(missionId: string): Promise<Record<string, unknown>> {
  const row = await queryOne<{ constraints_json: Record<string, unknown> }>(
    "SELECT constraints_json FROM missions WHERE id = $1",
    [missionId],
  );
  return row?.constraints_json ?? {};
}

beforeEach(async () => {
  await resetDb();
});

describe("setMissionModel against Postgres", () => {
  it("merges the model as a JSONB object beside its siblings and reads it back", async () => {
    const { sessionId, missionId } = await seedMission();
    const outcome = await setMissionModel({ sessionId, missionId, model: SONNET });

    expect(outcome).toEqual({ outcome: "updated", model: SONNET, acceptanceCleared: false });
    expect(await constraints(missionId)).toEqual({ reasoningEffort: "low", model: SONNET });
    const mission = await getMission(missionId);
    expect(mission === null ? null : missionToDraft(mission).model).toEqual(SONNET);
  });

  it("clears to null, which reads as not set", async () => {
    const { sessionId, missionId } = await seedMission();
    await setMissionModel({ sessionId, missionId, model: SONNET });
    await setMissionModel({ sessionId, missionId, model: null });

    expect(await constraints(missionId)).toEqual({ reasoningEffort: "low", model: null });
    const mission = await getMission(missionId);
    expect(mission === null ? undefined : missionToDraft(mission).model).toBeNull();
  });

  it("invalidates a prior acceptance, and the v10 hash moves with the model", async () => {
    const { sessionId, missionId } = await seedMission("previously-accepted");
    const before = await getMission(missionId);
    const outcome = await setMissionModel({ sessionId, missionId, model: SONNET });
    const after = await getMission(missionId);

    expect(outcome).toMatchObject({ outcome: "updated", acceptanceCleared: true });
    expect(after?.acceptedContractHash ?? null).toBeNull();
    if (before === null || after === null) throw new Error("mission row missing");
    expect(computeContractHash(missionToDraft(after))).not.toBe(computeContractHash(missionToDraft(before)));
  });
});
