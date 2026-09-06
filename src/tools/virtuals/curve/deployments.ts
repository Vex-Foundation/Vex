/**
 * The Virtuals bonding-curve contract table, per chain, and the proxy
 * implementations each address is pinned to.
 *
 * EVERY VALUE HERE WAS MEASURED, not transcribed from a community post. The
 * closed loop that proves the table on 2026-09-04 (archived under
 * `agents-colab/agents_dm/virtuals-trade-2026-09-04/pins.json`) is:
 *
 *   FRouterV3.factory()      === BondingV5.factory()      === `ffactoryV2`
 *   FRouterV3.assetToken()   === `virtual`
 *   BondingV5.router()       === `frouterV3`
 *   EIP-1967 implementation slot of each proxy === the pinned implementation
 *
 * The community-cited BondingV5 implementation `0x22aAAfa2...` is WRONG on Base
 * and is recorded here so nobody re-adopts it: the slot answers
 * `0x20C124e1...` (plan v3 section 9, "Base proxy evidence").
 *
 * WHY THE IMPLEMENTATION IS PART OF THE AUTHORITY TABLE. These are transparent
 * upgradeable proxies. An upgrade changes what `buy(...)` and `sell(...)` MEAN
 * without changing the address a signature commits to, so the trade lane
 * re-reads the slot immediately before signing and refuses by name when it moved
 * (`./proxy-identity.ts`). A pin that is only checked at build time would be a
 * comment, not a control.
 */

import type { Address } from "viem";

/** Chains where Virtuals runs a bonding curve Vex can trade. */
export type VirtualsCurveChainKey = "base" | "robinhood";

export interface VirtualsCurveDeployment {
  readonly chainId: number;
  /** The canonical slug the manifest advertises and the reply echoes. */
  readonly key: VirtualsCurveChainKey;
  readonly name: string;
  /** The entry point the user signs: `buy` / `sell` live here. */
  readonly bondingV5: Address;
  /**
   * The APPROVE target. FRouterV3 is what pulls VIRTUAL on a buy and the agent
   * token on a sell (`FRouterV3.buy` / `.sell` call `safeTransferFrom(to, ...)`),
   * so the allowance is granted to the router, never to BondingV5.
   */
  readonly frouterV3: Address;
  /** `FRouterV3.factory()`; owns `getPair`, `buyTax`, `sellTax`, the vaults. */
  readonly ffactoryV2: Address;
  /** `BondingV5.bondingConfig()`; owns the anti-sniper type table. */
  readonly bondingConfig: Address;
  /** `FRouterV3.assetToken()` - the curve's quote asset on this chain. */
  readonly virtual: Address;
  /** VIRTUAL's own decimals, read on chain 2026-09-04 on both chains. */
  readonly virtualDecimals: number;
  /** The EIP-1967 implementations every pre-sign read is held to. */
  readonly implementations: {
    readonly bondingV5: Address;
    readonly frouterV3: Address;
  };
}

const BASE: VirtualsCurveDeployment = {
  chainId: 8453,
  key: "base",
  name: "Base",
  bondingV5: "0x1A540088125d00dD3990f9dA45CA0859af4d3B01",
  frouterV3: "0x02FE8eC3d9BBf7318eb54590bcC39198a8b47deD",
  ffactoryV2: "0x488Db0978b34C6Fd901760b9024B565C1117c7c8",
  bondingConfig: "0x5C4A1A72c5a11909e318FCc08e52e49299ABEdaF",
  virtual: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  virtualDecimals: 18,
  implementations: {
    bondingV5: "0x20C124e13069889633FC4212e0797c95cb30Db40",
    frouterV3: "0x58377381523e86d66F9f29016371335dDcB89d32",
  },
};

const ROBINHOOD: VirtualsCurveDeployment = {
  chainId: 4663,
  key: "robinhood",
  name: "Robinhood Chain",
  bondingV5: "0xd4cCBFA37e2f35611b3042e4096Ad7a3459Bd007",
  frouterV3: "0xCa6395246B4382Ba70F886526dD9a9De984F6081",
  ffactoryV2: "0xFC2E4Da3EdB2E18100473339c763705d263D20A9",
  bondingConfig: "0x3e331Fdd9Fe54D5047b1B7339Fd5c91977D53e2F",
  virtual: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
  virtualDecimals: 18,
  implementations: {
    bondingV5: "0x66Fc520c7F316B8623eee2A5dA821c3b34D0539D",
    frouterV3: "0x09256b9D607c53fD946681F7C5a7a4381ba285A1",
  },
};

const BY_KEY: Readonly<Record<VirtualsCurveChainKey, VirtualsCurveDeployment>> = {
  base: BASE,
  robinhood: ROBINHOOD,
};

export const VIRTUALS_CURVE_CHAIN_KEYS: readonly VirtualsCurveChainKey[] = ["base", "robinhood"];

/** The deployment for a canonical slug, or `undefined` when the chain has no curve here. */
export function virtualsCurveDeployment(key: string): VirtualsCurveDeployment | undefined {
  return BY_KEY[key as VirtualsCurveChainKey];
}

/** The deployment for a numeric chain id, or `undefined`. */
export function virtualsCurveDeploymentByChainId(chainId: number): VirtualsCurveDeployment | undefined {
  return VIRTUALS_CURVE_CHAIN_KEYS.map((key) => BY_KEY[key]).find((d) => d.chainId === chainId);
}
