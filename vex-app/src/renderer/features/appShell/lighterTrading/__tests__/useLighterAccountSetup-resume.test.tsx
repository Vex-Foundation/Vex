/**
 * WHAT A RETRY IS ALLOWED TO DO.
 *
 * The setup chain spends real money, so the two rules this suite pins are the
 * ones that decide whether a click costs a second deposit:
 *
 *   1. A submit whose outcome Vex CANNOT PROVE (`indeterminate`, which a
 *      Lighter deposit also reaches on `l2_pending` - confirmed on the
 *      settlement chain, credit still landing) is not a failure. It hands over
 *      to its own confirm half, which only polls.
 *   2. Retry reads the live account FIRST. The recorded step is a closure from
 *      when the step began; replaying it blindly re-runs a phase the account
 *      has moved past.
 *   3. A submit REFUSED BEFORE DISPATCH retries ITSELF, bounded, before the
 *      user is asked - while a failure reported after dispatch never does,
 *      because it may already have paid for a transaction.
 *
 * Both are driven through the real hook against a fake bridge, so a regression
 * shows up as an extra `prepareDeskAction` call rather than as prose.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LighterAccountSetupStatus,
  LighterDeskAction,
} from "@shared/schemas/lighter-trading.js";

const mocks = vi.hoisted(() => ({
  useLighterAccountSetupStatus: vi.fn(),
}));

vi.mock("../../../../lib/api/lighter-trading.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../lib/api/lighter-trading.js")
  >("../../../../lib/api/lighter-trading.js");
  return {
    ...actual,
    useLighterAccountSetupStatus: mocks.useLighterAccountSetupStatus,
  };
});

const { useLighterAccountSetup } = await import("../useLighterAccountSetup.js");

const SESSION = "11111111-1111-4111-8111-111111111111";
/** Mirrors of the hook's own schedule; a drift here shows up as a stalled case. */
const POLL_MS = 2_000;
const AUTO_RETRY_MS = [2_000, 5_000] as const;
const CONFIRM_KEY_TIMEOUT_MS = 2 * 60_000;

function status(over: Partial<LighterAccountSetupStatus> = {}): LighterAccountSetupStatus {
  return {
    environment: "rhc",
    settlementSymbol: "USDG",
    walletAddress: "0xb3920000000000000000000000000000000dDfE1",
    walletSettlementBalance: "12.97",
    nativeGasSufficient: true,
    settlementNetworkName: "Robinhood Chain mainnet",
    nativeGasSymbol: "ETH",
    minimumDeposit: "1",
    accountExists: false,
    accountCollateral: "0",
    tradingKeyRegistered: false,
    keyRegistrationResumable: false,
    feePolicy: { perpFeePercent: 0.1, spotFeePercent: 0.25 },
    feeAuthorized: false,
    ...over,
  };
}

/** The live account, as the fake bridge answers it; cases mutate it in place. */
let live: LighterAccountSetupStatus;
let prepared: Array<LighterDeskAction>;
let approveExecutionStatus: "succeeded" | "failed" | "indeterminate";
/** The dispatched result's body, as the approve reply carries it. */
let approveToolOutput: string | null;
/** Every reconcile the modal asked for; the count is the point of several cases. */
let reconcileCalls: number;
/** Flips the live key on, as a real reconcile would once the nonce lands. */
let reconcileActivatesKey: boolean;
/** Refusals the fake bridge hands back, one per `prepareDeskAction`, then none. */
let refusals: Array<string>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  );
}

function mount() {
  return renderHook(
    () =>
      useLighterAccountSetup({
        sessionId: SESSION,
        initialEnvironment: "rhc",
        open: true,
        onDone: vi.fn(),
      }),
    { wrapper },
  );
}

/**
 * Let everything pending settle: `ms` of the hook's own timers (the 2s confirm
 * poll, the auto-retry backoff) plus the promises each one resolves. Time is
 * fake, so a case that spans half a minute of polling costs nothing to run.
 */
