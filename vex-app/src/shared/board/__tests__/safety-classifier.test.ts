/**
 * THE SAFETY DECISION TABLE, one fixture per row.
 *
 * Every case asserts the ROW as well as the state. A first-match-wins table
 * can reach the right answer through the wrong rule, and that is exactly the
 * defect that would survive a state-only assertion and then break the moment
 * the rows are reordered.
 *
 * The bundle builder starts from a CLEAN, complete, verified document and each
 * case perturbs one thing, so a case proves the row it names rather than the
 * accumulated shape of a hand-written blob.
 */

import { describe, expect, it } from "vitest";

import type {
  BoardDetailsBundle,
  BoardGoPlusFlags,
  BoardPercent,
  BoardQuickIntelFlags,
  BoardSafetyConflict,
} from "../../schemas/board-details.js";
import { boardDetailsBundleSchema } from "../../schemas/board-details.js";
import {
  CONCENTRATION_PCT,
  NEW_PAIR_SECONDS,
  TAX_HARD_PCT,
  TAX_RISK_PCT,
  showsNewPairChip,
} from "../safety-checks.js";
import { boardSafetyEvidenceFrom, lastGoodFromBundle } from "../safety-evidence.js";
import {
  classifyBoardSafety,
  countBoardSafety,
  describeBoardSafetyCounts,
  type BoardSafetyEvidence,
  type BoardSafetyState,
} from "../safety-classifier.js";

const NOW = 1_756_000_000_000;
const FETCHED = NOW - 10_000;
const EXPIRES = NOW + 50_000;

function pct(value: number, unit: BoardPercent["unit"] = "percent"): BoardPercent {
  return { raw: String(value), normalizedPct: value, unit };
}

function goPlusClean(): BoardGoPlusFlags {
  return {
    isHoneypot: false,
    isOpenSource: true,
    isProxy: false,
    isMintable: false,
    isBlacklisted: false,
    transferPausable: false,
    hiddenOwner: false,
    canTakeBackOwnership: false,
    cannotSellAll: false,
    slippageModifiable: false,
    buyTaxPct: pct(0),
    sellTaxPct: pct(0),
    ownerShare: pct(1.2),
    creatorShare: pct(0.4),
  };
}

function quickIntelClean(): BoardQuickIntelFlags {
  return {
    contractVerified: true,
    isScam: false,
    isHoneypot: false,
    isProxy: false,
    hiddenOwner: false,
    canMint: false,
    canBlacklist: false,
    canPauseTrading: false,
    hasFeeWarning: false,
    hasExternalContractRisk: false,
    hasGeneralVulnerabilities: false,
    hasObfuscatedAddressRisk: false,
    buyTaxPct: pct(0),
    sellTaxPct: pct(0),
    transferTaxPct: pct(0),
    lpBurnedPct: pct(99.99),
  };
}

/** A complete, verified, entirely clean document: the only shape that is green. */
function cleanBundle(): BoardDetailsBundle {
  return {
    subject: { chain: "ethereum", pairAddress: "0x80BF6573d7b16c049E449D67017a7bE2DA8B429E" },
    baseTokenAddress: "0xabc0000000000000000000000000000000000001",
    baseTokenSymbol: "ETHCATE",
    holders: { count: 1358, source: "goplus", shareUnit: "fraction" },
    liquidityLocks: {
      // Measured on ethereum and solana: the ONLY lock row was tagged Burned
      // and `lockedPct` is exactly that burn (probe C2).
      lockedPct: pct(99.99),
      rows: [{ tag: "Burned", share: pct(99.99) }],
    },
    safety: {
      coverage: { state: "complete", presentBlocks: ["security.goplus", "security.quickintel"], absentBlocks: [] },
      goplus: goPlusClean(),
      quickintel: quickIntelClean(),
      tokenAuthority: null,
      conflicts: [],
    },
    auditedTokenCheck: {
      auditedTokenAddress: "0xabc0000000000000000000000000000000000001",
      auditedTokenSymbol: "ETHCATE",
      addressesAgree: true,
      symbolsAgree: true,
      mismatch: false,
    },
    providerWindow: { cacheMaxAgeSeconds: 60, cacheAgeSeconds: 5 },
    fetchedAtMs: FETCHED,
    expiresAtMs: EXPIRES,
    metaIds: [],
  };
}

