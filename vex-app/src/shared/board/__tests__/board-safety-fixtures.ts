/**
 * THE SHARED BOARD-SAFETY FIXTURES.
 *
 * ONE clean document, used by the classifier table test and by the projector's
 * own threshold test. Two hand-written "clean" bundles would be two different
 * definitions of clean, and the day they drifted the two suites would disagree
 * about the same token while both stayed green. A helper module, never a spec:
 * it declares no test of its own.
 */

import type {
  BoardDetailsBundle,
  BoardGoPlusFlags,
  BoardPercent,
  BoardQuickIntelFlags,
} from "../../schemas/board-details.js";
import type { BoardSafetyEvidence } from "../safety-classifier.js";
import { lastGoodFromBundle } from "../safety-evidence.js";

export const NOW = 1_756_000_000_000;
const FETCHED = NOW - 10_000;
const EXPIRES = NOW + 50_000;

export function pct(value: number, unit: BoardPercent["unit"] = "percent"): BoardPercent {
  return { raw: String(value), normalizedPct: value, unit };
}

export function goPlusClean(): BoardGoPlusFlags {
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

export function quickIntelClean(): BoardQuickIntelFlags {
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
export function cleanBundle(): BoardDetailsBundle {
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
export function evidence(
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
