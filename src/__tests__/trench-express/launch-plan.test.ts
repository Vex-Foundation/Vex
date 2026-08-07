/**
 * The launch money-path assembly — ORDER and REFUSALS.
 *
 * The invariants pinned here are the ones that cost real money if they break:
 *   - the fee is PLANNED before the ceiling gate but never enters `msg.value`;
 *   - the ceiling compares `msg.value + vexFee`, excluding gas;
 *   - Path 2 is FAIL-CLOSED today because no mission has ceilings authored;
 *   - an unregistered image store and an unknown image are DIFFERENT refusals;
 *   - the fee comes from the anchored storage read, never the preview constant;
 *   - the preview DTO never merges gas into the authorized figure.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { toHex, type Address } from "viem";

import {
  registerLaunchImageByteResolver,
  resetLaunchImageByteResolver,
} from "@vex-agent/tools/protocols/trench/launch-image-byte-resolver.js";
import {
  buildLaunchPlan,
  LAUNCH_FEE_LEG_GAS_LIMIT,
} from "@vex-agent/tools/protocols/trench/handlers/launch/plan.js";
import { TRENCH_CREATION_FEE_SLOT, TRENCH_CREATION_FEE_FIXTURE } from "@tools/trench-express/evm/creation-fee.js";
import { buildTrenchFeeDisclosure } from "@tools/trench-express/fee/index.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import type { PlanTrenchFeeLeg } from "@vex-agent/tools/protocols/trench/handlers/launch/fee-seam.js";
import type { ValidatedLaunchRequest } from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";

const WALLET = "0x33eF000000000000000000000000000000000001" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const FEE = TRENCH_CREATION_FEE_FIXTURE.feeWei; // 0.001 ETH
const ANCHOR = 25_749_542n;
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

const REQUEST: ValidatedLaunchRequest = {
  name: "Vex x Trench",
  symbol: "VEXTE",
  description: "a launch",
  links: ["https://vex.example"],
  imageId: "img_01",
  prebuyWei: 300_000_000_000_000n,
};

function publicClient(overrides: Record<string, unknown> = {}) {
  return {
    async getBlockNumber() { return ANCHOR; },
    async getStorageAt(args: { slot: string }) {
      return args.slot.toLowerCase() === TRENCH_CREATION_FEE_SLOT.toLowerCase()
        ? TRENCH_CREATION_FEE_FIXTURE.rawWord
        : undefined;
    },
    async estimateGas() { return 2_000_000n; },
    async getGasPrice() { return 20_000_000n; },
    // The pre-sign balance gate reads this. A funded wallet is the default here
    // so these tests keep pinning what they are about; the gate itself is
    // pinned in `launch-broadcast-balance-gate.test.ts`.
    async getBalance() { return 10n ** 20n; },
    ...overrides,
  } as never;
}

/** 25 bps of the base, floor. `null` on dust. */
const realisticFeePlanner: PlanTrenchFeeLeg = (req) => {
  const feeWei = (req.baseWei * 25n) / 10_000n;
  if (feeWei === 0n) return null;
  return {
    feeWei,
    netWei: req.baseWei - feeWei,
    txParams: { to: "0x00000000000000000000000000000000000feee5" as Address, data: "0x", value: feeWei },
    event: {} as never,
    disclosure: buildTrenchFeeDisclosure({ basis: "launch_msg_value", baseWei: req.baseWei, feeWei }),
  };
};

const noFeePlanner: PlanTrenchFeeLeg = () => null;

function baseInput(over: Record<string, unknown> = {}) {
  return {
    request: REQUEST,
    sessionId: "sess-1",
    walletAddress: WALLET,
    permission: "full" as const,
    publicClient: publicClient(),
    planFeeLeg: realisticFeePlanner,
    nativeAddress: NATIVE,
    ...over,
  };
}

afterEach(() => {
  resetLaunchImageByteResolver();
  vi.restoreAllMocks();
});

function mountImage(bytes: Uint8Array | null = IMAGE_BYTES) {
  registerLaunchImageByteResolver(async () =>
    bytes === null ? null : { bytes, digest: "0xstoreddigest" },
  );
}