/**
 * Evidence built through the REAL chain: the wire bundle, the check projector,
 * then the classifier. A fixture that skipped the projector would prove the
 * table and nothing about the arithmetic that feeds it.
 */
function evidence(
  bundle: BoardDetailsBundle | null,
  overrides: Partial<BoardSafetyEvidence> = {},
): BoardSafetyEvidence {
  return {
    lastGood: bundle === null ? null : lastGoodFromBundle(bundle),
    lastAttempt: { status: "ok", atMs: NOW },
    lastGoodExpired: false,
    ...overrides,
  };
}

describe("the fixtures are valid against the wire contract", () => {
  it("parses the clean bundle through its own schema", () => {
    // A fixture that could not cross the IPC boundary would prove nothing
    // about production behaviour.
    expect(boardDetailsBundleSchema.safeParse(cleanBundle()).success).toBe(true);
  });
});

describe("row 1 - pending", () => {
  it("is pending while a first read is in flight and nothing has landed", () => {
    const verdict = classifyBoardSafety(
      evidence(null, { lastAttempt: { status: "in-flight" } }),
    );
    expect(verdict).toMatchObject({ state: "pending", row: 1 });
  });

  it("is NOT pending once a bundle exists, even while a refresh is in flight", () => {
    const verdict = classifyBoardSafety(
      evidence(cleanBundle(), { lastAttempt: { status: "in-flight" } }),
    );
    expect(verdict.state).toBe("clear");
  });
});

describe("row 2 - unavailable", () => {
  it("is unavailable when the last attempt failed and nothing ever landed", () => {
    const verdict = classifyBoardSafety(
      evidence(null, {
        lastAttempt: { status: "failed", atMs: NOW, reason: "transport" },
      }),
    );
    expect(verdict).toMatchObject({ state: "unavailable", row: 2 });
  });
});

describe("row 3 - not-indexed", () => {
  it("is not-indexed when the provider says it does not know this pair", () => {
    const verdict = classifyBoardSafety(
      evidence(null, {
        lastAttempt: { status: "failed", atMs: NOW, reason: "not-indexed" },
      }),
    );
    expect(verdict).toMatchObject({ state: "not-indexed", row: 3 });
  });
});

describe("row 4 - incomplete", () => {
  it("is incomplete for a 200 whose analysis blocks are all empty", () => {
    // allBlocksNull: a well-formed document that says nothing. This must never
    // render as a clean result.
    const bundle: BoardDetailsBundle = {
      ...cleanBundle(),
      liquidityLocks: null,
      safety: {
        coverage: {
          state: "not_indexed",
          presentBlocks: [],
          absentBlocks: ["security.goplus", "security.quickintel", "holders.native"],
        },
        goplus: null,
        quickintel: null,
        tokenAuthority: null,
        conflicts: [],
      },
      auditedTokenCheck: {
        auditedTokenAddress: null,
        auditedTokenSymbol: null,
        addressesAgree: null,
        symbolsAgree: null,
        mismatch: false,
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "incomplete", row: 4 });
    expect(verdict.reasons).toContain("isHoneypot");
  });

  it("is incomplete on solana, where security.* was measured ABSENT for a live trending pool", () => {
    // Probe P1: this is the ORDINARY solana answer, not an edge case. The chip
    // is neutral, never green.
    const bundle: BoardDetailsBundle = {
      ...cleanBundle(),
      subject: { chain: "solana", pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU" },
      holders: { count: 20507, source: "dexscreener", shareUnit: "percent" },
      safety: {
        coverage: {
          state: "partial",
          presentBlocks: ["holders.native", "liquidityLocks"],
          absentBlocks: ["security.goplus", "security.quickintel"],
        },
        goplus: null,
        quickintel: null,
        tokenAuthority: { solanaMintable: false, solanaFreezable: false, solanaBridgeMintOnly: false },
        conflicts: [],
      },
      auditedTokenCheck: {
        auditedTokenAddress: null,
        auditedTokenSymbol: null,
        addressesAgree: null,
        symbolsAgree: null,
        mismatch: false,
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "incomplete", row: 4 });
  });

  it("is incomplete, not clear, when a REQUIRED check went unanswered and the rest is clean", () => {
    // One auditor answered and everything it said was clean; the other did not
    // answer at all. An absent block is unknown, never clean. Measured: 5 to 7
    // of 11 blocks answered on every probed chain, so this is the common shape.
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        quickintel: null,
        coverage: {
          state: "partial",
          presentBlocks: ["security.goplus"],
          absentBlocks: ["security.quickintel"],
        },
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "incomplete", row: 4 });
    // And it is caught BELOW the flag rows, so a honeypot the one auditor did
    // see is still reported as high risk rather than hidden behind coverage.
    expect(verdict.reasons).toContain("contractVerified");
  });
});

