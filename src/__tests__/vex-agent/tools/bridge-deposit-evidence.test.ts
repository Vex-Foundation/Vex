/**
 * The ONE rule that lets a bridge deposit declare an executed ERC-20 amount:
 * exactly one receipt `Transfer` log that matches the event's input token, the
 * signing wallet, a recipient proven by the signed transaction or the plan, a
 * positive amount, and the quote as an ABSOLUTE upper bound.
 *
 * These cases are the reason the rule exists: a quoted amount that was never
 * logged, a second candidate transfer, a transfer to somebody else, and an
 * amount above the quote must all end as a NAMED decline, never as a number
 * the AgentScan server's own ERC-20 log scan would then fail to find.
 */
import { describe, it, expect, vi } from "vitest";

// The rule under test is pure; the module's other export is the confirm-site
// writer, so the durable repo is stubbed to keep this suite off the database.
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  confirmActivityEvent: vi.fn(),
  fillExecutedAmountsOnConfirmed: vi.fn(),
  noteSettlementDeclined: vi.fn(),
  provenLegAmounts: vi.fn(),
}));

const {
  authorizedDepositRecipients,
  bridgeDepositFloor,
  FEE_ON_TRANSFER_DEDUCTIONS,
  proveErc20DepositAmount,
  withholdFeeOnDepositShortfall,
} = await import("@vex-agent/tools/protocols/bridge-deposit-evidence.js");
type DepositTransferLog =
  import("@vex-agent/tools/protocols/bridge-deposit-evidence.js").DepositTransferLog;

