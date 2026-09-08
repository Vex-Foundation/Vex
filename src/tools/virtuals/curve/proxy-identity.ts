/**
 * The EIP-1967 implementation pin for BondingV5 and FRouterV3.
 *
 * WHY THIS IS AN AUTHORITY ROW AND NOT A COMMENT. Both are transparent
 * upgradeable proxies. An upgrade changes what `buy(amountIn, token, minOut,
 * deadline)` MEANS - the tax order, the floor comparison, which vault receives
 * what - while the address the signature commits to stays the same. So the pin
 * is re-read from the slot immediately before signing and a moved
 * implementation is refused BY NAME rather than traded through.
 *
 * The slot is the standard `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`.
 * The four pinned values in `./deployments.ts` were read from this very slot on
 * 2026-09-04 and archived.
 */

import { getAddress, type Address, type Hex } from "viem";

import type { VirtualsCurveDeployment } from "./deployments.js";

/** `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`. */
export const EIP1967_IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface ImplementationSlotReader {
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
}

/** The implementation currently behind `proxy`, or `null` when the slot is empty. */
export async function readImplementation(
  client: ImplementationSlotReader,
  proxy: Address,
): Promise<Address | null> {
  const word = await client.getStorageAt({ address: proxy, slot: EIP1967_IMPLEMENTATION_SLOT });
  if (typeof word !== "string" || word.length < 42) return null;
  const candidate = `0x${word.slice(-40)}`;
  if (/^0x0{40}$/.test(candidate)) return null;
  return getAddress(candidate);
}

export interface ProxyIdentity {
  readonly bondingV5: Address;
  readonly frouterV3: Address;
}

export type ProxyIdentityVerdict =
  | { readonly ok: true; readonly observed: ProxyIdentity }
  | { readonly ok: false; readonly reason: string; readonly observed: Partial<ProxyIdentity> };

/**
 * Read both implementation slots and hold them to the pinned values.
 *
 * A slot that cannot be read at all is a REFUSAL, not a pass: an unreadable
 * implementation is an unknown contract, and an unknown contract on the signing
 * path fails closed (rule 07).
 */
export async function checkPinnedImplementations(
  client: ImplementationSlotReader,
  deployment: VirtualsCurveDeployment,
): Promise<ProxyIdentityVerdict> {
  const [bondingV5, frouterV3] = await Promise.all([
    readImplementation(client, deployment.bondingV5),
    readImplementation(client, deployment.frouterV3),
  ]);
  const observed = {
    ...(bondingV5 === null ? {} : { bondingV5 }),
    ...(frouterV3 === null ? {} : { frouterV3 }),
  };
  if (bondingV5 === null || frouterV3 === null) {
    return {
      ok: false,
      observed,
      reason:
        `The EIP-1967 implementation slot of ${bondingV5 === null ? "BondingV5" : "FRouterV3"} on ${deployment.name}`
        + " could not be read, so Vex cannot prove which contract would run this trade.",
    };
  }
  const pinned = deployment.implementations;
  if (bondingV5 !== getAddress(pinned.bondingV5)) {
    return { ok: false, observed, reason: implementationMoved("BondingV5", deployment, pinned.bondingV5, bondingV5) };
  }
  if (frouterV3 !== getAddress(pinned.frouterV3)) {
    return { ok: false, observed, reason: implementationMoved("FRouterV3", deployment, pinned.frouterV3, frouterV3) };
  }
  return { ok: true, observed: { bondingV5, frouterV3 } };
}

function implementationMoved(
  contract: string,
  deployment: VirtualsCurveDeployment,
  pinned: Address,
  observed: Address,
): string {
  return (
    `${contract} on ${deployment.name} has been upgraded since Vex reviewed it: the proxy now runs `
    + `${observed}, and Vex is pinned to ${pinned}. An upgrade can change what buy and sell do, so nothing was signed.`
  );
}
