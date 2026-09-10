/**
 * The TypeScript half of Lighter's TxType 20 signing path: what Vex sends the
 * signer helper, what it accepts back, and what it refuses.
 *
 * The risk this guards is the process boundary, not the arithmetic (that is
 * `lighter-margin-fraction.test.ts`). The helper is a separate binary that
 * receives an API private key on stdin and returns a signed payload, so the
 * contract worth testing is: the exact payload leaves, the key never appears in
 * a result, a transaction of the wrong type is discarded rather than returned,
 * and a signed payload carrying a fee leg is refused even though the helper
 * claimed success. The runner is faked because the subject IS the boundary;
 * the real binary is exercised end to end by the harness.
 *
 * Structure follows the repo's own `lighter-order-lifecycle-signer.test.ts`,
 * which is the same shape of test one op earlier.
 */

import { describe, expect, it } from "vitest";

import { ErrorCodes, VexError } from "../../errors.js";
import {
  createLighterLeverageSignerBinary,
  type LighterSignerBinaryRunRequest,
} from "@tools/lighter/signer-binary-adapter.js";
import { buildLighterUpdateLeverageSigningInput } from "@tools/lighter/signer-leverage.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";

const secret = materialFromSecret(`0x${"1".repeat(80)}`);
const scope = {
  environment: "rhc" as const,
  accountIndex: 42,
  apiKeyIndex: 7,
  nonce: "9",
  expiredAt: "1893456000000",
  secret,
};
const leverage = { marketIndex: 1, initialMarginFraction: 200, marginMode: 0 as const };

function signedResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, txType: 20, txInfo: "{}", txHash: "0xleverage", ...overrides };
}

describe("Lighter leverage signer payload", () => {
  it("sends the exact canonical payload and returns the bound identity", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const signer = createLighterLeverageSignerBinary({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        return signedResponse();
      },
    });

    const result = await signer.signUpdateLeverage(
      buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      operation: "signUpdateLeverage",
      chainId: 466324,
      accountIndex: "42",
      apiKeyIndex: 7,
      nonce: "9",
      expiredAt: "1893456000000",
      updateLeverage: { marketIndex: 1, initialMarginFraction: 200, marginMode: 0 },
    });
    // Vex takes no fee on a configuration change, so no fee terms may travel
    // with the request at all.
    expect(calls[0]?.payload).not.toHaveProperty("integratorFees");
    expect(result).toEqual({
      kind: "lighter_update_leverage_signer_result",
      operation: "update_leverage",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      nonce: "9",
      expiredAt: "1893456000000",
      txType: 20,
      txInfo: "{}",
      txHash: "0xleverage",
    });
  });

  it("keeps the signing key out of the result it hands back", async () => {
    const signer = createLighterLeverageSignerBinary({ runner: async () => signedResponse() });
    const result = await signer.signUpdateLeverage(
      buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage }),
    );
    expect(JSON.stringify(result)).not.toContain(secret.privateKey);
  });

  it("carries the isolated mode through unchanged", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const signer = createLighterLeverageSignerBinary({
      runner: async (request) => {
        calls.push(request);
        return signedResponse();
      },
    });
    await signer.signUpdateLeverage(
      buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage, marginMode: 1 }),
    );
    expect(calls[0]?.payload).toMatchObject({ updateLeverage: { marginMode: 1 } });
  });
});

