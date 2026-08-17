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
import { resolveInjectedProtocolTool } from "../registry/injected-protocol-tools.js";

/**
 * Phase 4d: does this dispatch run an IRREVERSIBLE (mutating) tool? For
 * `execute_tool` the answer comes from the TARGET protocol manifest (the
 * wrapper itself is `mutating: false`); a missing/unknown target is treated as
 * non-mutating. For a MUTATING protocol-alias (Stage 8b, e.g. `swap_execute`) the
 * answer ALSO comes from the resolved TARGET manifest, so the mission
 * auto-retry-unsafe stamp reflects the target — not a generic alias default.
 * For other internal tools it is the registry `mutating` flag. Preview / dryRun
 * targets are stamped conservatively (a mutating manifest stamps regardless) —
 * safer to over-stamp than to miss a broadcast.
 *
 * This predicate must classify SIDE-EFFECT RISK, not validate args. A router
 * throw (invalid args, unknown family, a hidden pair not yet revealed) is
 * swallowed here and falls back to the alias's own registry `mutating` flag
 * (true for a mutating alias) so the stamp still fires conservatively; the
 * real router error surfaces later as a bounded failure in the dedicated
 * dispatch branch.
 */
export function dispatchTargetIsMutating(call: ToolCallRequest): boolean {
  if (call.name === "execute_tool") {
    const toolId = typeof call.args.toolId === "string" ? call.args.toolId : "";
    if (!toolId) return false;
    return getProtocolManifest(toolId)?.mutating === true;
  }
  // Injected discovered-tool lane — the manifest resolved from the mapped
  // function name is the side-effect authority, exactly as for `execute_tool`.
  const injected = resolveInjectedProtocolTool(call.name);
  if (injected) return injected.mutating;
  if (isMutatingProtocolAlias(call.name)) {
    const router = MUTATING_PROTOCOL_ALIAS_ROUTERS[call.name];
    try {
      // No session scope at this classification-only call site — a router
      // that NEEDS it (the hidden Uniswap pair) always throws here, which
      // correctly falls back to the registry's static `mutating` flag below.
      const target = router(call.args, undefined);
      // An ASYNC router (`bridge`, which awaits the live Khalani chain registry
      // to pick its venue) cannot be resolved at this SYNCHRONOUS classification
      // site. Fall back to the alias's registry flag exactly as an un-routable
      // call does - conservative, and identical to what either bridge target
      // would classify as, since both are mutating.
      if (target instanceof Promise) {
        // The discarded promise must not become an unhandled rejection: this
        // classification never awaits it, and the router rejects for ordinary
        // reasons (invalid args, an unreadable registry). The real failure
        // surfaces from the dispatch branch, which does await its own call.
        target.catch(() => undefined);
        return isMutatingTool(call.name);
      }
      return getProtocolManifest(target.toolId)?.mutating === true;
    } catch {
      // Un-routable args are NOT a side-effect signal — fall back to the
      // alias's registry classification (mutating) so the stamp is conservative.
      return isMutatingTool(call.name);
    }
  }
  return isMutatingTool(call.name);
}
