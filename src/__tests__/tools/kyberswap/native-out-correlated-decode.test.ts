/**
 * THE NATIVE-OUT RULE (R2 stage F2) — ONE rule, correlated, corroborated.
 *
 * The old rule accepted a native output leg only from a canonical
 * `Withdrawal(address indexed src, uint256 wad)` whose `src` is the ROUTER.
 * Two real receipts on two chains defeat that binding:
 *
 * - Robinhood 4663 (the owner's own swap, the transaction that motivated this
 *   entire workstream): NO `Withdrawal` at all — the WETH clone BURNS, i.e.
 *   `Transfer(src -> 0x0)`.
 * - Base 8453 (`./fixtures/base-native-settlement-receipts.json`,
 *   tx 0x70d2…ed65): a canonical `Withdrawal` whose `src` is the KYBER EXECUTOR
 *   `0x8f10…f996`, not the router — which is exactly why
 *   `decodeKyberSwapSettlement` returned `null` for it.
 *
 * The replacement is NOT "trust any unwrap". It is:
 *
 *   1. exactly ONE `Swapped` emitted BY THE VERIFIED ROUTER for this row;
 *   2. its `sender` and `dstReceiver` are the row's wallet, its `srcToken` is
 *      the row's input token, its `dstToken` is the native sentinel;
 *   3. `returnAmount` is the executed output;
 *   4. REQUIRED corroboration: exactly one same-value unwrap of the chain's
 *      wrapped native — a `Withdrawal` from router OR executor, or a burn
 *      `Transfer(src -> 0x0)`;
 *   5. anything else — absence, ambiguity, a second candidate, a value
 *      mismatch, a missing correlation field — DECLINES BY NAME.
 *
 * Why corroboration is REQUIRED and not optional: it has NOT been verified from
 * Kyber's contract source that `Swapped` is emitted only after `returnAmount` is
 * actually delivered. Rule 4 is what makes the rule safe without that proof, so
 * it must not be relaxed to "optional" without obtaining it.
 *
 * And the finding that STANDS: `Swapped.spentAmount` must NEVER be used for
 * `executedAmountIn`, because the Vex fee is a component of the input — the
 * fixture's own numbers say so (4000000 debited = 3990000 spent + 10000 fee).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  decodeKyberSwapSettlement,
  type SwapSettlementLog,
} from "@tools/kyberswap/evm/swap-settlement.js";

interface FixtureReceipt {
  readonly txHash: string;
  readonly chainId: number;
  readonly from: string;
  readonly to: string;
  readonly logs: readonly SwapSettlementLog[];
}

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/base-native-settlement-receipts.json", import.meta.url),
    "utf8",
  ),
) as Record<string, FixtureReceipt> & {
  readonly _notes: Record<string, string>;
};

const KYBER = FIXTURE.kyber_usdc_to_native_eth_base;
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** The ROUTER — the receipt's `to`, and the address that emits `Swapped`. */
const ROUTER = KYBER.to;
/** The EXECUTOR — emits the Withdrawal. NOT the router; that is the whole point. */
const EXECUTOR = "0x8f10b468b06c6fd214b65f87778827f7d113f996";
const WALLET = KYBER.from;

/** From the fixture's own recorded expectation. */
const EXPECTED_OUT_WEI = "2149469568496706";
/** The wallet's true USDC debit — fee INCLUDED, which is why spentAmount is wrong for it. */
const EXPECTED_IN_RAW = "4000000";

function decode(over: Partial<Parameters<typeof decodeKyberSwapSettlement>[0]> = {}) {
  return decodeKyberSwapSettlement({
    logs: KYBER.logs,
    walletAddress: WALLET,
    tokenIn: { isNative: false, address: BASE_USDC },
    tokenOut: { isNative: true, address: "0x0000000000000000000000000000000000000000" },
    wrappedNativeAddress: BASE_WETH,
    wrappedNativeWithdrawalSource: ROUTER,
    routerAddress: ROUTER,
    ...over,
  });
}