describe("the fee is planned BEFORE the ceiling but is NEVER in msg.value", () => {
  it("msg.value is exactly creationFee + prebuy — the Vex fee is a separate tx", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    const expectedValue = FEE + REQUEST.prebuyWei;
    expect(result.plan.txParams.value).toBe(expectedValue);
    expect(result.plan.preview.msgValueWei).toBe(expectedValue.toString());
    // The fee exists and is NOT part of the value.
    expect(result.plan.feeLeg?.feeWei).toBe((expectedValue * 25n) / 10_000n);
    expect(BigInt(result.plan.preview.vexFeeWei)).toBeGreaterThan(0n);
    expect(result.plan.txParams.value).not.toBe(expectedValue + result.plan.feeLeg!.feeWei);
  });

  it("the fee planner is CALLED with the full msg.value as its base", async () => {
    mountImage();
    const spy = vi.fn(realisticFeePlanner);
    const result = await buildLaunchPlan(baseInput({ planFeeLeg: spy }) as never);
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      basis: "launch_msg_value",
      baseWei: FEE + REQUEST.prebuyWei,
      kind: "launch",
    });
  });

  it("dust ⇒ no fee leg, no row, and vexFeeCharged is false", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput({ planFeeLeg: noFeePlanner }) as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.feeLeg).toBeNull();
    expect(result.plan.preview.vexFeeWei).toBe("0");
    expect(result.plan.preview.vexFeeCharged).toBe(false);
  });
});

describe("PATH 2 IS FAIL-CLOSED TODAY", () => {
  it("refuses an autonomous launch when NEITHER ceiling is authored", async () => {
    mountImage();
    // This is today's live state: no mission carries either number.
    const result = await buildLaunchPlan(
      baseInput({
        ceilings: {
          contract: { maxLaunchValueRaw: null, maxLaunchValueDecimals: null, maxLaunchCount: null },
          launchesUsed: 0,
        },
      }) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ceiling_not_set");
    expect(result.reason).toMatch(/not unlimited|zero authority/i);
  });

  it("refuses when only the VALUE ceiling is authored — BOTH are required", async () => {
    mountImage();
    const result = await buildLaunchPlan(
      baseInput({
        ceilings: {
          contract: { maxLaunchValueRaw: "1000000000000000000", maxLaunchValueDecimals: 18, maxLaunchCount: null },
          launchesUsed: 0,
        },
      }) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ceiling_not_set");
  });

  it("refuses when the count cap is already used up, naming the count", async () => {
    mountImage();
    const result = await buildLaunchPlan(
      baseInput({
        ceilings: {
          contract: { maxLaunchValueRaw: "1000000000000000000", maxLaunchValueDecimals: 18, maxLaunchCount: 2 },
          launchesUsed: 2,
        },
      }) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("already used 2");
  });

  it("the ceiling counts the VEX FEE — a launch that fits without it can still refuse", async () => {
    mountImage();
    const msgValue = FEE + REQUEST.prebuyWei;
    const vexFee = (msgValue * 25n) / 10_000n;
    // Ceiling set to EXACTLY msg.value: fits without the fee, refuses with it.
    const contract = {
      maxLaunchValueRaw: msgValue.toString(),
      maxLaunchValueDecimals: 18,
      maxLaunchCount: 5,
    };
    const withFee = await buildLaunchPlan(
      baseInput({ ceilings: { contract, launchesUsed: 0 } }) as never,
    );
    expect(withFee.ok).toBe(false);
    if (withFee.ok) throw new Error("unreachable");
    expect(withFee.reason).toContain((msgValue + vexFee).toString());

    // Same launch with no fee charged fits exactly.
    const noFee = await buildLaunchPlan(
      baseInput({ planFeeLeg: noFeePlanner, ceilings: { contract, launchesUsed: 0 } }) as never,
    );
    expect(noFee.ok).toBe(true);
  });

  it("a HUMAN-authorized launch is NOT ceiling-gated (no ceilings passed)", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(true);
  });
});

describe("image refusals are DISTINCT failures", () => {
  it("unregistered resolver ⇒ image_store_unavailable, never an empty image", async () => {
    // No resolver mounted at all.
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("image_store_unavailable");
  });

  it("unknown image ⇒ image_not_found, and the message names the locker", async () => {
    mountImage(null);
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("image_not_found");
    expect(result.reason).toMatch(/locker/i);
  });

  it("binds the digest the LOCKER recorded, so a later swap is detectable", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.binding.imageDigest).toBe("0xstoreddigest");
  });
});

