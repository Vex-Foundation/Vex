/**
 * The pools.fun launch IPC contract, from the boundary's point of view.
 *
 * These are NEGATIVE tests first, because the contract's job is refusing. The
 * renderer must not be able to name a fee, a value, a gas figure or a wallet;
 * `deploy` must carry nothing but the opaque fingerprint; and a URL field must
 * never accept a scheme that can execute.
 */

import { describe, expect, it } from "vitest";
import {
  poolsClaimInputSchema,
  poolsLaunchDeployInputSchema,
  poolsLaunchFormSchema,
  poolsLaunchPrepareInputSchema,
  poolsPreparedLaunchSchema,
} from "../pools-launch.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

function form(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Flamingo",
    symbol: "FLAM",
    pairedAsset: "weth",
    image: { kind: "url", url: "https://example.test/f.png" },
    tweetUrl: null,
    websiteUrl: null,
    prebuy: null,
    feeRecipient: { kind: "session_wallet" },
    ...over,
  };
}

describe("pools launch form — the money fields that do not exist", () => {
  it.each([
    "creationFeeWei",
    "msgValueWei",
    "vexFeeWei",
    "gasLimit",
    "gasPriceWei",
    "deadline",
    "walletAddress",
    "value",
  ])("rejects a renderer-supplied `%s`", (field) => {
    // `.strict()` is what makes this a refusal rather than a silent drop: a
    // money-shaped key that is ignored is a key someone will later start
    // honouring.
    const parsed = poolsLaunchFormSchema.safeParse(form({ [field]: "1" }));
    expect(parsed.success).toBe(false);
  });
});

