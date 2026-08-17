/**
 * `morpho.rewards.get` - behaviour over the live-captured Merkl bodies.
 *
 * The assertions that matter here are arithmetic and honesty, in that order. The
 * claimable figure is a subtraction the provider does not perform, and the
 * attribution label is a claim the provider does not make; both are places where
 * a plausible-looking answer can be wrong in a direction nobody checks.
 */

import { describe, it, expect, vi } from "vitest";

import {
  MERKL_OPPORTUNITY_MOONWELL,
  MERKL_OPPORTUNITY_MORPHO,
  MERKL_REWARDS_CAPTURED_WALLET,
  MERKL_USER_REWARDS_BASE,
} from "./rewards-fixtures.js";
import { validateMerklOpportunity, validateMerklUserRewards } from "@tools/merkl/validation.js";
import { attributeMerklRewards } from "@tools/merkl/rewards.js";
import type { MerklClient } from "@tools/merkl/client.js";
import { morphoRewardsGet } from "@vex-agent/tools/protocols/morpho/handlers/rewards-get.js";
import { parseMorphoRewardsParams } from "@vex-agent/tools/protocols/morpho/read-params.js";

// Hoisted by vitest, so it must sit at the top level. The handler reaches for the
// process-wide client; here it gets one that answers only from the captured bodies.
vi.mock("@tools/merkl/client.js", async () => {
  const actual = await vi.importActual<typeof import("@tools/merkl/client.js")>("@tools/merkl/client.js");
  return { ...actual, getMerklClient: () => fixtureClient() };
});

const MORPHO_OPPORTUNITY_ID = "9836065204209028807";
const MOONWELL_OPPORTUNITY_ID = "7346841169498192596";

/** A client that answers only from the captured bodies. No network, ever. */
function fixtureClient(overrides: { failOpportunities?: boolean } = {}): MerklClient {
  return {
    getUserRewards: async (_wallet: string, chainId: number) =>
      validateMerklUserRewards(MERKL_USER_REWARDS_BASE, chainId),
    getOpportunity: async (id: string) => {
      if (overrides.failOpportunities === true) throw new Error("merkl refused");
      if (id === MORPHO_OPPORTUNITY_ID) return validateMerklOpportunity(MERKL_OPPORTUNITY_MORPHO);
      if (id === MOONWELL_OPPORTUNITY_ID) return validateMerklOpportunity(MERKL_OPPORTUNITY_MOONWELL);
      throw new Error(`unexpected opportunity ${id}`);
    },
  } as unknown as MerklClient;
}

describe("merkl reward validation", () => {
  it("reads the captured Base body without dropping a row", () => {
    const page = validateMerklUserRewards(MERKL_USER_REWARDS_BASE, 8453);
    expect(page.chainId).toBe(8453);
    expect(page.chainName).toBe("Base");
    expect(page.rewards).toHaveLength(3);
    expect(page.rewards.map((r) => r.token.symbol)).toEqual(["WELL", "MORPHO", "USDC"]);
  });

  it("keeps decimals beside every raw amount, at both scales in one answer", () => {
    const page = validateMerklUserRewards(MERKL_USER_REWARDS_BASE, 8453);
    expect(page.rewards[0]?.token.decimals).toBe(18);
    expect(page.rewards[2]?.token.decimals).toBe(6);
  });

  it("refuses a NUMBER-shaped amount rather than parsing a double", () => {
    const mutated = [
      {
        chain: { id: 8453, name: "Base" },
        rewards: [
          {
            amount: 27159256967843778403797,
            claimed: "0",
            pending: "0",
            token: { address: "0xa88594d404727625a9437c3f886c7643872296ae", decimals: 18, symbol: "WELL" },
            breakdowns: [],
          },
        ],
      },
    ];
    expect(validateMerklUserRewards(mutated, 8453).rewards).toHaveLength(0);
  });

  it("drops a row whose decimals are missing, because its amount is then unreadable", () => {
    const mutated = [
      {
        chain: { id: 8453, name: "Base" },
        rewards: [
          {
            amount: "1",
            claimed: "0",
            pending: "0",
            token: { address: "0xa88594d404727625a9437c3f886c7643872296ae", symbol: "WELL" },
            breakdowns: [],
          },
        ],
      },
    ];
    expect(validateMerklUserRewards(mutated, 8453).rewards).toHaveLength(0);
  });

  it("keeps a reward whose USD price is absent, because a price is display-only", () => {
    const mutated = [
      {
        chain: { id: 8453, name: "Base" },
        rewards: [
          {
            amount: "10",
            claimed: "0",
            pending: "0",
            token: { address: "0xa88594d404727625a9437c3f886c7643872296ae", decimals: 18, symbol: null },
            breakdowns: [],
          },
        ],
      },
    ];
    const page = validateMerklUserRewards(mutated, 8453);
    expect(page.rewards).toHaveLength(1);
    expect(page.rewards[0]?.token.priceUsd).toBeNull();
  });

  it("ignores an unmodelled field rather than failing on it", () => {
    const page = validateMerklUserRewards(MERKL_USER_REWARDS_BASE, 8453);
    // The MORPHO row's breakdowns carry `subCampaignId`, which Vex does not model.
    expect(page.rewards[1]?.breakdowns).toHaveLength(2);
  });

  it("ignores an envelope for a chain that was not asked about", () => {
    const page = validateMerklUserRewards(
      [{ chain: { id: 1, name: "Ethereum" }, rewards: [{ amount: "1", claimed: "0", pending: "0", token: { address: "0xa88594d404727625a9437c3f886c7643872296ae", decimals: 18 }, breakdowns: [] }] }],
      8453,
    );
    expect(page.rewards).toHaveLength(0);
  });
});