describe("the Base receipt whose unwrap came from the EXECUTOR", () => {
  it("decodes both legs — the case the router-bound rule returned null for", () => {
    expect(decode()).toEqual({
      amountInRaw: EXPECTED_IN_RAW,
      amountOutRaw: EXPECTED_OUT_WEI,
    });
  });

  it("takes the INPUT from the wallet's own net delta, never Swapped.spentAmount", () => {
    // 4000000 debited = 3990000 `spentAmount` + 10000 fee. Using spentAmount
    // would under-report what the user actually paid by exactly the Vex fee.
    expect(decode()?.amountInRaw).toBe("4000000");
    expect(decode()?.amountInRaw).not.toBe("3990000");
  });

  it("decodes when the corroborating unwrap comes from the ROUTER instead", () => {
    const logs = KYBER.logs.map((log) =>
      log.topics[1]?.toLowerCase() === `0x${"0".repeat(24)}${EXECUTOR.slice(2)}`
        ? { ...log, topics: [log.topics[0], `0x${"0".repeat(24)}${ROUTER.slice(2).toLowerCase()}`] as string[] }
        : log,
    );
    expect(decode({ logs })?.amountOutRaw).toBe(EXPECTED_OUT_WEI);
  });
});

describe("it DECLINES rather than guessing", () => {
  /** Strip every wrapped-native unwrap (Withdrawal and burn) from the receipt. */
  const WITHDRAWAL_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ZERO_PADDED = `0x${"0".repeat(64)}`;

  function withoutUnwraps(logs: readonly SwapSettlementLog[]): SwapSettlementLog[] {
    return logs.filter((log) => {
      if (log.address.toLowerCase() !== BASE_WETH.toLowerCase()) return true;
      if (log.topics[0] === WITHDRAWAL_TOPIC) return false;
      return !(log.topics[0] === TRANSFER_TOPIC && log.topics[2] === ZERO_PADDED);
    });
  }

  it("with NO unwrap at all — corroboration is required, not optional", () => {
    expect(decode({ logs: withoutUnwraps(KYBER.logs) })).toBeNull();
  });

  it("when the Swapped event is not emitted by the verified router", () => {
    // Neither proof applies: no `Swapped` from this address, and no
    // `Withdrawal` bound to it either.
    expect(decode({
      routerAddress: "0x000000000000000000000000000000000000dead",
      wrappedNativeWithdrawalSource: "0x000000000000000000000000000000000000dead",
    })).toBeNull();
  });

  it("when dstReceiver is not our wallet", () => {
    expect(decode({ walletAddress: "0x000000000000000000000000000000000000beef" })).toBeNull();
  });

  it("when NO verified router is supplied at all — nothing is inferred", () => {
    // Both names must be absent: the handler has always supplied the verified
    // router under the older `wrappedNativeWithdrawalSource`, and that remains a
    // valid way to name it.
    expect(decode({ routerAddress: undefined, wrappedNativeWithdrawalSource: undefined }))
      .toBeNull();
  });

  it("when the unwrap value DISAGREES with returnAmount", () => {
    const logs = KYBER.logs.map((log) =>
      log.address.toLowerCase() === BASE_WETH.toLowerCase()
        && log.topics[0] === WITHDRAWAL_TOPIC
        ? { ...log, data: `0x${(1n).toString(16).padStart(64, "0")}` }
        : log,
    );
    expect(decode({ logs })).toBeNull();
  });

  it("when a SECOND same-value unwrap makes the corroboration ambiguous", () => {
    const unwrap = KYBER.logs.find(
      (log) => log.address.toLowerCase() === BASE_WETH.toLowerCase()
        && log.topics[0] === WITHDRAWAL_TOPIC,
    );
    expect(unwrap).toBeDefined();
    expect(decode({ logs: [...KYBER.logs, unwrap as SwapSettlementLog] })).toBeNull();
  });

  it("never throws on attacker-shaped log data — it declines", () => {
    const logs = [...KYBER.logs, {
      address: BASE_WETH,
      topics: [WITHDRAWAL_TOPIC, `0x${"0".repeat(24)}${EXECUTOR.slice(2)}`],
      data: "0xnot-a-word",
    }];
    expect(() => decode({ logs })).not.toThrow();
  });
});

describe("the ERC-20 → ERC-20 path is unaffected", () => {
  it("still uses net wallet delta and needs no router correlation", () => {
    const result = decodeKyberSwapSettlement({
      logs: KYBER.logs,
      walletAddress: WALLET,
      tokenIn: { isNative: false, address: BASE_USDC },
      tokenOut: { isNative: false, address: BASE_WETH },
    });
    // The wallet received no WETH in this receipt (it received native), so the
    // received leg legitimately declines — the point is that it did not throw
    // and did not need a router.
    expect(result).toBeNull();
  });
});
