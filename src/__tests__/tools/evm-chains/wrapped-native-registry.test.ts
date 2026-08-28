/**
 * The wrapped-native CAPABILITY registry, enumerated against its own live
 * verification archive.
 *
 * The registry's header claims each row was admitted by a read-only live probe.
 * That claim is only worth something if something checks it, so this test is
 * the enforcement: it walks EVERY row, finds the archived probe transcript for
 * that chain id, and re-derives the registry's own assertions from the raw
 * bytes the node returned.
 *
 * The decoded values are computed HERE from the ABI-encoded hex, never
 * transcribed. A hand-copied "WETH" would agree with a registry that had been
 * hand-copied the same way; a decoder disagrees with both.
 *
 * The cross-source block exists because a wrong address on this path is the
 * user's funds sent to a contract that will not give them back, and three other
 * in-repo tables already name a wrapped-native address for some of these
 * chains. Full coverage by those tables is NOT required - they answer different
 * questions on different chain sets - but AGREEMENT is: where a chain appears on
 * both sides, a disagreement means one of the two is wrong and neither can be
 * assumed to be this one.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { listWrappedNativeContracts } from "@tools/evm-chains/wrapped-native.js";
import { getEvmChainQuotePolicy } from "@tools/dexscreener/evm-chain-quote-policy.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getKyberWrappedNativeAddress } from "@tools/kyberswap/wrapped-native.js";
import { chainIdToSlug } from "@tools/kyberswap/chains.js";

const FIXTURE_DIR = resolve(__dirname, "..", "..", "fixtures", "evm-chains", "wrapped-native");

interface ProbeResponse {
  readonly result?: string;
  readonly error?: { readonly code: number; readonly message: string };
}

interface Probe {
  readonly name: string;
  readonly response: ProbeResponse;
}

interface WrappedNativeFixture {
  readonly chainId: number;
  readonly address: string;
  readonly probes: readonly Probe[];
}

function readFixture(chainId: number): WrappedNativeFixture {
  const path = resolve(FIXTURE_DIR, `${chainId}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as WrappedNativeFixture;
}

function probeNamed(fixture: WrappedNativeFixture, name: string): Probe {
  const probe = fixture.probes.find((entry) => entry.name === name);
  if (probe === undefined) {
    throw new Error(`fixture for chain ${fixture.chainId} has no probe named "${name}"`);
  }
  return probe;
}

/** One 32-byte ABI word, as a bigint, from a 0x-prefixed return blob. */
function abiWord(hex: string, index: number): bigint {
  const body = hex.slice(2);
  const start = index * 64;
  const word = body.slice(start, start + 64);
  if (word.length !== 64) {
    throw new Error(`return data has no word at index ${index}: ${hex}`);
  }
  return BigInt(`0x${word}`);
}

/**
 * Decode `string` from an ABI return blob: a head word holding the byte offset
 * of the tail, then a length word, then the UTF-8 bytes padded to a word.
 *
 * Written out rather than delegated to viem so the assertion does not depend on
 * the same library the production registry imports.
 */
function decodeAbiString(hex: string): string {
  const offset = Number(abiWord(hex, 0));
  const body = hex.slice(2);
  const lengthAt = offset * 2;
  const length = Number(BigInt(`0x${body.slice(lengthAt, lengthAt + 64)}`));
  const dataAt = lengthAt + 64;
  const bytes = body.slice(dataAt, dataAt + length * 2);
  return Buffer.from(bytes, "hex").toString("utf8");
}

const REGISTRY = listWrappedNativeContracts();

describe("the wrapped-native registry is backed by its live verification archive", () => {
  it("registers at least one chain, so the table below is not vacuously green", () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
  });

  for (const entry of REGISTRY) {
    describe(`chain ${entry.chainId} (${entry.slug})`, () => {
      const fixture = readFixture(entry.chainId);

      it("has an archived probe transcript for the address it registers", () => {
        expect(fixture.chainId).toBe(entry.chainId);
        expect(fixture.address).toBe(entry.address);
      });

      it("registers the symbol the contract itself returned", () => {
        const returned = probeNamed(fixture, "symbol()").response.result;
        expect(returned).toBeTypeOf("string");
        expect(decodeAbiString(returned as string)).toBe(entry.symbol);
      });

      it("registers the decimals the contract itself returned", () => {
        const returned = probeNamed(fixture, "decimals()").response.result;
        expect(returned).toBeTypeOf("string");
        expect(Number(abiWord(returned as string, 0))).toBe(entry.decimals);
      });

      it("answered deposit() and withdraw(0) without reverting", () => {
        expect(probeNamed(fixture, "deposit()").response.error).toBeUndefined();
        expect(probeNamed(fixture, "withdraw(0)").response.error).toBeUndefined();
      });

      it("reverted withdraw(2^255), proving the balance requirement is enforced", () => {
        // The whole point of the pair above and this one: a contract that
        // accepts every call is not a wrapped-native contract, it is an address
        // that swallows calldata. Only the revert distinguishes them.
        const probe = probeNamed(fixture, "withdraw(2^255) zero-balance");
        expect(probe.response.error).toBeDefined();
        expect(probe.response.result).toBeUndefined();
      });
    });
  }
});

describe("registry shape", () => {
  it("has no duplicate chain id", () => {
    const ids = REGISTRY.map((entry) => entry.chainId);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("stores every address in its checksummed form", () => {
    for (const entry of REGISTRY) {
      expect(entry.address).toBe(getAddress(entry.address));
    }
  });
});

/**
 * Cross-source agreement.
 *
 * Each of these tables was populated for its own purpose and is allowed to be
 * missing a chain this registry has (and to have chains this one does not).
 * What is not allowed is a DIFFERENT address for the same chain: that is two
 * sources of truth disagreeing about where a user's funds go.
 */
describe("agrees with every overlapping in-repo wrapped-native source", () => {
  function overlaps(
    label: string,
    lookup: (chainId: number) => string | undefined,
  ): void {
    it(`agrees with ${label} on every chain both know`, () => {
      const disagreements: string[] = [];
      let compared = 0;
      for (const entry of REGISTRY) {
        const other = lookup(entry.chainId);
        if (other === undefined) continue;
        compared += 1;
        if (other.toLowerCase() !== entry.address.toLowerCase()) {
          disagreements.push(
            `chain ${entry.chainId} (${entry.slug}): registry ${entry.address}, ${label} ${other}`,
          );
        }
      }
      expect(disagreements).toEqual([]);
      // A lookup that silently answered `undefined` everywhere would make the
      // assertion above true without comparing anything.
      expect(compared).toBeGreaterThan(0);
    });
  }

  overlaps(
    "tools/dexscreener/evm-chain-quote-policy.ts",
    (chainId) => getEvmChainQuotePolicy(chainId)?.policy.wrappedNative,
  );

  overlaps(
    "tools/uniswap/deployments.ts",
    (chainId) => getUniswapDeployment(chainId)?.weth,
  );

  overlaps(
    "tools/evm-chains/registry.ts",
    (chainId) => getLocalChain(chainId)?.quoteAssetPolicy.wrappedNative,
  );

  overlaps("tools/kyberswap/wrapped-native.ts", (chainId) => {
    const slug = chainIdToSlug(chainId);
    if (slug === undefined) return undefined;
    // Fail-closed by design for a non-aggregator slug, which is an absence
    // rather than a disagreement.
    try {
      return getKyberWrappedNativeAddress(slug);
    } catch {
      return undefined;
    }
  });
});
