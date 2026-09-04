/**
 * The compensation that stands in for a `pending` block tag that subtracts
 * nothing.
 *
 * THE DEFECT THIS CLOSES, in one sentence: on Arbitrum, Optimism, Sonic, Monad,
 * BSC, HyperEVM and MegaETH the endpoint answers `pending` with the head block
 * or has no pending block at all (measured, WP2-E0), so a read taken at
 * `pending` there cannot see this wallet's own unconfirmed spending, and a swap
 * could be authorized against money an in-flight transfer had already taken.
 *
 * WHAT THE FIX IS ALLOWED TO CLAIM. Vex knows what VEX broadcast, because every
 * EVM transaction it sends owns a durable row before the signature exists. So
 * "no in-flight row" makes the `latest` read current for every spend this
 * application can know about - and nothing more than that. The third-party
 * spend from the same key stays invisible and is named in the pin note rather
 * than papered over.
 *
 * WHAT WE DO STRICTLY BETTER THAN THE REFERENCE. MetaMask's own helper falls
 * back from `pending` to `latest` and returns the result as the same fact
 * (`transaction-pay-controller/src/utils/token.ts:369-390`,
 * `requestBalanceWithFallback`), with no per-chain knowledge of whether the tag
 * meant anything in the first place and no compensation when it did not.
 */

import { describe, it, expect, vi } from "vitest";

import {
  judgePendingObservation,
  PENDING_COMPENSATION_CAUSES,
} from "@vex-agent/tools/protocols/quote-authority/pending-debit-compensation.js";

const WALLET = "0x1111111111111111111111111111111111111111";

/** Base: measured with a pending block one above head. */
const PENDING_REAL = 8453;
/** Arbitrum: measured answering `pending` with the head block itself. */
const PENDING_DEAD = 42161;

describe("judging whether a pending observation is current", () => {
  it("takes the chain's own word on an endpoint with a real pending state, and asks the database nothing", async () => {
    const readInFlight = vi.fn(async () => true);

    const verdict = await judgePendingObservation(
      { chainId: PENDING_REAL, wallet: WALLET },
      readInFlight,
    );

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.basis).toBe("chain_pending_state");
    // The tag already did the subtraction. Querying anyway would spend a round
    // trip to learn something the read has already accounted for - and, as the
    // stub's `true` shows, would refuse a swap the chain can answer for.
    expect(readInFlight).not.toHaveBeenCalled();
  });

  it("accepts the read on a pending-dead chain when this wallet has nothing in flight", async () => {
    const verdict = await judgePendingObservation(
      { chainId: PENDING_DEAD, wallet: WALLET },
      async () => false,
    );

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    // The basis is named, and it is NOT the chain's: a caller that logs this
    // can tell which of the two guarantees it actually had.
    expect(verdict.basis).toBe("durable_in_flight_accounting");
    expect(verdict.capability.state).toBe("head_alias");
  });

  it("refuses on a pending-dead chain while any broadcast of ours is unresolved", async () => {
    const verdict = await judgePendingObservation(
      { chainId: PENDING_DEAD, wallet: WALLET },
      async () => true,
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // FAIL CLOSED and by its own name: nothing is known to be missing from the
    // wallet, so this may never be reported as `insufficient_balance`
    // (contract C2.3). What is missing is the ability to check.
    expect(verdict.cause).toBe(PENDING_COMPENSATION_CAUSES.inFlightBroadcast);
  });

  it("refuses when the durable record itself cannot be read", async () => {
    const verdict = await judgePendingObservation(
      { chainId: PENDING_DEAD, wallet: WALLET },
      async () => {
        throw new Error("database unreachable");
      },
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.cause).toBe(PENDING_COMPENSATION_CAUSES.inFlightStateUnreadable);
  });

  it("refuses an unmeasured chain rather than assuming its pending tag works", async () => {
    const readInFlight = vi.fn(async () => false);

    const verdict = await judgePendingObservation(
      { chainId: 1337, wallet: WALLET },
      readInFlight,
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.cause).toBe(PENDING_COMPENSATION_CAUSES.capabilityUnknown);
    // Nothing is asked of the database either: the compensation is only
    // meaningful once the chain's own behaviour is known, and an unknown chain
    // is not a chain whose local accounting can stand in for it.
    expect(readInFlight).not.toHaveBeenCalled();
  });
});