async function tick(ms = 0): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  live = status();
  prepared = [];
  refusals = [];
  approveExecutionStatus = "succeeded";
  approveToolOutput = null;
  reconcileCalls = 0;
  reconcileActivatesKey = false;
  mocks.useLighterAccountSetupStatus.mockImplementation(() => ({
    data: { ok: true, data: live },
    isLoading: false,
  }));
  // `window.vex` is a readonly, fully-typed bridge; a test stubs a partial of
  // it. defineProperty sets it without an `as unknown as` escape (its `value`
  // is untyped) and stays re-definable across beforeEach runs.
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
    lighterTrading: {
      getAccountSetupStatus: () => ({ promise: Promise.resolve({ ok: true, data: live }) }),
      reconcileKeyRegistration: () => {
        reconcileCalls += 1;
        if (reconcileActivatesKey) {
          live = { ...live, tradingKeyRegistered: true, keyRegistrationResumable: false };
        }
        return Promise.resolve({ ok: true, data: { attempted: true, status: "active" } });
      },
      prepareDeskAction: (input: { action: LighterDeskAction }) => {
        prepared.push(input.action);
        const refusal = refusals.shift();
        return Promise.resolve(refusal === undefined
          ? { ok: true, data: { kind: "enqueued", approvalId: "appr-1" } }
          : { ok: true, data: { kind: "refused", reason: refusal } });
      },
    },
    approvals: {
      approve: () =>
        Promise.resolve({
          ok: true,
          data: {
            executionStatus: approveExecutionStatus,
            toolOutput: approveToolOutput,
            message: "approve reply message",
          },
        }),
    },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLighterAccountSetup resume rules", () => {
  it("an unprovable deposit polls for the credit instead of erroring", async () => {
    approveExecutionStatus = "indeterminate";
    const { result } = mount();

    act(() => { result.current.setAmountIn("12"); });
    act(() => { result.current.start(); });
    await tick();
    expect(prepared).toHaveLength(1);

    // The deposit landed while Vex could not prove it; the confirm half sees it
    // on its next poll and walks on to the key step of its own accord.
    live = status({ accountExists: true, accountCollateral: "12", walletSettlementBalance: "0.97" });
    await tick(POLL_MS);

    expect(prepared.some((a) => a.kind === "onboarding_key")).toBe(true);
    expect(result.current.error).toBeNull();
    // One deposit, ever - the second call is the key step, not another deposit.
    expect(prepared.filter((action) => action.kind === "onboarding_deposit")).toHaveLength(1);
  });

  it("retry after an unprovable deposit never submits a second deposit", async () => {
    approveExecutionStatus = "indeterminate";
    const { result } = mount();

    act(() => { result.current.setAmountIn("12"); });
    act(() => { result.current.start(); });
    await tick();
    expect(result.current.phase).toBe("confirming_deposit");

    // The account moved on AFTER the step that is still recorded for resume.
    live = status({ accountExists: true, accountCollateral: "12", walletSettlementBalance: "0.97" });
    approveExecutionStatus = "succeeded";
    act(() => { result.current.retry(); });
    await tick();

    expect(prepared.some((a) => a.kind === "onboarding_key")).toBe(true);
    expect(prepared.filter((action) => action.kind === "onboarding_deposit")).toHaveLength(1);
  });

  it("retries a refused submit on its own, with no click and no error shown", async () => {
    // The refusal that sent this whole investigation: the deposit is credited
    // on Lighter but not yet proven locally, so the key step is refused for an
    // account that plainly exists. It clears within seconds.
    live = status({ accountExists: true, accountCollateral: "12" });
    refusals = ["Lighter key registration requires a Phase 2-resolved account owned by the selected wallet."];

    const { result } = mount();
    act(() => { result.current.start(); });
    await tick();
    expect(prepared.filter((a) => a.kind === "onboarding_key")).toHaveLength(1);
    // Nothing is shown while an attempt is still owed - the step reads as busy.
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe("registering_key");

    await tick(AUTO_RETRY_MS[0]);

    expect(prepared.filter((a) => a.kind === "onboarding_key")).toHaveLength(2);
    // The user was never shown a dead end, and never had to press anything.
    expect(result.current.error).toBeNull();
  });

  it("surfaces a refusal the user must act on once the attempts run out", async () => {
    live = status({ accountExists: true, accountCollateral: "12" });
    refusals = ["nope", "nope", "nope", "nope"];

    const { result } = mount();
    act(() => { result.current.start(); });
    await tick();
    await tick(AUTO_RETRY_MS[0]);
    await tick(AUTO_RETRY_MS[1]);

    // Two automatic attempts followed the first, and then it is the user's call.
    expect(prepared.filter((a) => a.kind === "onboarding_key")).toHaveLength(3);
    expect(result.current.error).toBe("nope");
  });

  it("a deposit that reverted is never re-sent automatically", async () => {
    // The dispatch happened and the transaction paid for itself. Re-sending it
    // on a timer would pay again for the same refusal, so this one stops and
    // asks - and it says what the chain said, not the JSON it arrived in.
    approveExecutionStatus = "failed";
    approveToolOutput = JSON.stringify({
      source: "vex_lighter_live_deposit",
      status: "failed",
      stage: "deposit",
      reason: "Deposit transaction reverted on chain.",
    });
    const { result } = mount();

    act(() => { result.current.setAmountIn("12"); });
    act(() => { result.current.start(); });
    await tick();
    expect(result.current.error).toBe("Deposit transaction reverted on chain.");

    await tick(AUTO_RETRY_MS[0] + AUTO_RETRY_MS[1]);
    expect(prepared.filter((a) => a.kind === "onboarding_deposit")).toHaveLength(1);

    // The user can still decide to send it again themselves.
    approveExecutionStatus = "succeeded";
    approveToolOutput = null;
    act(() => { result.current.retry(); });
    await tick();
    expect(prepared.filter((a) => a.kind === "onboarding_deposit")).toHaveLength(2);
  });

  it("retry after a completed setup finishes instead of re-running a step", async () => {
    approveExecutionStatus = "failed";
    const { result } = mount();

    act(() => { result.current.setAmountIn("12"); });
    act(() => { result.current.start(); });
    await tick();
    expect(result.current.error).not.toBeNull();
    const attempts = prepared.length;

    live = status({
      accountExists: true,
      accountCollateral: "12",
      tradingKeyRegistered: true,
      feeAuthorized: true,
    });
    act(() => { result.current.retry(); });
    await tick();

    expect(result.current.phase).toBe("done");
    expect(prepared).toHaveLength(attempts);
  });

  /**
   * The executor stops at `key_verified` when the account nonce has not caught
   * up, and nothing else finishes a registration: no sweep covers it, and
   * re-preparing one is refused by design. A confirm that only WATCHED
   * `tradingKeyRegistered` could therefore never come true - it polled for two
   * minutes and then asked the user to press a button that refused.
   */
  it("drives the reconcile while confirming the key, instead of only watching", async () => {
    live = status({ accountExists: true, accountCollateral: "12" });
    const { result } = mount();

    act(() => { result.current.start(); });
    await tick();
    expect(result.current.phase).toBe("confirming_key");
    expect(reconcileCalls).toBeGreaterThan(0);

    // The nonce lands and the next reconcile activates the credential.
    reconcileActivatesKey = true;
    await tick(POLL_MS);

    expect(live.tradingKeyRegistered).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("reconciles an on-chain registration instead of preparing a second one", async () => {
    // Exactly the stuck state: the key is registered and verified on Lighter,
    // the local credential is not active, and a fresh registration is refused.
    live = status({
      accountExists: true,
      accountCollateral: "12",
      keyRegistrationResumable: true,
    });
    refusals = ["Lighter onboarding workflow is in key_verified; key registration cannot be prepared from this state."];
    reconcileActivatesKey = true;

    const { result } = mount();
    act(() => { result.current.start(); });
    await tick();

    // Not one registration was prepared, so not one could be refused.
    expect(prepared.filter((a) => a.kind === "onboarding_key")).toHaveLength(0);
    expect(reconcileCalls).toBeGreaterThan(0);
    expect(result.current.error).toBeNull();
  });

  it("retry out of the stuck state reconciles rather than re-registering", async () => {
    live = status({
      accountExists: true,
      accountCollateral: "12",
      keyRegistrationResumable: true,
    });
    const { result } = mount();

    // Get the modal into the error state the timeout leaves behind.
    act(() => { result.current.start(); });
    await tick(CONFIRM_KEY_TIMEOUT_MS + POLL_MS);
    expect(result.current.error).not.toBeNull();

    reconcileActivatesKey = true;
    act(() => { result.current.retry(); });
    await tick();

    expect(prepared.filter((a) => a.kind === "onboarding_key")).toHaveLength(0);
    expect(live.tradingKeyRegistered).toBe(true);
  });

  it("a pending automatic retry does not outlive the modal", async () => {
    live = status({ accountExists: true, accountCollateral: "12" });
    refusals = ["nope", "nope", "nope"];

    const { result, unmount } = mount();
    act(() => { result.current.start(); });
    await tick();
    expect(prepared).toHaveLength(1);

    unmount();
    await tick(AUTO_RETRY_MS[0] + AUTO_RETRY_MS[1]);
    expect(prepared).toHaveLength(1);
  });
});
