/**
 * The execution snapshot: what a curve quote SEALS, and every way an execute is
 * refused for proposing something else.
 *
 * This suite walks the money-path authority table row by row. Each `it` below
 * corresponds to one row the brief marks "revalidated pre-sign", and asserts the
 * refusal is BY NAME - a refusal that does not say which figure moved is not
 * actionable, and "re-quote" without a reason is how an agent re-quotes into the
 * same wall.
 */

import { describe, expect, it } from "vitest";

import {
  antiSniperBoundExceededRefusal,
  compareVirtualsExecutionInputs,
  digestVirtualsSnapshot,
  isVirtualsRouteRef,
  restoreVirtualsSnapshot,
  sealVirtualsSnapshot,
  virtualsCardFacts,
  VIRTUALS_QUOTE_BINDING_CARD_VERSION,
  VIRTUALS_SNAPSHOT_VERSION,
  type VirtualsExecutionInputs,
  type VirtualsSnapshotFields,
} from "@vex-agent/tools/protocols/quote-authority/virtuals.js";
import { readQuoteBindingPreview, renderQuoteBinding } from "@vex-agent/tools/protocols/quote-authority/restore.js";

const TOKEN = { address: "0x1984edF491D3399FBc09E6d0856E01fF3721f952", symbol: "CULTOS", decimals: 18 };
const VIRTUAL = { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", symbol: "VIRTUAL", decimals: 18 };

function buyFields(overrides: Partial<VirtualsSnapshotFields> = {}): VirtualsSnapshotFields {
  return {
    v: VIRTUALS_SNAPSHOT_VERSION,
    provider: "virtuals",
    chainId: 8453,
    side: "buy",
    token: TOKEN,
    virtual: VIRTUAL,
    pair: "0x3e11e685a056048C2dFa1c0dc1E1D0F233DbA84a",
    bondingV5Implementation: "0x20C124e13069889633FC4212e0797c95cb30Db40",
    frouterV3Implementation: "0x58377381523e86d66F9f29016371335dDcB89d32",
    totalInRaw: "500000000000000000",
    curveAmountRaw: "498750000000000000",
    fee: {
      disposition: "charged_on_input",
      amountRaw: "1250000000000000",
      receiver: "0xe341f3da256C38356bce4Afd456d7fa36E356E94",
      bps: 25,
      disclosureText: "Vex charges 25 bps of the VIRTUAL you commit.",
    },
    taxes: { protocolTaxPct: 1, effectiveAntiSniperPct: 0, antiSniperType: 0, acceptedAntiSniperPct: null },
    quotedOutRaw: "5703628764027853216296",
    contractFloorRaw: "5646592476387574684133",
    walletNetMinRaw: null,
    slippageBps: 100,
    expiresAt: "2026-09-04T22:00:00.000Z",
    ...overrides,
  };
}

function sellFields(): VirtualsSnapshotFields {
  return buyFields({
    side: "sell",
    totalInRaw: "10000000000000000000000",
    curveAmountRaw: "10000000000000000000000",
    fee: {
      disposition: "charged_on_settled_output",
      amountRaw: "2169702031074365",
      receiver: "0xe341f3da256C38356bce4Afd456d7fa36E356E94",
      bps: 25,
      disclosureText: "Vex charges 25 bps of the VIRTUAL you receive.",
    },
    quotedOutRaw: "876647285282572930",
    contractFloorRaw: "867880812429747200",
    walletNetMinRaw: "859202004305449728",
  });
}

function inputsFrom(fields: VirtualsSnapshotFields): VirtualsExecutionInputs {
  return {
    chainId: fields.chainId,
    side: fields.side,
    token: fields.token,
    virtual: fields.virtual,
    pair: fields.pair,
    bondingV5Implementation: fields.bondingV5Implementation,
    frouterV3Implementation: fields.frouterV3Implementation,
    totalInRaw: fields.totalInRaw,
    curveAmountRaw: fields.curveAmountRaw,
    fee: fields.fee,
    taxes: fields.taxes,
  };
}

describe("sealing and restoring", () => {
  it("round-trips a sealed snapshot through the durable shape", () => {
    const sealed = sealVirtualsSnapshot(buyFields());
    const restored = restoreVirtualsSnapshot(JSON.parse(JSON.stringify(sealed)));
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.snapshot.digest).toBe(sealed.digest);
  });

  it("digests the CONTENT, so any bound field changes the digest", () => {
    const baseline = digestVirtualsSnapshot(buyFields());
    const moved: Array<[string, VirtualsSnapshotFields]> = [
      ["floor", buyFields({ contractFloorRaw: "1" })],
      ["fee amount", buyFields({ fee: { ...buyFields().fee, amountRaw: "1" } as VirtualsSnapshotFields["fee"] })],
      ["protocol tax", buyFields({ taxes: { ...buyFields().taxes, protocolTaxPct: 2 } })],
      ["accepted bound", buyFields({ taxes: { ...buyFields().taxes, acceptedAntiSniperPct: 40 } })],
      ["implementation", buyFields({ bondingV5Implementation: "0x0000000000000000000000000000000000000001" })],
      ["side", sellFields()],
      ["slippage", buyFields({ slippageBps: 300 })],
      ["expiry", buyFields({ expiresAt: "2026-09-05T00:00:00.000Z" })],
    ];
    for (const [what, fields] of moved) {
      expect(digestVirtualsSnapshot(fields), `${what} must move the digest`).not.toBe(baseline);
    }
  });

  it("refuses a row whose digest no longer covers its own contents", () => {
    const sealed = sealVirtualsSnapshot(buyFields());
    const tampered = { ...sealed, contractFloorRaw: "1" };
    const restored = restoreVirtualsSnapshot(tampered);
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.refusal.kind).toBe("digest_mismatch");
  });

  it("refuses an older snapshot format BY NAME rather than as unreadable", () => {
    const restored = restoreVirtualsSnapshot({ ...sealVirtualsSnapshot(buyFields()), v: 0 });
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.refusal.kind).toBe("snapshot_version_unsupported");
  });

  it("refuses a missing or structurally wrong row", () => {
    expect(restoreVirtualsSnapshot(null)).toMatchObject({ ok: false, refusal: { kind: "missing_snapshot" } });
    expect(restoreVirtualsSnapshot({ provider: "virtuals", v: 1 })).toMatchObject({
      ok: false, refusal: { kind: "snapshot_unreadable" },
    });
  });

  it("recognises its own rows and no other venue's", () => {
    expect(isVirtualsRouteRef(sealVirtualsSnapshot(buyFields()))).toBe(true);
    expect(isVirtualsRouteRef({ provider: "uniswap" })).toBe(false);
    expect(isVirtualsRouteRef(null)).toBe(false);
  });

  it("points every refusal at THIS venue's quote tool", () => {
    const restored = restoreVirtualsSnapshot(null);
    if (!restored.ok) expect(restored.refusal.message).toContain("virtuals__agent_trade_quote");
  });
});

