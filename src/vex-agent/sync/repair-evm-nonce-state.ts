/** One bounded maintenance pass using the normal lookup-only recovery owners. */
import { recoverStaleHashlessIntents, HASHLESS_INTENT_RECOVERY_LEASE_MS } from "@vex-agent/db/repos/agent-activity.js";
import { repairPendingActivity, type RepairDeps } from "./agent-activity-repair.js";
import { buildProductionRepairDeps } from "./agent-activity-repair/chain-sources.js";

export async function repairEvmNonceState(deps: RepairDeps = buildProductionRepairDeps()) {
  const hashless = await recoverStaleHashlessIntents(HASHLESS_INTENT_RECOVERY_LEASE_MS, 25);
  const pending = await repairPendingActivity(deps, { includeAuxiliaryState: true });
  return { hashlessRecovered: hashless.length, pending };
}
