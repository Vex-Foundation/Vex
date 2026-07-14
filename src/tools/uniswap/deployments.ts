/**
 * Uniswap V2 + V3 per-chain deployment registry (keyless quoting + execution).
 *
 * Vex uses Uniswap as an all-EVM fallback where KyberSwap is primary, including
 * on Robinhood Chain (4663), which KyberSwap now aggregates too (venue policy
 * lives in `./venue-router.ts`). Every address below was RE-VERIFIED on-chain before it
 * landed here — a wrong router/factory address moves real funds to the wrong
 * contract, so the registry is treated as maximum sensitivity.
 *
 * ── Verification method (fund-safety gate) ──────────────────────────────────
 * For every chain we probed the live RPC and asserted the *wiring*, not just
 * that code exists at the address:
 *   - V3 SwapRouter02.factory()  == the chain's V3 factory
 *   - V3 SwapRouter02.WETH9()     == the chain's WETH
 *   - QuoterV2.factory()          == the chain's V3 factory
 *   - QuoterV2.WETH9()            == the chain's WETH
 *   - V2 Router02.factory()       == the chain's V2 factory
 *   - V2 Router02.WETH()          == the chain's WETH
 *   - V2 factory.allPairsLength() > 0 (factory is live with pairs)
 * A chain lands here ONLY when all of the above matched. Chains that could not
 * be verified live are simply ABSENT — the tool then errors cleanly (never a
 * guess). Canonical source of the candidate addresses: developers.uniswap.org
 * deployment pages; the on-chain probe is the authority.
 *
 * Robinhood Chain (4663) verified 2026-07-05 via
 * https://rpc.mainnet.chain.robinhood.com (eth_chainId → 0x1237 = 4663). The
 * six KyberSwap-overlap chains verified 2026-07-05 via their public RPCs.
 *
 * Gas rule: NEVER cache/hardcode gas limits — the client factory
 * (`./evm-client.ts`) estimates fresh at send time (viem default).
 */

import type { Address } from "viem";

/** Uniswap V2 core addresses for a chain (absent when V2 is not deployed). */
export interface UniswapV2Deployment {
  readonly factory: Address;
  readonly router02: Address;
}

/** Uniswap V3 core addresses for a chain (absent when V3 is not deployed). */
export interface UniswapV3Deployment {
  readonly factory: Address;
  /** SwapRouter02 (the router with the exactInput/exactInputSingle surface Vex uses). */
  readonly swapRouter02: Address;
  readonly quoterV2: Address;
  /** V3 fee tiers to probe on this chain, in basis points * 100 (500 = 0.05%). */
  readonly feeTiers: readonly number[];
}

export interface UniswapDeployment {
  readonly chainId: number;
  /** Stable lowercase key used for logs, tests, and dexscreener slug alignment. */
  readonly key: string;
  readonly name: string;
  /** Canonical wrapped-native token — always a connector and the native-leg wrap target. */
  readonly weth: Address;
  /**
   * Extra intermediate tokens to try for 2-hop routes, on top of WETH (which is
   * always tried). On 4663 this is VIRTUAL + USDG (VIRTUAL is the base pair for
   * Virtuals agent tokens like $VEX). Addresses on-chain-verified.
   */
  readonly connectors: readonly Address[];
  readonly v2?: UniswapV2Deployment;
  readonly v3?: UniswapV3Deployment;
  /**
   * Bundled public RPC. For 4663 the local chain registry
   * (`tools/evm-chains/registry.ts`) is the source of truth (it honours a user
   * override + wires Multicall3), so the client factory defers to it and this
   * URL is only a documented fallback. For the KyberSwap-overlap chains this
   * matches `tools/kyberswap/evm/config.ts` DEFAULT_RPC (publicnode).
   */
  readonly defaultRpcUrl: string;
}

const STANDARD_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

// ── Robinhood Chain (4663) — Uniswap fallback (KyberSwap primary here too) ────
// All six deployment addresses + WETH cross-verified 2026-07-05:
//   V2 Router02.factory()=0x8bce…937f, WETH()=0x0Bd7…AD73
//   V3 SwapRouter02.factory()=0x1f7d…2efa, WETH9()=0x0Bd7…AD73
//   QuoterV2.factory()=0x1f7d…2efa, WETH9()=0x0Bd7…AD73
//   V2 factory.allPairsLength()=1011 (0x3f3)
const ROBINHOOD: UniswapDeployment = {
  chainId: 4663,
  key: "robinhood",
  name: "Robinhood Chain",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  connectors: [
    "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", // VIRTUAL (base pair for $VEX & Virtuals agent tokens)
    "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG (6 decimals)
  ],
  v2: {
    factory: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
    router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
  },
  v3: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
    quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    feeTiers: STANDARD_V3_FEE_TIERS,
  },
  defaultRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
};

