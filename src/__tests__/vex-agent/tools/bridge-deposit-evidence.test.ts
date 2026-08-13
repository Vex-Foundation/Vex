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

const { proveErc20DepositAmount, authorizedDepositRecipients } = await import(
  "@vex-agent/tools/protocols/bridge-deposit-evidence.js"
);
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

  it("accepts a fee-on-transfer shortfall only while ONE candidate remains", () => {
    // The token skimmed its own fee to a third party, so the deposit log carries
    // less than the plan. The deposit transfer is still the single candidate.
    const feeSkim = transferLog({ to: STRANGER, amount: 10_000n });
    const outcome = request({
      logs: [feeSkim, transferLog({ amount: 990_000n })],
      expectedAmountRaw: "1000000",
    });
    expect(outcome).toEqual({ kind: "proven", amountRaw: "990000" });
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

  it("proves a transfer within the spender's effective allowance", () => {
    const outcome = request({
      logs: [transferLog({ to: STRANGER, amount: 400_000n })],
      recipients: spenderRecipients(400_000n),
    });
    expect(outcome).toEqual({ kind: "proven", amountRaw: "400000" });
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
