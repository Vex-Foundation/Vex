/**
 * The deposit binding itself: what `bound: true` is allowed to mean, and what
 * the unverified-selector report is allowed to remember.
 *
 * TWO RULES ARE PINNED HERE.
 *
 * 1. A CONFIRMED SIGNATURE IS NOT AUTOMATICALLY A BOUND. `0x5a1ee3ac`
 *    (`depositErc20(address,address,bytes32)`) appears in the same verified
 *    `RelayDepository` source as the four-argument overload, but it encodes no
 *    amount and carries no native value: the depository pulls the whole
 *    EFFECTIVE allowance. The approve guard binds a grant this plan CONTAINS,
 *    and Relay legitimately omits the approve step when an allowance already
 *    exists, so nothing on this path proves that allowance equals `bridgedRaw`.
 *    Reporting it `bound: true` would tell the caller the principal was proven
 *    when it was not, so it is refused until an exact allowance read exists.
 *
 * 2. THE UNVERIFIED-SELECTOR DEDUP IS BOUNDED. Half of every dedup key (the
 *    selector) is provider-controlled, and the map used to grow for the life of
 *    the process. It is now a fixed-capacity LRU whose evictions are counted in
 *    the log line, so a reader can tell a shape may be reported twice rather
 *    than believing the dedup was exact.
 */

import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, getAddress } from "viem";

const info = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: { info: (...args: unknown[]) => info(...args), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { verifyBridgeDepositCalldata, logUnverifiedDepositSelector } = await import(
  "@tools/evm-chains/bridge-deposit-calldata.js"
);

const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const DEPOSITORY = getAddress("0x4cD00E387622C35bDDB9b4c962C136462338BC31");
const PRINCIPAL = 5_000_000n;

/** `depositErc20(depositor, token, id)` - the three-argument, amount-free overload. */
function allowancePullData(): string {
  const body = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
    [WALLET, USDC, `0x${"11".repeat(32)}`],
  );
  return `0x5a1ee3ac${body.slice(2)}`;
}

/** `depositErc20(depositor, token, amount, id)` - the bindable overload. */
function boundDepositData(amount: bigint = PRINCIPAL): string {
  const body = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [WALLET, USDC, amount, `0x${"11".repeat(32)}`],
  );
  return `0xe8017952${body.slice(2)}`;
}

describe("verifyBridgeDepositCalldata - the allowance-pulling overload is refused, never bound", () => {
  const plan = { originToken: USDC, wallet: WALLET, principalRaw: PRINCIPAL };

  it("refuses `0x5a1ee3ac` and names the selector, so the agent can re-quote", () => {
    const verdict = verifyBridgeDepositCalldata(
      { to: DEPOSITORY, data: allowancePullData(), value: 0n },
      plan,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("deposit_allowance_pull_unbindable");
      expect(verdict.detail).toContain("0x5a1ee3ac");
      expect(verdict.detail).toMatch(/allowance/i);
    }
  });

  it("refuses it even when the depositor and the token are this plan's own", () => {
    // Every argument it DOES encode is correct; the refusal is about the
    // argument it does not encode, which is the only one that moves money.
    const verdict = verifyBridgeDepositCalldata(
      { to: DEPOSITORY, data: allowancePullData(), value: 0n },
      plan,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "deposit_allowance_pull_unbindable" });
  });

  it("refuses it when Vex derived no principal at all", () => {
    // A `null` principal is exactly the state in which the receipt floor is the
    // only amount rule, so an unbindable pull must not slip through as bound.
    const verdict = verifyBridgeDepositCalldata(
      { to: DEPOSITORY, data: allowancePullData(), value: 0n },
      { originToken: USDC, wallet: WALLET, principalRaw: null },
    );
    expect(verdict).toMatchObject({ ok: false, reason: "deposit_allowance_pull_unbindable" });
  });

  it("still binds the four-argument overload the live captures carry", () => {
    expect(verifyBridgeDepositCalldata({ to: DEPOSITORY, data: boundDepositData(), value: 0n }, plan))
      .toEqual({ ok: true, bound: true, signature: "depositErc20(address,address,uint256,bytes32)" });
  });

  it("still refuses the four-argument overload when the amount is not the principal", () => {
    expect(verifyBridgeDepositCalldata({ to: DEPOSITORY, data: boundDepositData(1n), value: 0n }, plan))
      .toMatchObject({ ok: false, reason: "deposit_principal_mismatch" });
  });

  it("still records, rather than refuses, a selector no authority confirms", () => {
    expect(verifyBridgeDepositCalldata({ to: DEPOSITORY, data: `0xabcdef01${"00".repeat(32)}`, value: 0n }, plan))
      .toEqual({ ok: true, bound: false, selector: "0xabcdef01" });
  });
});

describe("logUnverifiedDepositSelector - provider-controlled keys are bounded", () => {
  /** One more than the module's capacity, so the cap is crossed exactly once. */
  const OVER_CAPACITY = 65;

  function report(index: number): void {
    logUnverifiedDepositSelector({
      venue: "relay.bridge",
      chainId: 8453,
      selector: `0x${index.toString(16).padStart(8, "0")}`,
      target: DEPOSITORY,
    });
  }

  it("reports each shape once, then evicts the oldest key and says how many it dropped", () => {
    info.mockClear();
    for (let index = 0; index < OVER_CAPACITY; index++) report(index);
    // Every distinct shape is still REPORTED: the bound is on what is
    // remembered, never on what the operator is told.
    expect(info).toHaveBeenCalledTimes(OVER_CAPACITY);
    const repeated = info.mock.calls.length;
    // The shape reported most recently is still deduplicated.
    report(OVER_CAPACITY - 1);
    expect(info.mock.calls.length).toBe(repeated);

    // The OLDEST shape was evicted to make room, so it reports a second time -
    // and the line carries the eviction count that explains why.
    report(0);
    expect(info.mock.calls.length).toBe(repeated + 1);
    const last = info.mock.calls.at(-1);
    const meta = last?.[1] as { dedupEvictedKeys?: number } | undefined;
    expect(meta?.dedupEvictedKeys).toBeGreaterThan(0);
  });
});
