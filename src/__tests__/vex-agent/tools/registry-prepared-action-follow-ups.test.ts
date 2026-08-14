import { describe, expect, it } from "vitest";
import { validatePreparedActionFollowUp } from "../../../vex-agent/tools/registry/prepared-action-follow-ups.js";

const INTENT_ID = "intent-00000000-0000-4000-8000-000000000001";
const LIGHTER_INTENT_ID = "lighter-exec-00000000-0000-4000-8000-000000000001";
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

function lighterCandidate() {
  return {
    toolName: "execute_tool",
    args: {
      toolId: "lighter.order.create",
      params: { intentId: LIGHTER_INTENT_ID },
    },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "order.create",
      namespace: "lighter",
      criticalArgs: {
        orderSummary:
          "Buy 1 ETH at limit price 3000 (est. notional 3000) on Robinhood Chain Lighter (rhc); "
          + "good-till-time; expires 2030-01-01T00:00:00.000Z. API acceptance is not final execution.",
        marketSymbol: "ETH",
        baseAmountDisplay: "1",
        priceDisplay: "3000",
        notionalDisplay: "3000",
        orderExpiryIso: "2030-01-01T00:00:00.000Z",
        toolId: "lighter.order.create",
        intentId: LIGHTER_INTENT_ID,
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        marketIndex: 0,
        side: "buy",
        baseAmountInteger: "10000",
        priceInteger: "300000",
        orderType: "limit",
        timeInForce: "good-till-time",
        reduceOnly: false,
        previewId: "lighter-preview-1",
        matchHash: "a".repeat(64),
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

  it("allows and canonicalizes execute_tool lighter.order.create.prepare → execute_tool lighter.order.create", () => {
    const input = lighterCandidate();
    const result = validatePreparedActionFollowUp("execute_tool", input);
    expect(result).toEqual({
      ok: true,
      followUp: input,
    });
  });

  it("allows the injected Lighter prepare function to hand off to execute_tool lighter.order.create", () => {
    const input = lighterCandidate();
    const result = validatePreparedActionFollowUp("lighter__order__create__prepare", input);
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

  it("rejects unlisted mapping attempts", () => {
    expect(
      validatePreparedActionFollowUp("kyberswap_prequote", {
        ...candidate(),
        toolName: "kyberswap_execute",
      }),
    ).toEqual({ ok: false, reason: "unknown_mapping" });
  });

  it("rejects malformed Lighter create follow-ups", () => {
    expect(
      validatePreparedActionFollowUp("execute_tool", {
        ...lighterCandidate(),
        approvalPreview: {
          ...lighterCandidate().approvalPreview,
          namespace: undefined,
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("execute_tool", {
        ...lighterCandidate(),
        approvalPreview: {
          ...lighterCandidate().approvalPreview,
          toolName: "execute_tool",
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("execute_tool", {
        ...lighterCandidate(),
        args: {
          toolId: "lighter.order.create",
          params: { intentId: "not-a-lighter-intent" },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    for (const apiKeyIndex of [0, 1, 2, 3, 255]) {
      expect(
        validatePreparedActionFollowUp("execute_tool", {
          ...lighterCandidate(),
          approvalPreview: {
            ...lighterCandidate().approvalPreview,
            criticalArgs: {
              ...lighterCandidate().approvalPreview.criticalArgs,
              apiKeyIndex,
            },
          },
        }),
      ).toEqual({ ok: false, reason: "invalid_contract" });
    }
  });

  it("rejects Lighter create follow-ups with a missing or malformed human disclosure", () => {
    const overrides: Record<string, unknown>[] = [
      { orderSummary: "" },
      { orderSummary: null },
      { orderSummary: "x".repeat(601) },
      { marketSymbol: "" },
      { marketSymbol: "x".repeat(33) },
      { baseAmountDisplay: "not-a-number" },
      { baseAmountDisplay: "-1" },
      { priceDisplay: "3,000" },
      { notionalDisplay: "" },
      { orderExpiryIso: "whenever" },
    ];
    for (const override of overrides) {
      expect(
        validatePreparedActionFollowUp("execute_tool", {
          ...lighterCandidate(),
          approvalPreview: {
            ...lighterCandidate().approvalPreview,
            criticalArgs: {
              ...lighterCandidate().approvalPreview.criticalArgs,
              ...override,
            },
          },
        }),
        `override ${JSON.stringify(override)} must fail closed`,
      ).toEqual({ ok: false, reason: "invalid_contract" });
    }
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