const TOKEN = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const OTHER_TOKEN = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const WALLET = "0x1111111111111111111111111111111111111111";
const DEPOSITORY = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function padded(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function transferLog(args: {
  token?: string;
  from?: string;
  to?: string;
  amount?: bigint;
  data?: string;
}): DepositTransferLog {
  return {
    address: args.token ?? TOKEN,
    topics: [TRANSFER_TOPIC, padded(args.from ?? WALLET), padded(args.to ?? DEPOSITORY)],
    data: args.data ?? word(args.amount ?? 1_000_000n),
  };
}

function request(overrides: Partial<Parameters<typeof proveErc20DepositAmount>[0]> = {}) {
  return proveErc20DepositAmount({
    logs: [transferLog({})],
    chainId: 8453,
    tokenAddress: TOKEN,
    senderAddress: WALLET,
    recipients: [{ address: DEPOSITORY, maxAmountRaw: null }],
    quotedAmountInRaw: "1000000",
    ...overrides,
  });
}

describe("proveErc20DepositAmount", () => {
  it("proves the amount of the single matching Transfer log", () => {
    expect(request()).toEqual({ kind: "proven", amountRaw: "1000000" });
  });

  it("matches addresses case-insensitively", () => {
    const outcome = request({
      logs: [transferLog({ token: TOKEN.toUpperCase().replace("0X", "0x") })],
      senderAddress: WALLET.toUpperCase().replace("0X", "0x"),
    });
    expect(outcome).toEqual({ kind: "proven", amountRaw: "1000000" });
  });

  it("declines when two candidate transfers are indistinguishable", () => {
    const outcome = request({ logs: [transferLog({}), transferLog({ amount: 999_999n })] });
    expect(outcome).toEqual({ kind: "declined", reason: "ambiguous_candidate_transfers", candidateCount: 2 });
  });

  it("declines when the recipient is not the one the signed transaction pays", () => {
    const outcome = request({ logs: [transferLog({ to: STRANGER })] });
    expect(outcome).toEqual({ kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 });
  });

  it("declines when the transfer moves a different token", () => {
    const outcome = request({ logs: [transferLog({ token: OTHER_TOKEN })] });
    expect(outcome).toEqual({ kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 });
  });

  it("declines when the transfer comes from another wallet", () => {
    const outcome = request({ logs: [transferLog({ from: STRANGER })] });
    expect(outcome).toEqual({ kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 });
  });

  it("declines an amount above the quoted bound, which is absolute and never a percentage", () => {
    const outcome = request({ logs: [transferLog({ amount: 1_000_001n })] });
    expect(outcome).toEqual({ kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 });
  });

  it("declines a zero-amount transfer", () => {
    const outcome = request({ logs: [transferLog({ amount: 0n })] });
    expect(outcome).toEqual({ kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 });
  });

  it("ignores a malformed data word instead of reading it as an amount", () => {
    const outcome = request({ logs: [transferLog({ data: "0x1" })] });
    expect(outcome).toEqual({ kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 });
  });

  it("ignores an ERC-721 Transfer, whose token id is an indexed fourth topic", () => {
    const erc721: DepositTransferLog = {
      address: TOKEN,
      topics: [TRANSFER_TOPIC, padded(WALLET), padded(DEPOSITORY), word(7n)],
      data: "0x",
    };
    expect(request({ logs: [erc721] })).toEqual({
      kind: "declined", reason: "no_candidate_transfer", candidateCount: 0,
    });
  });

  it("declines when the quoted bound itself is not a raw integer", () => {
    const outcome = request({ quotedAmountInRaw: "1.5" });
    expect(outcome).toEqual({ kind: "declined", reason: "unusable_evidence_request", candidateCount: 0 });
  });

  it("declines when no recipient could be proven from the signed transaction", () => {
    const outcome = request({ recipients: [] });
    expect(outcome).toEqual({ kind: "declined", reason: "unusable_evidence_request", candidateCount: 0 });
  });

  it("accepts a Vex-built TRANSFER whose logged amount equals the plan", () => {
    const outcome = request({ expectedAmountRaw: "1000000" });
    expect(outcome).toEqual({ kind: "proven", amountRaw: "1000000" });
  });

  it("uses the Vex-built plan amount to pick the one transfer that is ours", () => {
    const outcome = request({
      logs: [transferLog({ amount: 400_000n }), transferLog({ amount: 1_000_000n })],
      expectedAmountRaw: "1000000",
    });
    expect(outcome).toEqual({ kind: "proven", amountRaw: "1000000" });
  });

  it("reports a fee-on-transfer shortfall as SHORT, because no deduction is measured for this token", () => {
    // This case used to assert `proven: 990000` against a
    // quoted 1,000,000, and that acceptance is exactly the hole: the amount was
    // declared, the full fixed Vex fee then followed, and the user consented to
    // a card that said the whole 1,000,000 would travel. "Some tokens skim a
    // fee" is not evidence about THIS token; only a measured entry in
    // `FEE_ON_TRANSFER_DEDUCTIONS` lowers the floor, and it is empty.
    const feeSkim = transferLog({ to: STRANGER, amount: 10_000n });
    const outcome = request({
      logs: [feeSkim, transferLog({ amount: 990_000n })],
      expectedAmountRaw: "1000000",
    });
    expect(outcome).toEqual({ kind: "short", provenAmountRaw: "990000", quotedAmountRaw: "1000000" });
  });

  it("declines a fee-on-transfer shortfall that leaves two possible deposits", () => {
    const outcome = request({
      logs: [transferLog({ amount: 990_000n }), transferLog({ amount: 10_000n })],
      expectedAmountRaw: "1000000",
    });
    expect(outcome).toEqual({ kind: "declined", reason: "ambiguous_candidate_transfers", candidateCount: 2 });
  });

  it("accepts any of several proven recipients (deposit target or approved spender)", () => {
    const outcome = request({
      logs: [transferLog({ to: STRANGER })],
      recipients: [
        { address: DEPOSITORY, maxAmountRaw: null },
        { address: STRANGER, maxAmountRaw: null },
      ],
    });
    expect(outcome).toEqual({ kind: "proven", amountRaw: "1000000" });
  });

  it("reports a one-unit deposit against the whole quote as SHORT, not as an amount", () => {
    // The shape that used to pay a full fixed fee for a bridge that moved
    // nothing worth the name.
    expect(request({ logs: [transferLog({ amount: 1n })] }))
      .toEqual({ kind: "short", provenAmountRaw: "1", quotedAmountRaw: "1000000" });
  });

  it("proves the exact quoted principal, which is the floor", () => {
    expect(request({ logs: [transferLog({ amount: 1_000_000n })] }))
      .toEqual({ kind: "proven", amountRaw: "1000000" });
  });

  it("reports one unit below the floor as SHORT", () => {
    expect(request({ logs: [transferLog({ amount: 999_999n })] }))
      .toEqual({ kind: "short", provenAmountRaw: "999999", quotedAmountRaw: "1000000" });
  });

  it("declines an empty receipt", () => {
    expect(request({ logs: [] })).toEqual({
      kind: "declined", reason: "no_candidate_transfer", candidateCount: 0,
    });
  });
});

describe("authorizedDepositRecipients - the replayed allowance rule", () => {
  const grant = (token: string, spender: string, amountRaw: bigint) => ({ token, spender, amountRaw });

  it("authorizes the call target unconditionally, bounded only by the quote", () => {
    expect(authorizedDepositRecipients({ inputToken: TOKEN, callTarget: DEPOSITORY, approvals: [] }))
      .toEqual([{ address: DEPOSITORY, maxAmountRaw: null }]);
  });

  it("authorizes a spender granted an allowance on the INPUT token, up to that allowance", () => {
    const recipients = authorizedDepositRecipients({
      inputToken: TOKEN, callTarget: DEPOSITORY, approvals: [grant(TOKEN, STRANGER, 500n)],
    });
    expect(recipients).toContainEqual({ address: STRANGER, maxAmountRaw: 500n });
  });

  it("ignores an allowance granted on a DIFFERENT token", () => {
    const recipients = authorizedDepositRecipients({
      inputToken: TOKEN, callTarget: DEPOSITORY, approvals: [grant(OTHER_TOKEN, STRANGER, 500n)],
    });
    expect(recipients).toEqual([{ address: DEPOSITORY, maxAmountRaw: null }]);
  });

  it("a reset-only approval authorizes nobody", () => {
    const recipients = authorizedDepositRecipients({
      inputToken: TOKEN, callTarget: DEPOSITORY, approvals: [grant(TOKEN, STRANGER, 0n)],
    });
    expect(recipients).toEqual([{ address: DEPOSITORY, maxAmountRaw: null }]);
  });

  it("grant-then-reset leaves the spender revoked, because the replay is last-write-wins", () => {
    const recipients = authorizedDepositRecipients({
      inputToken: TOKEN,
      callTarget: DEPOSITORY,
      approvals: [grant(TOKEN, STRANGER, 500n), grant(TOKEN, STRANGER, 0n)],
    });
    expect(recipients).toEqual([{ address: DEPOSITORY, maxAmountRaw: null }]);
  });

  it("reset-then-grant leaves the spender authorized at the LAST amount", () => {
    const recipients = authorizedDepositRecipients({
      inputToken: TOKEN,
      callTarget: DEPOSITORY,
      approvals: [grant(TOKEN, STRANGER, 0n), grant(TOKEN, STRANGER, 900n)],
    });
    expect(recipients).toContainEqual({ address: STRANGER, maxAmountRaw: 900n });
  });
});

describe("proveErc20DepositAmount - the allowance is an absolute ceiling", () => {
  const spenderRecipients = (maxAmountRaw: bigint) => [
    { address: DEPOSITORY, maxAmountRaw: null },
    { address: STRANGER, maxAmountRaw },
  ];

  it("proves a transfer to a spender when it also reaches the quoted floor", () => {
    // The allowance is the CEILING for a spender recipient; the quoted
    // principal is still the FLOOR, so the two only agree at the principal
    // itself. That is the live shape: the approve guard binds the allowance to
    // exactly the amount being bridged.
    const outcome = request({
      logs: [transferLog({ to: STRANGER, amount: 1_000_000n })],
      recipients: spenderRecipients(1_000_000n),
    });
    expect(outcome).toEqual({ kind: "proven", amountRaw: "1000000" });
  });

  it("reports a transfer inside the allowance but under the quote as SHORT", () => {
    const outcome = request({
      logs: [transferLog({ to: STRANGER, amount: 400_000n })],
      recipients: spenderRecipients(400_000n),
    });
    expect(outcome).toEqual({ kind: "short", provenAmountRaw: "400000", quotedAmountRaw: "1000000" });
  });

  it("declines a transfer larger than the spender could ever have pulled", () => {
    const outcome = request({
      logs: [transferLog({ to: STRANGER, amount: 400_001n })],
      recipients: spenderRecipients(400_000n),
    });
    expect(outcome).toEqual({ kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 });
  });

  it("keeps the quote as the ceiling when the allowance is larger", () => {
    const outcome = request({
      logs: [transferLog({ to: STRANGER, amount: 1_000_001n })],
      recipients: spenderRecipients(10_000_000n),
    });
    expect(outcome).toEqual({ kind: "declined", reason: "no_candidate_transfer", candidateCount: 0 });
  });
});

// ── The floor and its fee-on-transfer table ────────────────────────────────

describe("bridgeDepositFloor - the deposit floor and the table that may lower it", () => {
  it("ships with an EMPTY table, so the floor is the quote itself", () => {
    expect(FEE_ON_TRANSFER_DEDUCTIONS.size).toBe(0);
    expect(bridgeDepositFloor({ chainId: 8453, tokenAddress: TOKEN, quotedRaw: 1_000_000n }))
      .toBe(1_000_000n);
  });

  it("lowers the floor by the MEASURED absolute deduction for that chain and token", () => {
    const measured = new Map<string, bigint>([[`8453:${TOKEN.toLowerCase()}`, 2_500n]]);
    expect(bridgeDepositFloor({ chainId: 8453, tokenAddress: TOKEN, quotedRaw: 1_000_000n, deductions: measured }))
      .toBe(997_500n);
  });

  it("keeps the deduction ABSOLUTE: ten times the trade gets the same allowance, not ten times it", () => {
    // Rule 90: a money tolerance is absolute, never a percentage that grows
    // with trade size. The same 2,500 units on a ten-times-larger trade.
    const measured = new Map<string, bigint>([[`8453:${TOKEN.toLowerCase()}`, 2_500n]]);
    expect(bridgeDepositFloor({ chainId: 8453, tokenAddress: TOKEN, quotedRaw: 10_000_000n, deductions: measured }))
      .toBe(9_997_500n);
  });

  it("does not apply another chain's measurement to this chain", () => {
    const measured = new Map<string, bigint>([[`1:${TOKEN.toLowerCase()}`, 2_500n]]);
    expect(bridgeDepositFloor({ chainId: 8453, tokenAddress: TOKEN, quotedRaw: 1_000_000n, deductions: measured }))
      .toBe(1_000_000n);
  });

  it("does not apply another token's measurement to this token", () => {
    const measured = new Map<string, bigint>([[`8453:${OTHER_TOKEN.toLowerCase()}`, 2_500n]]);
    expect(bridgeDepositFloor({ chainId: 8453, tokenAddress: TOKEN, quotedRaw: 1_000_000n, deductions: measured }))
      .toBe(1_000_000n);
  });
});

// ── The fee decision for a short deposit ───────────────────────────────────

describe("withholdFeeOnDepositShortfall - a short bridge is never charged", () => {
  const shortfall = { provenAmountRaw: "999999", quotedAmountRaw: "1000000" };

  it("aborts the planned fee row and takes no fee", async () => {
    const aborted: Array<readonly [number, string, number]> = [];
    const collection = await withholdFeeOnDepositShortfall({
      shortfall,
      executionId: 42,
      feeLegIndex: 2,
      logScope: "relay.bridge",
      abortPlannedFeeRow: async (fromIndex, reason, toIndexExclusive) => {
        aborted.push([fromIndex, reason, toIndexExclusive]);
      },
    });
    expect(collection.collection).toBe("not_attempted");
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.[0]).toBe(2);
  });

  it("bounds the abort to the fee row ALONE, leaving the logical fill row pending", async () => {
    // The deposit WAS submitted to the provider: it merely moved less than the
    // quote. Its `bridge_fill_expected` row is the next event index, and
    // `abortPlannedEvents` finalizes every hashless pending row from
    // `fromIndex` onward, so an unbounded abort would terminalize the
    // reconciliation row and release the in-flight guard of a live bridge.
    const aborted: Array<readonly [number, string, number]> = [];
    await withholdFeeOnDepositShortfall({
      shortfall,
      executionId: 42,
      feeLegIndex: 3,
      logScope: "khalani.bridge",
      abortPlannedFeeRow: async (fromIndex, reason, toIndexExclusive) => {
        aborted.push([fromIndex, reason, toIndexExclusive]);
      },
    });
    expect(aborted).toEqual([[3, "deposit proved less than the quoted principal", 4]]);
  });

  it("names BOTH figures in the note the agent and the human read", async () => {
    const collection = await withholdFeeOnDepositShortfall({
      shortfall, executionId: 42, feeLegIndex: 2, logScope: "khalani.bridge",
      abortPlannedFeeRow: async () => undefined,
    });
    expect(collection.collectionNote).toContain("999999");
    expect(collection.collectionNote).toContain("1000000");
    expect(collection.collectionNote).toMatch(/no vex fee was taken/i);
  });

  it("aborts nothing when this bridge planned no fee row at all", async () => {
    let called = false;
    await withholdFeeOnDepositShortfall({
      shortfall, executionId: 42, feeLegIndex: -1, logScope: "relay.bridge",
      abortPlannedFeeRow: async () => { called = true; },
    });
    expect(called).toBe(false);
  });
});