describe("compareVirtualsExecutionInputs - the pre-sign authority walk", () => {
  const snapshot = sealVirtualsSnapshot(buyFields());

  it("passes when the execute resolved exactly what the quote sealed", () => {
    expect(compareVirtualsExecutionInputs(snapshot, inputsFrom(buyFields()))).toBeNull();
  });

  it("refuses an UPGRADED proxy first, before anything else it might explain", () => {
    const fresh = { ...inputsFrom(buyFields()), bondingV5Implementation: "0x0000000000000000000000000000000000000009" };
    const drift = compareVirtualsExecutionInputs(snapshot, fresh);
    expect(drift?.kind).toBe("implementation_changed");
    expect(drift?.message).toMatch(/upgraded/);
  });

  it("refuses the other proxy just as hard", () => {
    const fresh = { ...inputsFrom(buyFields()), frouterV3Implementation: "0x0000000000000000000000000000000000000009" };
    expect(compareVirtualsExecutionInputs(snapshot, fresh)?.kind).toBe("implementation_changed");
  });

  it("refuses a side flip - a buy quote can never authorize a sell", () => {
    const drift = compareVirtualsExecutionInputs(snapshot, inputsFrom(sellFields()));
    expect(drift?.kind).toBe("side_changed");
  });

  it("refuses a changed pair, token or chain", () => {
    for (const fresh of [
      { ...inputsFrom(buyFields()), chainId: 4663 },
      { ...inputsFrom(buyFields()), pair: "0x0000000000000000000000000000000000000002" },
      { ...inputsFrom(buyFields()), token: { ...TOKEN, address: "0x0000000000000000000000000000000000000003" } },
    ]) {
      expect(compareVirtualsExecutionInputs(snapshot, fresh)?.kind).toBe("pair_changed");
    }
  });

  it("refuses a changed amount and NAMES both figures", () => {
    const fresh = { ...inputsFrom(buyFields()), curveAmountRaw: "1" };
    const drift = compareVirtualsExecutionInputs(snapshot, fresh);
    expect(drift?.kind).toBe("amount_changed");
    expect(drift?.message).toContain("498750000000000000");
    expect(drift?.message).toContain("now 1");
  });

  it("refuses a fee that resolved differently, in either direction", () => {
    const appeared = {
      ...inputsFrom(buyFields()),
      fee: { disposition: "not_charged", amountRaw: null, receiver: buyFields().fee.receiver, bps: 0, disclosureText: "none" },
    } as VirtualsExecutionInputs;
    expect(compareVirtualsExecutionInputs(snapshot, appeared)?.kind).toBe("fee_changed");

    const redirected = {
      ...inputsFrom(buyFields()),
      fee: { ...buyFields().fee, receiver: "0x000000000000000000000000000000000000dEaD" },
    } as VirtualsExecutionInputs;
    expect(compareVirtualsExecutionInputs(snapshot, redirected)?.kind).toBe("fee_changed");
  });

  it("refuses a changed accepted anti-sniper BOUND on its own", () => {
    const fresh = {
      ...inputsFrom(buyFields()),
      taxes: { ...buyFields().taxes, acceptedAntiSniperPct: 40 },
    };
    const drift = compareVirtualsExecutionInputs(snapshot, fresh);
    expect(drift?.kind).toBe("anti_sniper_bound_changed");
  });

  it("refuses a changed protocol tax or anti-sniper TYPE", () => {
    for (const taxes of [
      { ...buyFields().taxes, protocolTaxPct: 5 },
      { ...buyFields().taxes, antiSniperType: 4 },
    ]) {
      const drift = compareVirtualsExecutionInputs(snapshot, { ...inputsFrom(buyFields()), taxes });
      expect(drift?.kind).toBe("tax_changed");
    }
  });

  it("does NOT refuse a decayed anti-sniper percent - that is expected, not drift", () => {
    // The anti-sniper tax falls every second inside its window. Refusing on the
    // change itself would make every quote unexecutable; the question the lane
    // asks is whether it is still inside the ACCEPTED BOUND, which is a
    // different check with its own refusal.
    const fresh = {
      ...inputsFrom(buyFields()),
      taxes: { ...buyFields().taxes, effectiveAntiSniperPct: 12 },
    };
    expect(compareVirtualsExecutionInputs(snapshot, fresh)).toBeNull();
  });

  it("every refusal carries a hint that says nothing was signed and nothing re-cut", () => {
    const drift = compareVirtualsExecutionInputs(snapshot, { ...inputsFrom(buyFields()), curveAmountRaw: "1" });
    expect(drift?.hint).toMatch(/Nothing was signed/);
    expect(drift?.hint).toContain("virtuals__agent_trade_quote");
  });
});

