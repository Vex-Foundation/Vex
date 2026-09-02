/**
 * The `protocol = 'wallet_wrap'` arm of the venue dispatch: the pending-fallback
 * sweep's only route to the wrap decoder.
 *
 * Driven through `decodeVenueSettlement` rather than through the decoder
 * directly, because the arm is where the INPUTS are resolved and where the
 * three-way contract is decided, and neither is visible from the decoder's own
 * signature. What is pinned:
 *
 *  1. A decodable row comes back `decoded` WITH BOTH LEGS. The wrap arm is the
 *     only one that establishes two legs from one proven quantity, so a
 *     regression to a single leg would leave every repaired row incomplete
 *     forever under `roleLegsIncomplete`.
 *  2. AN UNDECODABLE ROW DECLINES BY NAME. `amounts_undecodable` is a durable
 *     fact the sweep stores; falling through to the unmapped-protocol arm, or
 *     to a generic wallet-relative reading, would be a different claim.
 *  3. A ROW WHOSE CHAIN READ DID NOT ANSWER DEFERS, and specifically does NOT
 *     decline. This is the distinction the whole three-way result type exists
 *     for: a decline stamps the decoder version and retires the row, while a
 *     deferral learned nothing and must leave it eligible for the next pass. A
 *     wrap's native input is not in any log, so an unreadable transaction is
 *     exactly that state; an UNWRAP takes no chain read and can never reach it.
 *  4. THE ARM IS BOUND TO ITS TWO ROLES. A `wallet_wrap` row carrying any other
 *     role must not enter this branch: the branch reads the wrapped-native
 *     contract off a role-dependent column, so a row it does not understand
 *     would be judged against the wrong leg.
 *
 * The bound contract is deliberately the ROW'S OWN wrapped-native leg, never a
 * registry lookup, so a receipt is always judged against the deployment the
 * human approved. The "wrong contract" case below is what proves it.
 */

import { describe, it, expect } from "vitest";
import { toEventSelector } from "viem";

import { decodeVenueSettlement } from "@vex-agent/sync/executed-amount-fallback/venue-dispatch.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type {
  DepositEvidenceDeps,
  MinedTransaction,
} from "@vex-agent/sync/executed-amount-fallback/deposit-evidence-resolver.js";

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const WETH = "0x4200000000000000000000000000000000000006";
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO = "0x0000000000000000000000000000000000000000";
const TX_HASH = "0xfeed000000000000000000000000000000000000000000000000000000000001";
const CHAIN_ID = 8453;

const DEPOSIT_TOPIC = toEventSelector("Deposit(address,uint256)");
const WITHDRAWAL_TOPIC = toEventSelector("Withdrawal(address,uint256)");
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

const AMOUNT = 2_500_000_000_000_000_000n;

function pad(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

const WRAP_LOGS = [
  { address: WETH, topics: [DEPOSIT_TOPIC, pad(WALLET)], data: word(AMOUNT) },
  { address: WETH, topics: [TRANSFER_TOPIC, pad(ZERO), pad(WALLET)], data: word(AMOUNT) },
];

const UNWRAP_LOGS = [
  { address: WETH, topics: [TRANSFER_TOPIC, pad(WALLET), pad(ZERO)], data: word(AMOUNT) },
  { address: WETH, topics: [WITHDRAWAL_TOPIC, pad(WALLET)], data: word(AMOUNT) },
];

/**
 * A confirmed-but-amountless wrap row, as the sweep selects it. The native leg
 * is the sentinel and the wrapped leg is the bound contract; the direction
 * decides which side each sits on, which is exactly what the arm reads.
 */
function wrapRow(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    protocol: "wallet_wrap",
    eventRole: "wrap",
    kind: "wrap",
    chainId: CHAIN_ID,
    walletAddress: WALLET,
    tokenInAddress: NATIVE_SENTINEL,
    tokenOutAddress: WETH,
    amountInRaw: AMOUNT.toString(),
    amountOutRaw: AMOUNT.toString(),
    txHash: TX_HASH,
    ...overrides,
  } as AgentActivityEvent;
}

function unwrapRow(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return wrapRow({
    eventRole: "unwrap",
    tokenInAddress: WETH,
    tokenOutAddress: NATIVE_SENTINEL,
    ...overrides,
  });
}

const MINED_WRAP: MinedTransaction = {
  from: WALLET,
  to: WETH,
  input: "0xd0e30db0",
  valueRaw: AMOUNT.toString(),
};