describe("row 5 - identity mismatch", () => {
  it("outranks every flag, because the flags belong to a different token", () => {
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), isHoneypot: true },
      },
      auditedTokenCheck: {
        auditedTokenAddress: "0xdead000000000000000000000000000000009999",
        auditedTokenSymbol: "COPYCAT",
        addressesAgree: false,
        symbolsAgree: null,
        mismatch: true,
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "identity-mismatch", row: 5 });
  });
});

describe("row 6 - conflict", () => {
  it("is a conflict when the two providers contradict each other on a hard flag", () => {
    const clean = cleanBundle();
    const conflict: BoardSafetyConflict = {
      field: "isHoneypot",
      goplus: true,
      quickintel: false,
      hard: true,
    };
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), isHoneypot: true },
        conflicts: [conflict],
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "conflict", row: 6 });
    expect(verdict.reasons).toEqual(["isHoneypot"]);
  });

  it("does not treat a SOFT disagreement as a conflict state", () => {
    // `canBlacklist` disagreed on ethereum in the live probe. It is a real
    // divergence and it is listed, but it is not the same fact as the two
    // auditors contradicting each other about a honeypot.
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        quickintel: { ...quickIntelClean(), canBlacklist: true },
        conflicts: [
          { field: "canBlacklist", goplus: false, quickintel: true, hard: false },
        ],
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict.state).toBe("flagged");
    expect(verdict.row).toBe(7);
  });
});

describe("row 7 - hard flags", () => {
  it.each([
    // BOTH auditors, deliberately: one saying honeypot while the other says
    // no is a CONFLICT (row 6), which has its own case below.
    ["an agreed honeypot", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: {
        ...b.safety,
        goplus: { ...goPlusClean(), isHoneypot: true },
        quickintel: { ...quickIntelClean(), isHoneypot: true },
      },
    }), "goplus.isHoneypot"],
    ["scam", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: { ...b.safety, quickintel: { ...quickIntelClean(), isScam: true } },
    }), "quickintel.isScam"],
    ["cannot sell all", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: { ...b.safety, goplus: { ...goPlusClean(), cannotSellAll: true } },
    }), "goplus.cannotSellAll"],
    ["obfuscated address risk", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: {
        ...b.safety,
        quickintel: { ...quickIntelClean(), hasObfuscatedAddressRisk: true },
      },
    }), "quickintel.hasObfuscatedAddressRisk"],
    ["solana bridge mint only", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: {
        ...b.safety,
        tokenAuthority: {
          solanaMintable: false,
          solanaFreezable: false,
          solanaBridgeMintOnly: true,
        },
      },
    }), "tokenAuthority.solanaBridgeMintOnly"],
  ])("flags %s", (_label, mutate, reason) => {
    const verdict = classifyBoardSafety(evidence(mutate(cleanBundle())));
    expect(verdict).toMatchObject({ state: "flagged", row: 7 });
    expect(verdict.reasons).toContain(reason);
  });

  it("treats a tax AT the hard threshold as hard, and one below it as risk", () => {
    const clean = cleanBundle();
    const atHard: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), buyTaxPct: pct(TAX_HARD_PCT) },
      },
    };
    expect(classifyBoardSafety(evidence(atHard))).toMatchObject({ state: "flagged" });
    expect(classifyBoardSafety(evidence(atHard)).reasons).toContain("goplus.buyTax");
    const justUnder: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), buyTaxPct: pct(TAX_HARD_PCT - 0.01) },
      },
    };
    // Under the hard threshold but over the risk one: still a failing check,
    // and it is the ELEVATED check id that names why.
    expect(classifyBoardSafety(evidence(justUnder)).reasons).toContain(
      "goplus.buyTaxElevated",
    );
  });
});

