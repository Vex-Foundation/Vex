/**
 * The local-chain ENUMERATION union (WP6b).
 *
 * WHY THIS FILE EXISTS. Robinhood Chain 4663 could only ever look at four seed
 * tokens plus the wallet's pins, so a token held there and never pinned was
 * invisible - and the two wallet references show how that becomes a wrong
 * answer rather than a partial one: MetaMask swallows a failed detection into
 * an empty result indistinguishable from "this chain has no tokens"
 * (`TokenBalancesController.ts:958-1022`). The union that fixes the blindness
 * therefore has to answer a second question in the same breath: is this set
 * every holding, or only the part we could see. Both questions are asserted
 * here, and never one through the other.
 *
 * Structure follows a production table suite in the VS Code checkout
 * (`src/vs/base/test/common/iterativePaging.test.ts`): one named factory builds
 * the scripted source, each case overrides exactly the axis it is about, and
 * the assertion is on the model's public state rather than on how it got there.
 */

import { describe, it, expect } from "vitest";

import type { BlockscoutInventoryResult } from "@tools/blockscout/client.js";
import {
  buildLocalChainScanSet,
  fromBlockscoutInventory,
  localChainInventorySources,
  type LocalChainIndexerObservation,
} from "@vex-agent/wallet-inventory/local-chain.js";

const CHAIN_ID = 4663;
const OBSERVED_AT = "2026-08-31T12:00:00.000Z";

// Checksummed spellings, and the lowercase ones a DB row or a provider may use.
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const AIRDROP = "0x1111111111111111111111111111111111111111";

/** An indexer answer, complete unless a case says otherwise. */
function indexerObservation(
  overrides: Partial<LocalChainIndexerObservation> = {},
): LocalChainIndexerObservation {
  return {
    source: "blockscout_erc20_inventory",
    exhaustive: true,
    failed: false,
    incompleteReason: null,
    candidates: [{ address: AIRDROP, providerFlags: { reputation: "ok" } }],
    unprocessedContractAddresses: [],
    ...overrides,
  };
}

/** The scan set as the read lane builds it, with only the axis under test moved. */
function scanSet(input: {
  seedAddresses?: readonly string[];
  pinnedAddresses?: readonly string[];
  indexer?: LocalChainIndexerObservation | null;
} = {}) {
  return buildLocalChainScanSet({
    chainId: CHAIN_ID,
    seedAddresses: input.seedAddresses ?? [WETH, VEX],
    pinnedAddresses: input.pinnedAddresses ?? [],
    indexer: input.indexer === undefined ? indexerObservation() : input.indexer,
  });
}

describe("local-chain enumeration union - the set", () => {
  it("unions the three sources and attributes every address to its origins", () => {
    const set = scanSet({
      seedAddresses: [WETH, VEX],
      pinnedAddresses: [VIRTUAL],
      indexer: indexerObservation({
        candidates: [
          { address: AIRDROP, providerFlags: { reputation: "ok" } },
          // The indexer also sees a token that is already a seed: one entry,
          // both origins, and the provider's label still arrives.
          { address: VEX, providerFlags: { reputation: "spam" } },
        ],
      }),
    });

    expect(set.entries).toEqual([
      { address: WETH, origins: ["seed"], providerFlags: null },
      { address: AIRDROP, origins: ["indexer"], providerFlags: { reputation: "ok" } },
      { address: VEX, origins: ["seed", "indexer"], providerFlags: { reputation: "spam" } },
      { address: VIRTUAL, origins: ["pin"], providerFlags: null },
    ]);
    expect(set.addresses).toEqual([WETH, AIRDROP, VEX, VIRTUAL]);
  });

  it("deduplicates case-insensitively and checksums the survivor once", () => {
    const set = scanSet({
      seedAddresses: [VEX],
      pinnedAddresses: [VEX.toLowerCase()],
      indexer: indexerObservation({
        candidates: [{ address: VEX.toUpperCase().replace("0X", "0x"), providerFlags: { reputation: "ok" } }],
      }),
    });

    expect(set.addresses).toEqual([VEX]);
    expect(set.entries).toEqual([
      { address: VEX, origins: ["seed", "pin", "indexer"], providerFlags: { reputation: "ok" } },
    ]);
  });

  it("orders by lowercase address whatever order the sources answered in", () => {
    const forward = scanSet({ seedAddresses: [WETH, VEX], pinnedAddresses: [VIRTUAL] });
    const reversed = scanSet({ seedAddresses: [VEX, WETH], pinnedAddresses: [VIRTUAL] });

    expect(forward.addresses).toEqual(reversed.addresses);
    const lowered = forward.addresses.map((address) => address.toLowerCase());
    expect(lowered).toEqual([...lowered].sort());
  });

  it("reports an unparsable pin instead of skipping it, and still trusts the indexer", () => {
    const set = scanSet({
      // "USDC" is a symbol, not an address: exactly the untrusted DB row the
      // old scan set dropped in silence.
      pinnedAddresses: ["USDC"],
      indexer: indexerObservation(),
    });

    expect(set.droppedAddresses).toEqual([{ origin: "pin", reason: "address_unparsable" }]);
    expect(set.addresses).not.toContain("USDC");
    // A corrupt pin names no contract, and a real token behind it would be
    // enumerated by the indexer anyway - so one junk DB row must not be able to
    // freeze this chain's whole projection.
    expect(set.exhaustive).toBe(true);
  });

  it("loses exhaustiveness when an INDEXER candidate could not be parsed", () => {
    const set = scanSet({
      indexer: indexerObservation({
        candidates: [
          { address: AIRDROP, providerFlags: { reputation: "ok" } },
          // An address shape no parser accepts. The client's own validation
          // rejects these upstream, so this is the owner refusing to trust that
          // guarantee: a contract we were told this wallet holds and cannot
          // scan must cost the completeness claim, not vanish.
          { address: "0xnot-an-address", providerFlags: { reputation: "ok" } },
        ],
      }),
    });

    expect(set.droppedAddresses).toEqual([{ origin: "indexer", reason: "address_unparsable" }]);
    expect(set.exhaustive).toBe(false);
  });
});