/** Chain reads are scripted per test; an unexpected receipt read is a failure. */
function depsWith(transaction: MinedTransaction | null): DepositEvidenceDeps {
  return {
    fetchReceiptStatus: async () => {
      throw new Error("the wrap arm must not read a receipt status");
    },
    fetchTransaction: async () => transaction,
  };
}

/** Deps that PROVE no chain read happened at all - the unwrap contract. */
const NO_CHAIN_READ: DepositEvidenceDeps = {
  fetchReceiptStatus: async () => {
    throw new Error("the wrap arm must not read a receipt status");
  },
  fetchTransaction: async () => {
    throw new Error("an unwrap takes no chain read and must never fetch a transaction");
  },
};

describe("venue dispatch: wallet_wrap decodes", () => {
  it("a wrap row returns BOTH legs from the receipt and the signed value", async () => {
    const result = await decodeVenueSettlement({
      row: wrapRow(),
      logs: WRAP_LOGS,
      hint: null,
      deps: depsWith(MINED_WRAP),
    });

    expect(result).toEqual({
      kind: "decoded",
      amounts: {
        executedAmountInRaw: AMOUNT.toString(),
        executedAmountOutRaw: AMOUNT.toString(),
      },
    });
  });

  it("an unwrap row returns both legs WITHOUT touching the chain", async () => {
    // The deps throw on any read. Passing them proves the unwrap path is
    // provable from the receipt alone, which is why it can never defer.
    const result = await decodeVenueSettlement({
      row: unwrapRow(),
      logs: UNWRAP_LOGS,
      hint: null,
      deps: NO_CHAIN_READ,
    });

    expect(result).toEqual({
      kind: "decoded",
      amounts: {
        executedAmountInRaw: AMOUNT.toString(),
        executedAmountOutRaw: AMOUNT.toString(),
      },
    });
  });
});

