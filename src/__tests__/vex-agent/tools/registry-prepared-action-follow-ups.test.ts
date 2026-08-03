import { describe, expect, it } from "vitest";
import { validatePreparedActionFollowUp } from "../../../vex-agent/tools/registry/prepared-action-follow-ups.js";

const INTENT_ID = "intent-00000000-0000-4000-8000-000000000001";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

function candidate() {
  return {
    toolName: "wallet_send_confirm",
    args: { walletFamily: "solana", intentId: INTENT_ID },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "wallet_send_confirm",
      criticalArgs: {
        network: "solana",
        chain: null,
        to: "3SnLmaqoEczS2ft7RLQ1BRhtsLuAauWnx9K7pDjSRQrp",
        amount: "32.813008",
        token: "ANSEM",
      },
    },
  };
}

describe("prepared-action follow-up registry", () => {
  it("allows and canonicalizes wallet_send_prepare → wallet_send_confirm", () => {
    const input = candidate();
    const result = validatePreparedActionFollowUp("wallet_send_prepare", input);
    expect(result).toEqual({
      ok: true,
      followUp: input,
    });
  });

  it("rejects unknown source→target pairs", () => {
    expect(
      validatePreparedActionFollowUp("token_find", candidate()),
    ).toEqual({ ok: false, reason: "unknown_mapping" });
    expect(
      validatePreparedActionFollowUp("wallet_send_prepare", {
        ...candidate(),
        toolName: "swap",
      }),
    ).toEqual({ ok: false, reason: "unknown_mapping" });
  });

  it("rejects a second mapping attempt (maintainer decision: wallet-only, exactly one mapping)", () => {
    expect(
      validatePreparedActionFollowUp("kyberswap_prequote", {
        ...candidate(),
        toolName: "kyberswap_execute",
      }),
    ).toEqual({ ok: false, reason: "unknown_mapping" });
  });

  it("rejects extra confirm args and spoofed or malformed trusted previews", () => {
    expect(
      validatePreparedActionFollowUp("wallet_send_prepare", {
        ...candidate(),
        args: { ...candidate().args, to: "model-supplied" },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("wallet_send_prepare", {
        ...candidate(),
        approvalPreview: {
          ...candidate().approvalPreview,
          criticalArgs: {
            ...candidate().approvalPreview.criticalArgs,
            network: "eip155",
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it("rejects a malformed intentId shape", () => {
    expect(
      validatePreparedActionFollowUp("wallet_send_prepare", {
        ...candidate(),
        args: { walletFamily: "solana", intentId: "not-a-uuid" },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it("rejects an unparsable expiry", () => {
    expect(
      validatePreparedActionFollowUp("wallet_send_prepare", {
        ...candidate(),
        expiresAt: "not-a-date",
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it("rejects an eip155 preview missing a chain and a solana preview carrying one", () => {
    expect(
      validatePreparedActionFollowUp("wallet_send_prepare", {
        toolName: "wallet_send_confirm",
        args: { walletFamily: "eip155", intentId: INTENT_ID },
        expiresAt: EXPIRES_AT,
        approvalPreview: {
          toolName: "wallet_send_confirm",
          criticalArgs: {
            network: "eip155",
            chain: null,
            to: "0xfedcba0987654321fedcba0987654321fedcba09",
            amount: "1.5",
            token: null,
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("wallet_send_prepare", {
        ...candidate(),
        approvalPreview: {
          ...candidate().approvalPreview,
          criticalArgs: {
            ...candidate().approvalPreview.criticalArgs,
            chain: "base",
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
  });
});