describe("local-chain enumeration union - the completeness verdict", () => {
  it("is exhaustive only when an indexer answered completely", () => {
    expect(scanSet({ indexer: indexerObservation() }).exhaustive).toBe(true);
  });

  it("is never exhaustive on seeds and pins alone", () => {
    const set = scanSet({ indexer: null });

    expect(set.exhaustive).toBe(false);
    expect(set.indexer).toBeNull();
  });

  it("keeps the candidates a PARTIAL answer did parse, without claiming completeness", () => {
    const set = scanSet({
      indexer: indexerObservation({
        exhaustive: false,
        incompleteReason: "invalid_response",
        unprocessedContractAddresses: ["0x2222222222222222222222222222222222222222"],
      }),
    });

    expect(set.exhaustive).toBe(false);
    expect(set.addresses).toContain(AIRDROP);
  });

  it("returns seeds and pins, never an empty set, when the indexer failed", () => {
    const set = scanSet({
      indexer: indexerObservation({
        exhaustive: false,
        failed: true,
        incompleteReason: "unavailable",
        candidates: [],
      }),
    });

    // The MetaMask anti-pattern in one assertion: a failed enumeration must not
    // shorten the answer, only its claim.
    expect(set.addresses).toEqual([WETH, VEX]);
    expect(set.exhaustive).toBe(false);
  });
});

