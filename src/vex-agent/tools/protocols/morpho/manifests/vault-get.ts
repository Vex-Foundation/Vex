import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_VAULT_READ_DISCOVERY } from "../../embeddings/morpho/vault-reads.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";

/**
 * `morpho.vault.get` - the pre-deposit read for one vault.
 *
 * There is deliberately NO `version` param. An address does not announce its
 * generation, and Morpho answers a V1 address asked as V2 with the same
 * `NOT_FOUND` envelope as a nonexistent address, so a caller forced to guess
 * would be told a real vault does not exist. The client tries V2 then V1 and
 * only reports a miss after both, naming that both were checked.
 *
 * BOTH `vaultAddress` and `chain` are required for the same reason
 * `morpho.market.get` requires both: Morpho's by-address reads take a non-null
 * `chainId`, and the same address on the wrong chain resolves to nothing.
 */
export const MORPHO_VAULT_GET_TOOL: ProtocolToolManifest = {
  toolId: "morpho.vault.get",
  publicName: "morpho__vault_get",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "Read ONE Morpho vault in full, by its `vaultAddress` and the `chain` it lives on (both REQUIRED - a vault "
    + "address is chain-scoped and the same address on the wrong chain resolves to nothing). The vault GENERATION is "
    + "detected automatically: V2 is tried first and V1 second, so you never have to know which one an address "
    + "belongs to, and a miss is only reported after both registries were checked. Use this AFTER "
    + "`morpho__vaults_discover` has narrowed the candidates and BEFORE treating a vault as somewhere to deposit, "
    + "because it returns the facts the screening call cannot carry. "
    + "RETURNS everything the discovery row has (asset with decimals, TVL as {raw, decimals, symbol, human, usd}, "
    + "share price, the labelled APY block, fees, curator, listed flag, warnings) PLUS three blocks. "
    + "`config`: who can change this vault and how fast - owner and any pending owner, curator, allocators, the V1 "
    + "guardian or the V2 sentinels, the fee recipients, the timelock (a single `timelockSeconds` on V1, a "
    + "per-function `timelocks[]` table on V2), and `pendingConfigCount`, the number of governance changes ALREADY "
    + "QUEUED and waiting out their timelock. `state`: share price, total assets, share supply in SHARE units (not "
    + "comparable with total assets), immediately withdrawable liquidity, and on V2 the idle balance and the "
    + "liquidity that can only be freed by a penalised forced deallocation. `allocations` (on by default): every "
    + "lending market the vault currently supplies, each naming its marketId, its loan and collateral symbols with "
    + "decimals, its lltvPercent, the amount supplied, the cap the curator set, any pending cap change with the date "
    + "it becomes valid, and that market's OWN supply APY. "
    + "APY LABELLING IS THE CONTRACT: this vault's `netApyPercent` is NET of the curator's fee, while each "
    + "allocation's `marketSupplyApyPercent` is GROSS - the allocations will read higher than the vault, and that gap "
    + "is the fee, not an arbitrage. `apyPercent` is the vault's yield before the fee; `netApyExcludingRewardsPercent` "
    + "EXCLUDES incentives while `netApyPercent` INCLUDES them, both after the fee; each `rewards[]` entry is a "
    + "separate APR in its own token. "
    + "CURATOR DRIFT IS THE MAIN RISK THIS TOOL EXISTS TO SURFACE. A vault is a MANAGED product: the curator chooses "
    + "which markets it supplies and can change that choice, with timelocks that in live vaults range from zero to "
    + "about three weeks depending on the function. Today's allocations are not a property of the vault - re-read "
    + "before acting on a list you saw earlier, and treat `pendingConfigCount` above zero as a change already in "
    + "flight. GATING: only V2 vaults have gates. `gating.withdrawalGated` true means a contract decides whether a "
    + "depositor may exit; `gating.depositGated` blocks entry; `abdicated: true` on a gate means the curator "
    + "permanently gave up the right to install it. Never recommend a deposit into a withdrawal-gated vault without "
    + "saying so first. BAD DEBT: a loss in an underlying market is socialised through the vault's SHARE PRICE, so it "
    + "reaches every depositor rather than only the position that caused it. "
    + "LIMITS: state is point-in-time, USD values are Morpho's oracle estimates rather than traded prices, the "
    + "trailing average returned by `includeHistory` covers a window Morpho does not name, and Morpho publishes no "
    + "SLA. Read-only - it signs nothing and spends nothing.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "vaultAddress",
      type: "string",
      required: true,
      description:
        "The vault's 0x-prefixed 40-hex contract address. Read one from `morpho__vaults_discover`. A 64-hex value is "
        + "rejected by name because that is a MARKET id and belongs to `morpho__market_get`. You do not need to know "
        + "whether the vault is V1 or V2; both are tried.",
    },
    {
      key: "chain",
      type: "string",
      required: true,
      description:
        `The chain the vault lives on. ${CANONICAL_CHAIN_SENTENCE} Required because a vault address is chain-scoped, `
        + "so the same address on the wrong chain resolves to nothing. Discovery ships the supported slugs on this "
        + "tool's `chains` metadata, and an unsupported chain is rejected with the full set spelled out.",
    },
    {
      key: "includeAllocations",
      type: "boolean",
      description:
        "Include the per-market allocation table with caps and each market's own APY (default TRUE). It is on by "
        + "default because a vault's real risk is the risk of the markets underneath it, not of the vault contract. "
        + "Set false only when you already know the allocations and want a smaller reply.",
    },
    {
      key: "includeHistory",
      type: "boolean",
      description:
        "Add Morpho's trailing average APY beside the live rate (default false). Morpho returns a single average and "
        + "does NOT name the window it covers, so it is labelled 'recent average' rather than a fixed period; there "
        + "is no `lookback` here because the vault schema exposes no named averaging windows the way markets do.",
    },
  ],
  exampleParams: {
    vaultAddress: "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9",
    chain: "base",
    includeAllocations: true,
  },
  discovery: MORPHO_VAULT_READ_DISCOVERY["morpho.vault.get"],
};
