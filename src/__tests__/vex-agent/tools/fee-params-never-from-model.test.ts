/**
 * CROSS-VENUE RULE: no fee-bearing field on any bridge or swap request may
 * originate from tool params.
 *
 * A fee the model controls, paid to an address the model chooses, is an
 * overcharge vector — and the approval preview is arguments-only, so the human
 * approving the trade never sees it. Vex's answer is uniform: an integrator /
 * referral / platform fee and its recipient are PRODUCT-OWNER CONSTANTS pinned
 * next to the venue, never derived from model or tool input.
 *
 * Precedents this test generalizes:
 *   - KyberSwap — `KYBERSWAP_FEE_BPS` / `KYBERSWAP_FEE_RECEIVER`
 *     (`src/tools/kyberswap/constants.ts`: "NEVER derived from model/tool
 *     params. A model-controllable fee is an overcharge vector.")
 *   - Jupiter — `JUPITER_SWAP_FEE_BPS` + the derived treasury ATA
 *     (`prepareFeeBearingJupiterSwap` is the ONE place they are set).
 *   - Khalani — `referrer` / `referrerFeeBps` were the outlier that DID come
 *     from tool params (up to 99.99% of the bridged amount, to any address,
 *     invisible in both the quote response and the approval preview). The
 *     surface is now removed; see `khalani/khalani-referrer-fee-rejection.test.ts`.
 *
 * This suite is the tripwire for the NEXT venue: it sweeps every model-facing
 * param surface — protocol tool manifests and the action-alias JSON schemas —
 * and fails if a fee-shaped key reappears. If a new venue legitimately needs a
 * fee knob, that is a product decision: pin it to a constant, disclose it in the
 * approval preview, and do not reopen this door.
 */

import { describe, expect, it } from "vitest";

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";

/**
 * Names that indicate a value which sets, or directs the payment of, a fee.
 * Deliberately broad — a false positive costs one line of review, a false
 * negative costs user funds.
 */
const FEE_BEARING_KEY = /fee|referr|integrator|affiliate|commission|rebate|kickback|payout|beneficiar/i;

/**
 * Keys that MATCH the pattern above but are not a fee Vex could ever charge.
 * Every entry needs a reason. Keep this list as short as the truth allows.
 */
const REVIEWED_NON_CHARGING_KEYS = new Map<string, string>([
  // Hyperliquid funding-rate/limit read + order knob — a market rate the venue
  // charges, echoed for display or bounded by the user, not a Vex fee and not a
  // payment destination.
  ["maxFeeRate", "user-set upper bound on the venue's own rate; pays nobody"],
]);

/**
 * Exemptions bound to ONE surface, spelled `<surface> :: <key>`.
 *
 * Deliberately narrower than {@link REVIEWED_NON_CHARGING_KEYS}, which exempts a
 * spelling EVERYWHERE it appears. A key can be harmless on a read tool and an
 * overcharge vector on the mutating tool that lands next to it a phase later, and
 * a name-wide exemption would let the second one through silently. Use this list
 * unless the spelling is genuinely never chargeable anywhere.
 */
const REVIEWED_NON_CHARGING_SITES = new Map<string, string>([
  // A pools.fun SCREENING FILTER, on a read-only tool: it selects launchpad rows
  // whose creator-fee stream is directed at the given wallet ("show me the
  // tokens this person earns from"). It sets no fee, directs no payment, and
  // reaches no signing path — the value goes into a provider query string and
  // comes back as rows. The pools namespace charges nothing and has no mutating
  // tool; when the launch family lands, its own params are NOT covered by this
  // entry and must face this sweep on their own.
  [
    "protocol:pools.tokens :: feeRecipientAddress",
    "read-only launchpad screening filter; sets no fee and directs no payment",
  ],
  // The S3 spotlight tool's feed selector, same spelling collision and same
  // reasoning: `feed` picks which of the three feeds inside ONE already-fetched
  // read-only provider document is projected (topBoosts | recentBoosts |
  // latestProfiles | all). It reaches no signing path, charges nothing, and
  // names no recipient. The "boost amounts" in the rows it selects are money
  // OTHER people already spent on the provider, reported as data; nothing here
  // can direct a payment of ours.
  [
    "protocol:dexscreener.spotlight :: feed",
    "read-only provider feed selector, closed enum; sets no fee and directs no payment",
  ],
]);

interface ParamSite {
  readonly surface: string;
  readonly key: string;
}

function collectProtocolParamKeys(): ParamSite[] {
  const sites: ParamSite[] = [];
  for (const tool of PROTOCOL_TOOLS) {
    for (const param of tool.params ?? []) {
      sites.push({ surface: `protocol:${tool.toolId}`, key: param.key });
    }
  }
  return sites;
}

function collectAliasParamKeys(): ParamSite[] {
  const sites: ParamSite[] = [];
  for (const alias of ACTION_ALIAS_TOOLS) {
    const schema: unknown = alias.parameters;
    if (typeof schema !== "object" || schema === null) continue;
    const properties: unknown = (schema as { properties?: unknown }).properties;
    if (typeof properties !== "object" || properties === null) continue;
    for (const key of Object.keys(properties as Record<string, unknown>)) {
      sites.push({ surface: `alias:${alias.name}`, key });
    }
  }
  return sites;
}