describe("row 8 - risk flags", () => {
  it.each([
    ["mintable", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: { ...b.safety, goplus: { ...goPlusClean(), isMintable: true } },
    }), "goplus.canMint"],
    ["solana freezable", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: {
        ...b.safety,
        tokenAuthority: {
          solanaMintable: false,
          solanaFreezable: true,
          solanaBridgeMintOnly: false,
        },
      },
    }), "tokenAuthority.solanaFreezable"],
    ["pausable trading", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: { ...b.safety, quickintel: { ...quickIntelClean(), canPauseTrading: true } },
    }), "quickintel.canPauseTrading"],
    ["hidden owner", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: { ...b.safety, goplus: { ...goPlusClean(), hiddenOwner: true } },
    }), "goplus.hiddenOwner"],
    ["proxy", (b: BoardDetailsBundle): BoardDetailsBundle => ({
      ...b,
      safety: { ...b.safety, goplus: { ...goPlusClean(), isProxy: true } },
    }), "goplus.isProxy"],
  ])("flags %s", (_label, mutate, reason) => {
    // A11 states the hard flags and the owner-power flags as two rows; both
    // resolve to the same chip, so the classifier reports the merged row.
    const verdict = classifyBoardSafety(evidence(mutate(cleanBundle())));
    expect(verdict).toMatchObject({ state: "flagged", row: 7 });
    expect(verdict.reasons).toContain(reason);
  });

  it("flags owner concentration AT the threshold and clears one step below it", () => {
    const clean = cleanBundle();
    const at: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), ownerShare: pct(CONCENTRATION_PCT) },
      },
    };
    expect(classifyBoardSafety(evidence(at))).toMatchObject({ state: "flagged", row: 7 });
    const under: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), ownerShare: pct(CONCENTRATION_PCT - 0.01) },
      },
    };
    expect(classifyBoardSafety(evidence(under)).state).toBe("clear");
  });

  it("never compares a concentration whose unit could not be established", () => {
    // A share that might be 25 or 0.25 is not evidence of concentration. It
    // reaches the unverified row instead of being compared as a number.
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: {
          ...goPlusClean(),
          ownerShare: { raw: "25", normalizedPct: 25, unit: "unverified" },
        },
      },
    };
    expect(classifyBoardSafety(evidence(bundle))).toMatchObject({
      state: "unverified",
      row: 9,
    });
  });
});

describe("row 9 - unverified", () => {
  it("fires on a decision percent whose unit is unverified (fixture: lpBurnedPct)", () => {
    // The one field the endpoint documents in this state, and the reason this
    // row is DEFENSIVE: no probe observed lockedPct arriving unverified.
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        quickintel: {
          ...quickIntelClean(),
          lpBurnedPct: { raw: "99.99", normalizedPct: null, unit: "unverified" },
        },
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "unverified", row: 9 });
    expect(verdict.reasons).toContain("quickintel.lpBurnedPct");
  });

  it("fires on an unverified lock share, the field the plan cares about", () => {
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      liquidityLocks: {
        lockedPct: { raw: "89", normalizedPct: null, unit: "unverified" },
        rows: [{ tag: "Locked", share: null }],
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "unverified", row: 9 });
    expect(verdict.reasons).toContain("dexscreener.lockedPct");
  });

  it("fires on an unverified contract with zero flags", () => {
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        quickintel: { ...quickIntelClean(), contractVerified: false },
      },
    };
    expect(classifyBoardSafety(evidence(bundle))).toMatchObject({
      state: "unverified",
      row: 9,
    });
  });

  it("fires when the provider never stated which token it analysed", () => {
    // An unstated subject is an UNVERIFIED subject, not a verified one.
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      auditedTokenCheck: {
        auditedTokenAddress: null,
        auditedTokenSymbol: null,
        addressesAgree: null,
        symbolsAgree: null,
        mismatch: false,
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(verdict).toMatchObject({ state: "unverified", row: 9 });
    expect(verdict.reasons).toContain("auditedToken");
  });

  it("ranks BELOW a hard flag: a honeypot with an unverified share is flagged", () => {
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      liquidityLocks: {
        lockedPct: { raw: "89", normalizedPct: null, unit: "unverified" },
        rows: [],
      },
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), isHoneypot: true },
        quickintel: { ...quickIntelClean(), isHoneypot: true },
      },
    };
    expect(classifyBoardSafety(evidence(bundle))).toMatchObject({
      state: "flagged",
      row: 7,
    });
  });
});

