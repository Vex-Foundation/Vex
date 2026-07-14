import { describe, expect, it } from "vitest";

import { withHyperliquidWalletMutationLock } from "@vex-agent/tools/protocols/runtime/hyperliquid-mutation-lock.js";

describe("Hyperliquid wallet mutation lock", () => {
  it("serializes two concurrent opens for the same normalized wallet", async () => {
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const open = (label: string) => withHyperliquidWalletMutationLock("0xAbC", async () => {
      calls.push(`${label}:gate`);
      if (label === "first") await new Promise<void>((resolve) => { releaseFirst = resolve; });
      calls.push(`${label}:submit`);
    });

    const first = open("first");
    const second = open("second");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["first:gate"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual(["first:gate", "first:submit", "second:gate", "second:submit"]);
  });

  it("re-evaluates a sole-stop cancellation only after earlier wallet work completes", async () => {
    let soleStopExists = false;
    const open = withHyperliquidWalletMutationLock("0xabc", async () => {
      soleStopExists = true;
    });
    const cancel = withHyperliquidWalletMutationLock("0xABC", async () => {
      return soleStopExists ? "blocked" : "submitted";
    });

    await open;
    await expect(cancel).resolves.toBe("blocked");
  });
});