// ── Ethereum (1) ── verified 2026-07-05 (V2 factory allPairsLength=514949) ──
const ETHEREUM: UniswapDeployment = {
  chainId: 1,
  key: "ethereum",
  name: "Ethereum",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  connectors: [
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  ],
  v2: {
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    router02: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  },
  v3: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: STANDARD_V3_FEE_TIERS,
  },
  defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
};

// ── Base (8453) ── verified 2026-07-05 (V2 factory allPairsLength=3030579) ──
const BASE: UniswapDeployment = {
  chainId: 8453,
  key: "base",
  name: "Base",
  weth: "0x4200000000000000000000000000000000000006",
  connectors: [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  ],
  v2: {
    factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    router02: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  },
  v3: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    feeTiers: STANDARD_V3_FEE_TIERS,
  },
  defaultRpcUrl: "https://base-rpc.publicnode.com",
};

// ── Arbitrum One (42161) ── verified 2026-07-05 (V2 allPairsLength=8683) ──
const ARBITRUM: UniswapDeployment = {
  chainId: 42161,
  key: "arbitrum",
  name: "Arbitrum One",
  weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  connectors: [
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
  ],
  v2: {
    factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
    router02: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  },
  v3: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: STANDARD_V3_FEE_TIERS,
  },
  defaultRpcUrl: "https://arbitrum-one-rpc.publicnode.com",
};

// ── Optimism (10) ── verified 2026-07-05 (V2 allPairsLength=5188) ──
const OPTIMISM: UniswapDeployment = {
  chainId: 10,
  key: "optimism",
  name: "Optimism",
  weth: "0x4200000000000000000000000000000000000006",
  connectors: [
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // USDC
  ],
  v2: {
    factory: "0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf",
    router02: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2",
  },
  v3: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: STANDARD_V3_FEE_TIERS,
  },
  defaultRpcUrl: "https://optimism-rpc.publicnode.com",
};

// ── Polygon (137) ── verified 2026-07-05 (V2 allPairsLength=42594) ──
// WETH() here is WPOL/WMATIC (the wrapped native) — the router's own WETH9().
const POLYGON: UniswapDeployment = {
  chainId: 137,
  key: "polygon",
  name: "Polygon",
  weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  connectors: [
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // USDC (native)
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH (bridged)
  ],
  v2: {
    factory: "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C",
    router02: "0xedf6066a2b290C185783862C7F4776A2C8077AD1",
  },
  v3: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: STANDARD_V3_FEE_TIERS,
  },
  defaultRpcUrl: "https://polygon-bor-rpc.publicnode.com",
};

// ── BNB Chain (56) ── verified 2026-07-05 (V2 allPairsLength=7969) ──
// WETH() here is WBNB (the wrapped native).
const BSC: UniswapDeployment = {
  chainId: 56,
  key: "bsc",
  name: "BNB Chain",
  weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  connectors: [
    "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC
    "0x55d398326f99059fF775485246999027B3197955", // USDT
  ],
  v2: {
    factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    router02: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  },
  v3: {
    factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    swapRouter02: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    quoterV2: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    feeTiers: STANDARD_V3_FEE_TIERS,
  },
  defaultRpcUrl: "https://bsc-rpc.publicnode.com",
};

const DEPLOYMENTS: readonly UniswapDeployment[] = [
  ROBINHOOD,
  ETHEREUM,
  BASE,
  ARBITRUM,
  OPTIMISM,
  POLYGON,
  BSC,
];

const BY_ID: ReadonlyMap<number, UniswapDeployment> = new Map(
  DEPLOYMENTS.map((d) => [d.chainId, d]),
);

/** Deployment for a chain id, or undefined when Uniswap is not registered there. */
export function getUniswapDeployment(chainId: number): UniswapDeployment | undefined {
  return BY_ID.get(chainId);
}

/** True iff Uniswap has a verified deployment on this chain id. */
export function isUniswapChain(chainId: number): boolean {
  return BY_ID.has(chainId);
}

/** All registered Uniswap deployments (chain-extensible; one row per verified chain). */
export function listUniswapDeployments(): readonly UniswapDeployment[] {
  return DEPLOYMENTS;
}

/**
 * Router spender allowlist (security: validate BEFORE any ERC-20 approve).
 * Mirrors `KYBER_KNOWN_SPENDERS` — an approval may ONLY target a Uniswap V2
 * Router02 or V3 SwapRouter02 that is registered above. Built once from the
 * verified registry so it can never drift from the addresses actually routed.
 */
export const UNISWAP_KNOWN_SPENDERS: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const d of DEPLOYMENTS) {
    if (d.v2) set.add(d.v2.router02.toLowerCase());
    if (d.v3) set.add(d.v3.swapRouter02.toLowerCase());
  }
  return set;
})();