describe("row 10 - stale", () => {
  it("is stale when the bundle is past its freshness AND the refresh failed", () => {
    const bundle = cleanBundle();
    const verdict = classifyBoardSafety(
      evidence(bundle, {
        lastGoodExpired: true,
        lastAttempt: {
          status: "failed",
          atMs: bundle.expiresAtMs + 1,
          reason: "transport",
        },
      }),
    );
    expect(verdict).toMatchObject({ state: "stale", row: 10 });
  });

  it("is NOT stale past its freshness while nothing has failed", () => {
    // Expiry alone means the entry may be re-read, not that the reader is
    // looking at something that could not be refreshed.
    const bundle = cleanBundle();
    expect(
      classifyBoardSafety(evidence(bundle, { lastGoodExpired: true })).state,
    ).toBe("clear");
  });

  it("is NOT stale when a failure follows a bundle that is still fresh", () => {
    const bundle = cleanBundle();
    expect(
      classifyBoardSafety(
        evidence(bundle, {
          lastAttempt: { status: "failed", atMs: NOW, reason: "transport" },
        }),
      ).state,
    ).toBe("clear");
  });

  it("ranks BELOW the flag rows: a stale honeypot is still flagged", () => {
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), isHoneypot: true },
        quickintel: { ...quickIntelClean(), isHoneypot: true },
      },
    };
    expect(
      classifyBoardSafety(
        evidence(bundle, {
          lastGoodExpired: true,
          lastAttempt: {
            status: "failed",
            atMs: bundle.expiresAtMs + 1,
            reason: "transport",
          },
        }),
      ),
    ).toMatchObject({ state: "flagged", row: 7 });
  });
});

describe("row 11 - clear", () => {
  it("is the only row that produces green", () => {
    expect(classifyBoardSafety(evidence(cleanBundle()))).toMatchObject({
      state: "clear",
      row: 11,
    });
  });

  it("clears a tax exactly AT the risk threshold", () => {
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), buyTaxPct: pct(TAX_RISK_PCT) },
      },
    };
    expect(classifyBoardSafety(evidence(bundle)).state).toBe("clear");
  });

  it("does not clear a tax one step past the risk threshold", () => {
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), buyTaxPct: pct(TAX_RISK_PCT + 0.01) },
      },
    };
    expect(classifyBoardSafety(evidence(bundle))).toMatchObject({
      state: "flagged",
      row: 7,
    });
  });

  it("clears a pool whose LP lock block is absent, which two of four chains showed", () => {
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = { ...clean, liquidityLocks: null };
    expect(classifyBoardSafety(evidence(bundle)).state).toBe("clear");
  });
});

