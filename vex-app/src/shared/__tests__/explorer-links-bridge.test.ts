/**
 * Bridge explorer-link resolution (Agent Scan Phase 2, R14) — pins that a
 * bridge leg's explorer link is resolved ONLY through the curated allowlist,
 * NEVER a raw provider URL:
 *
 *   - every chain this phase's bridge routes touch (Base / Arbitrum / Optimism
 *     / Robinhood / Solana) resolves AND passes the REAL external-link
 *     allowlist (`isAllowedExternalUrl` over `EXPLORER_EXTERNAL_ALLOW`);
 *   - a `solana`-family leg resolves to the Solana explorer's SIGNATURE path
 *     (base58, not a 0x hash) — the provider-native Solana chain id (which
 *     differs across providers) is never used as a key;
 *   - a Khalani/Relay chain NOT in the curated map (abstract 2741, a made-up
 *     id, or — the security case — a RAW provider explorer URL smuggled in as
 *     the chain string) resolves to `null`: no link, never a raw pass-through;
 *   - a malicious ref cannot smuggle path/query segments (encodeURIComponent).
 *
 * This is the renderer-side guard for the bridge feed's per-leg links, which
 * are built from `BridgeLeg { chainId, chainFamily, txHash }` via the SAME
 * `explorerTxUrl` the swap/legacy paths use — no bridge-specific URL builder,
 * no allowlist bypass.
 */

import { describe, expect, it } from "vitest";
import {
  EXPLORER_EXTERNAL_ALLOW,
  explorerTxUrl,
} from "../explorer-links.js";
import { isAllowedExternalUrl } from "../../main/security/url.js";
import { SOLANA_CHAIN_ID } from "../chains/display.js";
import type { BridgeChainFamily } from "../schemas/bridge-legs.js";

const HASH = "0xbridge0deposit0hash";
const SOL_SIG = "5VERYrealSolanaSignature111111111111111111";

/**
 * The renderer's leg → explorer-chain-key rule (mirrored here, the same rule
 * `TokenHistoryScreen`/`MovesBlock` apply): a `solana`-family leg uses the
 * `solana` key; an eip155 leg uses its bare decimal chain id.
 */
function chainKeyForLeg(chainId: number, family: BridgeChainFamily): string {
  return family === "solana" ? "solana" : String(chainId);
}

describe("bridge explorer resolution — curated allowlist only", () => {
  it.each([
    ["base", 8453],
    ["arbitrum", 42161],
    ["optimism", 10],
    ["robinhood", 4663],
  ] as ReadonlyArray<readonly [string, number]>)(
    "resolves + allowlists an EVM bridge leg on %s",
    (_slug, chainId) => {
      const key = chainKeyForLeg(chainId, "eip155");
      const url = explorerTxUrl(key, HASH);
      expect(url, `no explorer for bridge chain ${chainId}`).not.toBeNull();
      expect(isAllowedExternalUrl(url as string, EXPLORER_EXTERNAL_ALLOW)).toBe(true);
    },
  );

  it("resolves a Solana-family leg to the SIGNATURE path (base58, not a 0x hash key)", () => {
    // Khalani's Solana chain id (20011000000) and Relay's (792703809) differ;
    // the renderer keys on `chainFamily`, NOT the numeric id, so both map to
    // the one `solana` explorer.
    const khalaniKey = chainKeyForLeg(SOLANA_CHAIN_ID, "solana");
    const relayKey = chainKeyForLeg(792703809, "solana");
    expect(khalaniKey).toBe("solana");
    expect(relayKey).toBe("solana");
    const url = explorerTxUrl("solana", SOL_SIG);
    expect(url).toBe(`https://explorer.solana.com/tx/${SOL_SIG}`);
    expect(isAllowedExternalUrl(url as string, EXPLORER_EXTERNAL_ALLOW)).toBe(true);
  });

  it("REJECTS an uncurated Khalani chain — no link, never a raw provider URL", () => {
    // Abstract (2741) is a live Khalani chain with no verified explorer host in
    // the repo/dossier → fail closed to a non-interactive row.
    expect(explorerTxUrl(chainKeyForLeg(2741, "eip155"), HASH)).toBeNull();
    // A provider-native Solana id used WITHOUT the family mapping never resolves.
    expect(explorerTxUrl(String(792703809), SOL_SIG)).toBeNull();
    // The security case: a raw provider explorer URL smuggled in as the chain
    // string is NOT a curated key → null, never echoed back as a link.
    expect(explorerTxUrl("https://abscan.org/tx/", HASH)).toBeNull();
    expect(explorerTxUrl("abscan.org", HASH)).toBeNull();
  });

  it("URL-encodes a hostile leg ref so it cannot smuggle path/query segments", () => {
    expect(explorerTxUrl("base", "abc/../evil?x=1#f")).toBe(
      "https://basescan.org/tx/abc%2F..%2Fevil%3Fx%3D1%23f",
    );
  });
});
