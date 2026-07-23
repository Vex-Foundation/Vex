/**
 * Relay `/chains` route-health gate (Wave-2 W2, R11).
 *
 * Relay parses `vmType`/`depositEnabled`/`disabled` per chain but gated them
 * NOWHERE. This is the single gate: a bridge route is serviceable ONLY when BOTH
 * endpoints are, right now, EVM AND deposit-enabled AND not disabled.
 *
 * FAIL-CLOSED (R11): every health field is optional on the untrusted `/chains`
 * payload, so the checks use STRICT equality — a MISSING field (undefined) fails
 * exactly like an explicit bad value. Solana/other vmTypes are out of scope this
 * phase (`vmType === "evm"` required). The result names WHICH side failed and
 * WHY so the caller can surface an honest reason and never silently proceed.
 */

import type { RelayChain } from "./types.js";

export type RelayRouteSide = "origin" | "destination";

export type RelayChainHealthFailure =
  | "chain_not_found"
  | "vm_type_not_evm"
  | "deposit_not_enabled"
  | "chain_disabled";

export type RelayRouteHealth =
  | { readonly serviceable: true; readonly origin: RelayChain; readonly destination: RelayChain }
  | {
      readonly serviceable: false;
      readonly failedSide: RelayRouteSide;
      readonly chainId: number;
      readonly reason: RelayChainHealthFailure;
    };

/**
 * First failing health check for a FOUND chain, or null when it is EVM +
 * deposit-enabled + not disabled. Strict equality on optional fields → any
 * missing field fails closed. (Not-found is handled at the call site so the
 * caller keeps the narrowed non-null chain for the serviceable result.)
 */
function foundChainHealthFailure(chain: RelayChain): RelayChainHealthFailure | null {
  if (chain.vmType !== "evm") return "vm_type_not_evm";
  if (chain.depositEnabled !== true) return "deposit_not_enabled";
  if (chain.disabled !== false) return "chain_disabled";
  return null;
}

/**
 * Gate a bridge route against the live Relay `/chains` registry. Serviceable
 * only when BOTH sides pass; otherwise names the failing side + reason. Origin
 * is evaluated first so a doubly-broken route reports deterministically.
 */
export function evaluateRelayRouteHealth(
  chains: readonly RelayChain[],
  originChainId: number,
  destinationChainId: number,
): RelayRouteHealth {
  const byId = new Map(chains.map((c) => [c.id, c]));

  const origin = byId.get(originChainId);
  if (!origin) {
    return { serviceable: false, failedSide: "origin", chainId: originChainId, reason: "chain_not_found" };
  }
  const originFailure = foundChainHealthFailure(origin);
  if (originFailure) {
    return { serviceable: false, failedSide: "origin", chainId: originChainId, reason: originFailure };
  }

  const destination = byId.get(destinationChainId);
  if (!destination) {
    return {
      serviceable: false,
      failedSide: "destination",
      chainId: destinationChainId,
      reason: "chain_not_found",
    };
  }
  const destinationFailure = foundChainHealthFailure(destination);
  if (destinationFailure) {
    return {
      serviceable: false,
      failedSide: "destination",
      chainId: destinationChainId,
      reason: destinationFailure,
    };
  }

  return { serviceable: true, origin, destination };
}
