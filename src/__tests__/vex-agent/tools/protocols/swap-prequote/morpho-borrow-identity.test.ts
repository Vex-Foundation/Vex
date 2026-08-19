/**
 * Morpho Blue BORROW-lane prequote identity and block wording (E3c, migration
 * 081).
 *
 * THE PROPERTY THAT MATTERS MOST is that the four operations cannot authorize
 * each other. They run against the SAME market and the SAME wallet, and two of
 * them can carry the same raw amount, so if they shared a kind a
 * collateral-supply quote could authorize a BORROW execute: the wallet would
 * have approved putting money in and been charged with taking debt out. These
 * cases pin that the kind tag makes that structurally impossible, that the
 * market id, the amount and the slippage are bound, that a full-debt repayment
 * has its own stable identity, and that a blocked borrow never gets worded as a
 * swap.
 *
 * Pure functions only: no DB, no chain, no wallet resolution.
 */

import { describe, expect, it } from "vitest";

import type { GateBlockReason } from "@vex-agent/tools/protocols/prequote/gate-errors.js";
import { block } from "@vex-agent/tools/protocols/prequote/gate/messages.js";
import { computePrequoteMatchHash } from "@vex-agent/tools/protocols/prequote/identity/hash.js";
import type { MorphoBorrowMatchInput } from "@vex-agent/tools/protocols/prequote/identity/hash.js";

const ALL_REASONS: readonly GateBlockReason[] = [
  "gate_error",
  "no_session",
  "unresolved_token",
  "no_quote",
  "safety_fail",
  "wallet_setup",
  "wallet_scope",
  "wallet_not_selected",
  "unbindable_param",
];

const MARKET_ID = "0xB323495F7E4148BE5643A4EA4A8221EEF163E4BCCFDEDC2A6F4696BAACBC86CC";
const WALLET = "0x1111111111111111111111111111111111111111";
const VAULT = "0x4200000000000000000000000000000000000006";

const BASE = {
  sessionId: "session-081",
  provider: "morpho",
  chainId: 8453,
  marketId: MARKET_ID,
  walletAddress: WALLET,
  amount: "1047061",
  slippageBps: "50",
} as const;

const SUPPLY_COLLATERAL: MorphoBorrowMatchInput = { ...BASE, kind: "lend_supply_collateral" };
const WITHDRAW_COLLATERAL: MorphoBorrowMatchInput = { ...BASE, kind: "lend_withdraw_collateral" };
const BORROW: MorphoBorrowMatchInput = { ...BASE, kind: "lend_borrow" };
const REPAY: MorphoBorrowMatchInput = { ...BASE, kind: "lend_repay", repayFullDebt: false };

describe("a Morpho borrow-lane quote authorizes only its own operation", () => {
  it("gives the four operations four different match hashes even on identical material", () => {
    // Same market, same wallet, same raw amount, same slippage: ONLY the kind
    // tag differs. If any two collided, one operation's quote would authorize
    // the other's execute.
    const sameMaterial = [SUPPLY_COLLATERAL, WITHDRAW_COLLATERAL, BORROW, REPAY] as const;
    const hashes = sameMaterial.map((input) => computePrequoteMatchHash(input));
    expect(new Set(hashes).size, "two borrow-lane operations share a match hash").toBe(4);
  });

  it("does not collide with the vault lend kinds on the same wallet and amount", () => {
    const vaultDeposit = computePrequoteMatchHash({
      kind: "lend_deposit",
      sessionId: BASE.sessionId,
      provider: "morpho",
      chainId: 8453,
      walletAddress: WALLET,
      receiver: WALLET,
      vault: VAULT,
      amount: BASE.amount,
      slippageBps: "50",
    });
    for (const input of [SUPPLY_COLLATERAL, WITHDRAW_COLLATERAL, BORROW, REPAY]) {
      expect(computePrequoteMatchHash(input)).not.toBe(vaultDeposit);
    }
  });
});

