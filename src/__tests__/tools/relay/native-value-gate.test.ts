/**
 * Relay native-value authorization — the pre-signature gate on the provider's
 * own `tx.value` (phase-3 W3).
 *
 * WHY THIS SUITE EXISTS. `planRelayStepTx` used to canonicalize the quote's
 * `tx.value` and hand it straight to the signer, so a Relay quote could attach
 * ANY native charge on top of the bridged amount and Vex would sign it. Khalani
 * has refused that since the deBridge measurement (1e15 wei, ~$1.86, on a $2
 * bridge); Relay's bridge-fee leg shipped ahead of the doctrine.
 *
 * THE LOAD-BEARING RULE, and the one this suite exists to keep: the authorized
 * amount is `tx.value − nativePrincipal == surcharge`, NEVER `tx.value == fee`.
 * A `tx.value == fee` rule refuses every native-in bridge, where the principal
 * itself rides in the value. The "native-in is NOT broken" cases below are the
 * regression guard for exactly that.
 */
import { describe, it, expect, vi } from "vitest";
import { getAddress } from "viem";

// `execute.ts` imports the Relay client module; nothing here polls, but the
// module must load without a configured client.
vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: () => ({ getIntentStatus: vi.fn() }),
  RELAY_INTENT_STATUS_PATH: "/intents/status/v3",
}));

const { planRelayStepTx } = await import("@tools/relay/execute.js");
const { classifyRelayStepNativeValue, relayNativeValueGuidance } = await import("@tools/relay/native-value.js");
const { evaluateNativeValueAuthorization } = await import("@tools/evm-chains/native-value-authorization/index.js");

import type { RelayStepNativeValueContext } from "@tools/relay/native-value.js";
import type { RelayStep } from "@tools/relay/types.js";

const ORIGIN = 8453;
const FROM = getAddress("0x1111111111111111111111111111111111111111");
const TO = "0x2222222222222222222222222222222222222222";
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** The post-Vex-fee amount Vex asked Relay to bridge (0.001 ETH minus 25 bps). */
const BRIDGED_WEI = "997500000000000";

function step(value: string, data = "0x"): RelayStep {
  return {
    id: "deposit",
    kind: "transaction",
    items: [{ data: { to: TO, value, data, chainId: ORIGIN } }],
  } as unknown as RelayStep;
}

function nativeInDeposit(over: Partial<RelayStepNativeValueContext> = {}): RelayStepNativeValueContext {
  return {
    role: "bridge_deposit",
    originCurrency: NATIVE,
    tradeType: "EXACT_INPUT",
    bridgedAmountRaw: BRIDGED_WEI,
    ...over,
  };
}

function erc20Deposit(over: Partial<RelayStepNativeValueContext> = {}): RelayStepNativeValueContext {
  return {
    role: "bridge_deposit",
    originCurrency: USDC,
    tradeType: "EXACT_INPUT",
    bridgedAmountRaw: "997500",
    ...over,
  };
}

