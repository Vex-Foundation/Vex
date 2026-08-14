/**
 * `morpho.vault.get` - one Morpho vault in full, either generation.
 *
 * VERSION DETECTION IS AUTOMATIC and there is no `version` param, because an
 * agent holding an address has no reliable way to know which generation it
 * belongs to and a wrong guess would return "no such vault" for a vault that
 * exists. The client tries `vaultV2ByAddress` first and falls back to
 * `vaultByAddress`; Morpho answers a wrong-generation address with the same
 * `NOT_FOUND` envelope as a wrong address, so only the SECOND miss is reported,
 * and it says both registries were checked.
 *
 * Everything this returns beyond the screening row is a fact a depositor needs
 * and the discovery call cannot carry: who can change the vault and how fast
 * (owner, curator, allocators, guardian or sentinels, and the timelock those
 * changes wait out), how many governance changes are already QUEUED, which
 * lending markets the vault currently supplies and under what caps, and, on V2,
 * whether a gate contract can refuse a withdrawal.
 */

import { getMorphoClient } from "@tools/morpho/client.js";
import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoVaultGetParams } from "../read-params.js";
import {
  MORPHO_USD_DISCLAIMER,
  MORPHO_VAULT_APY_DISCLAIMER,
  MORPHO_VAULT_CURATOR_NOTE,
  MORPHO_VAULT_GATING_NOTE,
  projectVaultDetail,
} from "../projectors.js";
import { morphoFailureDetail } from "./shared.js";

export async function morphoVaultGet(
  params: Record<string, unknown>,
  context?: { abortSignal?: AbortSignal },
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoVaultGetParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  let detail;
  try {
    detail = await getMorphoClient().getVault(
      {
        vaultAddress: q.vaultAddress,
        chainId: q.chainId,
        includeAllocations: q.includeAllocations,
        includeHistory: q.includeHistory,
      },
      context?.abortSignal,
    );
  } catch (err) {
    return fail(`morpho.vault.get failed ${morphoFailureDetail(err)}`);
  }

  const vault = projectVaultDetail(detail, q.includeHistory);
  const redWarnings = detail.warnings.filter((w) => w.level === "RED");
  const gating = detail.gating;

  return ok({
    summary:
      `${detail.name ?? "unnamed vault"} (${detail.symbol ?? "no symbol"}), a Morpho `
      + `${detail.version.toUpperCase()} vault holding ${detail.asset.symbol ?? "its asset"} on ${q.chainSlug}, `
      + `${detail.listed ? "curated by Morpho" : "NOT curated by Morpho"}.`
      + (gating?.withdrawalGated === true
        ? " WITHDRAWALS ARE GATED: a gate contract decides whether a depositor may exit."
        : "")
      + (gating?.depositGated === true ? " Deposits are gated by a contract." : "")
      + (detail.pendingConfigCount > 0
        ? ` ${detail.pendingConfigCount} governance change(s) are queued and will take effect after their timelock.`
        : "")
      + (redWarnings.length > 0
        ? ` ${redWarnings.length} RED warning(s): ${redWarnings.map((w) => w.type).join(", ")}.`
        : ""),
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    vault,
    notes: {
      apy: MORPHO_VAULT_APY_DISCLAIMER,
      usd: MORPHO_USD_DISCLAIMER,
      curator: MORPHO_VAULT_CURATOR_NOTE,
      gating: gating === null
        ? "This is a V1 vault, which has no gating mechanism: no contract can block a deposit or a withdrawal here. "
          + "Only V2 vaults have gates."
        : MORPHO_VAULT_GATING_NOTE,
      entry:
        "Before depositing: `listed:false` means nobody vetted this vault, a RED warning names a concrete defect, and "
        + "the vault's risk is the risk of the markets in `allocations` rather than of the vault contract alone. On a "
        + "V2 vault a loss in an underlying market is socialised through the SHARE PRICE, so it reaches every "
        + "depositor rather than only the position that caused it.",
      allocations: q.includeAllocations
        ? "`allocations` is what the vault supplies RIGHT NOW. The curator can change it, so re-read before acting."
        : "Set includeAllocations:true to see which lending markets this vault actually supplies and under what caps.",
      history: q.includeHistory
        ? "`apyHistory` is Morpho's own trailing average. Morpho does not name the window, so do not present it as a "
          + "fixed period."
        : "Set includeHistory:true to add Morpho's trailing average APY alongside the live rate.",
    },
    nextStep:
      "Compare against siblings with morpho.vaults.discover on the same asset, and read any allocation that concerns "
      + "you with morpho.market.get. Vex has no Morpho mutating tools yet - this namespace is read-only.",
  });
}