describe("the count accounting", () => {
  const cases: readonly [BoardSafetyState, "clean" | "high-risk" | "unchecked"][] = [
    ["clear", "clean"],
    ["flagged", "high-risk"],
    ["conflict", "high-risk"],
    ["identity-mismatch", "high-risk"],
    ["pending", "unchecked"],
    ["unverified", "unchecked"],
    ["not-indexed", "unchecked"],
    ["incomplete", "unchecked"],
    ["unavailable", "unchecked"],
    ["stale", "unchecked"],
  ];

  it("puts every state in exactly one bucket, and unknown pools stay counted", () => {
    const counts = countBoardSafety(cases.map(([state]) => state));
    expect(counts.total).toBe(cases.length);
    expect(counts.clean + counts.highRisk + counts.unchecked).toBe(cases.length);
    expect(counts.clean).toBe(1);
    expect(counts.highRisk).toBe(3);
    expect(counts.unchecked).toBe(6);
  });

  it("writes the chat card's sentence, omitting empty buckets only", () => {
    expect(
      describeBoardSafetyCounts(countBoardSafety(["clear", "clear", "clear", "flagged", "flagged"])),
    ).toBe("3 clean checks - 2 high risk");
    expect(describeBoardSafetyCounts(countBoardSafety(["clear"]))).toBe("1 clean check");
    expect(
      describeBoardSafetyCounts(countBoardSafety(["clear", "incomplete", "flagged"])),
    ).toBe("1 clean check - 1 high risk - 1 unchecked");
  });

  it("returns null rather than an empty sentence for an empty board", () => {
    expect(describeBoardSafetyCounts(countBoardSafety([]))).toBeNull();
  });
});

describe("the New pair chip is visual precedence only", () => {
  it("shows below the threshold and not at it", () => {
    expect(showsNewPairChip(NEW_PAIR_SECONDS - 1)).toBe(true);
    expect(showsNewPairChip(NEW_PAIR_SECONDS)).toBe(false);
    expect(showsNewPairChip(null)).toBe(false);
  });

  it("does not change the classifier state or the counters", () => {
    // A new pair that is a honeypot still counts as high risk even though its
    // card wears the amber chip.
    const clean = cleanBundle();
    const bundle: BoardDetailsBundle = {
      ...clean,
      safety: {
        ...clean.safety,
        goplus: { ...goPlusClean(), isHoneypot: true },
        quickintel: { ...quickIntelClean(), isHoneypot: true },
      },
    };
    const verdict = classifyBoardSafety(evidence(bundle));
    expect(showsNewPairChip(120)).toBe(true);
    expect(countBoardSafety([verdict.state]).highRisk).toBe(1);
  });
});

describe("boardSafetyEvidenceFrom - combining a new outcome with what is held", () => {
  it("maps a details outcome to a lastGood bundle", () => {
    const bundle = cleanBundle();
    const built = boardSafetyEvidenceFrom({
      outcome: { kind: "details", bundle },
      nowMs: NOW,
    });
    expect(classifyBoardSafety(built).state).toBe("clear");
  });

  it("maps an absent outcome to a settled not-indexed attempt", () => {
    const built = boardSafetyEvidenceFrom({
      outcome: { kind: "absent", reason: "unknown_pair" },
      nowMs: NOW,
    });
    expect(classifyBoardSafety(built)).toMatchObject({ state: "not-indexed", row: 3 });
  });

  it("maps an unavailable outcome to a failed attempt", () => {
    const built = boardSafetyEvidenceFrom({
      outcome: { kind: "unavailable", reason: "transport" },
      nowMs: NOW,
    });
    expect(classifyBoardSafety(built)).toMatchObject({ state: "unavailable", row: 2 });
  });

  it("NEVER discards the bundle on screen when a refresh fails", () => {
    // The case the two-fact evidence model exists for. Dropping the old bundle
    // would force a choice between showing nothing and lying about the age.
    const bundle = cleanBundle();
    const built = boardSafetyEvidenceFrom({
      outcome: { kind: "unavailable", reason: "provider" },
      previous: lastGoodFromBundle(bundle),
      previousExpiresAtMs: bundle.expiresAtMs,
      nowMs: bundle.expiresAtMs + 1,
    });
    expect(built.lastGood).not.toBeNull();
    expect(classifyBoardSafety(built)).toMatchObject({ state: "stale", row: 10 });
  });

  it("reports a reader's own cancellation as aborted, never as a provider problem", () => {
    const built = boardSafetyEvidenceFrom({
      outcome: { kind: "unavailable", reason: "cancelled" },
      nowMs: NOW,
    });
    expect(built.lastAttempt).toMatchObject({ status: "failed", reason: "aborted" });
  });
});