describe("planRelayStepTx — native value must be authorized before signing", () => {
  it("a native-in deposit whose tx.value IS the bridged principal signs (tx.value − principal == 0)", () => {
    const tx = planRelayStepTx(step(BRIDGED_WEI), ORIGIN, FROM, nativeInDeposit());
    expect(tx).toEqual({ to: getAddress(TO), data: "0x", value: BigInt(BRIDGED_WEI) });
  });

  it("a native-in deposit with a provider surcharge on TOP of the principal is REFUSED", () => {
    const surcharged = (BigInt(BRIDGED_WEI) + 1_000_000_000_000_000n).toString();
    expect(() => planRelayStepTx(step(surcharged), ORIGIN, FROM, nativeInDeposit()))
      .toThrow(/NATIVE_VALUE_UNAUTHORIZED|could not be attributed/i);
  });

  it("the refusal names the exact unattributed amount so the agent can report it", () => {
    const surcharged = (BigInt(BRIDGED_WEI) + 1_000_000_000_000_000n).toString();
    expect(() => planRelayStepTx(step(surcharged), ORIGIN, FROM, nativeInDeposit()))
      .toThrow(/1000000000000000 wei/);
  });

  it("an ERC-20 deposit carrying zero native value signs — the proven live path stays free", () => {
    const tx = planRelayStepTx(step("0", "0xabcd"), ORIGIN, FROM, erc20Deposit());
    expect(tx).toEqual({ to: getAddress(TO), data: "0xabcd", value: 0n });
  });

  it("an ERC-20 deposit carrying ANY native value is REFUSED (no principal can ride in tx.value)", () => {
    expect(() => planRelayStepTx(step("1000000000000000", "0xabcd"), ORIGIN, FROM, erc20Deposit()))
      .toThrow(/NATIVE_VALUE_UNAUTHORIZED|could not be attributed/i);
  });

  it("an allowance step signs at zero value and is REFUSED at any non-zero value", () => {
    // An allowance leg has no principal to claim — it grants a spend, it does
    // not move the user's money — so ANY native value on it is unattributable.
    const approve: RelayStepNativeValueContext = nativeInDeposit({ role: "allowance" });
    expect(planRelayStepTx(step("0", "0x095ea7b3"), ORIGIN, FROM, approve).value).toBe(0n);
    expect(() => planRelayStepTx(step("1", "0x095ea7b3"), ORIGIN, FROM, approve))
      .toThrow(/could not be attributed/i);
  });

  it("carries the NATIVE_VALUE_UNAUTHORIZED code, the same one Khalani's refusal uses", () => {
    const surcharged = (BigInt(BRIDGED_WEI) + 1n).toString();
    try {
      planRelayStepTx(step(surcharged), ORIGIN, FROM, nativeInDeposit());
      expect.unreachable("the surcharged step must not produce a signable transaction");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("NATIVE_VALUE_UNAUTHORIZED");
    }
  });

  it("a tx.value SMALLER than the principal Vex derived is refused as a contradiction, never clamped", () => {
    // The classifier attributes NOTHING when Vex's own components exceed the
    // transaction's value: the inputs disagree with the transaction, and
    // clamping the principal down to fit would turn that into an approval.
    const short = (BigInt(BRIDGED_WEI) - 1n).toString();
    expect(() => planRelayStepTx(step(short), ORIGIN, FROM, nativeInDeposit()))
      .toThrow(new RegExp(`${short} wei of native value could not be attributed`));
  });

  it("the thrown message states the refusal and that nothing was signed, within the 200-char scrub cap", () => {
    const surcharged = (BigInt(BRIDGED_WEI) + 1n).toString();
    let message = "";
    try {
      planRelayStepTx(step(surcharged), ORIGIN, FROM, nativeInDeposit());
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/refused before signing/i);
    expect(message).toMatch(/nothing was signed or broadcast for this step/i);
    // Never leave room to read this as funds possibly moving.
    expect(message).not.toMatch(/in flight|may still|confirmation pending/i);
    // `summarizeProtocolError` truncates at 200 chars — the two facts above must
    // never be the ones cut off.
    expect(message.length).toBeLessThanOrEqual(200);
  });
});

describe("relayNativeValueGuidance — the part the agent has to act on", () => {
  it("separates a Vex policy refusal from a transport failure", () => {
    const guidance = relayNativeValueGuidance("bridge_deposit");
    expect(guidance).toMatch(/NOT a network, provider or transport failure/i);
    expect(guidance).toMatch(/re-sending the SAME quote will be refused again/i);
  });

  it("names a path the agent can take with no user present", () => {
    const guidance = relayNativeValueGuidance("bridge_deposit");
    expect(guidance).toMatch(/relay__bridge_quote_get/);
    expect(guidance).toMatch(/khalani__bridge_execute/);
  });
});

describe("classifyRelayStepNativeValue — what Vex will and will not attribute", () => {
  const call = (valueWei: bigint) => ({ chainId: ORIGIN, to: getAddress(TO), data: "0x" as const, valueWei });

  it("attributes the bridged principal on a native-in EXACT_INPUT deposit", () => {
    const auth = classifyRelayStepNativeValue(call(BigInt(BRIDGED_WEI)), nativeInDeposit());
    expect(auth.components.map((c) => c.kind)).toEqual(["native_principal"]);
    expect(evaluateNativeValueAuthorization(auth).ok).toBe(true);
  });

  it("attributes NOTHING when the trade type is not EXACT_INPUT — `amount` is then not the input", () => {
    const auth = classifyRelayStepNativeValue(
      call(BigInt(BRIDGED_WEI)),
      nativeInDeposit({ tradeType: "EXACT_OUTPUT" }),
    );
    expect(auth.components.map((c) => c.kind)).toEqual(["unclassified"]);
    expect(evaluateNativeValueAuthorization(auth).ok).toBe(false);
  });

  it("never invents a protocol fee — Relay has no prover, so a surcharge stays unclassified", () => {
    const auth = classifyRelayStepNativeValue(call(BigInt(BRIDGED_WEI) + 5n), nativeInDeposit());
    const unclassified = auth.components.find((c) => c.kind === "unclassified");
    expect(unclassified?.amountWei).toBe(5n);
    expect(unclassified?.evidence.source).toBe("unproven");
  });

  it("a zero-value call needs no components and authorizes without any RPC", () => {
    const auth = classifyRelayStepNativeValue(call(0n), erc20Deposit());
    expect(auth.components).toEqual([]);
    expect(evaluateNativeValueAuthorization(auth).ok).toBe(true);
  });
});
