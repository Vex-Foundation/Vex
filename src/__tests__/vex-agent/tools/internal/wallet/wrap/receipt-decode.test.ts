/**
 * `decodeWrapSettlement` - what a mined EVM wrap or unwrap receipt PROVES.
 *
 * The decoder is the single settlement rule behind two callers (the wrap
 * confirm handler and the pending-fallback sweep), so what it accepts is what
 * both of them will write into `executed_amount_*`. Four properties are pinned
 * here, and each of them is a way a wrong decode would report money that did
 * not move:
 *
 *  1. THE EMITTER IS BOUND. Only the wrapped-native contract this row approved
 *     may supply the quantity. A `Deposit` from any other address in the same
 *     transaction proves nothing about this wrapper, and matching it would let
 *     an unrelated event in the same receipt set both executed legs.
 *  2. THE PARTY IS BOUND. The indexed `dst`/`src` must be this wallet. A
 *     wrapper event for somebody else is not this row.
 *  3. THE NATIVE LEG OF A WRAP COMES FROM THE SIGNED TRANSACTION, NEVER FROM A
 *     LOG. `deposit()` is payable and a native movement emits nothing, so the
 *     declared `value` is the only evidence; absent, the leg is unknowable and
 *     the decode must decline rather than invent it from the credit.
 *  4. AMOUNTS ARE DECIMAL DIGIT STRINGS, exact past IEEE-754. One case is
 *     driven with 2^90 wei, which `Number` cannot hold, and the returned
 *     strings are compared character for character.
 *
 * THE EVENT TOPICS ARE DERIVED, NOT PASTED. Every topic below is computed with
 * viem's `toEventSelector` from the event signature, so a fixture cannot agree
 * with a wrong constant in the module under test: if the decoder's hand-written
 * hash drifted from the real one, its `topics[0]` comparison would miss and
 * every decode here would return null. That is rule 10's "wire names come from
 * machine artifacts" applied to an ABI the receipts themselves carry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { toEventSelector } from "viem";

/**
 * The anomaly warn is part of the contract under test (a silent decline of a
 * self-consistent receipt is indistinguishable from "not mined yet"), so the
 * logger is a TYPED fake rather than a cast-through-unknown spy: `vi.hoisted`
 * gives the mock factory a fully typed `warn` whose `mock.calls` need no
 * assertion to read.
 */
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn<(message: string, meta: Record<string, unknown>) => void>(),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: loggerMock.warn, error: vi.fn() },
}));

const { decodeWrapSettlement } = await import(
  "@vex-agent/tools/internal/wallet/wrap/receipt-decode.js"
);
type WrapSettlementLog =
  import("@vex-agent/tools/internal/wallet/wrap/receipt-decode.js").WrapSettlementLog;
type WrapReceiptVerdict =
  import("@vex-agent/tools/internal/wallet/wrap/receipt-decode.js").WrapReceiptVerdict;
type WrapDecodedSettlement =
  import("@vex-agent/tools/internal/wallet/wrap/receipt-decode.js").WrapDecodedSettlement;

/**
 * The proven legs of a verdict that MUST be `settled`. It throws rather than
 * returning undefined so a case that silently stopped settling fails on the
 * spot instead of comparing `undefined` to `undefined`.
 */
function legsOf(verdict: WrapReceiptVerdict): WrapDecodedSettlement {
  if (verdict.kind !== "settled") {
    throw new Error(`expected a settled verdict, got ${verdict.kind}`);
  }
  return verdict.legs;
}

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const OTHER_WALLET = "0x9999888877776666555544443333222211110000";
const WETH = "0x4200000000000000000000000000000000000006";
const OTHER_CONTRACT = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ZERO = "0x0000000000000000000000000000000000000000";

/** `Deposit(address indexed dst, uint wad)` - the WETH9 credit event. */
const DEPOSIT_TOPIC = toEventSelector("Deposit(address,uint256)");
/** `Withdrawal(address indexed src, uint wad)`. */
const WITHDRAWAL_TOPIC = toEventSelector("Withdrawal(address,uint256)");
/** `Transfer(address indexed from, address indexed to, uint value)`. */
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