describe("merkl reward attribution", () => {
  it("computes claimable as accrued MINUS claimed, exactly", async () => {
    const page = validateMerklUserRewards(MERKL_USER_REWARDS_BASE, 8453);
    const attributed = await attributeMerklRewards(fixtureClient(), page);
    const well = attributed.rewards[0];
    // 27159256967843778403797 - 26977794427478008954964
    expect(well?.claimableRaw).toBe("181462540365769448833");
    expect(well?.amountRaw).toBe("27159256967843778403797");
  });

  it("never folds `pending` into `claimable`", async () => {
    const page = validateMerklUserRewards(MERKL_USER_REWARDS_BASE, 8453);
    const attributed = await attributeMerklRewards(fixtureClient(), page);
    expect(attributed.rewards[0]?.pendingRaw).toBe("50123183238199030734");
    expect(attributed.rewards[0]?.claimableRaw).not.toContain("50123183238199030734");
  });

  it("marks Morpho from the resolved protocol id and NOT from a campaign name", async () => {
    const page = validateMerklUserRewards(MERKL_USER_REWARDS_BASE, 8453);
    const attributed = await attributeMerklRewards(fixtureClient(), page);
    expect(attributed.rewards[0]?.hasMorphoSource).toBe(true);
    expect(attributed.rewards[0]?.sources[0]?.protocolId).toBe("morpho");
    // The USDC row's campaigns belong to Moonwell despite sitting in the same
    // wallet's Morpho-heavy answer.
    const usdc = attributed.rewards[2];
    expect(usdc?.hasMorphoSource).toBe(false);
    expect(usdc?.sources[0]?.protocolId).toBe("moonwell");
    expect(attributed.attribution.complete).toBe(true);
  });

  it("counts a row with NO campaign at all as unattributable, not as not-Morpho", async () => {
    // The live smoke found the burn address holding eight such rows on Base.
    const page = validateMerklUserRewards(
      [
        {
          chain: { id: 8453, name: "Base" },
          rewards: [
            {
              amount: "703408",
              claimed: "0",
              pending: "0",
              token: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" },
              breakdowns: [],
            },
          ],
        },
      ],
      8453,
    );
    const attributed = await attributeMerklRewards(fixtureClient(), page);
    expect(attributed.attribution.unattributableRewards).toBe(1);
    expect(attributed.attribution.complete).toBe(false);
    expect(attributed.rewards[0]?.hasMorphoSource).toBe(false);
  });

  it("reports an unresolvable campaign as UNKNOWN rather than as not-Morpho", async () => {
    const page = validateMerklUserRewards(MERKL_USER_REWARDS_BASE, 8453);
    const attributed = await attributeMerklRewards(fixtureClient({ failOpportunities: true }), page);
    expect(attributed.attribution.complete).toBe(false);
    expect(attributed.attribution.unresolvedOpportunities).toBe(2);
    for (const reward of attributed.rewards) {
      expect(reward.hasMorphoSource).toBe(false);
      expect(reward.sources[0]?.protocolId).toBeNull();
    }
  });
});

describe("morpho.rewards.get params", () => {
  it("requires a wallet address and refuses a non-address", () => {
    expect(parseMorphoRewardsParams({}).ok).toBe(false);
    const bad = parseMorphoRewardsParams({ walletAddress: "vitalik.eth" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.rejection.param).toBe("walletAddress");
  });

  it("refuses an over-wide chain fan-out BY NAME instead of trimming it", () => {
    const parsed = parseMorphoRewardsParams({
      walletAddress: MERKL_REWARDS_CAPTURED_WALLET,
      chainIds: "ethereum,base,arbitrum,optimism,polygon",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.rejection.param).toBe("chainIds");
      expect(parsed.rejection.message).toContain("at most");
    }
  });

  it("refuses an unsupported chain by name, with the supported list", () => {
    const parsed = parseMorphoRewardsParams({ walletAddress: MERKL_REWARDS_CAPTURED_WALLET, chainIds: "katana" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.rejection.message).toContain("base");
  });

  it("echoes the chains as slugs so the caller sees what was actually read", () => {
    const parsed = parseMorphoRewardsParams({ walletAddress: MERKL_REWARDS_CAPTURED_WALLET, chainIds: "base" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.echo["chainIds"]).toEqual(["base"]);
  });
});

describe("morpho.rewards.get handler", () => {
  it("returns every reward token by default, not only Morpho's", async () => {
    const result = await morphoRewardsGet({
      walletAddress: MERKL_REWARDS_CAPTURED_WALLET,
      chainIds: "base",
    });
    expect(result.success).toBe(true);
    const data = result.data as { chains: { rewards: { token: { symbol: string } }[] }[] };
    const symbols = data.chains[0]?.rewards.map((r) => r.token.symbol);
    expect(symbols).toContain("USDC");
    expect(symbols).toContain("WELL");
  });

  it("narrows to Morpho only when explicitly asked", async () => {
    const result = await morphoRewardsGet({
      walletAddress: MERKL_REWARDS_CAPTURED_WALLET,
      chainIds: "base",
      morphoOnly: true,
    });
    const data = result.data as { chains: { rewards: { token: { symbol: string } }[] }[] };
    expect(data.chains[0]?.rewards.map((r) => r.token.symbol)).not.toContain("USDC");
  });
});
