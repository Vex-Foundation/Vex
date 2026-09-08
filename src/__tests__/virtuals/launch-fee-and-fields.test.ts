/**
 * The launch fee split (owner F3) and the field bounds.
 *
 * The fee arithmetic is the same `currency_in` model every Vex venue uses, and
 * the tests below pin the ROUNDING at the boundaries rather than the happy path:
 * a fee that rounded UP would charge a user a smallest unit Vex did not earn,
 * and a split whose parts did not sum to the total would make the approval's
 * three numbers disagree with the one that leaves the wallet.
 *
 * What is NOT tested here, because it is not arithmetic: the WAIVER. Whether
 * the fee is collectible at all is the keeper observation, and that lives in
 * `launch-keeper-wait.test.ts` and in the fee-leg's own tests.
 */

import { describe, expect, it } from "vitest";

import {
  resolveVirtualsLaunchFee,
  VIRTUALS_LAUNCH_FEE_BPS,
  VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
  readLaunchCores,
  readLaunchDescription,
  readLaunchName,
  readLaunchTicker,
  readLaunchUrl,
  LAUNCH_DESCRIPTION_MAX,
  LAUNCH_NAME_MAX,
  LAUNCH_TICKER_MAX,
} from "@tools/virtuals/launch/index.js";
import {
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import { VEX_TREASURY_EVM } from "../../lib/vex-treasury.js";

function deployment(key: string): VirtualsCurveDeployment {
  const found = virtualsCurveDeployment(key);
  if (found === undefined) throw new Error(`no deployment for ${key}`);
  return found;
}
const BASE = deployment("base");

describe("the Vex launch fee split (F3)", () => {
  it("is 25 bps of the committed amount, floored, and the parts sum to the total", () => {
    const committedRaw = 1_000_000_000_000_000_000n;
    const fee = resolveVirtualsLaunchFee({ deployment: BASE, committedRaw });

    expect(VIRTUALS_LAUNCH_FEE_BPS).toBe(25);
    expect(fee.feeRaw).toBe(2_500_000_000_000_000n);
    expect(fee.launchAmountRaw).toBe(997_500_000_000_000_000n);
    // The property the approval depends on: what the venue gets plus what Vex
    // takes IS what leaves the wallet, exactly.
    expect(fee.launchAmountRaw + (fee.feeRaw ?? 0n)).toBe(committedRaw);
    expect(fee.committedRaw).toBe(committedRaw);
  });

  it("FLOORS rather than rounds, so a user is never charged a unit Vex did not earn", () => {
    // 399 * 25 / 10000 = 0.9975. A rounding implementation charges 1; flooring
    // charges 0, and the difference is a real smallest unit on every trade.
    const fee = resolveVirtualsLaunchFee({ deployment: BASE, committedRaw: 399n });
    expect(fee.feeRaw).toBeNull();
    expect(fee.launchAmountRaw).toBe(399n);

    // 400 is the first amount that yields a whole unit.
    const boundary = resolveVirtualsLaunchFee({ deployment: BASE, committedRaw: 400n });
    expect(boundary.feeRaw).toBe(1n);
    expect(boundary.launchAmountRaw).toBe(399n);

    // 799 still yields 1, not 2.
    const below = resolveVirtualsLaunchFee({ deployment: BASE, committedRaw: 799n });
    expect(below.feeRaw).toBe(1n);
  });

  it("takes NO fee at all when it would floor to zero, and says why", () => {
    const fee = resolveVirtualsLaunchFee({ deployment: BASE, committedRaw: 100n });
    expect(fee.feeRaw).toBeNull();
    expect(fee.disclosure.charged).toBe(false);
    if (fee.disclosure.charged !== false) throw new Error("expected an uncharged disclosure");
    expect(fee.disclosure.bps).toBe(0);
    expect(fee.disclosure.reason).toContain("rounds to zero");
  });

  it("names the treasury as the receiver, and never a value from anywhere else", () => {
    expect(VIRTUALS_LAUNCH_FEE_RECEIVER_EVM).toBe(VEX_TREASURY_EVM);
    const fee = resolveVirtualsLaunchFee({ deployment: BASE, committedRaw: 1_000_000_000_000_000_000n });
    expect(fee.disclosure.charged).toBe("after_keeper_launch");
    if (fee.disclosure.charged !== "after_keeper_launch") throw new Error("expected a charged disclosure");
    expect(fee.disclosure.receiver).toBe(VEX_TREASURY_EVM);
    expect(fee.disclosure.tokenAddress).toBe(BASE.virtual);
    expect(fee.disclosure.tokenSymbol).toBe("VIRTUAL");
  });

  it("DISCLOSES the waiver in the same breath as the charge", () => {
    // The note is the user-visible half of owner F3. A disclosure that stated
    // the fee without the condition it is collected under would describe a
    // charge the user might never incur as one they always do.
    const fee = resolveVirtualsLaunchFee({ deployment: BASE, committedRaw: 1_000_000_000_000_000_000n });
    expect(fee.disclosure.waivedWhen).toBe("awaiting_keeper");
    expect(fee.disclosure.collectedWhen).toBe("separate_transfer_after_observed_launch");
    expect(fee.disclosure.note).toContain("WAIVED");
    expect(fee.disclosure.note).toContain("keeper");
  });
});

describe("the launch field bounds", () => {
  it("accepts a normal name, ticker and description", () => {
    expect(readLaunchName("Otaku Analyst")).toEqual({ ok: true, value: "Otaku Analyst" });
    expect(readLaunchDescription(" reads anime sentiment ")).toEqual({ ok: true, value: "reads anime sentiment" });
  });

  it("UPPERCASES the ticker, because the uppercased form is what is encoded", () => {
    const verdict = readLaunchTicker("otaku");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.value).toBe("OTAKU");
  });

  it("refuses a ticker with punctuation, which is unreadable in a wallet", () => {
    const verdict = readLaunchTicker("OT AKU");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("letters and digits");
  });

  it("refuses a blank name and an over-long one, with the bound in the sentence", () => {
    expect(readLaunchName("   ").ok).toBe(false);
    const long = readLaunchName("x".repeat(LAUNCH_NAME_MAX + 1));
    expect(long.ok).toBe(false);
    if (long.ok) throw new Error("expected a refusal");
    expect(long.reason).toContain(String(LAUNCH_NAME_MAX));
  });

  it("refuses control characters, which no approval surface can render", () => {
    const verdict = readLaunchName("OtakuAnalyst");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("control characters");
  });

  it("names the gas reason when a description is too long", () => {
    const verdict = readLaunchDescription("x".repeat(LAUNCH_DESCRIPTION_MAX + 1));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain(String(LAUNCH_DESCRIPTION_MAX));
    expect(verdict.reason).toContain("gas");
  });

  it("keeps the ticker bound stated", () => {
    const verdict = readLaunchTicker("A".repeat(LAUNCH_TICKER_MAX + 1));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain(String(LAUNCH_TICKER_MAX));
  });
});

