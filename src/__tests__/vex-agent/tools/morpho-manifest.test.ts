/**
 * Morpho manifest surface, mirroring `pendle-manifest.test.ts`.
 *
 * Four lanes ship: MARKETS (batch 1), VAULTS (batch 2), PORTFOLIO (batch 3: one
 * wallet's positions, and the markets' transaction record), and PREVIEW (E3b-1:
 * pricing one vault operation without performing it). The tool-count
 * assertion is deliberate: a later batch adding a tool must update this list, so
 * a tool can never reach discovery without someone naming it here.
 */

import { describe, it, expect } from "vitest";
import { MORPHO_TOOLS } from "../../../vex-agent/tools/protocols/morpho/manifest.js";
import { MORPHO_HANDLERS } from "../../../vex-agent/tools/protocols/morpho/handlers.js";
import { MORPHO_MARKET_READ_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/morpho/market-reads.js";
import { MORPHO_VAULT_READ_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/morpho/vault-reads.js";
import { MORPHO_POSITION_READ_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/morpho/position-reads.js";
import { MORPHO_WALLET_READ_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/morpho/wallet-reads.js";
import { MORPHO_QUOTE_READ_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/morpho/quote-reads.js";
import { MORPHO_BORROW_EXECUTE_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/morpho/execute-borrow.js";
import { MORPHO_EXECUTE_WRITE_DISCOVERY } from "../../../vex-agent/tools/protocols/embeddings/morpho/execute-writes.js";
import {
  EXECUTE_GATE_TOOLS,
  PREQUOTE_QUOTE_TOOLS,
} from "../../../vex-agent/tools/protocols/prequote/registry.js";
import {
  PROTOCOL_NAMESPACE_ALLOWLIST,
  NAMESPACE_DEFAULTS,
  getProtocolHandler,
  getProtocolManifest,
} from "../../../vex-agent/tools/protocols/catalog.js";
import { NAMESPACE_LIFECYCLE } from "../../../vex-agent/tools/protocols/lifecycle.js";
import {
  VEX_DEFAULT_SLIPPAGE_BPS,
  VEX_MAX_SLIPPAGE_BPS,
} from "../../../vex-agent/tools/protocols/slippage-policy.js";
import { MORPHO_CHAINS, MORPHO_SUPPORTED_CHAIN_SLUGS } from "../../../tools/morpho/chains.js";
import { getKyberChains } from "../../../tools/kyberswap/chains.js";
import { listLocalChains } from "../../../tools/evm-chains/registry.js";
import { definedValue } from "../../_test-value-guards.js";

const EXPECTED_TOOL_IDS = [
  "morpho.markets.discover",
  "morpho.market.get",
  "morpho.vaults.discover",
  "morpho.vault.get",
  "morpho.positions.get",
  "morpho.markets.activity",
  "morpho.rewards.get",
  "morpho.wallet.balance",
  "morpho.vault.quote",
  "morpho.vault.deposit",
  "morpho.vault.withdraw",
  "morpho.market.quote",
  "morpho.market.supplyCollateral",
  "morpho.market.withdrawCollateral",
  "morpho.market.borrow",
  "morpho.market.repay",
  "morpho.rewards.claim",
];

/**
 * The tools that SPEND. Every read-lane assertion below excludes them by
 * name rather than by a softened predicate: a check that quietly accepts a
 * mutating tool is a check that would accept the next one by accident.
 */
const MORPHO_EXECUTE_TOOL_IDS = [
  "morpho.vault.deposit",
  "morpho.vault.withdraw",
  "morpho.market.supplyCollateral",
  "morpho.market.withdrawCollateral",
  "morpho.market.borrow",
  "morpho.market.repay",
  "morpho.rewards.claim",
];

/** Every discovery passage in the namespace, whichever lane module owns it. */
const MORPHO_DISCOVERY = {
  ...MORPHO_MARKET_READ_DISCOVERY,
  ...MORPHO_VAULT_READ_DISCOVERY,
  ...MORPHO_POSITION_READ_DISCOVERY,
  ...MORPHO_WALLET_READ_DISCOVERY,
  ...MORPHO_QUOTE_READ_DISCOVERY,
  ...MORPHO_EXECUTE_WRITE_DISCOVERY,
  ...MORPHO_BORROW_EXECUTE_DISCOVERY,
};

describe("morpho manifest", () => {
  it("declares exactly the markets, vaults, portfolio, preview and execute lanes", () => {
    expect(MORPHO_TOOLS).toHaveLength(EXPECTED_TOOL_IDS.length);
    expect(MORPHO_TOOLS.map((t) => t.toolId).sort()).toEqual([...EXPECTED_TOOL_IDS].sort());
  });

  it("marks every tool active, and every READ tool read-only and non-mutating", () => {
    for (const tool of MORPHO_TOOLS) {
      expect(tool.namespace).toBe("morpho");
      expect(tool.toolId.startsWith("morpho.")).toBe(true);
      expect(tool.lifecycle).toBe("active");
      if (MORPHO_EXECUTE_TOOL_IDS.includes(tool.toolId)) continue;
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
    }
  });

  it("marks the two EXECUTE tools mutating and as wallet broadcasts, which is what gates them", () => {
    // `mutating` is what routes a tool through the approval gate and
    // `user_wallet_broadcast` is what the taxonomy and the approval card read.
    // A spending tool that declared neither would broadcast unattended.
    for (const toolId of MORPHO_EXECUTE_TOOL_IDS) {
      const found = MORPHO_TOOLS.find((t) => t.toolId === toolId);
      expect(found, toolId).toBeDefined();
      const tool = definedValue(found, `execute tool ${toolId}`);
      expect(tool.mutating).toBe(true);
      expect(tool.actionKind).toBe("user_wallet_broadcast");
    }
  });

  it("gates BOTH execute tools on a quote, one prequote kind per direction", () => {
    // The direction split is the money-safety property: a shared kind would let
    // a deposit quote authorize a withdrawal execute on the same vault.
    expect(EXECUTE_GATE_TOOLS["morpho.vault.deposit"]).toEqual({
      kind: "lend_deposit", family: "eip155", provider: "morpho",
    });
    expect(EXECUTE_GATE_TOOLS["morpho.vault.withdraw"]).toEqual({
      kind: "lend_withdraw", family: "eip155", provider: "morpho",
    });
    expect(PREQUOTE_QUOTE_TOOLS["morpho.vault.quote"]).toEqual({
      kind: "morpho-lend", family: "eip155", provider: "morpho",
    });
  });

  it("declares no requiresEnv - the API is keyless, so gating would hide the tools", () => {
    for (const tool of MORPHO_TOOLS) expect(tool.requiresEnv).toBeUndefined();
  });

  it("has a handler registered for every manifest, and no orphan handler", () => {
    expect(Object.keys(MORPHO_HANDLERS).sort()).toEqual([...EXPECTED_TOOL_IDS].sort());
    for (const toolId of EXPECTED_TOOL_IDS) {
      expect(getProtocolManifest(toolId)).toBeDefined();
      expect(getProtocolHandler(toolId)).toBeDefined();
    }
  });

  it("declares no fee, limit or destination parameter at all", () => {
    // A read lane cannot take one, and a mutating batch must add them
    // deliberately rather than inherit a spelling from here.
    const banned = ["fee", "feeBps", "feeRecipient", "recipient", "destination", "receiver"];
    for (const tool of MORPHO_TOOLS) {
      for (const param of tool.params) expect(banned).not.toContain(param.key);
    }
  });

  it("declares an enum for every param whose prose lists accepted values", () => {
    for (const tool of MORPHO_TOOLS) {
      for (const param of tool.params) {
        if (/\bone of\b/i.test(param.description) && param.description.includes(",")) {
          expect(param.enum, `${tool.toolId}.${param.key}`).toBeDefined();
          expect(definedValue(param.enum, `${tool.toolId}.${param.key} enum`).length).toBeGreaterThan(1);
        }
      }
    }
  });

  it("ships an exampleParams containing every required key", () => {
    for (const tool of MORPHO_TOOLS) {
      for (const param of tool.params) {
        if (param.required === true) expect(tool.exampleParams).toHaveProperty(param.key);
      }
    }
  });

  it("carries an extensive description naming the APY basis rule and the listed default", () => {
    for (const tool of MORPHO_TOOLS) {
      // Well past the 120-char lint minimum, per the owner's obszerne-opisy decree.
      expect(tool.description.length).toBeGreaterThan(900);
      // The two execute tools cannot claim to be read-only; they must instead
      // say plainly that they spend, which is what the manifest lint's own
      // mutating anchor requires.
      expect(tool.description).toMatch(
        MORPHO_EXECUTE_TOOL_IDS.includes(tool.toolId) ? /SPENDS/ : /Read-only/,
      );
    }
    // The APY-basis rule is asserted on the tools that actually RETURN an APY.
    // Three tools return none at all, so requiring the sentence there would only
    // teach the next author to paste a claim the tool does not support:
    // `morpho.markets.activity` is a transaction log; `morpho.rewards.get`
    // returns claimable token AMOUNTS rather than any rate, and deliberately
    // says a reward APR is not part of the lending rate instead of quoting one;
    // `morpho.wallet.balance` is an on-chain balance and allowance read that
    // touches no rate at all.
    const NO_APY_TOOL_IDS = [
      "morpho.markets.activity",
      "morpho.rewards.get",
      "morpho.wallet.balance",
      // The two EXECUTE tools return a settlement - amounts, shares and a hash
      // - and no rate of any kind. An APY-basis sentence here would be a claim
      // about a number the reply does not contain.
      "morpho.vault.deposit",
      "morpho.vault.withdraw",
      // The preview prices ONE operation at a point in time and returns no rate
      // of any kind, so an APY-basis sentence here would be a claim the reply
      // cannot support.
      "morpho.vault.quote",
      // The CLAIM returns proven per-token credits and a hash. It names no rate
      // at all - the rewards it sweeps are balances, not an APY - so an
      // APY-basis sentence would describe a number the reply does not contain.
      "morpho.rewards.claim",
      // The BLUE MARKET lane returns a health factor, a liquidity figure and a
      // settlement - no rate at all. Its preview is a point-in-time price of one
      // operation, exactly like the vault preview above, and the four executes
      // return a proven amount and a hash.
      "morpho.market.quote",
      "morpho.market.supplyCollateral",
      "morpho.market.withdrawCollateral",
      "morpho.market.borrow",
      "morpho.market.repay",
    ];
    for (const tool of MORPHO_TOOLS) {
      if (NO_APY_TOOL_IDS.includes(tool.toolId)) continue;
      expect(tool.description, tool.toolId).toMatch(/EXCLUDE/);
      expect(tool.description, tool.toolId).toMatch(/INCLUDE/);
    }
    const discover = MORPHO_TOOLS.find((t) => t.toolId === "morpho.markets.discover");
    expect(discover?.description).toContain("297,995%");
    expect(discover?.description).toContain("REJECTED BY NAME");
  });

  it("states the vault-versus-market APY basis rule on both vault tools", () => {
    // The single most expensive confusion available in this namespace: a vault
    // APY has already had the curator fee taken out, a market APY has not.
    for (const toolId of ["morpho.vaults.discover", "morpho.vault.get"]) {
      const tool = MORPHO_TOOLS.find((t) => t.toolId === toolId);
      expect(tool?.description, toolId).toMatch(/NET of the (vault's|curator's) fee/);
      expect(tool?.description, toolId).toMatch(/GROSS/);
    }
  });

  it("surfaces the gated-vault hazard on both vault tools", () => {
    for (const toolId of ["morpho.vaults.discover", "morpho.vault.get"]) {
      const tool = MORPHO_TOOLS.find((t) => t.toolId === toolId);
      expect(tool?.description, toolId).toContain("withdrawalGated");
    }
  });

  it("grounds the vault listedOnly default in the observed test vault", () => {
    const vaults = MORPHO_TOOLS.find((t) => t.toolId === "morpho.vaults.discover");
    expect(vaults?.description).toContain("tstcntrct");
  });

  it("declares no `version` param on the vault detail read", () => {
    // Generation detection is automatic. A caller forced to guess would be told
    // a real vault does not exist when they guessed wrong.
    const get = MORPHO_TOOLS.find((t) => t.toolId === "morpho.vault.get");
    expect(get?.params.map((p) => p.key)).not.toContain("version");
  });

  it("states the preview-only contract on the quote tool, in the description and in the classification", () => {
    // The one claim that must survive every future edit to this manifest: a
    // quote commits nothing. It is asserted three ways because a description
    // sentence alone would not stop the tool being reclassified as mutating.
    const quote = MORPHO_TOOLS.find((t) => t.toolId === "morpho.vault.quote");
    expect(quote?.mutating).toBe(false);
    expect(quote?.actionKind).toBe("read");
    expect(quote?.description).toMatch(/PREVIEW AND IT COMMITS NOTHING/);
    expect(quote?.description).toMatch(/nothing is signed, nothing is sent/);
  });

  it("names the two different scales and the withdrawal-is-not-a-bundle fact on the quote tool", () => {
    const quote = MORPHO_TOOLS.find((t) => t.toolId === "morpho.vault.quote");
    // Reading a share raw amount at the asset's scale is the thousandfold error.
    expect(quote?.description).toMatch(/THE TWO SCALES ARE DIFFERENT/);
    // A withdrawal has no bundle and no price guard, and neither absence is a bug.
    expect(quote?.description).toMatch(/A DEPOSIT IS A BUNDLER3 MULTICALL; A WITHDRAWAL IS NOT/);
    // A revert before the approval exists must never be reported as a broken vault.
    expect(quote?.description).toMatch(/NOT A FAULT IN THE VAULT/);
  });

  it("surfaces the gated-vault hazard on the quote tool too, since a deposit is the act it gates", () => {
    const quote = MORPHO_TOOLS.find((t) => t.toolId === "morpho.vault.quote");
    expect(quote?.description).toMatch(/withdrawal-gated vault/);
    expect(quote?.description).toMatch(/UNKNOWN rather than absent/);
  });

  it("declares the amount pair as an ENFORCED exclusive group, not prose", () => {
    const quote = MORPHO_TOOLS.find((t) => t.toolId === "morpho.vault.quote");
    expect(quote?.exclusiveParamGroups).toEqual([["depositAmountRaw", "withdrawAmountRaw"]]);
    // Exactly-one, so neither amount may be marked required on its own.
    for (const key of ["depositAmountRaw", "withdrawAmountRaw"]) {
      expect(quote?.params.find((p) => p.key === key)?.required, key).not.toBe(true);
    }
    const direction = quote?.params.find((p) => p.key === "direction");
    expect(direction?.required).toBe(true);
    expect(direction?.enum).toEqual(["deposit", "withdraw"]);
  });

  it("writes its OWN decimals-source sentence on each raw amount, not the canonical one", () => {
    // CANONICAL_RAW_AMOUNT_SENTENCE points at `token_find` and contains an em
    // dash, which this namespace bans. Each amount must therefore name the
    // vault ASSET's decimals itself, and must not name the SHARE decimals as
    // the source, which is the wrong number sitting right next to the right one.
    const quote = MORPHO_TOOLS.find((t) => t.toolId === "morpho.vault.quote");
    for (const key of ["depositAmountRaw", "withdrawAmountRaw"]) {
      const param = quote?.params.find((p) => p.key === key);
      expect(param?.description, key).toMatch(/RAW base units/);
      expect(param?.description, key).toMatch(/asset\.decimals/);
      expect(param?.description, key).toMatch(/morpho\.vault\.get/);
      expect(param?.description, key).not.toContain("token_find");
    }
  });

  it("declares the quote slippage param as a bps number so a fractional value cannot pass", () => {
    const slippage = MORPHO_TOOLS
      .find((t) => t.toolId === "morpho.vault.quote")
      ?.params.find((p) => p.key === "slippageBps");
    expect(slippage?.type).toBe("number");
    expect(slippage?.unit).toBe("bps");
    // The default is interpolated from slippage-policy.ts, never written here.
    expect(slippage?.description).toContain(`Default ${VEX_DEFAULT_SLIPPAGE_BPS}`);
    expect(slippage?.description).toContain(`caps this at ${VEX_MAX_SLIPPAGE_BPS}`);
  });

  it("states the no-close-factor liquidation rule wherever a health factor is discussed", () => {
    // The single most expensive misreading available in this namespace: a health
    // factor just under 1 on Morpho can cost the WHOLE position, because there
    // is no close factor capping how much a liquidator may repay.
    const positions = MORPHO_TOOLS.find((t) => t.toolId === "morpho.positions.get");
    expect(positions?.description).toMatch(/NO CLOSE FACTOR/);
    expect(positions?.description).toMatch(/liquidatable RIGHT NOW/);
    expect(positions?.description).toMatch(/NULL HEALTH FACTOR MEANS NO DEBT, NOT SAFETY/);
  });

  it("states the one-wallet-per-call rule on the positions read", () => {
    const positions = MORPHO_TOOLS.find((t) => t.toolId === "morpho.positions.get");
    expect(positions?.description).toMatch(/ONE WALLET PER CALL/);
    const wallet = positions?.params.find((p) => p.key === "walletAddress");
    expect(wallet?.required).toBe(true);
    expect(wallet?.description).toMatch(/rejected by name/);
  });

  it("names the V2 position coverage gap rather than implying totality", () => {
    const positions = MORPHO_TOOLS.find((t) => t.toolId === "morpho.positions.get");
    expect(positions?.description).toMatch(/no per-user list of V2 vault\s+positions/);
    expect(positions?.description).toContain("vaultV2Coverage");
  });

  it("states the per-event asset rule and the absence of USD on activity rows", () => {
    const activity = MORPHO_TOOLS.find((t) => t.toolId === "morpho.markets.activity");
    expect(activity?.description).toMatch(/no USD figure on any transaction row/);
    expect(activity?.description).toMatch(/DEPENDS ON THE EVENT/);
    expect(activity?.description).toContain("badDebtAssets");
  });

  it("warns that a unix timestamp is seconds, not milliseconds, on both time params", () => {
    const activity = MORPHO_TOOLS.find((t) => t.toolId === "morpho.markets.activity");
    for (const key of ["since", "until"]) {
      const param = activity?.params.find((p) => p.key === key);
      expect(param?.description, key).toMatch(/SECONDS/);
      expect(param?.description, key).toMatch(/milliseconds/);
    }
  });

  it("uses no em dash anywhere in authored agent-facing text", () => {
    for (const tool of MORPHO_TOOLS) {
      expect(tool.description).not.toContain("—");
      for (const param of tool.params) expect(param.description).not.toContain("—");
    }
    for (const entry of Object.values(MORPHO_DISCOVERY)) {
      expect(entry.embeddingText).not.toContain("—");
      for (const alias of entry.aliases ?? []) expect(alias).not.toContain("—");
      for (const intent of entry.exampleIntents ?? []) expect(intent).not.toContain("—");
    }
  });

  it("binds each manifest to its own discovery passage", () => {
    for (const tool of MORPHO_TOOLS) {
      expect(tool.discovery).toBe(MORPHO_DISCOVERY[tool.toolId as keyof typeof MORPHO_DISCOVERY]);
      expect(tool.discovery?.embeddingText).toMatch(/Use when/);
      expect(tool.discovery?.embeddingText).toMatch(/Example queries:/);
      expect(tool.discovery?.chains).toEqual(MORPHO_SUPPORTED_CHAIN_SLUGS);
    }
  });
});

describe("morpho namespace registration", () => {
  it("is allowlisted, active, and classified as mixed_trading", () => {
    expect(PROTOCOL_NAMESPACE_ALLOWLIST).toContain("morpho");
    expect(NAMESPACE_LIFECYCLE["morpho"]).toBe("active");
    expect(NAMESPACE_DEFAULTS["morpho"]).toBe("mixed_trading");
  });
});

describe("morpho chain registry", () => {
  it("is exactly the intersection of Morpho's chains and Vex's own registries", () => {
    const vexChainIds = new Set<number>([
      ...getKyberChains().map((c) => c.chainId),
      ...listLocalChains().map((c) => c.id),
    ]);
    for (const chain of MORPHO_CHAINS) {
      expect(vexChainIds.has(chain.chainId), `${chain.slug} must exist in a Vex registry`).toBe(true);
    }
    expect(MORPHO_CHAINS).toHaveLength(9);
  });

  it("spells every slug exactly as the canonical KyberSwap registry does", () => {
    const kyberSlugs = new Map<number, string>(getKyberChains().map((c) => [c.chainId, c.slug]));
    for (const chain of MORPHO_CHAINS) {
      expect(chain.slug).toBe(kyberSlugs.get(chain.chainId));
    }
  });
});
