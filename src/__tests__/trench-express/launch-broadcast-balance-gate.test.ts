/**
 * The PRE-SIGN BALANCE GATE on the launch plan.
 *
 * Two defects this pins, both on the money path:
 *
 *   1. A failed gas estimate used to become `0n` and the plan continued. Gas is
 *      display-only for the AUTHORIZED figure, but a node that will not
 *      estimate is a node that will not price the transaction — and zero is not
 *      a number anyone may reason about. A failed estimate is a REFUSAL.
 *   2. Nothing read the wallet's native balance, so a launch could be signed
 *      that the wallet demonstrably cannot pay for: the whole spend is
 *      `msg.value` + the launch's own gas + the Vex fee leg + that leg's gas.
 *      A refusal by name beats an on-chain "insufficient funds" the user pays
 *      nothing for but learns nothing from.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Address } from "viem";

import {
  registerLaunchImageByteResolver,
  registerLaunchImageOnchainByteResolver,
  resetLaunchImageByteResolver,
  resetLaunchImageOnchainByteResolver,
} from "@vex-agent/tools/protocols/shared/launch-image-byte-resolver.js";
import {
  buildLaunchPlan,
  LAUNCH_FEE_LEG_GAS_LIMIT,
} from "@vex-agent/tools/protocols/trench/handlers/launch/plan.js";
import { TRENCH_CREATION_FEE_SLOT, TRENCH_CREATION_FEE_FIXTURE } from "@tools/trench-express/evm/creation-fee.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import type { PlanTrenchFeeLeg } from "@vex-agent/tools/protocols/trench/handlers/launch/fee-seam.js";
import type { ValidatedLaunchRequest } from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";

const WALLET = "0x33eF000000000000000000000000000000000001" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const FEE = TRENCH_CREATION_FEE_FIXTURE.feeWei;
const ANCHOR = 25_749_542n;
const GAS_ESTIMATE = 2_000_000n;
const GAS_PRICE = 20_000_000n;
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

const REQUEST: ValidatedLaunchRequest = {
  name: "Vex x Trench",
  symbol: "VEXTE",
  description: "a launch",
  links: ["https://vex.example"],
  imageId: "img_01",
  prebuyWei: 300_000_000_000_000n,
};

const MSG_VALUE = FEE + REQUEST.prebuyWei;
const VEX_FEE = (MSG_VALUE * 25n) / 10_000n;
const LAUNCH_GAS_WEI = gasLimitWithHeadroom(GAS_ESTIMATE) * GAS_PRICE;
const REQUIRED = MSG_VALUE + LAUNCH_GAS_WEI + VEX_FEE + LAUNCH_FEE_LEG_GAS_LIMIT * GAS_PRICE;

function publicClient(overrides: Record<string, unknown> = {}) {
  return {
    async getBlockNumber() { return ANCHOR; },
    async getStorageAt(args: { slot: string }) {
      return args.slot.toLowerCase() === TRENCH_CREATION_FEE_SLOT.toLowerCase()
        ? TRENCH_CREATION_FEE_FIXTURE.rawWord
        : undefined;
    },
    async estimateGas() { return GAS_ESTIMATE; },
    async getGasPrice() { return GAS_PRICE; },
    async getBalance() { return REQUIRED * 10n; },
    ...overrides,
  } as never;
}

const feePlanner: PlanTrenchFeeLeg = (req) => {
  const feeWei = (req.baseWei * 25n) / 10_000n;
  if (feeWei === 0n) return null;
  return {
    feeWei,
    netWei: req.baseWei - feeWei,
    txParams: { to: "0x00000000000000000000000000000000000feee5" as Address, value: feeWei },
    event: {} as never,
    disclosure: {},
  } as never;
};

function baseInput(over: Record<string, unknown> = {}) {
  return {
    request: REQUEST,
    sessionId: "sess-1",
    walletAddress: WALLET,
    permission: "full" as const,
    publicClient: publicClient(),
    planFeeLeg: feePlanner,
    nativeAddress: NATIVE,
    ...over,
  };
}

function mountImage(): void {
  registerLaunchImageByteResolver(async () => ({ bytes: IMAGE_BYTES, digest: "0xstoreddigest" }));
  // The Trench path consumes the ON-CHAIN copy. For an image already inside the
  // budget both seams hand back the same bytes and digest, which is this case.
  registerLaunchImageOnchainByteResolver(async () => ({
    kind: "resolved",
    bytes: IMAGE_BYTES,
    digest: "0xstoreddigest",
  }));
}

afterEach(() => {
  resetLaunchImageByteResolver();
  resetLaunchImageOnchainByteResolver();
  vi.restoreAllMocks();
});

describe("the fee leg's budgeted gas", () => {
  it("is headroom(LIVE ESTIMATE) — proven against the captured RBC fixture, not an assumed floor", () => {
    // The live capture (`fixtures/live-captures/fee-leg-gas-estimate.json`,
    // chain 4663 @ block 26020712) shows the exact empty-calldata treasury
    // transfer estimating to 21000. `signStageBroadcast` then signs
    // `gasLimitWithHeadroom(estimate)`, so budgeting the raw estimate would
    // underbudget the balance the wallet needs to broadcast the leg at all.
    const capture = JSON.parse(readFileSync(
      new URL("./fixtures/live-captures/fee-leg-gas-estimate.json", import.meta.url), "utf8",
    )) as { request: { data: string }; response: { estimatedGas: string } };
    // The fixture must describe the transaction the fee leg actually sends.
    expect(capture.request.data).toBe("0x");
    expect(LAUNCH_FEE_LEG_GAS_LIMIT).toBe(gasLimitWithHeadroom(BigInt(capture.response.estimatedGas)));
    expect(LAUNCH_FEE_LEG_GAS_LIMIT).toBeGreaterThan(BigInt(capture.response.estimatedGas));
  });

  it("is included in the preview's network fee — every transaction the launch causes", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.preview.estimatedNetworkFeeWei).toBe(
      (LAUNCH_GAS_WEI + LAUNCH_FEE_LEG_GAS_LIMIT * GAS_PRICE).toString(),
    );
  });

  it("budgets NO fee-leg gas when the fee floors to dust — there is no second transaction", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput({ planFeeLeg: () => null }) as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.preview.estimatedNetworkFeeWei).toBe(LAUNCH_GAS_WEI.toString());
  });
});

describe("the pre-sign native balance gate", () => {
  it("plans when the balance covers msg.value + launch gas + the Vex fee leg and its gas", async () => {
    mountImage();
    const balances: unknown[] = [];
    const result = await buildLaunchPlan(baseInput({
      publicClient: publicClient({
        async getBalance(args: unknown) { balances.push(args); return REQUIRED; },
      }),
    }) as never);
    expect(result.ok).toBe(true);
    // The balance was read FOR THIS WALLET — not assumed.
    expect(balances).toEqual([{ address: WALLET }]);
  });

  it("refuses by name — never signs — when the balance is one wei short of the full spend", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput({
      publicClient: publicClient({ async getBalance() { return REQUIRED - 1n; } }),
    }) as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("insufficient_native_balance");
    expect(result.reason).toContain("Nothing was signed");
  });

  it("counts the Vex fee leg in the requirement — a balance covering only value+gas is refused", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput({
      publicClient: publicClient({ async getBalance() { return MSG_VALUE + LAUNCH_GAS_WEI; } }),
    }) as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("insufficient_native_balance");
  });

  it("a FAILED gas estimate is a refusal, never a zero", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput({
      publicClient: publicClient({
        async estimateGas() { throw new Error("node refused to estimate"); },
      }),
    }) as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("gas_unestimable");
    expect(result.reason).toContain("Nothing was signed");
  });

  it("an unreadable balance is a refusal, never an assumption that funds exist", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput({
      publicClient: publicClient({ async getBalance() { throw new Error("rpc down"); } }),
    }) as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("balance_unreadable");
  });
});