describe("social URLs written to permanent public storage", () => {
  it("accepts an https link and normalises it", () => {
    const verdict = readLaunchUrl("https://x.com/otaku", "twitter");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.value).toBe("https://x.com/otaku");
  });

  it("treats an omitted or empty link as an empty slot, not an error", () => {
    expect(readLaunchUrl(undefined, "telegram")).toEqual({ ok: true, value: "" });
    expect(readLaunchUrl("", "telegram")).toEqual({ ok: true, value: "" });
    expect(readLaunchUrl(null, "youtube")).toEqual({ ok: true, value: "" });
  });

  it("REFUSES http, because Vex would be publishing the downgrade on chain", () => {
    const verdict = readLaunchUrl("http://x.com/otaku", "twitter");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("https");
  });

  it("REFUSES credentials in the URL, which would be a secret in permanent storage", () => {
    const verdict = readLaunchUrl("https://user:pass@x.com/otaku", "website");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("credentials");
  });
});

describe("cores, the only field the contract itself bounds", () => {
  it("accepts an array of numbers, an array of strings and a comma-separated string", () => {
    for (const input of [[0, 1, 2], ["0", "1", "2"], "0,1,2", " 0 , 1 , 2 "]) {
      const verdict = readLaunchCores(input);
      expect(verdict.ok, `rejected ${JSON.stringify(input)}`).toBe(true);
      if (!verdict.ok) throw new Error(verdict.reason);
      expect(verdict.value).toEqual([0, 1, 2]);
    }
  });

  it("REFUSES an empty list, naming the revert it would cause", () => {
    for (const input of [[], "", "   "]) {
      const verdict = readLaunchCores(input);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("expected a refusal");
      expect(verdict.reason).toContain("InvalidInput");
    }
  });

  it("does NOT widen a single value into a list", () => {
    // A bare `2` silently becoming `[2]` is how a caller launches an agent with
    // capabilities it did not choose.
    const verdict = readLaunchCores(2);
    expect(verdict.ok).toBe(false);
  });

  it("refuses a value outside uint8 and a repeated id", () => {
    expect(readLaunchCores([256]).ok).toBe(false);
    expect(readLaunchCores([-1]).ok).toBe(false);
    expect(readLaunchCores([1.5]).ok).toBe(false);
    const repeated = readLaunchCores([1, 1]);
    expect(repeated.ok).toBe(false);
    if (repeated.ok) throw new Error("expected a refusal");
    expect(repeated.reason).toContain("repeats");
  });
});
