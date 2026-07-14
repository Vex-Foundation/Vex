/**
 * Coverage audit — every chain identity a real runtime emitter can put on a
 * tool result's `_tradeCapture.chain` / `_explorerRefs[].chain` MUST resolve
 * through the shared `explorerTxUrl` map AND emit a URL the REAL external-link
 * allowlist accepts. This is the guard that keeps the "deliberately tiny" map
 * from silently falling behind the chains the tools actually trade on.
 *
 * The runtime chain lists below are MIRRORED (not imported): the source files
 * live in the root `@tools/*` runtime tree, and pulling them into a shared test
 * would drag the agent runtime across the renderer/shared process boundary.
 * They are copied verbatim with a source pointer — KEEP IN SYNC when a chain is
 * added to either source file (a drift here means a real trade renders no link).
 *
 * The allowlist half imports the real `isAllowedExternalUrl` (pure policy in
 * `src/main/security/url.ts`) via a relative path — a test-only cross that the
 * process-boundary check intentionally skips for `__tests__`.
 */

import { describe, expect, it } from "vitest";
import {
  EXPLORER_EXTERNAL_ALLOW,
  explorerTxUrl,
} from "../explorer-links.js";
import { isAllowedExternalUrl } from "../../main/security/url.js";

const HASH = "0xabc123def456";

// MIRROR of src/tools/kyberswap/chains.ts `CHAINS` (slug + chainId). KyberSwap
// captures emit `chain: <canonical slug>` (resolveChainSlug normalizes aliases
// down to the slug), and other EVM paths emit `String(chainId)`; both shapes
// must resolve. KEEP IN SYNC with that file.
const KYBER_CHAINS: ReadonlyArray<readonly [slug: string, chainId: number]> = [
  ["ethereum", 1],
  ["bsc", 56],
  ["arbitrum", 42161],
  ["polygon", 137],
  ["optimism", 10],
  ["avalanche", 43114],
  ["base", 8453],
  ["linea", 59144],
  ["mantle", 5000],
  ["sonic", 146],
  ["berachain", 80094],
  ["ronin", 2020],
  ["unichain", 130],
  ["hyperevm", 999],
  ["plasma", 9745],
  ["etherlink", 42793],
  ["monad", 143],
  ["megaeth", 4326],
  ["scroll", 534352],
  ["zksync", 324],
];

// MIRROR of src/tools/evm-chains/registry.ts ROBINHOOD_CHAIN.activityChainKeys
// — the exact lowercased `_tradeCapture.chain` values that map to chain 4663.
// KEEP IN SYNC with that file.
const EVM_ACTIVITY_CHAIN_KEYS: readonly string[] = [
  "robinhood",
  "robinhood chain",
  "robinhoodchain",
  "rhc",
  "4663",
];

// Non-EVM + L1 identities the wallet/HyperCore paths emit directly.
const OTHER_IDENTITIES: readonly string[] = ["solana", "hyperliquid", "hyperevm"];

function everyRuntimeIdentity(): string[] {
  const ids = new Set<string>();
  for (const [slug, chainId] of KYBER_CHAINS) {
    ids.add(slug);
    ids.add(String(chainId));
  }
  for (const key of EVM_ACTIVITY_CHAIN_KEYS) ids.add(key);
  for (const id of OTHER_IDENTITIES) ids.add(id);
  return [...ids];
}

describe("explorer map covers every runtime chain identity", () => {
  it.each(everyRuntimeIdentity())(
    "resolves a tx URL for %s",
    (identity) => {
      const url = explorerTxUrl(identity, HASH);
      expect(url, `no explorer mapping for runtime chain "${identity}"`).not.toBeNull();
    },
  );

  it.each(everyRuntimeIdentity())(
    "URL for %s passes the real external-link allowlist",
    (identity) => {
      const url = explorerTxUrl(identity, HASH);
      expect(url).not.toBeNull();
      expect(
        isAllowedExternalUrl(url as string, EXPLORER_EXTERNAL_ALLOW),
        `allowlist rejected the emitted URL for "${identity}"`,
      ).toBe(true);
    },
  );
});