describe("the fee comes from the anchored read, and fails closed", () => {
  it("uses the storage-read fee and records the anchor block", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.preview.creationFeeWei).toBe(FEE.toString());
    expect(result.plan.preview.anchorBlockNumber).toBe(ANCHOR.toString());
    expect(result.plan.binding.creationFeeWei).toBe(FEE.toString());
  });

  it("refuses when the slot is unreadable — never falls back to 0.001", async () => {
    mountImage();
    const result = await buildLaunchPlan(
      baseInput({ publicClient: publicClient({ getStorageAt: async () => undefined }) }) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("fee_unreadable");
  });

  it("refuses an implausible fee rather than signing it", async () => {
    mountImage();
    const result = await buildLaunchPlan(
      baseInput({
        publicClient: publicClient({
          getStorageAt: async () => toHex(50n * 10n ** 18n, { size: 32 }),
        }),
      }) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("fee_unreadable");
  });

  // ONE CONTRACT: the payload is the CREATION FEE, never `msg.value`. The
  // main-side submit CAS reads it back as the fee, and the cross-seam suite in
  // `vex-app/src/main/token-launch/__tests__/submit-preview-id-cross-seam.test.ts`
  // proves the two agree without a hand-written id on either side.
  it("the previewId carries the anchored block AND the CREATION FEE read there", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.preview.previewId).toBe(`lp_${ANCHOR}_${FEE}`);
  });
});

describe("the preview DTO never merges gas into the authorized figure", () => {
  it("keeps gas as three DISTINCT fields, none of them summed into msg.value", async () => {
    mountImage();
    const result = await buildLaunchPlan(baseInput() as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const p = result.plan.preview;

    // OUR OWN bound over the node's estimate — never the bare estimate. The
    // repo's shared helper owns the factor; asserting against it rather than a
    // copied number keeps this test honest if the factor is ever retuned.
    const bound = gasLimitWithHeadroom(2_000_000n);
    expect(bound).toBeGreaterThan(2_000_000n);
    expect(p.estimatedGasLimit).toBe(bound.toString());
    expect(p.estimatedGasPriceWei).toBe("20000000");
    // PIN UPDATED (round 3): the network fee covers EVERY transaction the
    // launch causes — the create AND the Vex fee leg that follows it — because
    // the shared schema promises gas for each, and the modal that renders this
    // is the consent surface. `estimatedGasLimit` still describes the create
    // call alone; only the fee total is the sum.
    const feeLegGas = LAUNCH_FEE_LEG_GAS_LIMIT * 20_000_000n;
    expect(p.estimatedNetworkFeeWei).toBe((bound * 20_000_000n + feeLegGas).toString());
    // msg.value is untouched by gas.
    expect(p.msgValueWei).toBe((FEE + REQUEST.prebuyWei).toString());
    // And there is deliberately no merged total field at all.
    expect(Object.keys(p)).not.toContain("totalCostWei");
    expect(Object.keys(p)).not.toContain("estimatedTotalCostWei");
  });

  // PIN UPDATED (fix wave, defect f): this test used to assert that a failed
  // estimate degraded to `estimatedNetworkFeeWei: "0"` and the plan continued.
  // That was safe only while nothing consumed the number. The pre-sign balance
  // gate now does, so a zero would make the gate compare the spend against a
  // figure nobody proved — and rule 90 forbids rendering a provider's silence
  // as a number on a money path. A launch that cannot be priced is refused.
  it("refuses the launch when gas estimation fails — a failed estimate is never a zero", async () => {
    mountImage();
    const result = await buildLaunchPlan(
      baseInput({
        publicClient: publicClient({
          estimateGas: async () => { throw new Error("node says no"); },
        }),
      }) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("gas_unestimable");
  });
});