describe("Lighter leverage signing input bounds", () => {
  it.each([
    { name: "spot market index", patch: { marketIndex: 2048 } },
    { name: "the provider's nil market marker", patch: { marketIndex: 255 } },
    { name: "a negative market index", patch: { marketIndex: -1 } },
    { name: "a fractional market index", patch: { marketIndex: 1.5 } },
    { name: "no margin at all", patch: { initialMarginFraction: 0 } },
    { name: "margin above the provider tick", patch: { initialMarginFraction: 10001 } },
    { name: "a fractional margin", patch: { initialMarginFraction: 200.5 } },
  ])("refuses $name before anything is signed", ({ patch }) => {
    expect(() => buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage, ...patch }))
      .toThrow(VexError);
  });

  it("refuses a margin mode outside the closed provider set", () => {
    expect(() => buildLighterUpdateLeverageSigningInput({
      ...scope,
      ...leverage,
      // Cast at the test boundary only: the type already forbids this, and the
      // point is that a value arriving from a durable row or an IPC edge is
      // refused at runtime rather than signed.
      marginMode: 2 as unknown as 0 | 1,
    })).toThrow(VexError);
  });

  it("applies the same account, key and expiry bounds as the order lifecycle builders", () => {
    // These bounds are not restated in the leverage module; it reuses
    // `lifecycleScope`. This proves the reuse is real rather than a comment.
    expect(() => buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage, apiKeyIndex: 3 }))
      .toThrow("managed trading index");
    expect(() => buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage, accountIndex: -1 }))
      .toThrow("safe non-negative integer");
    expect(() => buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage, expiredAt: "0" }))
      .toThrow("outside the official signer range");
    expect(() => buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage, nonce: "01" }))
      .toThrow("canonical decimal text");
  });

  it("accepts the exact provider bounds", () => {
    for (const patch of [
      { marketIndex: 0, initialMarginFraction: 1 },
      { marketIndex: 254, initialMarginFraction: 10000 },
    ]) {
      expect(() => buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage, ...patch }))
        .not.toThrow();
    }
  });
});

describe("Lighter leverage signer output", () => {
  it("discards a transaction of any other type", async () => {
    for (const txType of [15, 16, 17, 13, 20.5]) {
      const signer = createLighterLeverageSignerBinary({
        runner: async () => signedResponse({ txType }),
      });
      await expect(signer.signUpdateLeverage(
        buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage }),
      )).rejects.toMatchObject({ code: ErrorCodes.LIGHTER_INVALID_REQUEST });
    }
  });

  it("discards a helper answer that did not succeed or is missing a hash", async () => {
    for (const raw of [
      { ok: false, errorCode: "signing_failed" },
      signedResponse({ txHash: "" }),
      signedResponse({ txInfo: "" }),
      null,
    ]) {
      const signer = createLighterLeverageSignerBinary({ runner: async () => raw });
      await expect(signer.signUpdateLeverage(
        buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage }),
      )).rejects.toBeInstanceOf(VexError);
    }
  });

  it("refuses a signed payload that carries integrator fee attributes", async () => {
    // lighter-go's L2UpdateLeverageTxInfo EMBEDS L2TxAttributes and hashes
    // them, so "no fee on this transaction type" is Vex policy rather than an
    // SDK guarantee. The Go helper refuses the request; this refuses the
    // RESULT, because the helper is a separate process whose output is
    // evidence and not trust.
    const signer = createLighterLeverageSignerBinary({
      runner: async () => signedResponse({
        txInfo: JSON.stringify({ L2TxAttributes: { "1": 12, "2": 0, "3": 0 } }),
      }),
    });
    await expect(signer.signUpdateLeverage(
      buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage }),
    )).rejects.toBeInstanceOf(VexError);
  });

  it("accepts the empty attribute shapes the helper actually produces", async () => {
    // The helper passes an explicit empty types.L2TxAttributes, which lighter-go
    // serializes as a nil map: JSON null. An absent key and an empty object are
    // the other two shapes that mean the same thing.
    for (const attributes of ['{"L2TxAttributes":null}', "{}", '{"L2TxAttributes":{}}']) {
      const signer = createLighterLeverageSignerBinary({
        runner: async () => signedResponse({ txInfo: attributes }),
      });
      await expect(signer.signUpdateLeverage(
        buildLighterUpdateLeverageSigningInput({ ...scope, ...leverage }),
      )).resolves.toMatchObject({ txType: 20 });
    }
  });
});
