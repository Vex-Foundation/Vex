/**
 * Two things the launch lane must get right about its own durable state.
 *
 * 1. THE STORED BLOCK IS UNTRUSTED INPUT. `mapRow` hands the JSONB column back
 *    exactly as the database held it, typed `unknown`, because a durable row
 *    has crossed persistence and a process boundary (rule 04). The validator
 *    below is the ONE place that shape is established, and it REFUSES rather
 *    than repairs: a block missing a field the plan needs cannot be
 *    reconstructed from the row's other columns, and guessing one would put a
 *    guessed value into an approval.
 *
 * 2. THE ROWS ARE PLANNED BEFORE ANYTHING IS BROADCAST, including the fee row
 *    that may never be signed. A leg signed but not recorded is a transfer with
 *    no audit row; a leg recorded but never signed is finalized as
 *    never-attempted. On this lane the fee row not running is a NORMAL outcome
 *    rather than an exception (owner F3), which is why it exists up front.
 */

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { readVirtualsIntentBlock } from "@vex-agent/tools/protocols/virtuals/handlers/launch/intent-block.js";
import { planCancelEvent, planLaunchEvents } from "@vex-agent/tools/protocols/virtuals/handlers/launch/activity.js";
import type { LaunchPlan } from "@vex-agent/tools/protocols/virtuals/handlers/launch/plan.js";
import {
  buildLaunchApproveTx,
  buildPreLaunchTx,
  launchCalldataFingerprint,
  resolveVirtualsLaunchFee,
} from "@tools/virtuals/launch/index.js";
import {
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";

function deployment(key: string): VirtualsCurveDeployment {
  const found = virtualsCurveDeployment(key);
  if (found === undefined) throw new Error(`no deployment for ${key}`);
  return found;
}
const BASE = deployment("base");

function validBlock(): Record<string, unknown> {
  return {
    chainKey: "base",
    bondingV5: BASE.bondingV5,
    imageUrl: "https://assets.example/a/abc123.jpeg",
    imageCid: "abc123",
    cores: [0, 1, 2],
    antiSniperTaxType: 1,
    nameSuffix: "by_virtuals",
    onChainName: "Otaku Analyst by Virtuals",
    urls: ["", "", "", ""],
    calldataFingerprint: "0xfeed",
    launchAmountRaw: "997500000000000000",
    protocolFeeRaw: "0",
  };
}

describe("readVirtualsIntentBlock", () => {
  it("reads a complete block and defaults the facts that arrive later to null", () => {
    const read = readVirtualsIntentBlock(validBlock());
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.reason);
    expect(read.block.chainKey).toBe("base");
    expect(read.block.onChainName).toBe("Otaku Analyst by Virtuals");
    expect(read.block.cores).toEqual([0, 1, 2]);
    // The optional set is what the launch learns AFTER it is signed. Their
    // absence is a STAGE of the launch, not a defect, so they read as null.
    expect(read.block.pairAddress).toBeNull();
    expect(read.block.virtualId).toBeNull();
    expect(read.block.preLaunchBlock).toBeNull();
    expect(read.block.keeperLaunchTxHash).toBeNull();
    expect(read.block.vexFeeWaived).toBe(false);
  });

  it("carries the settled facts once they exist", () => {
    const read = readVirtualsIntentBlock({
      ...validBlock(),
      pairAddress: "0x5724d6793c69187Dc9C0F2d34262DE308fC2F399",
      virtualId: "50000019577",
      initialPurchaseRaw: "2000000000000000000",
      preLaunchBlock: "50870256",
      keeperLaunchTxHash: "0x9eca4cb5",
      vexFeeWaived: true,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.reason);
    expect(read.block.preLaunchBlock).toBe("50870256");
    expect(read.block.vexFeeWaived).toBe(true);
  });

  it("REFUSES a block that is not an object at all", () => {
    for (const raw of [null, undefined, "", 0, [], "a string"]) {
      const read = readVirtualsIntentBlock(raw);
      expect(read.ok, `accepted ${JSON.stringify(raw)}`).toBe(false);
    }
  });

  it("REFUSES a block missing any required field, and NAMES which", () => {
    for (const key of [
      "chainKey", "bondingV5", "imageUrl", "onChainName",
      "calldataFingerprint", "launchAmountRaw", "protocolFeeRaw",
    ]) {
      const block = validBlock();
      delete block[key];
      const read = readVirtualsIntentBlock(block);
      expect(read.ok, `accepted a block with no ${key}`).toBe(false);
      if (read.ok) throw new Error(`accepted a block with no ${key}`);
      expect(read.reason).toContain(key);
    }
  });

  it("refuses an empty or malformed cores list rather than launching without capabilities", () => {
    expect(readVirtualsIntentBlock({ ...validBlock(), cores: [] }).ok).toBe(false);
    expect(readVirtualsIntentBlock({ ...validBlock(), cores: ["0"] }).ok).toBe(false);
    expect(readVirtualsIntentBlock({ ...validBlock(), cores: "0,1" }).ok).toBe(false);
  });

  it("refuses a name-suffix or url shape the contract has no encoding for", () => {
    expect(readVirtualsIntentBlock({ ...validBlock(), nameSuffix: "by_vex" }).ok).toBe(false);
    expect(readVirtualsIntentBlock({ ...validBlock(), urls: ["", ""] }).ok).toBe(false);
    expect(readVirtualsIntentBlock({ ...validBlock(), urls: [1, 2, 3, 4] }).ok).toBe(false);
  });

  it("refuses a non-integer anti-sniper type", () => {
    expect(readVirtualsIntentBlock({ ...validBlock(), antiSniperTaxType: "1" }).ok).toBe(false);
    expect(readVirtualsIntentBlock({ ...validBlock(), antiSniperTaxType: 1.5 }).ok).toBe(false);
  });
});

/** A plan shaped exactly as `buildLaunchPlan` produces one, with no chain read. */
function planWith(options: {
  readonly allowanceRaw: bigint;
  readonly committedRaw: bigint;
}): LaunchPlan {
  const fee = resolveVirtualsLaunchFee({ deployment: BASE, committedRaw: options.committedRaw });
  const args = {
    name: "Otaku Analyst",
    ticker: "OTAKU",
    cores: [0, 1, 2],
    description: "reads anime sentiment",
    imageUrl: "https://assets.example/a/abc123.jpeg",
    urls: ["", "", "", ""] as readonly [string, string, string, string],
    purchaseAmountRaw: fee.launchAmountRaw,
    startTime: 1_788_600_000n,
    antiSniperTaxType: 1,
    nameSuffix: "by_virtuals" as const,
  };
  const preLaunchTx = buildPreLaunchTx({ deployment: BASE, args });
  const allowanceLegNeeded = options.allowanceRaw < fee.launchAmountRaw;
  return {
    deployment: BASE,
    state: {
      ok: true,
      blockNumber: 50_870_256n,
      bondingConfig: getAddress("0x0000000000000000000000000000000000000c0f"),
      feeTo: getAddress("0x86CbAC9d9Ac726F729eEf6627Dc4817BcBB03A9c"),
      protocolLaunchFeeRaw: 0n,
      scheduledStartTimeDelaySeconds: 86_400n,
      scheduledLaunchFeeRaw: 0n,
      acfFeeRaw: 10_000_000_000_000_000_000n,
      initialSupply: 1_000_000_000n,
      virtualDecimals: 18,
      virtualBalanceRaw: 10_000_000_000_000_000_000n,
      allowanceRaw: options.allowanceRaw,
      implementations: {
        bondingV5: getAddress(BASE.implementations.bondingV5),
        frouterV3: getAddress(BASE.implementations.frouterV3),
      },
    },
    fee,
    args,
    preLaunchTx,
    approveTx: buildLaunchApproveTx({ deployment: BASE, amountRaw: fee.launchAmountRaw }),
    approveResetTx: buildLaunchApproveTx({ deployment: BASE, amountRaw: 0n }),
    allowanceLegNeeded,
    allowanceResetNeeded: allowanceLegNeeded && options.allowanceRaw > 0n,
    fingerprint: launchCalldataFingerprint({ chainId: BASE.chainId, tx: preLaunchTx }),
    onChainName: "Otaku Analyst by Virtuals",
    image: {
      url: "https://assets.example/a/abc123.jpeg",
      cid: "abc123",
      imageId: "img-1",
      label: "otaku.jpeg",
    },
    blockTimestamp: 1_788_600_000n,
  };
}

const PLAN_INPUT = { walletAddress: "0x33Ef6673bd80CB11fCc41B82BC2181e65cc4D2fa", sessionId: "s-1", intentId: "i-1" };

describe("planLaunchEvents", () => {
  it("plans an approval, the launch and the fee when the allowance is zero", () => {
    const plan = planLaunchEvents({
      plan: planWith({ allowanceRaw: 0n, committedRaw: 1_000_000_000_000_000_000n }),
      ...PLAN_INPUT,
    });
    expect(plan.events.map((e) => e.eventRole)).toEqual(["allowance", "token_launch", "vex_fee"]);
    expect(plan.launchLegCount).toBe(2);
    expect(plan.hasFeeRow).toBe(true);
    // Indexes are dense and ordered: the broadcast loop walks them, and a gap
    // would abort the wrong rows on a failure.
    expect(plan.events.map((e) => e.eventIndex)).toEqual([0, 1, 2]);
  });

  it("adds the USDT-style reset leg when a NON-ZERO allowance is short", () => {
    const plan = planLaunchEvents({
      plan: planWith({ allowanceRaw: 1n, committedRaw: 1_000_000_000_000_000_000n }),
      ...PLAN_INPUT,
    });
    expect(plan.events.map((e) => e.eventRole)).toEqual([
      "allowance_reset", "allowance", "token_launch", "vex_fee",
    ]);
    expect(plan.launchLegCount).toBe(3);
  });

  it("plans NO allowance leg when the wallet already approved enough", () => {
    const plan = planLaunchEvents({
      plan: planWith({ allowanceRaw: 10_000_000_000_000_000_000n, committedRaw: 1_000_000_000_000_000_000n }),
      ...PLAN_INPUT,
    });
    expect(plan.events.map((e) => e.eventRole)).toEqual(["token_launch", "vex_fee"]);
    expect(plan.launchLegCount).toBe(1);
  });

  it("plans NO fee row when the fee floors to zero", () => {
    // A zero-value transfer burns gas, adds an activity row and moves nothing.
    const plan = planLaunchEvents({
      plan: planWith({ allowanceRaw: 0n, committedRaw: 100n }),
      ...PLAN_INPUT,
    });
    expect(plan.hasFeeRow).toBe(false);
    expect(plan.events.some((e) => e.eventRole === "vex_fee")).toBe(false);
  });

  it("files every row under kind `launch`, protocol `virtuals` and the right chain", () => {
    const plan = planLaunchEvents({
      plan: planWith({ allowanceRaw: 0n, committedRaw: 1_000_000_000_000_000_000n }),
      ...PLAN_INPUT,
    });
    for (const event of plan.events) {
      expect(event.kind).toBe("launch");
      expect(event.protocol).toBe("virtuals");
      expect(event.chainId).toBe(8453);
      expect(event.chainSlug).toBe("base");
      expect(event.sessionId).toBe("s-1");
    }
  });

  it("names NO output token on the launch row, because it does not exist yet", () => {
    // A launch is the only venue action whose output token is minted by the
    // transaction about to be signed. A planned output leg would have to invent
    // an address, and the confirm path fills the real one in from the receipt.
    const plan = planLaunchEvents({
      plan: planWith({ allowanceRaw: 0n, committedRaw: 1_000_000_000_000_000_000n }),
      ...PLAN_INPUT,
    });
    const launchRow = plan.events.find((e) => e.eventRole === "token_launch");
    expect(launchRow).toBeDefined();
    if (launchRow === undefined) throw new Error("no token_launch row");
    expect(launchRow.tokenOut).toBeUndefined();
    expect(launchRow.tokenIn?.tokenSymbol).toBe("VIRTUAL");
    // The venue's amount, NOT the committed total: Vex's fee is its own row.
    expect(launchRow.tokenIn?.amountRaw).toBe("997500000000000000");
  });

  it("records the approved calldata fingerprint on the launch row's provenance", () => {
    // So a post-crash sweep can assess what was authorized without re-reading
    // anything.
    const built = planWith({ allowanceRaw: 0n, committedRaw: 1_000_000_000_000_000_000n });
    const plan = planLaunchEvents({ plan: built, ...PLAN_INPUT });
    const launchRow = plan.events.find((e) => e.eventRole === "token_launch");
    if (launchRow === undefined) throw new Error("no token_launch row");
    const provenance = launchRow.routeProvenance;
    expect(provenance).toBeDefined();
    if (provenance === undefined) throw new Error("no routeProvenance");
    expect(provenance.calldataFingerprint).toBe(built.fingerprint);
    expect(provenance.venue).toBe("virtuals-bonding");
    expect(provenance.intentId).toBe("i-1");
    expect(provenance.onChainName).toBe("Otaku Analyst by Virtuals");
  });

  it("sizes the allowance on the VENUE's amount, not the committed total", () => {
    // `preLaunch` pulls the launch fee plus the initial purchase and nothing
    // else; Vex's own fee is a separate transfer with no allowance at all. An
    // allowance sized on the total would approve more than the contract needs.
    const plan = planLaunchEvents({
      plan: planWith({ allowanceRaw: 0n, committedRaw: 1_000_000_000_000_000_000n }),
      ...PLAN_INPUT,
    });
    const allowanceRow = plan.events.find((e) => e.eventRole === "allowance");
    if (allowanceRow === undefined) throw new Error("no allowance row");
    expect(allowanceRow.tokenIn?.amountRaw).toBe("997500000000000000");
  });
});

describe("planCancelEvent", () => {
  it("records the refund as an OUTPUT leg on the launch arm", () => {
    // A cancel returns VIRTUAL to the wallet, so the money moves the other way
    // from every other row in this family.
    const event = planCancelEvent({
      deployment: BASE,
      walletAddress: PLAN_INPUT.walletAddress,
      sessionId: "s-1",
      tokenAddress: "0x84A0326C64d9f0E1F640062638807722E1dde87f",
      expectedRefundRaw: 2_000_000_000_000_000_000n,
    });
    expect(event.eventRole).toBe("launch_cancel");
    expect(event.kind).toBe("launch");
    expect(event.tokenIn).toBeUndefined();
    expect(event.tokenOut?.tokenSymbol).toBe("VIRTUAL");
    expect(event.tokenOut?.amountRaw).toBe("2000000000000000000");
    expect(event.routeProvenance?.token).toBe("0x84A0326C64d9f0E1F640062638807722E1dde87f");
  });
});
