import { describe, it, expect, beforeEach } from "vitest";

import { createMissionDraft, getMissionSetupState } from "@vex-agent/engine/mission/setup.js";
import { handleMissionDraftUpdate } from "@vex-agent/tools/internal/mission.js";
import { makeTestContext } from "../../vex-agent/tools/_test-context.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

describe("mission draft persistence (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("persists a complete mission draft with JSONB array fields", async () => {
    const sessionId = await makeSession();
    const draft = await createMissionDraft(sessionId);

    const result = await handleMissionDraftUpdate(
      {
        title: "Solana Meme Degen 6h Flip 10 to 20",
        goal: "Autonomously trade Solana meme coins using Jupiter swaps on trending and CTO signals from DexScreener to grow Solana wallet total USD value from 10 to at least 20.",
        capitalSource: "Solana wallet GoVYsnzegMxCmco53bMBb1k3tsCkdEa8PCfh1PFa11E5",
        startingCapital: "$10.84 USD equivalent including JupUSD USDC SOL and meme dust to consolidate",
        allowedWallets: ["GoVYsnzegMxCmco53bMBb1k3tsCkdEa8PCfh1PFa11E5"],
        allowedChains: ["solana"],
        allowedProtocols: ["solana", "dexscreener"],
        riskProfile: "aggressive",
        successCriteria: ["Solana wallet total USD value >= 20 via wallet_balances"],
        stopConditions: ["6 hours elapsed from start", "Manual stop via /mission stop"],
        deadline: "2026-05-02T23:00:00Z",
      },
      makeTestContext({
        sessionId,
        sessionPermission: "full",
        missionId: draft.missionId,
        sessionKind: "mission",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      ready: true,
      status: "ready",
      nextAction:
        "The draft is ready — tell the user they can start the mission with the Start mission button in the host UI.",
    }));

    const setup = await getMissionSetupState(draft.missionId);
    expect(setup).toEqual(expect.objectContaining({
      ready: true,
      status: "ready",
      missingFields: [],
    }));
  });
});
