/**
 * The launch parameter boundary: what is refused, BY NAME, before any chain
 * read, any upload, any durable row and any key.
 *
 * Three families of refusal, and each is a product decision rather than
 * validation:
 *
 *  1. A caller-supplied FEE rate or receiver, rejected by name rather than
 *     dropped - a silent drop hides an attempted overcharge instead of
 *     surfacing it (rule 90).
 *  2. A caller-supplied IMAGE URL, rejected by name - the on-chain string is
 *     the content-addressed URL of bytes the user staged, and nothing else
 *     (owner I1, no mutable-URL fallback).
 *  3. A launch SHAPE this lane has no proven handler chain for, answered with
 *     a typed `unsupported` carrying the MEASURED reason (owner L1) rather than
 *     with "unknown parameter", which is a shrug.
 */

import { describe, expect, it } from "vitest";

import {
  checkForbiddenLaunchParams,
  checkUnsupportedLaunchShape,
  describeAntiSniperChoice,
  readLaunchFields,
  resolveLaunchChain,
} from "@vex-agent/tools/protocols/virtuals/handlers/launch/params.js";

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chain: "base",
    name: "Otaku Analyst",
    symbol: "otaku",
    description: "An agent that reads anime market sentiment.",
    cores: [0, 1, 2],
    amountIn: "1",
    ...overrides,
  };
}

describe("forbidden parameters", () => {
  it("rejects every fee spelling BY NAME, not silently", () => {
    for (const key of [
      "fee", "feeBps", "feeReceiver", "feeRecipient", "feeAmount",
      "vexFee", "vexFeeBps", "vexFeeReceiver", "launchFee", "protocolFee",
    ]) {
      const reason = checkForbiddenLaunchParams({ [key]: 1 });
      expect(reason, `${key} was not refused`).not.toBeNull();
      if (reason === null) throw new Error(`${key} was not refused`);
      expect(reason).toContain(`"${key}"`);
    }
  });

  it("treats PRESENCE as the violation, whatever the key carries", () => {
    // An empty string, null or an explicit undefined is still an attempted
    // override, and reading the value instead of the key is how one slips past.
    for (const value of ["", null, undefined, 0, false]) {
      expect(checkForbiddenLaunchParams({ feeBps: value })).not.toBeNull();
    }
  });

  it("rejects every caller-supplied image URL spelling BY NAME", () => {
    for (const key of ["imageUrl", "image", "imageURL", "logoUrl", "iconUrl"]) {
      const reason = checkForbiddenLaunchParams({ [key]: "https://evil.example/a.png" });
      expect(reason, `${key} was not refused`).not.toBeNull();
      if (reason === null) throw new Error(`${key} was not refused`);
      expect(reason).toContain(`"${key}"`);
      // The refusal must be ACTIONABLE: it names the two real paths.
      expect(reason).toContain("launchpads__image_publish");
      expect(reason).toContain("imagePath");
    }
  });

  it("accepts a call that carries none of them", () => {
    expect(checkForbiddenLaunchParams(validFields())).toBeNull();
  });
});

describe("launch shapes owner decision L1 closed", () => {
  it("refuses a scheduled launch with the MEASURED threshold in the reason", () => {
    const verdict = checkUnsupportedLaunchShape({ startTime: 1_788_600_000 });
    expect(verdict).not.toBeNull();
    if (verdict === null) throw new Error("expected an unsupported verdict");
    expect(verdict.feature).toBe("scheduled");
    expect(verdict.reason).toContain("86400");
    expect(verdict.reason).toContain("SCHEDULED");
  });

  it("refuses ACF with the measured fee in the reason", () => {
    const verdict = checkUnsupportedLaunchShape({ needAcf: true });
    expect(verdict).not.toBeNull();
    if (verdict === null) throw new Error("expected an unsupported verdict");
    expect(verdict.feature).toBe("acf");
    expect(verdict.reason).toContain("10 VIRTUAL");
  });

  it("refuses a non-zero airdrop and names where the supply would go", () => {
    const verdict = checkUnsupportedLaunchShape({ airdropBips: 100 });
    expect(verdict).not.toBeNull();
    if (verdict === null) throw new Error("expected an unsupported verdict");
    expect(verdict.feature).toBe("airdrop");
    expect(verdict.reason).toContain("teamTokenReservedWallet");
  });

  it("ACCEPTS an explicit zero airdrop, which is what a normal launch sends", () => {
    expect(checkUnsupportedLaunchShape({ airdropBips: 0 })).toBeNull();
  });

  it("refuses a privileged launch mode and names the check that would revert", () => {
    const verdict = checkUnsupportedLaunchShape({ launchMode: 1 });
    expect(verdict).not.toBeNull();
    if (verdict === null) throw new Error("expected an unsupported verdict");
    expect(verdict.feature).toBe("launch_mode");
    expect(verdict.reason).toContain("UnauthorizedLauncher");
  });

  it("accepts the normal immediate shape", () => {
    expect(checkUnsupportedLaunchShape({ launchMode: 0, airdropBips: 0, needAcf: false })).toBeNull();
    expect(checkUnsupportedLaunchShape({})).toBeNull();
  });
});