describe("antiSniperBoundExceededRefusal", () => {
  it("states the current percent, the accepted bound and the seconds left", () => {
    const refusal = antiSniperBoundExceededRefusal({
      approvedPct: 40, currentPct: 74, side: "buy", remainingSeconds: 41,
    });
    expect(refusal.message).toContain("74%");
    expect(refusal.message).toContain("at most 40%");
    expect(refusal.hint).toContain("41s");
    expect(refusal.hint).toMatch(/decays to zero/);
  });

  it("says plainly when the caller accepted nothing at all", () => {
    const refusal = antiSniperBoundExceededRefusal({
      approvedPct: null, currentPct: 98, side: "sell", remainingSeconds: 5_000,
    });
    expect(refusal.message).toMatch(/accepted no anti-sniper tax at all/);
  });
});

describe("the approval card", () => {
  it("renders the Virtuals binding through the shared reader", () => {
    const sealed = sealVirtualsSnapshot(sellFields());
    const preview = readQuoteBindingPreview("prequote-1", JSON.parse(JSON.stringify(sealed)), sealed.expiresAt);
    expect(preview).toBeDefined();
    expect(preview?.cardVersion).toBe(VIRTUALS_QUOTE_BINDING_CARD_VERSION);
    expect(preview?.approvedMinOutRaw).toBe(sealed.contractFloorRaw);
    expect(preview?.tokenOutSymbol).toBe("VIRTUAL");
  });

  it("puts every fact a person must read on the line, whole", () => {
    const sealed = sealVirtualsSnapshot(sellFields());
    const preview = readQuoteBindingPreview("prequote-1", JSON.parse(JSON.stringify(sealed)), sealed.expiresAt)!;
    const line = renderQuoteBinding(preview);
    // The digest is never abbreviated: a shortened one asks a person to consent
    // to a fingerprint they cannot check.
    expect(line).toContain(sealed.digest);
    expect(line).toContain("curve protocol tax 1%");
    expect(line).toContain("BondingV5 implementation 0x20C124e13069889633FC4212e0797c95cb30Db40");
    expect(line).toContain("Vex fee 25 bps of the VIRTUAL you receive");
    // The sell's most misreadable number is labelled where it is shown.
    expect(line).toMatch(/ESTIMATE at the current tax, not enforced by the contract/);
    expect(line).toMatch(/GROSS VIRTUAL, BEFORE the curve's taxes/);
  });

  it("names the accepted anti-sniper bound beside the current percent", () => {
    const sealed = sealVirtualsSnapshot(
      buyFields({ taxes: { protocolTaxPct: 1, effectiveAntiSniperPct: 74, antiSniperType: 1, acceptedAntiSniperPct: 80 } }),
    );
    const facts = virtualsCardFacts(sealed);
    expect(facts.lines.join(" | ")).toContain("anti-sniper tax 74% (type 1), accepted bound 80%");
  });

  it("renders amounts exactly, with no float in the path", () => {
    const facts = virtualsCardFacts(sealVirtualsSnapshot(buyFields()));
    expect(facts.quotedOutHuman).toBe("5703.628764027853216296");
    expect(facts.contractFloorHuman).toBe("5646.592476387574684133");
  });
});
