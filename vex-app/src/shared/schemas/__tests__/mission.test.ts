import { describe, expect, it } from "vitest";
import {
  MISSION_DRAFT_LIST_ITEM_MAX,
  missionAcceptContractInputSchema,
  missionAcceptContractResultSchema,
  missionConstraintsSchema,
  missionDeployedCapitalSchema,
  missionDraftDtoSchema,
  missionGetDraftInputSchema,
  missionListEntrySchema,
  missionStartResultSchema,
} from "../mission.js";

const SESSION = "00000000-0000-4000-8000-000000000003";
const ISO = "2026-05-21T10:00:00.000Z";

describe("mission schemas", () => {
  it("missionConstraintsSchema strips unknown keys via .strict()", () => {
    expect(
      missionConstraintsSchema.safeParse({
        maxSpendUsd: 100,
        leakedSecret: "kab00m",
      }).success,
    ).toBe(false);
  });

  it("missionConstraintsSchema accepts empty object", () => {
    expect(missionConstraintsSchema.safeParse({}).success).toBe(true);
  });

  it("missionConstraintsSchema accepts the Phase 4d autoRetryEnabled flag", () => {
    expect(
      missionConstraintsSchema.safeParse({ autoRetryEnabled: true }).success,
    ).toBe(true);
    const parsed = missionConstraintsSchema.parse({ autoRetryEnabled: false });
    expect(parsed.autoRetryEnabled).toBe(false);
    // Wrong type is rejected.
    expect(
      missionConstraintsSchema.safeParse({ autoRetryEnabled: "yes" }).success,
    ).toBe(false);
  });

  it("missionListEntrySchema enforces trim + length + non-empty", () => {
    expect(missionListEntrySchema.safeParse("").success).toBe(false);
    expect(missionListEntrySchema.safeParse("ok").success).toBe(true);
    expect(
      missionListEntrySchema.safeParse("x".repeat(MISSION_DRAFT_LIST_ITEM_MAX + 1))
        .success,
    ).toBe(false);
  });

  it("missionDraftDtoSchema requires uuid sessionId + enum status + lists", () => {
    const parsed = missionDraftDtoSchema.safeParse({
      missionId: "mission-1",
      sessionId: SESSION,
      status: "draft",
      title: "Rebalance",
      goal: "Rebalance the Arbitrum LP",
      constraints: {},
      successCriteria: ["TVL increased"],
      stopConditions: ["TVL drops by 10%"],
      riskProfile: "balanced",
      allowedChains: ["ethereum", "arbitrum"],
      allowedProtocols: ["uniswap"],
      allowedWallets: ["wallet-1"],
      createdAt: ISO,
      updatedAt: ISO,
      approvedAt: null,
      acceptance: null,
      deployedCapital: null,
      renewedFromMissionId: null,
      missingFields: [],
      canAcceptContract: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("missionDraftDtoSchema rejects unknown status outside the enum", () => {
    const parsed = missionDraftDtoSchema.safeParse({
      missionId: "mission-1",
      sessionId: SESSION,
      status: "unknown",
      title: null,
      goal: null,
      constraints: {},
      successCriteria: [],
      stopConditions: [],
      riskProfile: null,
      allowedChains: [],
      allowedProtocols: [],
      allowedWallets: [],
      createdAt: ISO,
      updatedAt: ISO,
      approvedAt: null,
      acceptance: null,
      deployedCapital: null,
      renewedFromMissionId: null,
      missingFields: [],
      canAcceptContract: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("missionDraftDtoSchema accepts a populated acceptance block", () => {
    const parsed = missionDraftDtoSchema.safeParse({
      missionId: "mission-1",
      sessionId: SESSION,
      status: "ready",
      title: null,
      goal: null,
      constraints: {},
      successCriteria: [],
      stopConditions: [],
      riskProfile: null,
      allowedChains: [],
      allowedProtocols: [],
      allowedWallets: [],
      createdAt: ISO,
      updatedAt: ISO,
      approvedAt: null,
      acceptance: {
        contractHash: "a".repeat(64),
        acceptedAt: ISO,
        acceptedBy: "host",
        contractHashVersion: 1,
      },
      deployedCapital: null,
      renewedFromMissionId: "mission-source",
      missingFields: [],
      canAcceptContract: false,
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * C3 - `deployedCapital` is hash-bound acceptance material, so its transport
   * contract is pinned here. It is NULLABLE BUT NOT OPTIONAL on purpose: a
   * fixture or producer that forgets the key must fail loudly rather than have
   * the omission read as an honest "not declared".
   */
  describe("missionDeployedCapitalSchema", () => {
    const VALID = {
      amountRaw: "3044000000000000000000",
      decimals: 18,
      chainId: 4663,
      assetAddress: "0x0f9f0000000000000000000000000000000000ee",
      assetSymbol: "VEX",
      amountHuman: "3044",
    };

    it("accepts a full declaration", () => {
      expect(missionDeployedCapitalSchema.safeParse(VALID).success).toBe(true);
    });

    it("accepts a null amountHuman (main could not derive a figure)", () => {
      expect(
        missionDeployedCapitalSchema.safeParse({ ...VALID, amountHuman: null })
          .success,
      ).toBe(true);
    });

    it.each([
      ["a numeric amountRaw", { amountRaw: 3044 }],
      ["a non-digit amountRaw", { amountRaw: "3044.5" }],
      ["a negative amountRaw", { amountRaw: "-3044" }],
      ["an over-long amountRaw", { amountRaw: "1".repeat(81) }],
      ["a fractional decimals", { decimals: 1.5 }],
      ["an out-of-range decimals", { decimals: 37 }],
      ["a zero chainId", { chainId: 0 }],
      ["an over-long assetAddress", { assetAddress: "a".repeat(129) }],
      ["a symbol outside the ticker charset", { assetSymbol: "VE X" }],
      ["a symbol with a newline", { assetSymbol: "VEX\ninjected" }],
      ["an over-long symbol", { assetSymbol: "V".repeat(33) }],
      ["an absent amountHuman", { amountHuman: undefined }],
    ])("rejects %s", (_label, override) => {
      expect(
        missionDeployedCapitalSchema.safeParse({ ...VALID, ...override }).success,
      ).toBe(false);
    });

    it("rejects an unknown extra key (strict transport)", () => {
      expect(
        missionDeployedCapitalSchema.safeParse({ ...VALID, usdValue: 1 }).success,
      ).toBe(false);
    });

    it("missionDraftDtoSchema carries the declaration and REQUIRES the key", () => {
      const base = {
        missionId: "mission-1",
        sessionId: SESSION,
        status: "ready" as const,
        title: null,
        goal: null,
        constraints: {},
        successCriteria: [],
        stopConditions: [],
        riskProfile: null,
        allowedChains: [],
        allowedProtocols: [],
        allowedWallets: [],
        createdAt: ISO,
        updatedAt: ISO,
        approvedAt: null,
        acceptance: null,
        renewedFromMissionId: null,
        missingFields: [],
        canAcceptContract: false,
      };
      expect(
        missionDraftDtoSchema.safeParse({ ...base, deployedCapital: VALID })
          .success,
      ).toBe(true);
      // Omitted key - the loud failure that keeps a stale producer honest.
      expect(missionDraftDtoSchema.safeParse(base).success).toBe(false);
    });
  });

  it("missionGetDraftInputSchema requires uuid sessionId", () => {
    expect(missionGetDraftInputSchema.safeParse({ sessionId: SESSION }).success).toBe(
      true,
    );
    expect(missionGetDraftInputSchema.safeParse({ sessionId: "x" }).success).toBe(
      false,
    );
  });
});

describe("missionAcceptContract - plan-mode (Approach A) round-trips", () => {
  const HASH = "a".repeat(64);

  it("input accepts an OPTIONAL planUpdatedAt (datetime) - and omitting it is valid", () => {
    // Plan-mode OFF / old builds: no planUpdatedAt → still valid.
    const withoutToken = missionAcceptContractInputSchema.safeParse({
      sessionId: SESSION,
      missionId: "mission-1",
      contractHash: HASH,
    });
    expect(withoutToken.success).toBe(true);

    // Plan-mode ON: the renderer echoes the reviewed plan row's updatedAt.
    const withToken = missionAcceptContractInputSchema.safeParse({
      sessionId: SESSION,
      missionId: "mission-1",
      contractHash: HASH,
      planUpdatedAt: ISO,
    });
    expect(withToken.success).toBe(true);
    if (withToken.success) {
      expect(withToken.data.planUpdatedAt).toBe(ISO);
    }
  });

  it("input rejects a non-datetime planUpdatedAt", () => {
    expect(
      missionAcceptContractInputSchema.safeParse({
        sessionId: SESSION,
        missionId: "mission-1",
        contractHash: HASH,
        planUpdatedAt: "not-a-timestamp",
      }).success,
    ).toBe(false);
  });

  it("result round-trips plan_missing", () => {
    const parsed = missionAcceptContractResultSchema.safeParse({
      outcome: "plan_missing",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.outcome).toBe("plan_missing");
  });

  it("result round-trips plan_stale", () => {
    const parsed = missionAcceptContractResultSchema.safeParse({
      outcome: "plan_stale",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.outcome).toBe("plan_stale");
  });

  it("accepted result carries an optional planAcceptedAt (present, null, or absent)", () => {
    const base = {
      outcome: "accepted" as const,
      missionId: "mission-1",
      acceptedContractHash: HASH,
      acceptedAt: ISO,
      acceptedBy: "host",
      contractHashVersion: 1,
    };

    // Absent (plan-mode off / no co-accept).
    expect(missionAcceptContractResultSchema.safeParse(base).success).toBe(true);

    // Present (plan co-accepted in the same TX).
    const withPlan = missionAcceptContractResultSchema.safeParse({
      ...base,
      planAcceptedAt: ISO,
    });
    expect(withPlan.success).toBe(true);
    if (withPlan.success && withPlan.data.outcome === "accepted") {
      expect(withPlan.data.planAcceptedAt).toBe(ISO);
    }

    // Null (explicitly nullable).
    expect(
      missionAcceptContractResultSchema.safeParse({
        ...base,
        planAcceptedAt: null,
      }).success,
    ).toBe(true);
  });
});

describe("missionStart - plan-acceptance start-gate (Stage 6)", () => {
  it("result round-trips plan_not_accepted with missionId", () => {
    const parsed = missionStartResultSchema.safeParse({
      outcome: "plan_not_accepted",
      missionId: "mission-1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.outcome === "plan_not_accepted") {
      expect(parsed.data.missionId).toBe("mission-1");
    }
  });
});
