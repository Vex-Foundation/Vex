/**
 * Mutating-target classification for the dispatcher.
 *
 * Resolves whether a given dispatch runs an IRREVERSIBLE (mutating) tool. The
 * answer is consumed by the mission auto-retry-unsafe stamp and the plan-mode
 * acceptance gate, which both need the EFFECTIVE side-effect of the resolved
 * TARGET (not the wrapper/alias name).
 */

import type { ToolCallRequest } from "../types.js";
import { isMutatingTool } from "../registry.js";
import { getProtocolManifest } from "../protocols/catalog.js";
import {
  MUTATING_PROTOCOL_ALIAS_ROUTERS,
  isMutatingProtocolAlias,
} from "../mutating-aliases.js";
import {
  HYPERVEXING_ALIAS_TARGETS,
  isHypervexingProtocolAlias,
} from "../hypervexing-aliases.js";

/**
 * Phase 4d: does this dispatch run an IRREVERSIBLE (mutating) tool? For
 * `execute_tool` the answer comes from the TARGET protocol manifest (the
 * wrapper itself is `mutating: false`); a missing/unknown target is treated as
 * non-mutating. For a MUTATING protocol-alias (Stage 8b, e.g. `swap`) the
 * answer ALSO comes from the resolved TARGET manifest, so the mission
 * auto-retry-unsafe stamp reflects the target — not a generic alias default.
 * For other internal tools it is the registry `mutating` flag. Preview / dryRun
 * targets are stamped conservatively (a mutating manifest stamps regardless) —
 * safer to over-stamp than to miss a broadcast.
 *
 * This predicate must classify SIDE-EFFECT RISK, not validate args. A router
 * throw (invalid args, Solana + EVM-only `side`, unknown family) is swallowed
 * here and falls back to the alias's own registry `mutating` flag (true for a
 * mutating alias) so the stamp still fires conservatively; the real router
 * error surfaces later as a bounded failure in the dedicated dispatch branch.
 */
export function dispatchTargetIsMutating(call: ToolCallRequest): boolean {
  if (call.name === "execute_tool") {
    const toolId = typeof call.args.toolId === "string" ? call.args.toolId : "";
    if (!toolId) return false;
    return getProtocolManifest(toolId)?.mutating === true;
  }
  if (isMutatingProtocolAlias(call.name)) {
    const router = MUTATING_PROTOCOL_ALIAS_ROUTERS[call.name];
    try {
      const target = router(call.args);
      return getProtocolManifest(target.toolId)?.mutating === true;
    } catch {
      // Un-routable args are NOT a side-effect signal — fall back to the
      // alias's registry classification (mutating) so the stamp is conservative.
      return isMutatingTool(call.name);
    }
  }
  if (isHypervexingProtocolAlias(call.name)) {
    // Do not resolve here: this predicate runs before route selection solely
    // to decide whether a mission needs an irreversible-operation stamp. The
    // real alias resolver owns the loud missing-target invariant at the
    // execution boundary. Keeping this lookup passive also lets dispatcher
    // tests use intentionally partial manifest catalogs.
    return getProtocolManifest(HYPERVEXING_ALIAS_TARGETS[call.name])?.mutating === true;
  }
  return isMutatingTool(call.name);
}
