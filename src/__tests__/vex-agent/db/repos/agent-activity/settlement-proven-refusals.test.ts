/**
 * THE REFUSAL CONTRACT OF THE SETTLEMENT-PROVEN WRITER, proved where it has to
 * hold: BEFORE any SQL runs.
 *
 * A caller writes this row inside its own money transaction, so a refusal that
 * reached the database would either abort that transaction on a CHECK or, worse,
 * write a row the EVM claim lane can never select. Every case here therefore
 * asserts two things: the typed reason the caller records, and that the client
 * was never touched at all.
 *
 * The positive path and every CHECK it satisfies are proved against real
 * PostgreSQL in `src/__tests__/integration/repos/settlement-proven-activity.int.test.ts`;
 * a fake client cannot prove a constraint.
 */

import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import {
  insertSettlementProvenActivityRowWith,
  type SettlementProvenActivityInput,
} from "@vex-agent/db/repos/agent-activity/settlement-proven.js";
import { testPoolClient } from "../../../../helpers/pool-client.js";

const HASH = `0x${"b".repeat(64)}`;
const WALLET = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** Any query at all is a failure: a refusal writes nothing and reads nothing. */
function forbiddenClient(): PoolClient {
  return testPoolClient({
    query: (): never => {
      throw new Error("the settlement-proven writer touched the database on a refused input");
    },
  });
}

function input(
  overrides: Partial<SettlementProvenActivityInput> = {},
): SettlementProvenActivityInput {
  return {
    eventRole: "exchange_deposit",
    protocol: "lighter",
    sessionId: "session-1",
    walletAddress: WALLET,
    execution: { toolId: "lighter.deposit", namespace: "lighter", intentParams: {} },
    chainId: 1,
    txHash: HASH,
    fromAddress: WALLET,
    nonce: 7,
    asset: { address: USDC, symbol: "USDC", decimals: 6 },
    amountRaw: "11000000",
    venueEvidence: { environment: "core" },
    ...overrides,
  };
}

describe("settlement-proven activity writer refusals", () => {
  it("refuses a deposit with no recorded sender and writes nothing", async () => {
    const outcome = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ fromAddress: null }),
    );

    expect(outcome).toMatchObject({ outcome: "refused", reason: "no_signed_leg" });
  });

  it("refuses a deposit with no recorded nonce and writes nothing", async () => {
    // The nonce is not cosmetic here: migration 045's
    // `agent_activity_evm_signed_leg_has_nonce` rejects an eip155 row that
    // carries a hash without one, and the observed-row escape hatch is closed
    // for a non-bridge row by 049. There is no weaker row to write.
    const outcome = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ nonce: null }),
    );

    expect(outcome).toMatchObject({ outcome: "refused", reason: "no_signed_leg" });
  });

  it("refuses a malformed settlement hash", async () => {
    const outcome = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ txHash: "0xnothex" }),
    );

    expect(outcome).toMatchObject({ outcome: "refused", reason: "malformed_signed_leg" });
  });

  it("refuses a sender that is not an address", async () => {
    const outcome = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ fromAddress: "not-an-address" }),
    );

    expect(outcome).toMatchObject({ outcome: "refused", reason: "malformed_signed_leg" });
  });

  it("refuses a negative or unsafe nonce", async () => {
    const negative = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ nonce: -1 }),
    );
    const unsafe = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ nonce: Number.MAX_SAFE_INTEGER + 2 }),
    );

    expect(negative).toMatchObject({ outcome: "refused", reason: "malformed_signed_leg" });
    expect(unsafe).toMatchObject({ outcome: "refused", reason: "malformed_signed_leg" });
  });

  it("refuses an amount that is not positive atomic units", async () => {
    for (const amountRaw of ["0", "1.5", "-1", "1e6", ""]) {
      const outcome = await insertSettlementProvenActivityRowWith(
        forbiddenClient(),
        input({ amountRaw }),
      );
      expect(outcome).toMatchObject({ outcome: "refused", reason: "malformed_amount" });
    }
  });

  it("refuses an asset whose decimals or address cannot be read", async () => {
    const decimals = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ asset: { address: USDC, symbol: "USDC", decimals: 6.5 } }),
    );
    const address = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ asset: { address: "0x00", symbol: "USDC", decimals: 6 } }),
    );

    expect(decimals).toMatchObject({ outcome: "refused", reason: "malformed_asset" });
    expect(address).toMatchObject({ outcome: "refused", reason: "malformed_asset" });
  });

  it("states a reason a caller can record, never a bare failure", async () => {
    const outcome = await insertSettlementProvenActivityRowWith(
      forbiddenClient(),
      input({ fromAddress: null, nonce: null }),
    );

    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome !== "refused") throw new Error("expected a refusal");
    expect(outcome.detail).toContain("signed");
  });
});