describe("pools launch form — validation", () => {
  it("accepts a complete, well-formed launch", () => {
    expect(poolsLaunchFormSchema.safeParse(form()).success).toBe(true);
  });

  it("accepts each of the three recipient choices", () => {
    for (const feeRecipient of [
      { kind: "session_wallet" },
      { kind: "address", address: ADDRESS },
      { kind: "x_username", username: "@vexdotfun" },
    ]) {
      expect(poolsLaunchFormSchema.safeParse(form({ feeRecipient })).success).toBe(true);
    }
  });

  /**
   * THE MONEY-PATH NEAR-MISS, pinned at the boundary.
   *
   * `\w` covers digits and letters, so a truncated address matches the username
   * shape. If this passed, a mistyped `0x123` would be resolved to whoever owns
   * that handle and the token's fee stream would go there PERMANENTLY. The
   * renderer refuses it too, but the renderer is untrusted here — this test is
   * what stops the guard being lost to a future renderer refactor.
   */
  it.each([
    ["a truncated address", "0x123"],
    ["a hex-looking stub", "0xnope"],
    ["an uppercase prefix", "0X123"],
    ["an @-prefixed address attempt", "@0x123"],
    ["a full address in the username field", "0x1111111111111111"],
  ])("refuses %s as an X username — it is an address the user got wrong", (_label, username) => {
    const parsed = poolsLaunchFormSchema.safeParse(
      form({ feeRecipient: { kind: "x_username", username } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("still accepts ordinary usernames that merely CONTAIN digits or an x", () => {
    // The rule is about the `0x` PREFIX, not about digits or the letter x —
    // over-refusing would lock real handles out of their own fee stream.
    for (const username of ["vex0x", "x0nline", "0vex", "web3guy", "@a1b2c3"]) {
      const parsed = poolsLaunchFormSchema.safeParse(
        form({ feeRecipient: { kind: "x_username", username } }),
      );
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects a recipient that is neither, or an address of the wrong shape", () => {
    for (const feeRecipient of [
      "0xabc",
      { kind: "address", address: "0x123" },
      { kind: "wallet" },
      { kind: "x_username", username: "x".repeat(16) },
      // A recipient carrying BOTH shapes is not a choice, it is an ambiguity.
      { kind: "address", address: ADDRESS, username: "vex" },
    ]) {
      expect(poolsLaunchFormSchema.safeParse(form({ feeRecipient })).success).toBe(false);
    }
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "http://example.test/f.png", "not a url"])(
    "refuses %s in the url branch — a link field can never carry an executable scheme",
    (url) => {
      // Asserted through the BRANCH, not a stray top-level key: a top-level
      // `imageUrl` is rejected by `.strict()` for a different reason entirely,
      // which would make this pass without proving the URL rule at all.
      expect(poolsLaunchFormSchema.safeParse(form({ image: { kind: "url", url } })).success).toBe(
        false,
      );
    },
  );

  it("refuses metadata text that cannot be written on-chain", () => {
    expect(poolsLaunchFormSchema.safeParse(form({ name: 'Flam"ingo' })).success).toBe(false);
    expect(poolsLaunchFormSchema.safeParse(form({ name: "Flam\ningo" })).success).toBe(false);
  });

  it("refuses a pairing the launchpad cannot honour", () => {
    // Tokenised stocks are not launchable on the live factory. The contract
    // refuses one rather than letting it fail at execute time.
    expect(poolsLaunchFormSchema.safeParse(form({ pairedAsset: "stock" })).success).toBe(false);
  });

  it("accepts either image branch, and `null` for no image at all", () => {
    for (const image of [
      { kind: "url", url: "https://example.test/f.png" },
      { kind: "locker", imageId: "img-1" },
      null,
    ]) {
      expect(poolsLaunchFormSchema.safeParse(form({ image })).success).toBe(true);
    }
  });

  it.each([
    ["both sources in one object", { kind: "url", url: "https://e.test/f.png", imageId: "img-1" }],
    ["a locker branch carrying a url", { kind: "locker", imageId: "img-1", url: "https://e.test/f.png" }],
    ["an empty locker id", { kind: "locker", imageId: "" }],
    ["a non-https url branch", { kind: "url", url: "http://e.test/f.png" }],
    ["a javascript: url branch", { kind: "url", url: "javascript:alert(1)" }],
    ["a locker branch with no id", { kind: "locker" }],
    ["a url branch with no url", { kind: "url" }],
    ["an unknown source kind", { kind: "ipfs", url: "https://e.test/f.png" }],
    ["the OLD flat shape", { imageUrl: "https://e.test/f.png" }],
  ])("refuses %s at the boundary", (_label, image) => {
    // The union makes "both sources" unrepresentable rather than merely
    // refused — that ambiguity is what let a provider honour one field and drop
    // the other in silence, blanking a real funded launch.
    expect(poolsLaunchFormSchema.safeParse(form({ image })).success).toBe(false);
  });

  it("refuses a prebuy finer than the PAIRED ASSET can represent", () => {
    // A silently truncated money field is a wrong amount, not a formatting
    // detail — and USDG's six decimals make the same digits legal against WETH
    // and illegal against USDG.
    expect(
      poolsLaunchFormSchema.safeParse(
        form({ pairedAsset: "usdg", prebuy: { amountHuman: "1.0000001" } }),
      ).success,
    ).toBe(false);
    expect(
      poolsLaunchFormSchema.safeParse(
        form({ pairedAsset: "usdg", prebuy: { amountHuman: "1.000001" } }),
      ).success,
    ).toBe(true);
    expect(
      poolsLaunchFormSchema.safeParse(
        form({ pairedAsset: "weth", prebuy: { amountHuman: "1.0000001" } }),
      ).success,
    ).toBe(true);
    // Eighteen is the floor of what WETH holds; nineteen is not representable.
    expect(
      poolsLaunchFormSchema.safeParse(
        form({ pairedAsset: "weth", prebuy: { amountHuman: `1.${"0".repeat(19)}` } }),
      ).success,
    ).toBe(false);
  });

  it("takes the prebuy as a HUMAN decimal, never a raw integer field", () => {
    expect(
      poolsLaunchFormSchema.safeParse(form({ prebuy: { amountHuman: "0.25" } })).success,
    ).toBe(true);
    // A raw-wei key is not part of the contract: the conversion happens once,
    // main-side, against on-chain decimals.
    expect(
      poolsLaunchFormSchema.safeParse(form({ prebuy: { rawWei: "250000" } })).success,
    ).toBe(false);
    expect(
      poolsLaunchFormSchema.safeParse(form({ prebuy: { amountHuman: "-1" } })).success,
    ).toBe(false);
  });
});

describe("pools launch — stage 2 carries nothing but the fingerprint", () => {
  it("accepts exactly the session and the opaque id", () => {
    expect(
      poolsLaunchDeployInputSchema.safeParse({ sessionId: "s1", fingerprintId: "fp1" }).success,
    ).toBe(true);
  });

  it.each(["form", "costs", "msgValueWei", "predictedTokenAddress", "feeRecipient"])(
    "rejects a deploy carrying `%s` — the click may not restate the launch",
    (field) => {
      const parsed = poolsLaunchDeployInputSchema.safeParse({
        sessionId: "s1",
        fingerprintId: "fp1",
        [field]: "anything",
      });
      expect(parsed.success).toBe(false);
    },
  );

  it("requires both ids", () => {
    expect(poolsLaunchDeployInputSchema.safeParse({ sessionId: "s1" }).success).toBe(false);
    expect(poolsLaunchDeployInputSchema.safeParse({ fingerprintId: "fp1" }).success).toBe(false);
  });
});

describe("pools launch — prepare input", () => {
  it("requires a session and a form, and refuses anything else", () => {
    expect(poolsLaunchPrepareInputSchema.safeParse({ sessionId: "s1", form: form() }).success).toBe(
      true,
    );
    expect(poolsLaunchPrepareInputSchema.safeParse({ form: form() }).success).toBe(false);
    expect(
      poolsLaunchPrepareInputSchema.safeParse({
        sessionId: "s1",
        form: form(),
        walletAddress: ADDRESS,
      }).success,
    ).toBe(false);
  });
});

describe("pools claim input", () => {
  it("takes a token address and nothing that could redirect a payout", () => {
    expect(poolsClaimInputSchema.safeParse({ sessionId: "s1", tokenAddress: ADDRESS }).success).toBe(
      true,
    );
    expect(
      poolsClaimInputSchema.safeParse({
        sessionId: "s1",
        tokenAddress: ADDRESS,
        recipient: ADDRESS,
      }).success,
    ).toBe(false);
    expect(
      poolsClaimInputSchema.safeParse({ sessionId: "s1", tokenAddress: "0x123" }).success,
    ).toBe(false);
  });
});

describe("prepared launch — every amount is readable", () => {
  const amount = {
    rawWei: "1000",
    decimals: 18,
    assetAddress: ADDRESS,
    assetSymbol: "ETH",
  };
  const prepared = {
    fingerprintId: "fp1",
    predictedTokenAddress: ADDRESS,
    predictedPoolAddress: ADDRESS,
    resolvedFeeRecipient: ADDRESS,
    pairedAsset: "weth",
    pairedAssetAddress: ADDRESS,
    costs: {
      deploymentFee: amount,
      prebuy: null,
      vexFee: amount,
      gasBound: amount,
      transactionValue: amount,
    },
    metadataUri: "https://example.test/m.json",
    imageLanded: true,
    expiresAt: "2026-08-18T12:00:00.000Z",
  };

  it("accepts a well-formed stage-1 answer", () => {
    expect(poolsPreparedLaunchSchema.safeParse(prepared).success).toBe(true);
  });

  it("REFUSES an amount that arrives without its decimals", () => {
    // A raw amount with no decimals is unreadable, and a reader that guesses is
    // a thousandfold error. The contract will not carry one.
    const { decimals: _dropped, ...noDecimals } = amount;
    const parsed = poolsPreparedLaunchSchema.safeParse({
      ...prepared,
      costs: { ...prepared.costs, deploymentFee: noDecimals },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a pre-formatted display string in place of a raw amount", () => {
    const parsed = poolsPreparedLaunchSchema.safeParse({
      ...prepared,
      costs: { ...prepared.costs, deploymentFee: { ...amount, rawWei: "0.001 ETH" } },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a metadata URI carrying an executable scheme", () => {
    // Provider-authored text crossing into the renderer. It is not rendered as
    // a link today, and this is what keeps that from mattering if it ever is.
    for (const metadataUri of [
      "javascript:alert(1)",
      "  JavaScript:alert(1)",
      "data:text/html,<script>",
      "vbscript:msgbox",
    ]) {
      expect(poolsPreparedLaunchSchema.safeParse({ ...prepared, metadataUri }).success).toBe(
        false,
      );
    }
    // An unfamiliar but inert scheme still passes: the hosting choice is the
    // backend's, and failing the whole prepare over a display field would be
    // worse than the thing being guarded.
    expect(
      poolsPreparedLaunchSchema.safeParse({ ...prepared, metadataUri: "ipfs://bafy" }).success,
    ).toBe(true);
  });

  it("requires imageLanded and expiresAt — both are load-bearing in the UI", () => {
    for (const field of ["imageLanded", "expiresAt"]) {
      const { [field]: _dropped, ...missing } = prepared as Record<string, unknown>;
      expect(poolsPreparedLaunchSchema.safeParse(missing).success).toBe(false);
    }
  });
});