function offendingSites(sites: readonly ParamSite[]): ParamSite[] {
  return sites.filter(
    (site) =>
      FEE_BEARING_KEY.test(site.key)
      && !REVIEWED_NON_CHARGING_KEYS.has(site.key)
      && !REVIEWED_NON_CHARGING_SITES.has(`${site.surface} :: ${site.key}`),
  );
}

describe("the site-scoped exemption list cannot be widened by accident", () => {
  // The exemption is only as safe as the claim that justifies it: "this is a
  // read tool" is what makes a fee-shaped key harmless. If the manifest it
  // names later becomes mutating — or stops existing, leaving a stale entry
  // that silently covers nothing while looking like review — the exemption has
  // to fail rather than keep vouching for something nobody re-read.
  it("every entry names a live, read-only manifest and carries a reason", () => {
    const problems: string[] = [];
    for (const [site, reason] of REVIEWED_NON_CHARGING_SITES) {
      if (reason.trim().length === 0) {
        problems.push(`${site}: empty reason — an exemption without a stated reason is not a review`);
        continue;
      }
      const [surface, key] = site.split(" :: ");
      if (!surface?.startsWith("protocol:") || !key) {
        problems.push(`${site}: not in the "protocol:<toolId> :: <paramKey>" form`);
        continue;
      }
      const toolId = surface.slice("protocol:".length);
      const manifest = PROTOCOL_TOOLS.find((tool) => tool.toolId === toolId);
      if (!manifest) {
        problems.push(`${site}: names no registered manifest — delete the stale entry`);
        continue;
      }
      if (manifest.mutating || manifest.actionKind !== "read") {
        problems.push(
          `${site}: ${toolId} is mutating=${manifest.mutating} actionKind=${manifest.actionKind} — `
          + "a fee-shaped param on a tool that can spend is exactly what this suite exists to catch",
        );
      }
      if (!manifest.params.some((param) => param.key === key)) {
        problems.push(`${site}: ${toolId} declares no param "${key}" — delete the stale entry`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("no fee-bearing field originates from tool params", () => {
  it("sweeps a non-trivial number of param sites (the sweep itself must not silently go empty)", () => {
    // Without this, a refactor that renames the exports would turn the whole
    // suite into a vacuous pass.
    expect(PROTOCOL_TOOLS.length).toBeGreaterThan(5);
    expect(ACTION_ALIAS_TOOLS.length).toBeGreaterThan(5);
    expect(collectProtocolParamKeys().length).toBeGreaterThan(20);
    expect(collectAliasParamKeys().length).toBeGreaterThan(20);
  });

  it("no protocol tool manifest exposes a fee-bearing param", () => {
    const offenders = offendingSites(collectProtocolParamKeys());
    expect(
      offenders.map((o) => `${o.surface} :: ${o.key}`),
      "A protocol tool exposes a fee-bearing param to the model. Pin the fee to a "
        + "product-owner constant next to the venue instead (see src/tools/kyberswap/constants.ts).",
    ).toEqual([]);
  });

  it("no action alias exposes a fee-bearing param", () => {
    const offenders = offendingSites(collectAliasParamKeys());
    expect(
      offenders.map((o) => `${o.surface} :: ${o.key}`),
      "An action alias exposes a fee-bearing param to the model. Pin the fee to a "
        + "product-owner constant next to the venue instead.",
    ).toEqual([]);
  });

  it("the Khalani bridge and quote surfaces carry no referrer knobs", () => {
    // The specific regression that motivated this rule, pinned by name on the
    // exact tools that carried it.
    for (const toolId of ["khalani.bridge", "khalani.quote.get"]) {
      const tool = PROTOCOL_TOOLS.find((t) => t.toolId === toolId);
      expect(tool, `${toolId} must exist`).toBeDefined();
      const keys = (tool?.params ?? []).map((p) => p.key);
      expect(keys).not.toContain("referrer");
      expect(keys).not.toContain("referrerFeeBps");
      // `refundTo` was removed for the SAME reason, one card later: it is a
      // fund destination the model could choose, invisible to the approving
      // human, and unprotected by prequote binding (an attacker sets the same
      // address on the quote and the execute, so the hashes collide). Vex now
      // derives it from the selected source wallet.
      expect(keys).not.toContain("refundTo");
      // The legitimate money leg must survive the removal.
      expect(keys).toContain("recipient");
    }
  });

  it("the bridge and BridgeQuote aliases carry no referrer knobs", () => {
    for (const aliasName of ["BridgeExecute", "BridgeQuote"]) {
      const alias = ACTION_ALIAS_TOOLS.find((a) => a.name === aliasName);
      expect(alias, `${aliasName} alias must exist`).toBeDefined();
      const properties = (alias?.parameters as { properties?: Record<string, unknown> })?.properties ?? {};
      expect(Object.keys(properties)).not.toContain("referrer");
      expect(Object.keys(properties)).not.toContain("referrerFeeBps");
      expect(Object.keys(properties)).toContain("recipient");
    }
  });

  it("every allowlisted fee-shaped key still carries a documented reason", () => {
    for (const [key, reason] of REVIEWED_NON_CHARGING_KEYS) {
      expect(FEE_BEARING_KEY.test(key), `${key} no longer matches the pattern — drop it`).toBe(true);
      expect(reason.length).toBeGreaterThan(15);
    }
  });
});