describe("local-chain enumeration union - the inventory-source rows", () => {
  it("reports the union and its indexer as two read sources on a clean pass", () => {
    const sources = localChainInventorySources({
      scan: scanSet(),
      chainRead: "read",
      observedAt: OBSERVED_AT,
    });

    expect(sources).toEqual([
      {
        chainId: CHAIN_ID,
        source: "blockscout_erc20_inventory",
        result: "read",
        exhaustive: true,
        observedAt: OBSERVED_AT,
      },
      {
        chainId: CHAIN_ID,
        source: "local_chain_indexer_union",
        result: "read",
        exhaustive: true,
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it("names a failed enumeration as a breadth loss, never as a failed chain", () => {
    const sources = localChainInventorySources({
      scan: scanSet({
        indexer: indexerObservation({
          exhaustive: false,
          failed: true,
          incompleteReason: "over_cap",
          candidates: [],
        }),
      }),
      chainRead: "read",
      observedAt: OBSERVED_AT,
    });

    expect(sources).toEqual([
      {
        chainId: CHAIN_ID,
        source: "blockscout_erc20_inventory",
        result: "failed",
        exhaustive: false,
        // C3.5: a read that observed nothing is never stamped fresh.
        observedAt: null,
        failureImpact: "enumeration_breadth",
        failureReason: "over_cap",
      },
      {
        chainId: CHAIN_ID,
        // The seed-and-pin enumeration is what actually produced this set, and
        // that is what the row says.
        source: "local_chain_seed_and_pins",
        result: "read",
        exhaustive: false,
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it("carries the provider's reason for a partial answer that still read", () => {
    const [indexerSource] = localChainInventorySources({
      scan: scanSet({
        indexer: indexerObservation({ exhaustive: false, incompleteReason: "invalid_response" }),
      }),
      chainRead: "read",
      observedAt: OBSERVED_AT,
    });

    expect(indexerSource).toEqual({
      chainId: CHAIN_ID,
      source: "blockscout_erc20_inventory",
      result: "read",
      exhaustive: false,
      observedAt: OBSERVED_AT,
      failureReason: "invalid_response",
    });
  });

  it("emits one bounded source row for a chain with no indexer at all", () => {
    const sources = localChainInventorySources({
      scan: scanSet({ indexer: null }),
      chainRead: "read",
      observedAt: OBSERVED_AT,
    });

    expect(sources).toEqual([
      {
        chainId: CHAIN_ID,
        source: "local_chain_seed_and_pins",
        result: "read",
        exhaustive: false,
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it("never stamps the chain row when the balance read itself failed", () => {
    const sources = localChainInventorySources({
      scan: scanSet(),
      chainRead: "failed",
      observedAt: OBSERVED_AT,
    });

    const chainRow = sources.find((source) => source.source === "local_chain_indexer_union");
    expect(chainRow).toEqual({
      chainId: CHAIN_ID,
      source: "local_chain_indexer_union",
      result: "failed",
      exhaustive: true,
      observedAt: null,
    });
  });
});

describe("Blockscout adapter", () => {
  /** The provider facts every result carries, so a case moves only its own axis. */
  function inventoryFacts() {
    return {
      source: "blockscout" as const,
      chainId: 4663 as const,
      inventoryScope: "erc20" as const,
      maxResponseBytes: 524_288 as const,
      maxProviderRows: 500 as const,
      transport: "electron_net" as const,
      providerRowCount: 1,
      responseBytes: 128,
      typeCensus: [{ type: "ERC-20", count: 1 }],
      omittedNonErc20Count: 0,
      invalidRowCount: 0,
      invalidReasonCounts: [],
      unprocessedContractAddresses: [],
    };
  }

  it("carries identity and labels forward, and nothing an RPC read owns", () => {
    const result: BlockscoutInventoryResult = {
      ...inventoryFacts(),
      status: "complete",
      inventoryComplete: true,
      candidates: [
        {
          address: VEX,
          tokenType: "ERC-20",
          // Present on the provider row and deliberately unreachable from here:
          // a wallet row's balance and scale come from the chain, not a cache.
          indexerBalanceRaw: "4229196476593709361909",
          indexerDecimals: 18,
          providerFlags: { reputation: "ok" },
        },
      ],
    };

    const observation = fromBlockscoutInventory(result);

    expect(observation).toEqual({
      source: "blockscout_erc20_inventory",
      exhaustive: true,
      failed: false,
      incompleteReason: null,
      candidates: [{ address: VEX, providerFlags: { reputation: "ok" } }],
      unprocessedContractAddresses: [],
    });
    expect(JSON.stringify(observation)).not.toContain("4229196476593709361909");
  });

  it("maps every non-complete provider status to a non-exhaustive observation", () => {
    const cases = [
      { reason: "unavailable" as const, candidates: [] },
      { reason: "over_cap" as const, candidates: [] },
      { reason: "invalid_response" as const, candidates: [] },
    ];

    for (const testCase of cases) {
      const observation = fromBlockscoutInventory({
        ...inventoryFacts(),
        status: "incomplete",
        inventoryComplete: false,
        incompleteReason: testCase.reason,
        errorCode: "BLOCKSCOUT_TEST",
        candidates: testCase.candidates,
      });

      expect(observation.exhaustive).toBe(false);
      expect(observation.failed).toBe(true);
      expect(observation.incompleteReason).toBe(testCase.reason);
    }
  });

  it("treats a partial answer as read-but-not-exhaustive, keeping its candidates", () => {
    const observation = fromBlockscoutInventory({
      ...inventoryFacts(),
      status: "incomplete",
      inventoryComplete: false,
      incompleteReason: "invalid_response",
      errorCode: "BLOCKSCOUT_RESPONSE_INVALID",
      invalidRowCount: 1,
      unprocessedContractAddresses: [VIRTUAL],
      candidates: [
        {
          address: VEX,
          tokenType: "ERC-20",
          indexerBalanceRaw: "1",
          indexerDecimals: 18,
          providerFlags: { reputation: "ok" },
        },
      ],
    });

    expect(observation.failed).toBe(false);
    expect(observation.exhaustive).toBe(false);
    expect(observation.candidates).toEqual([{ address: VEX, providerFlags: { reputation: "ok" } }]);
    // The identities the provider named and its own validation could not read
    // are carried, not counted away.
    expect(observation.unprocessedContractAddresses).toEqual([VIRTUAL]);
  });
});