describe("venue dispatch: wallet_wrap declines by name", () => {
  it("declines an unwrap whose receipt carries no wrapper event for this wallet", async () => {
    const result = await decodeVenueSettlement({
      row: unwrapRow(),
      logs: [],
      hint: null,
      deps: NO_CHAIN_READ,
    });

    expect(result.kind).toBe("declined");
    if (result.kind !== "declined") throw new Error("expected a decline");
    expect(result.reason).toBe("amounts_undecodable");
    // The arm's own sentence, not the unmapped-protocol fallthrough's.
    expect(result.detail).toContain("the receipt does not prove this unwrap");
  });

  it("declines a wrap whose mined transaction called a DIFFERENT contract", async () => {
    const result = await decodeVenueSettlement({
      row: wrapRow(),
      logs: WRAP_LOGS,
      hint: null,
      deps: depsWith({ ...MINED_WRAP, to: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" }),
    });

    expect(result.kind).toBe("declined");
    if (result.kind !== "declined") throw new Error("expected a decline");
    expect(result.reason).toBe("amounts_undecodable");
    expect(result.detail).toContain("did not call this row's wrapped-native contract");
  });

  it("declines a row whose wrapped-native leg is a native sentinel", async () => {
    // Both legs native is not a wrap this decoder can judge: there is no
    // wrapper contract whose events could establish the quantity.
    const result = await decodeVenueSettlement({
      row: wrapRow({ tokenOutAddress: NATIVE_SENTINEL }),
      logs: WRAP_LOGS,
      hint: null,
      deps: depsWith(MINED_WRAP),
    });

    expect(result.kind).toBe("declined");
    if (result.kind !== "declined") throw new Error("expected a decline");
    expect(result.detail).toContain("native sentinel");
  });
});

describe("venue dispatch: wallet_wrap defers rather than declines", () => {
  it("a wrap whose signed transaction cannot be read DEFERS - nothing was learned", async () => {
    // The genuinely-unavailable input. A decline here would retire a row whose
    // evidence is intact and merely unread this pass, and the sweep would never
    // look at it again.
    const result = await decodeVenueSettlement({
      row: wrapRow(),
      logs: WRAP_LOGS,
      hint: null,
      deps: depsWith(null),
    });

    expect(result.kind).toBe("deferred");
    if (result.kind !== "deferred") throw new Error("expected a deferral");
    expect(result.detail).toContain("could not be read this pass");
  });

  it("the same row DECODES on a later pass once the read answers", async () => {
    // The other half of what deferral means: eligibility was preserved, so the
    // identical row is decodable the moment the transport recovers.
    const row = wrapRow();
    const deferred = await decodeVenueSettlement({
      row, logs: WRAP_LOGS, hint: null, deps: depsWith(null),
    });
    expect(deferred.kind).toBe("deferred");

    const later = await decodeVenueSettlement({
      row, logs: WRAP_LOGS, hint: null, deps: depsWith(MINED_WRAP),
    });
    expect(later.kind).toBe("decoded");
  });

  it("a MISSING hash is not a deferral - it is a decline, because it will never arrive", async () => {
    const result = await decodeVenueSettlement({
      row: wrapRow({ txHash: null }),
      logs: WRAP_LOGS,
      hint: null,
      deps: depsWith(MINED_WRAP),
    });

    expect(result.kind).toBe("declined");
    if (result.kind !== "declined") throw new Error("expected a decline");
    expect(result.detail).toContain("no transaction hash");
  });
});

describe("venue dispatch: the arm is bound to its two roles", () => {
  const foreignRoles = ["swap", "allowance", "bridge_deposit", "lend_deposit"] as const;

  for (const role of foreignRoles) {
    it(`a wallet_wrap row with eventRole '${role}' does NOT match the arm`, async () => {
      const result = await decodeVenueSettlement({
        row: wrapRow({ eventRole: role as AgentActivityEvent["eventRole"] }),
        logs: WRAP_LOGS,
        hint: null,
        deps: NO_CHAIN_READ,
      });

      expect(result.kind).toBe("declined");
      if (result.kind !== "declined") throw new Error("expected a decline");
      expect(result.reason).toBe("amounts_undecodable");
      // The UNMAPPED-PROTOCOL sentence, which is the proof it fell past the
      // wrap branch rather than being judged by it.
      expect(result.detail).toBe(
        'no settlement decoder is wired for protocol "wallet_wrap"',
      );
    });
  }
});

/**
 * THE AMOUNT ANOMALY KEEPS THE ROW ELIGIBLE.
 *
 * A decline normally COMPLETES the decoder's work on a row: the sweep stamps
 * the decoder-set version and the row stops being selected until somebody bumps
 * it. That is right when the decline means "this decoder set cannot read this
 * receipt", and WRONG when it means "the receipt contradicts the approved
 * amount" - the second is a fact about the money, and burning the row's
 * eligibility would make an unresolved anomaly go quiet.
 *
 * So this arm reports `keepsEligibility`, and the caller
 * (`sync/executed-amount-fallback.ts`) skips the version stamp for it.
 */
describe("venue dispatch: a wrap whose receipt contradicts the approved amount", () => {
  /** The same receipt, one raw unit under what the row approved. */
  const SHORT = AMOUNT - 1n;
  const SHORT_WRAP_LOGS = [
    { address: WETH, topics: [DEPOSIT_TOPIC, pad(WALLET)], data: word(SHORT) },
    { address: WETH, topics: [TRANSFER_TOPIC, pad(ZERO), pad(WALLET)], data: word(SHORT) },
  ];

  it("declines AND keeps the row eligible for the next pass", async () => {
    const result = await decodeVenueSettlement({
      row: wrapRow(),
      logs: SHORT_WRAP_LOGS,
      hint: null,
      deps: depsWith({ ...MINED_WRAP, valueRaw: SHORT.toString() }),
    });

    expect(result.kind).toBe("declined");
    if (result.kind !== "declined") throw new Error("expected a decline");
    // THE POINT. Without this the sweep stamps the decoder version and the row
    // is never selected again, which is how the anomaly read as resolved.
    expect(result.keepsEligibility).toBe(true);
    // Both numbers travel in the detail so an operator can size the gap.
    expect(result.detail).toContain(SHORT.toString());
    expect(result.detail).toContain(AMOUNT.toString());
  });

  it("an ORDINARY undecodable wrap does NOT keep eligibility", async () => {
    // The contrast case: no wrapper event for this wallet at all. Nothing was
    // learned about the money, the decoder set is simply done with this row,
    // and the version stamp is correct there.
    const result = await decodeVenueSettlement({
      row: wrapRow(),
      logs: [],
      hint: null,
      deps: depsWith(MINED_WRAP),
    });

    expect(result.kind).toBe("declined");
    if (result.kind !== "declined") throw new Error("expected a decline");
    expect(result.keepsEligibility).toBeUndefined();
  });
});
