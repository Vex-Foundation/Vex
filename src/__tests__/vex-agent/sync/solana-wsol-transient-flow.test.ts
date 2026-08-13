/**
 * The instruction-level native-SOL decoder, proven against the two VERBATIM
 * mainnet captures whose wrapped-SOL account is created and closed inside the
 * transaction (`fixtures/jupiter-settlement/`), plus the tampered variants those
 * captures cannot contain.
 *
 * The amounts asserted below were read out of the instruction stream by hand
 * before the decoder existed:
 *   - `3SC5Mi5L` wraps 15,000,000 lamports with one System Transfer, spends them
 *     across THREE token debits (3,531,150 + 11,431,350 + 37,500) and pays a
 *     SEPARATE 1,000,000-lamport tip to another account;
 *   - `3ewjUYAG` receives 40,177,809 lamports of wrapped SOL into the transient
 *     account and closes it, so the close payout is that plus 2,039,280 of rent -
 *     which is exactly why the payout is never the amount.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { decodeTransientWsolFlow } from "@vex-agent/sync/solana-activity-repair/wsol-transient-flow.js";

const WALLET = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";

function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/jupiter-settlement/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** A deep copy, so a tampered variant cannot leak into another test. */
function variant(name: string): Record<string, any> {
  return JSON.parse(JSON.stringify(fixture(name))) as Record<string, any>;
}

const wrapInput = "swap-sol-to-usdc-3SC5Mi5L";
const unwrapOutput = "swap-usdc-to-sol-3ewjUYAG";

describe("decodeTransientWsolFlow - real mainnet transient flows", () => {
  it("proves the wrapped INPUT principal, not the tip and not the rent", () => {
    expect(decodeTransientWsolFlow(fixture(wrapInput), { owner: WALLET, direction: "input" })).toEqual({
      outcome: "proven",
      lamports: 15_000_000n,
    });
  });

  it("proves the unwrapped OUTPUT as the net credit, not the close payout", () => {
    expect(decodeTransientWsolFlow(fixture(unwrapOutput), { owner: WALLET, direction: "output" })).toEqual({
      outcome: "proven",
      lamports: 40_177_809n,
    });
  });

  it("refuses to read a funded wrap account as an output", () => {
    expect(decodeTransientWsolFlow(fixture(wrapInput), { owner: WALLET, direction: "output" })).toEqual({
      outcome: "declined",
      reason: "unexpected_funding_for_output",
    });
  });

  it("refuses to read an unwrap account as an input", () => {
    expect(decodeTransientWsolFlow(fixture(unwrapOutput), { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "no_principal_transfer",
    });
  });

  it.each(["input", "output"] as const)("finds no candidate in an all-SPL route (%s)", (direction) => {
    expect(
      decodeTransientWsolFlow(fixture("swap-jupusd-to-usdc-3g3NAiBJ"), { owner: WALLET, direction }),
    ).toEqual({ outcome: "declined", reason: "no_transient_candidate" });
  });

  it("reads nothing for a wallet that owns no account in the transaction", () => {
    expect(
      decodeTransientWsolFlow(fixture(wrapInput), { owner: "NotOurWallet11111111111111111111111111111", direction: "input" }),
    ).toEqual({ outcome: "declined", reason: "no_transient_candidate" });
  });
});

describe("decodeTransientWsolFlow - refusals", () => {
  it("declines a transaction that carried an on-chain error", () => {
    const body = variant(wrapInput);
    body.meta.err = { InstructionError: [4, "Custom"] };
    expect(decodeTransientWsolFlow(body, { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "on_chain_error",
    });
  });

  it("declines when a lookup table's addresses were not resolved", () => {
    // Every index past the static keys then points at nothing, and an unresolved
    // index could read as "not our wallet" and turn a refusal into a wrong amount.
    const body = variant(wrapInput);
    delete body.meta.loadedAddresses;
    expect(decodeTransientWsolFlow(body, { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "unresolved_account_index",
    });
  });

  it("declines when the account already held a balance - it was not created here", () => {
    const body = variant(wrapInput);
    body.meta.preTokenBalances.push({
      accountIndex: 1,
      mint: "So11111111111111111111111111111111111111112",
      owner: WALLET,
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      uiTokenAmount: { amount: "5", decimals: 9, uiAmount: null, uiAmountString: "5" },
    });
    expect(decodeTransientWsolFlow(body, { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "preexisting_balance",
    });
  });

  it("declines when the account is never closed back to the wallet", () => {
    const body = variant(wrapInput);
    body.transaction.message.instructions = body.transaction.message.instructions.filter(
      (ix: { data: string }) => ix.data !== "A", // the CloseAccount instruction
    );
    expect(decodeTransientWsolFlow(body, { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "no_transient_candidate",
    });
  });

  it("declines when SyncNative does not follow the funding transfer", () => {
    const body = variant(wrapInput);
    body.transaction.message.instructions = body.transaction.message.instructions.filter(
      (ix: { data: string }) => ix.data !== "J", // the SyncNative instruction
    );
    expect(decodeTransientWsolFlow(body, { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "sync_native_missing_or_misordered",
    });
  });

  it("declines when the debits out of the account do not sum to the principal", () => {
    // Residual flow: part of the wrapped principal never reached a pool, so the
    // principal is not what the swap consumed.
    const body = variant(wrapInput);
    const route = body.meta.innerInstructions.find((group: { index: number }) => group.index === 6);
    route.instructions = route.instructions.filter(
      (ix: { accounts: number[]; data: string }) => !(ix.accounts[0] === 1 && ix.data.length > 1),
    );
    expect(decodeTransientWsolFlow(body, { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "debits_do_not_match_principal",
    });
  });

  it("declines when a second wallet-owned transient wrap account exists", () => {
    const body = variant(wrapInput);
    const create = body.meta.innerInstructions.find((group: { index: number }) => group.index === 1);
    const clone = JSON.parse(JSON.stringify(create.instructions)) as { accounts: number[] }[];
    // Re-point the cloned create/init at another account index, and close it too.
    for (const ix of clone) ix.accounts = ix.accounts.map((account) => (account === 1 ? 3 : account));
    body.meta.innerInstructions.push({ index: 5, instructions: clone });
    body.transaction.message.instructions.push({
      accounts: [3, 0, 0],
      data: "A",
      programIdIndex: 11,
      stackHeight: 1,
    });
    expect(decodeTransientWsolFlow(body, { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "multiple_transient_candidates",
    });
  });

  it("declines an output whose transient account was SYNCED - wrapped lamports are not swap proceeds", () => {
    // The account can be given lamports by the `CreateAccount` that opens it,
    // which is not a System Transfer; a `SyncNative` would then turn those
    // lamports into a wrapped balance that nets out as a credit. Output value
    // may only ever come from SPL token credits.
    const body = variant(unwrapOutput);
    body.transaction.message.instructions.splice(3, 0, {
      accounts: [1],
      data: "J", // SyncNative on the transient candidate
      programIdIndex: 14, // the SPL Token program in this capture's key table
      stackHeight: 1,
    });
    expect(decodeTransientWsolFlow(body, { owner: WALLET, direction: "output" })).toEqual({
      outcome: "declined",
      reason: "unexpected_funding_for_output",
    });
  });

  it("declines a body it cannot read at all", () => {
    expect(decodeTransientWsolFlow({ meta: { err: null } }, { owner: WALLET, direction: "input" })).toEqual({
      outcome: "declined",
      reason: "unreadable_body",
    });
  });
});
