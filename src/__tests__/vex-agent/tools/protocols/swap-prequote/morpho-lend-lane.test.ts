/**
 * THE LANE DISCRIMINATOR: `lend_deposit` / `lend_withdraw` are now shared by two
 * genuinely different operations.
 *
 * A curated VAULT deposit and a Blue MARKET supply are both LENDING, so they
 * reuse one pair of kinds rather than minting a per-venue-shape pair that would
 * make "show me everything I lent" answer differently depending on which venue
 * earned it. The cost of that reuse is that the kind can no longer decide the
 * identity on its own, and these cases pin the four properties that make the
 * reuse safe rather than merely tidy:
 *
 *   1. a VAULT deposit quote cannot authorize a MARKET supply execute;
 *   2. a MARKET supply quote cannot authorize a VAULT deposit execute;
 *   3. each still authorizes its OWN lane, byte for byte;
 *   4. the vault-lane digests are UNCHANGED by the discriminator's arrival, so
 *      no prequote already recorded stops matching its own execute.
 *
 * Property 4 is why `lane` is deliberately absent from both hash materials. It
 * costs nothing to leave it out: the two materials cannot align anyway. A vault
 * deposit is 9 space-joined fields with a 40-hex VAULT ADDRESS in position 5,
 * while a market supply is 8 with a 64-hex MARKET ID there.
 *
 * Pure functions only: no DB, no chain, no wallet resolution.
 */

import { describe, expect, it } from "vitest";

import { computePrequoteMatchHash } from "@vex-agent/tools/protocols/prequote/identity/hash.js";
import type {
  LendDepositMatchInput,
  LendMarketSupplyMatchInput,
  LendMarketWithdrawMatchInput,
  LendWithdrawMatchInput,
} from "@vex-agent/tools/protocols/prequote/identity/hash.js";
import { lendHashMaterial } from "@vex-agent/tools/protocols/prequote/identity/hash/morpho-lend.js";
import { morphoBorrowHashMaterial } from "@vex-agent/tools/protocols/prequote/identity/hash/morpho-borrow.js";
import { EXECUTE_GATE_TOOLS } from "@vex-agent/tools/protocols/prequote/registry.js";

const SESSION = "session-lane";
const WALLET = "0x1111111111111111111111111111111111111111";
const VAULT = "0x4200000000000000000000000000000000000006";
const MARKET_ID = "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc";
const AMOUNT = "1047061";
const SLIPPAGE = "50";

const VAULT_DEPOSIT: LendDepositMatchInput = {
  kind: "lend_deposit",
  sessionId: SESSION,
  provider: "morpho",
  chainId: 8453,
  walletAddress: WALLET,
  receiver: WALLET,
  vault: VAULT,
  amount: AMOUNT,
  slippageBps: SLIPPAGE,
};

const VAULT_WITHDRAW: LendWithdrawMatchInput = { ...VAULT_DEPOSIT, kind: "lend_withdraw" };

const MARKET_SUPPLY: LendMarketSupplyMatchInput = {
  kind: "lend_deposit",
  lane: "market",
  sessionId: SESSION,
  provider: "morpho",
  chainId: 8453,
  marketId: MARKET_ID,
  walletAddress: WALLET,
  amount: AMOUNT,
  slippageBps: SLIPPAGE,
};

const MARKET_WITHDRAW: LendMarketWithdrawMatchInput = { ...MARKET_SUPPLY, kind: "lend_withdraw" };