describe("chain resolution", () => {
  it("resolves the two chains Vex launches on", () => {
    for (const [slug, chainId] of [["base", 8453], ["robinhood", 4663]] as const) {
      const resolved = resolveLaunchChain(slug);
      expect(resolved.kind).toBe("curve");
      if (resolved.kind !== "curve") throw new Error("expected a curve deployment");
      expect(resolved.deployment.chainId).toBe(chainId);
    }
  });

  it("answers Solana with the MEASURED reason and NO tool to use instead", () => {
    // Deliberately different from the trade lane's Solana answer, which points
    // at Jupiter. There is no permissionless launch call a self-custodial
    // wallet can make there, so pointing anywhere would send an agent looking
    // for a path that does not exist.
    const resolved = resolveLaunchChain("solana");
    expect(resolved.kind).toBe("handoff");
    if (resolved.kind !== "handoff") throw new Error("expected a handoff");
    expect(resolved.useInstead).toBeNull();
    expect(resolved.reason).toContain("Meteora");
    expect(resolved.reason).toContain("BACKEND");
  });

  it("answers Ethereum with the reason it has no launch contract", () => {
    const resolved = resolveLaunchChain("ethereum");
    expect(resolved.kind).toBe("handoff");
    if (resolved.kind !== "handoff") throw new Error("expected a handoff");
    expect(resolved.useInstead).toBeNull();
    expect(resolved.reason).toContain("no launch contract");
  });

  it("names the legal set on an unknown chain", () => {
    const resolved = resolveLaunchChain("polygon");
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind !== "invalid") throw new Error("expected invalid");
    expect(resolved.reason).toContain("base");
    expect(resolved.reason).toContain("robinhood");
  });
});

describe("readLaunchFields", () => {
  it("reads a whole valid launch and keeps the amount as an exact integer", () => {
    const read = readLaunchFields(validFields());
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.reason);
    expect(read.fields.chainSlug).toBe("base");
    expect(read.fields.name).toBe("Otaku Analyst");
    // The ticker is uppercased, and the uppercased form is what is encoded.
    expect(read.fields.ticker).toBe("OTAKU");
    expect(read.fields.cores).toEqual([0, 1, 2]);
    // Exact bigint, never a float: 1 VIRTUAL at 18 decimals.
    expect(read.fields.committedRaw).toBe(1_000_000_000_000_000_000n);
    expect(read.fields.amountInText).toBe("1");
    // The venue's own default, which is what its app sends.
    expect(read.fields.antiSniperTaxType).toBe(1);
    expect(read.fields.nameSuffix).toBe("by_virtuals");
    expect(read.fields.urls).toEqual(["", "", "", ""]);
  });

  it("checks the forbidden params BEFORE anything else", () => {
    // The order is the point: a caller who tried to set the fee must learn
    // THAT, not that their chain was misspelled.
    const read = readLaunchFields({ ...validFields({ chain: "nonsense" }), feeBps: 1 });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain('"feeBps"');
  });

  it("checks the closed shapes BEFORE the chain, because no chain read can open them", () => {
    const read = readLaunchFields(validFields({ needAcf: true, chain: "nonsense" }));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.unsupported?.feature).toBe("acf");
  });

  it("refuses an amount that is not a plain decimal, and never coerces it", () => {
    for (const amountIn of ["1e18", "-1", "0", "1.2.3", "abc", "", " "]) {
      const read = readLaunchFields(validFields({ amountIn }));
      expect(read.ok, `accepted amountIn "${amountIn}"`).toBe(false);
    }
  });

  it("reads the four social slots out of `links`, in the contract's order", () => {
    const read = readLaunchFields(validFields({
      links: {
        twitter: "https://x.com/otaku",
        website: "https://otaku.example",
      },
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.reason);
    expect(read.fields.urls).toEqual(["https://x.com/otaku", "", "", "https://otaku.example/"]);
  });

  it("refuses an http social link rather than publishing the downgrade on chain", () => {
    const read = readLaunchFields(validFields({ links: { twitter: "http://x.com/otaku" } }));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain("https");
  });

  it("refuses a non-object `links` rather than ignoring it", () => {
    // A caller who passed a string believes they set a link.
    const read = readLaunchFields(validFields({ links: "https://x.com/otaku" }));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain("links must be an object");
  });

  it("accepts the anti-sniper type as a number OR the manifest's string enum", () => {
    for (const value of [4, "4"]) {
      const read = readLaunchFields(validFields({ antiSniperTaxType: value }));
      expect(read.ok, `rejected ${JSON.stringify(value)}`).toBe(true);
      if (!read.ok) throw new Error(read.reason);
      expect(read.fields.antiSniperTaxType).toBe(4);
    }
  });

  it("refuses a seventh anti-sniper type, naming the contract check", () => {
    const read = readLaunchFields(validFields({ antiSniperTaxType: 6 }));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain("isValidAntiSniperType");
  });

  it("refuses a name-suffix choice the contract has no flag for", () => {
    const read = readLaunchFields(validFields({ nameSuffix: "by_vex" }));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain("nameSuffix");
  });

  it("carries the Solana refusal through as a handoff rather than an error", () => {
    const read = readLaunchFields(validFields({ chain: "solana" }));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.handoff?.chain).toBe("solana");
  });
});

describe("describeAntiSniperChoice", () => {
  it("says which sides are taxed and for how long, in words a person can read", () => {
    expect(describeAntiSniperChoice(0)).toContain("no anti-sniper tax");
    expect(describeAntiSniperChoice(1)).toContain("buys only");
    expect(describeAntiSniperChoice(1)).toContain("60 s");
    expect(describeAntiSniperChoice(3)).toContain("sells only");
    expect(describeAntiSniperChoice(4)).toContain("buys and sells");
    expect(describeAntiSniperChoice(5)).toContain("600 s");
  });

  it("states where the tax goes, which is not to the creator", () => {
    expect(describeAntiSniperChoice(1)).toContain("not to you");
  });

  it("refuses to describe a type it does not know rather than inventing one", () => {
    expect(describeAntiSniperChoice(9)).toContain("unknown to Vex");
  });
});