function pad(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** The wrapper's own credit event: `Deposit(dst = wallet, wad = amount)`. */
function depositLog(contract: string, dst: string, amount: bigint): WrapSettlementLog {
  return { address: contract, topics: [DEPOSIT_TOPIC, pad(dst)], data: word(amount) };
}

/** The wrapper's own debit event: `Withdrawal(src = wallet, wad = amount)`. */
function withdrawalLog(contract: string, src: string, amount: bigint): WrapSettlementLog {
  return { address: contract, topics: [WITHDRAWAL_TOPIC, pad(src)], data: word(amount) };
}

function transferLog(
  contract: string,
  from: string,
  to: string,
  amount: bigint,
): WrapSettlementLog {
  return {
    address: contract,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: word(amount),
  };
}

const ONE_ETH = 1_000_000_000_000_000_000n;

/**
 * 2^90 wei. `Number(2n ** 90n)` is 1.2379400392853803e+27 and round-trips to
 * 1237940039285380274899124224 only by luck of the nearest double; a decoder
 * that touched Number anywhere on this path would show up on the digits.
 */
const BEYOND_SAFE_INTEGER = 2n ** 90n;

describe("decodeWrapSettlement - a wrap the receipt proves", () => {
  it("decodes both legs from the Deposit plus the mint Transfer", () => {
    const decoded = decodeWrapSettlement({
      logs: [
        depositLog(WETH, WALLET, ONE_ETH),
        transferLog(WETH, ZERO, WALLET, ONE_ETH),
      ],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: ONE_ETH.toString(),
    });

    expect(decoded).toEqual({
      kind: "settled",
      legs: {
        executedAmountInRaw: ONE_ETH.toString(),
        executedAmountOutRaw: ONE_ETH.toString(),
      },
    });
  });

  it("the executed NATIVE INPUT is exactly the signed transaction's declared value", () => {
    // The point is not that the two numbers happen to be equal here: it is that
    // the decoder refuses to publish a native leg the transaction did not
    // declare. A credit of one ETH against a transaction that declared one wei
    // less describes two different transactions, and there is no tolerance.
    const declared = ONE_ETH - 1n;
    const decoded = decodeWrapSettlement({
      logs: [depositLog(WETH, WALLET, ONE_ETH), transferLog(WETH, ZERO, WALLET, ONE_ETH)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: declared.toString(),
    });
    expect(decoded.kind).toBe("undecodable");

    // CONTRACT CHANGE (fix round C, H2): this case used to assert that a
    // SMALLER self-consistent fill settled at the smaller number. It no longer
    // does, and must not: `deposit()` credits exactly the value sent, so a
    // receipt one wei under the approval is not a partial fill of the approved
    // operation - it is a different transaction, or a different intent. Both
    // legs stay unknown and the row stays a repair-lane candidate.
    const shortButSelfConsistent = decodeWrapSettlement({
      logs: [depositLog(WETH, WALLET, declared), transferLog(WETH, ZERO, WALLET, declared)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: declared.toString(),
    });
    expect(shortButSelfConsistent.kind).toBe("amount_mismatch");

    // The same receipt against the approval it actually matches DOES settle,
    // which is what proves the rejection above came from the approved-amount
    // comparison and not from some other predicate in the chain.
    const matching = decodeWrapSettlement({
      logs: [depositLog(WETH, WALLET, declared), transferLog(WETH, ZERO, WALLET, declared)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: declared.toString(),
      declaredValueRaw: declared.toString(),
    });
    expect(legsOf(matching).executedAmountInRaw).toBe(declared.toString());
  });

  it("decodes without the mint Transfer at all - not every wrapper emits one", () => {
    const decoded = decodeWrapSettlement({
      logs: [depositLog(WETH, WALLET, ONE_ETH)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: ONE_ETH.toString(),
    });
    expect(decoded).toEqual({
      kind: "settled",
      legs: {
        executedAmountInRaw: ONE_ETH.toString(),
        executedAmountOutRaw: ONE_ETH.toString(),
      },
    });
  });
});

describe("decodeWrapSettlement - an unwrap the receipt proves", () => {
  it("decodes both legs from the Withdrawal plus the burn Transfer", () => {
    const decoded = decodeWrapSettlement({
      logs: [
        transferLog(WETH, WALLET, ZERO, ONE_ETH),
        withdrawalLog(WETH, WALLET, ONE_ETH),
      ],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "unwrap",
      amountRaw: ONE_ETH.toString(),
    });

    expect(decoded).toEqual({
      kind: "settled",
      legs: {
        executedAmountInRaw: ONE_ETH.toString(),
        executedAmountOutRaw: ONE_ETH.toString(),
      },
    });
  });

  it("needs no native output log, because `withdraw` emits none by construction", () => {
    // The logs below are the WHOLE receipt: there is no event anywhere that
    // records the native payout, and there cannot be - `withdraw(uint256)` pays
    // the caller with a plain value transfer. The output leg IS the `wad`, and
    // an unwrap therefore never consults a declared value.
    const logs = [withdrawalLog(WETH, WALLET, ONE_ETH)];
    const decoded = decodeWrapSettlement({
      logs,
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "unwrap",
      amountRaw: ONE_ETH.toString(),
    });

    expect(decoded).toEqual({
      kind: "settled",
      legs: {
        executedAmountInRaw: ONE_ETH.toString(),
        executedAmountOutRaw: ONE_ETH.toString(),
      },
    });
    // No log in the receipt carries the native payout, so nothing but the
    // 1:1 rule could have produced the output leg.
    expect(logs.filter((log) => log.topics[0] === TRANSFER_TOPIC)).toEqual([]);
  });
});

describe("decodeWrapSettlement - what the evidence does NOT prove", () => {
  it("ignores a Deposit emitted by a DIFFERENT contract and returns null", () => {
    // Same event, same wallet, same amount - from a wrapper this row never
    // approved. Accepting it would let any unrelated contract in the receipt
    // supply both executed legs.
    const decoded = decodeWrapSettlement({
      logs: [
        depositLog(OTHER_CONTRACT, WALLET, ONE_ETH),
        transferLog(OTHER_CONTRACT, ZERO, WALLET, ONE_ETH),
      ],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: ONE_ETH.toString(),
    });
    expect(decoded.kind).toBe("undecodable");
  });

  it("returns null when the indexed party is a different wallet", () => {
    const wrap = decodeWrapSettlement({
      logs: [depositLog(WETH, OTHER_WALLET, ONE_ETH)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: ONE_ETH.toString(),
    });
    expect(wrap.kind).toBe("undecodable");

    const unwrap = decodeWrapSettlement({
      logs: [withdrawalLog(WETH, OTHER_WALLET, ONE_ETH)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "unwrap",
      amountRaw: ONE_ETH.toString(),
    });
    expect(unwrap.kind).toBe("undecodable");
  });

  it("returns null when the Transfer evidence DISAGREES with the wrapper event", () => {
    // A discrepancy, not a settlement. The two facts describe different
    // quantities, so neither may be published as the executed amount.
    const wrap = decodeWrapSettlement({
      logs: [
        depositLog(WETH, WALLET, ONE_ETH),
        transferLog(WETH, ZERO, WALLET, ONE_ETH - 1n),
      ],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: ONE_ETH.toString(),
    });
    expect(wrap.kind).toBe("undecodable");

    // The approved amount AGREES with the wrapper event here, on purpose: the
    // amount rule (below) would otherwise decline first and this case would
    // stop proving anything about the evidence leg.
    const unwrap = decodeWrapSettlement({
      logs: [
        withdrawalLog(WETH, WALLET, ONE_ETH),
        transferLog(WETH, WALLET, ZERO, ONE_ETH + 1n),
      ],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "unwrap",
      amountRaw: ONE_ETH.toString(),
    });
    expect(unwrap.kind).toBe("undecodable");
  });

  it("a wrap with NO declaredValueRaw returns null instead of inventing the native leg", () => {
    // The credit is right there in the Deposit, and it is deliberately NOT
    // enough: without the signed transaction's own value there is no proof the
    // native input came from this wallet's transaction at all.
    const decoded = decodeWrapSettlement({
      logs: [depositLog(WETH, WALLET, ONE_ETH), transferLog(WETH, ZERO, WALLET, ONE_ETH)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
    });
    expect(decoded.kind).toBe("undecodable");
  });

});

/**
 * THE APPROVED AMOUNT IS AN EQUALITY (fix round C, H2).
 *
 * `deposit()` credits exactly the transaction's value and `withdraw(amount)`
 * burns exactly `amount`: there is no router, no partial fill and no slippage
 * on this call shape, so the wrapper event MUST equal the approved amount. Any
 * other quantity is a settlement anomaly - a receipt from a different
 * transaction, a row bound to the wrong intent, or a wrapper that is not the
 * WETH9 shape this lane assumes - and none of those may be settled.
 *
 * The one-raw-unit tolerance the swap lanes carry is explicitly NOT inherited.
 *
 * Declining is what keeps the anomaly non-terminal: with no decode the executed
 * legs stay NULL, so the activity row remains a candidate of the correction
 * lane instead of being stamped with a quantity nothing proved. Each anomaly
 * also emits ONE structured warn naming BOTH numbers, because a silent decline
 * of a self-consistent receipt is indistinguishable from "not mined yet".
 */
describe("decodeWrapSettlement - the approved amount is an equality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function warnPayloads(): Record<string, unknown>[] {
    return loggerMock.warn.mock.calls
      .filter(([message]) => message === "wallet.wrap.settlement_amount_mismatch")
      .map(([, meta]) => meta);
  }

  it("the EXACT approved amount settles, and warns about nothing", () => {
    const decoded = decodeWrapSettlement({
      logs: [depositLog(WETH, WALLET, ONE_ETH), transferLog(WETH, ZERO, WALLET, ONE_ETH)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: ONE_ETH.toString(),
    });
    expect(decoded).toEqual({
      kind: "settled",
      legs: {
        executedAmountInRaw: ONE_ETH.toString(),
        executedAmountOutRaw: ONE_ETH.toString(),
      },
    });
    expect(warnPayloads()).toEqual([]);
  });

  it("one raw unit UNDER the approval declines and warns with both numbers", () => {
    const short = ONE_ETH - 1n;
    const decoded = decodeWrapSettlement({
      logs: [withdrawalLog(WETH, WALLET, short), transferLog(WETH, WALLET, ZERO, short)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "unwrap",
      amountRaw: ONE_ETH.toString(),
    });
    // Named as the ANOMALY, not "undecodable": the durable consequence
    // differs, and collapsing the two is the defect that let a contradicted
    // amount settle as though it had merely been unreadable.
    expect(decoded).toEqual({
      kind: "amount_mismatch",
      approvedAmountRaw: ONE_ETH.toString(),
      observedAmountRaw: short.toString(),
    });
    expect(warnPayloads()).toEqual([
      {
        direction: "unwrap",
        contractAddress: WETH,
        approvedAmountRaw: ONE_ETH.toString(),
        observedAmountRaw: short.toString(),
      },
    ]);
  });

  it("one raw unit OVER the approval is refused the same way", () => {
    const over = ONE_ETH + 1n;
    const decoded = decodeWrapSettlement({
      logs: [depositLog(WETH, WALLET, over), transferLog(WETH, ZERO, WALLET, over)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: over.toString(),
    });
    expect(decoded.kind).toBe("amount_mismatch");
    expect(warnPayloads()).toEqual([
      {
        direction: "wrap",
        contractAddress: WETH,
        approvedAmountRaw: ONE_ETH.toString(),
        observedAmountRaw: over.toString(),
      },
    ]);
  });

  it("NO wrapper event at all is an ordinary decline, NOT an anomaly warn", () => {
    // The distinction matters operationally: "this receipt says nothing about
    // this row yet" is the normal state of a row the sweep re-reads, and
    // warning on it would bury the real anomalies above.
    const decoded = decodeWrapSettlement({
      logs: [depositLog(OTHER_CONTRACT, WALLET, ONE_ETH)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: ONE_ETH.toString(),
    });
    expect(decoded.kind).toBe("undecodable");
    expect(warnPayloads()).toEqual([]);
  });

  it("the warn carries NO wallet address and NO calldata", () => {
    decodeWrapSettlement({
      logs: [depositLog(WETH, WALLET, ONE_ETH + 1n)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: ONE_ETH.toString(),
      declaredValueRaw: (ONE_ETH + 1n).toString(),
    });
    const serialized = JSON.stringify(warnPayloads());
    expect(serialized).not.toContain(WALLET.slice(2));
    expect(serialized).not.toContain("0xd0e30db0");
  });
});

describe("decodeWrapSettlement - amounts are exact decimal strings", () => {
  it("carries a value beyond IEEE-754 integer precision with no rounding", () => {
    const raw = BEYOND_SAFE_INTEGER.toString();
    // The guard on the guard: if this value were safe, the test would prove
    // nothing about precision.
    expect(Number.isSafeInteger(Number(raw))).toBe(false);

    const decoded = decodeWrapSettlement({
      logs: [
        depositLog(WETH, WALLET, BEYOND_SAFE_INTEGER),
        transferLog(WETH, ZERO, WALLET, BEYOND_SAFE_INTEGER),
      ],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "wrap",
      amountRaw: raw,
      declaredValueRaw: raw,
    });

    expect(decoded.kind).toBe("settled");
    expect(legsOf(decoded).executedAmountInRaw).toBe("1237940039285380274899124224");
    expect(legsOf(decoded).executedAmountOutRaw).toBe("1237940039285380274899124224");
    expect(legsOf(decoded).executedAmountInRaw).toBe(raw);
  });

  it("returns decimal digit strings, never hex and never a number", () => {
    const decoded = decodeWrapSettlement({
      logs: [withdrawalLog(WETH, WALLET, ONE_ETH)],
      walletAddress: WALLET,
      contractAddress: WETH,
      direction: "unwrap",
      amountRaw: ONE_ETH.toString(),
    });
    expect(typeof legsOf(decoded).executedAmountInRaw).toBe("string");
    expect(legsOf(decoded).executedAmountInRaw).toMatch(/^[1-9][0-9]*$/);
    expect(legsOf(decoded).executedAmountOutRaw).toMatch(/^[1-9][0-9]*$/);
  });
});