describe("a vault quote cannot authorize a market execute, or the reverse", () => {
  it("gives a VAULT deposit and a MARKET supply different digests under the SAME kind", () => {
    // Same session, same wallet, same chain, same raw amount, same slippage,
    // same kind tag. Only the LANE differs, and a collision here would let a
    // curated-vault approval pay for a concentrated single-market position.
    expect(computePrequoteMatchHash(MARKET_SUPPLY)).not.toBe(computePrequoteMatchHash(VAULT_DEPOSIT));
  });

  it("gives a VAULT withdrawal and a MARKET withdrawal different digests too", () => {
    expect(computePrequoteMatchHash(MARKET_WITHDRAW)).not.toBe(computePrequoteMatchHash(VAULT_WITHDRAW));
  });

  it("keeps the two lanes apart structurally, not by luck: different arity, different anchor", () => {
    const vaultFields = lendHashMaterial(VAULT_DEPOSIT).split(" ");
    const marketFields = morphoBorrowHashMaterial(MARKET_SUPPLY).split(" ");
    expect(vaultFields).toHaveLength(9);
    expect(marketFields).toHaveLength(8);
    // Position 5 (0-indexed) is the anchor on both, and the shapes cannot be
    // confused: a 40-hex contract address against a 64-hex market id.
    expect(vaultFields[6]).toMatch(/^0x[0-9a-f]{40}$/);
    expect(marketFields[4]).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("routes the four registrations to the lane they belong to", () => {
    // `lane` only exists on the two shared kinds, so the registration is
    // narrowed by kind first. That narrowing IS the assertion's other half: a
    // registration under any other kind has no lane to read.
    const laneOf = (toolId: string): string | undefined => {
      const entry = EXECUTE_GATE_TOOLS[toolId];
      if (entry === undefined) return undefined;
      return entry.kind === "lend_deposit" || entry.kind === "lend_withdraw" ? entry.lane : undefined;
    };
    expect(laneOf("morpho.vault.deposit")).toBe("vault");
    expect(laneOf("morpho.vault.withdraw")).toBe("vault");
    expect(laneOf("morpho.market.supply")).toBe("market");
    expect(laneOf("morpho.market.withdraw")).toBe("market");
  });
});

describe("each lane still authorizes its own execute", () => {
  it("reproduces the VAULT deposit digest from an identical identity", () => {
    expect(computePrequoteMatchHash({ ...VAULT_DEPOSIT })).toBe(computePrequoteMatchHash(VAULT_DEPOSIT));
  });

  it("reproduces the MARKET supply digest from an identical identity", () => {
    expect(computePrequoteMatchHash({ ...MARKET_SUPPLY })).toBe(computePrequoteMatchHash(MARKET_SUPPLY));
  });

  it("keeps the market lane's own two operations unmixable", () => {
    expect(computePrequoteMatchHash(MARKET_SUPPLY)).not.toBe(computePrequoteMatchHash(MARKET_WITHDRAW));
  });
});

describe("the vault lane's digests are UNCHANGED by the discriminator", () => {
  /**
   * The exact material the vault lane hashed before `lane` existed, pinned as a
   * literal rather than recomputed from the function under test. A change here
   * means every prequote already recorded for a vault deposit stops matching its
   * own execute, which would block every honest vault operation in flight.
   */
  const VAULT_DEPOSIT_MATERIAL =
    "lend_deposit session-lane morpho 8453 "
    + "0x1111111111111111111111111111111111111111 0x1111111111111111111111111111111111111111 "
    + "0x4200000000000000000000000000000000000006 1047061 50";

  it("hashes the vault deposit over exactly the pre-lane material", () => {
    expect(lendHashMaterial(VAULT_DEPOSIT)).toBe(VAULT_DEPOSIT_MATERIAL);
  });

  it("ignores an explicitly stated vault lane in the material", () => {
    // The discriminator is a routing fact, not an identity field. Stating it
    // must not move the digest, or an identity built by a caller that sets it
    // would stop matching one built by a caller that does not.
    expect(lendHashMaterial({ ...VAULT_DEPOSIT, lane: "vault" })).toBe(VAULT_DEPOSIT_MATERIAL);
    expect(computePrequoteMatchHash({ ...VAULT_DEPOSIT, lane: "vault" }))
      .toBe(computePrequoteMatchHash(VAULT_DEPOSIT));
  });

  it("hashes the vault withdrawal over the same material under its own tag", () => {
    expect(lendHashMaterial(VAULT_WITHDRAW))
      .toBe(VAULT_DEPOSIT_MATERIAL.replace("lend_deposit", "lend_withdraw"));
  });
});