describe("the identity binds what a substitution would change", () => {
  it("binds the MARKET ID, since two markets can share a loan token", () => {
    const other = computePrequoteMatchHash({
      ...BORROW,
      marketId: "0x" + "a".repeat(64),
    });
    expect(other).not.toBe(computePrequoteMatchHash(BORROW));
  });

  it("does NOT need to bind the token or its decimals, because the market id already does", () => {
    // A Morpho Blue market id is the hash of the market's own params, so the id
    // plus the kind determine the exact token the amount is denominated in and
    // therefore its scale. Binding the token as well would force the gate to
    // read the market from chain to build an identity, and a gate that needs
    // the network to decide is a gate that fails open on a bad RPC. Two
    // DIFFERENT markets still diverge, which is the property that matters.
    const otherMarket = computePrequoteMatchHash({ ...BORROW, marketId: "0x" + "b".repeat(64) });
    expect(otherMarket).not.toBe(computePrequoteMatchHash(BORROW));
  });

  it("binds the SLIPPAGE, so an execute cannot widen what the quote priced", () => {
    expect(computePrequoteMatchHash({ ...BORROW, slippageBps: "500" })).not.toBe(
      computePrequoteMatchHash(BORROW),
    );
  });

  it("binds the wallet and the chain", () => {
    expect(computePrequoteMatchHash({ ...BORROW, walletAddress: "0x" + "2".repeat(40) })).not.toBe(
      computePrequoteMatchHash(BORROW),
    );
    expect(computePrequoteMatchHash({ ...BORROW, chainId: 1 })).not.toBe(
      computePrequoteMatchHash(BORROW),
    );
  });

  it("gives a FULL-DEBT repayment its own identity, distinct from any exact one", () => {
    // A full-debt repayment carries no amount at all: its size is the position's
    // own share count, read from chain. It must still be stable and it must not
    // collide with an exact repayment, or a quote that priced closing the whole
    // debt would authorize repaying an arbitrary amount.
    const fullDebt: MorphoBorrowMatchInput = { ...REPAY, amount: "", repayFullDebt: true };
    const fullDebtAgain: MorphoBorrowMatchInput = { ...REPAY, amount: "", repayFullDebt: true };

    expect(computePrequoteMatchHash(fullDebt)).toBe(computePrequoteMatchHash(fullDebtAgain));
    expect(computePrequoteMatchHash(fullDebt)).not.toBe(computePrequoteMatchHash(REPAY));
  });

  it("is case-insensitive on the market id and the addresses, since both are hex", () => {
    expect(
      computePrequoteMatchHash({
        ...BORROW,
        marketId: MARKET_ID.toLowerCase(),
        walletAddress: WALLET.toUpperCase().replace("0X", "0x"),
      }),
    ).toBe(computePrequoteMatchHash(BORROW));
  });
});

describe("a blocked borrow-lane execute speaks the right language", () => {
  const KINDS = [
    ["lend_supply_collateral", "Collateral supply blocked"],
    ["lend_withdraw_collateral", "Collateral withdrawal blocked"],
    ["lend_borrow", "Borrow blocked"],
    ["lend_repay", "Repay blocked"],
  ] as const;

  it("never falls through to the SWAP wording, for any kind and any reason", () => {
    // A kind registered WITHOUT a message map inherits the swap fallback, which
    // would tell the agent to re-run a swap quote: a tool that cannot authorize
    // any of these operations. The agent would loop on advice that cannot work.
    for (const [kind, prefix] of KINDS) {
      for (const reason of ALL_REASONS) {
        const decision = block(reason, kind);
        // NARROWED, not asserted. `block()` returns the whole `GateDecision`
        // union, and only the blocking variant carries a message; reading
        // `.message` off the union would need a cast, which would also hide a
        // future change that stopped this returning a block at all.
        if (decision.kind !== "block") {
          throw new Error(`${kind}/${reason} did not produce a block decision`);
        }
        expect(decision.message, `${kind}/${reason} fell through to the swap map`).not.toContain(
          "Swap blocked",
        );
        expect(decision.message, `${kind}/${reason} is not worded for its operation`).toContain(
          prefix,
        );
      }
    }
  });

  /** The blocking variant's message, or a failure naming what came back instead. */
  function blockMessage(kind: Parameters<typeof block>[1]): string {
    const decision = block("no_quote", kind);
    if (decision.kind !== "block") throw new Error(`${kind} did not produce a block decision`);
    return decision.message;
  }

  it("tells a blocked borrow that a collateral quote will not authorize it", () => {
    expect(blockMessage("lend_borrow")).toContain("collateral quote does NOT authorize");
  });

  it("tells a blocked collateral withdrawal that a supply quote will not authorize it", () => {
    expect(blockMessage("lend_withdraw_collateral")).toContain("supplyCollateral quote does NOT authorize");
  });
});
