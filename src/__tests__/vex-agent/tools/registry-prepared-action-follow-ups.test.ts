import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePreparedActionFollowUp } from "../../../vex-agent/tools/registry/prepared-action-follow-ups.js";
import { buildLighterDepositCalldata } from "@tools/lighter/wallet-funding/deposit-calldata.js";

const INTENT_ID = "intent-00000000-0000-4000-8000-000000000001";
const LIGHTER_INTENT_ID = "lighter-exec-00000000-0000-4000-8000-000000000001";
const LIGHTER_LIFECYCLE_INTENT_ID = "lighter-lifecycle-00000000-0000-4000-8000-000000000001";
const LIGHTER_DEPOSIT_INTENT_ID = "lighter-onboard-00000000-0000-4000-8000-000000000001";
const LIGHTER_WITHDRAWAL_INTENT_ID = "lighter-withdrawal-00000000-0000-4000-8000-000000000001";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const LIGHTER_KEY_PUBLIC_KEY = "ab".repeat(40);
const LIGHTER_KEY_FINGERPRINT = createHash("sha256")
  .update(Buffer.from(LIGHTER_KEY_PUBLIC_KEY, "hex"))
  .digest("hex");

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

function lighterCancelCandidate() {
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.order.cancel", params: { intentId: LIGHTER_LIFECYCLE_INTENT_ID } },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "order.cancel",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.order.cancel",
        intentId: LIGHTER_LIFECYCLE_INTENT_ID,
        actionType: "cancel_one",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        marketIndex: 0,
        providerOrderId: "1152921504606846975",
        clientOrderId: "123",
        side: "buy",
        orderType: "limit",
        timeInForce: "good-till-time",
        price: "50",
        initialBaseAmount: "1",
        remainingBaseAmount: "0.5",
        filledBaseAmount: "0.5",
        matchHash: "b".repeat(64),
        summary: "Cancel exact Lighter order 1152921504606846975 on market 0.",
      },
    },
  };
}

function lighterModifyCandidate() {
  const cancel = lighterCancelCandidate();
  return {
    ...cancel,
    args: { toolId: "lighter.order.modify", params: { intentId: LIGHTER_LIFECYCLE_INTENT_ID } },
    approvalPreview: {
      toolName: "order.modify",
      namespace: "lighter",
      criticalArgs: {
        ...cancel.approvalPreview.criticalArgs,
        toolId: "lighter.order.modify",
        actionType: "modify",
        requestedBaseAmount: "0.75",
        requestedBaseAmountInteger: "7500",
        requestedPrice: "51.25",
        requestedPriceInteger: "5125",
        summary: "Modify exact Lighter order 1152921504606846975 on market 0 to total 0.75 at 51.25.",
      },
    },
  };
}

function lighterDepositCandidate() {
  return {
    toolName: "execute_tool",
    args: {
      toolId: "lighter.deposit",
      params: { intentId: LIGHTER_DEPOSIT_INTENT_ID },
    },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "deposit",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.deposit",
        intentId: LIGHTER_DEPOSIT_INTENT_ID,
        environment: "core",
        walletAddress: "0x1111111111111111111111111111111111111111",
        depositTo: "0x1111111111111111111111111111111111111111",
        depositContract: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
        chainId: 1,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
        amountDisplay: "11 USDC",
        settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        settlementTokenDecimals: 6,
        preflightMinimumTransferUnits: "1000000",
        preflightWalletBalanceUnits: "50000000",
        preflightWalletAllowanceUnits: "0",
        preflightEthereumBlockNumber: "23456789",
        preflightLighterBlockNumber: "23456780",
        preflightObservedAt: "2030-01-01T00:00:00.000Z",
        settlementNetworkName: "Ethereum mainnet",
        lighterRestBaseUrl: "https://mainnet.zklighter.elliot.ai",
        beneficiaryAddress: "0x1111111111111111111111111111111111111111",
        gatewayImplementationAddress: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
        gatewayCodeHash: `0x${"1".repeat(64)}`,
        settlementTokenImplementationAddress: null,
        settlementTokenCodeHash: `0x${"2".repeat(64)}`,
        depositCalldata: buildLighterDepositCalldata({
          environment: "core",
          to: "0x1111111111111111111111111111111111111111",
          amountUnits: 11_000_000n,
        }).data,
        depositValueWei: "0",
        approvalRequired: true,
        summary: "Deposit 11 USDC from this Vex wallet into its own Lighter account.",
        scopeNote: "This approval authorizes only this deposit, not a trade or withdrawal.",
      },
    },
  };
}

function lighterKeyRegistrationCandidate(environment: "core" | "rhc" = "core") {
  const isCore = environment === "core";
  return {
    toolName: "execute_tool",
    args: {
      toolId: "lighter.key.register",
      params: { intentId: LIGHTER_DEPOSIT_INTENT_ID },
    },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "key.register",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.key.register",
        intentId: LIGHTER_DEPOSIT_INTENT_ID,
        environment,
        walletAddress: "0x1111111111111111111111111111111111111111",
        ethereumChainId: isCore ? 1 : 4663,
        lighterChainId: isCore ? 304 : 466324,
        accountIndex: 42,
        apiKeyIndex: 6,
        registrationNonce: "0",
        publicKey: LIGHTER_KEY_PUBLIC_KEY,
        publicKeyFingerprint: LIGHTER_KEY_FINGERPRINT,
        vaultCredentialId: `lighter/${environment}/account-42/api-key-6`,
        summary: "Register this exact key.",
        authorityNote: "Registers one local credential; later actions stay separately gated.",
        signatureNote: "Signs one exact human-readable EIP-191 message locally.",
        scopeNote: "Does not authorize a deposit, order, transfer, or withdrawal.",
      },
    },
  };
}

function lighterWithdrawalCandidate() {
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.withdraw", params: { intentId: LIGHTER_WITHDRAWAL_INTENT_ID } },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "withdraw",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.withdraw",
        intentId: LIGHTER_WITHDRAWAL_INTENT_ID,
        previewId: "lwp_aaaaaaaaaaaaaaaaaaaaaaaa",
        matchHash: "a".repeat(64),
        environment: "core",
        operationClass: "secure_l2_withdrawal",
        accountIndex: 42,
        apiKeyIndex: 7,
        walletAddress: "0x1111111111111111111111111111111111111111",
        destinationAddress: "0x1111111111111111111111111111111111111111",
        signingChainId: 304,
        settlementChainId: 1,
        settlementNetworkName: "Ethereum mainnet",
        assetIndex: 3,
        assetSymbol: "USDC",
        assetDecimals: 6,
        settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        routeType: 0,
        route: "secure",
        amountUnits: "2000000",
        amountDisplay: "2 USDC",
        minimumWithdrawalUnits: "1000000",
        availableBalanceUnits: "8000000",
        collateralUnits: "10000000",
        initialMarginUnits: "1000000",
        pendingOrderCount: 0,
        openPositionCount: 0,
        activeOrderCount: 0,
        withdrawalDelaySeconds: 1227,
        estimatedClaimableAt: "2030-01-01T00:20:27.000Z",
        gatewayAddress: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
        gatewayImplementation: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
        gatewayCodeHash: `0x${"1".repeat(64)}`,
        settlementTokenCodeHash: `0x${"2".repeat(64)}`,
        preflightObservedAt: "2030-01-01T00:00:00.000Z",
        summary: "Withdraw 2 USDC from Core to the same wallet on Ethereum.",
        scopeNote: "Manual claim, if required, needs separate approval.",
      },
    },
  };
}

function lighterRhcDepositCandidate() {
  const candidate = lighterDepositCandidate();
  const walletAddress = candidate.approvalPreview.criticalArgs.walletAddress;
  return {
    ...candidate,
    approvalPreview: {
      ...candidate.approvalPreview,
      criticalArgs: {
        ...candidate.approvalPreview.criticalArgs,
        environment: "rhc",
        depositContract: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
        chainId: 4663,
        amountDisplay: "11 USDG",
        settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        settlementNetworkName: "Robinhood Chain mainnet",
        lighterRestBaseUrl: "https://api.rh.lighter.xyz",
        gatewayImplementationAddress: "0xE470e41Cacc197EA07f879577765A8c81234ED7B",
        settlementTokenImplementationAddress: "0x68184C449E1a8f34fA18d289737129FD27B66f8F",
        depositCalldata: buildLighterDepositCalldata({
          environment: "rhc",
          to: walletAddress,
          amountUnits: 11_000_000n,
        }).data,
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

  it.each(["execute_tool", "lighter__order__cancel__prepare"])(
    "allows %s to hand off an exact Lighter cancel intent",
    (sourceToolName) => {
      const input = lighterCancelCandidate();
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({ ok: true, followUp: input });
    },
  );

  it("rejects rounded or altered Lighter cancel identity", () => {
    const input = lighterCancelCandidate();
    expect(validatePreparedActionFollowUp("execute_tool", {
      ...input,
      approvalPreview: {
        ...input.approvalPreview,
        criticalArgs: { ...input.approvalPreview.criticalArgs, providerOrderId: "1152921504606846976" },
      },
    })).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it.each(["execute_tool", "lighter__order__modify__prepare"])(
    "allows %s to hand off an exact Lighter modify intent",
    (sourceToolName) => {
      const input = lighterModifyCandidate();
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({ ok: true, followUp: input });
    },
  );

  it("rejects an out-of-range Lighter modify amount", () => {
    const input = lighterModifyCandidate();
    expect(validatePreparedActionFollowUp("execute_tool", {
      ...input,
      approvalPreview: {
        ...input.approvalPreview,
        criticalArgs: {
          ...input.approvalPreview.criticalArgs,
          requestedBaseAmountInteger: (1n << 48n).toString(),
        },
      },
    })).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it.each(["execute_tool", "lighter__deposit__prepare"])(
    "allows %s to hand off an exact Lighter deposit intent",
    (sourceToolName) => {
      const input = lighterDepositCandidate();
      const result = validatePreparedActionFollowUp(sourceToolName, input);
      expect(result).toEqual({ ok: true, followUp: input });
    },
  );

  it("allows an exact environment-bound RHC USDG deposit preparation", () => {
    const input = lighterRhcDepositCandidate();
    expect(validatePreparedActionFollowUp("execute_tool", input)).toEqual({
      ok: true,
      followUp: input,
    });
  });

  it.each(["execute_tool", "lighter__withdraw__prepare"])(
    "allows %s to hand off an exact Core withdrawal intent",
    (sourceToolName) => {
      const input = lighterWithdrawalCandidate();
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({
        ok: true,
        followUp: input,
      });
    },
  );

  it.each([
    ["execute_tool", "core"],
    ["lighter__key__register__prepare", "core"],
    ["execute_tool", "rhc"],
    ["lighter__key__register__prepare", "rhc"],
  ] as const)(
    "allows %s to hand off an exact %s Lighter key-registration intent",
    (sourceToolName, environment) => {
      const input = lighterKeyRegistrationCandidate(environment);
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({
        ok: true,
        followUp: input,
      });
    },
  );

  it("rejects a cross-environment RHC key-registration approval tuple", () => {
    const candidate = lighterKeyRegistrationCandidate("rhc");
    expect(validatePreparedActionFollowUp("execute_tool", {
      ...candidate,
      approvalPreview: {
        ...candidate.approvalPreview,
        criticalArgs: {
          ...candidate.approvalPreview.criticalArgs,
          lighterChainId: 304,
        },
      },
    })).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it("rejects any altered Lighter key-registration approval field", () => {
    const overrides: Record<string, unknown>[] = [
      { environment: "rhc" },
      { walletAddress: "not-an-address" },
      { ethereumChainId: 8453 },
      { lighterChainId: 466324 },
      { accountIndex: 43 },
      { apiKeyIndex: 3 },
      { apiKeyIndex: 255 },
      { registrationNonce: "01" },
      { publicKey: "00".repeat(40) },
      { publicKeyFingerprint: "f".repeat(64) },
      { vaultCredentialId: "lighter/core/account-42/api-key-7" },
      { authorityNote: "" },
      { signatureNote: "" },
      { scopeNote: "" },
    ];
    for (const override of overrides) {
      const candidate = lighterKeyRegistrationCandidate();
      expect(
        validatePreparedActionFollowUp("execute_tool", {
          ...candidate,
          approvalPreview: {
            ...candidate.approvalPreview,
            criticalArgs: {
              ...candidate.approvalPreview.criticalArgs,
              ...override,
            },
          },
        }),
        `override ${JSON.stringify(override)} must fail closed`,
      ).toEqual({ ok: false, reason: "invalid_contract" });
    }
  });

  it("rejects Lighter deposit previews whose fund-moving fields were altered", () => {
    const overrides: Record<string, unknown>[] = [
      { intentId: "lighter-onboard-00000000-0000-4000-8000-000000000002" },
      { environment: "rhc" },
      { depositTo: "0x2222222222222222222222222222222222222222" },
      { depositContract: "0x2222222222222222222222222222222222222222" },
      { chainId: 8453 },
      { assetIndex: 4 },
      { routeType: 2 },
      { amountUnits: "0" },
      { amountDisplay: "11" },
      { amountDisplay: "11 DAI" },
      { amountDisplay: "011 USDC" },
      { settlementTokenAddress: "0x2222222222222222222222222222222222222222" },
      { settlementTokenDecimals: 18 },
      { preflightWalletBalanceUnits: "10999999" },
      { preflightWalletAllowanceUnits: "11000000", approvalRequired: true },
      { preflightEthereumBlockNumber: "0" },
      { preflightObservedAt: "not-a-date" },
      { beneficiaryAddress: "0x2222222222222222222222222222222222222222" },
      { depositCalldata: `0x8a857083${"0".repeat(256)}` },
      { depositValueWei: "1" },
      { lighterRestBaseUrl: "https://api.rh.lighter.xyz" },
    ];
    for (const override of overrides) {
      expect(
        validatePreparedActionFollowUp("execute_tool", {
          ...lighterDepositCandidate(),
          approvalPreview: {
            ...lighterDepositCandidate().approvalPreview,
            criticalArgs: {
              ...lighterDepositCandidate().approvalPreview.criticalArgs,
              ...override,
            },
          },
        }),
        `override ${JSON.stringify(override)} must fail closed`,
      ).toEqual({ ok: false, reason: "invalid_contract" });
    }
  });

  it("rejects extra Lighter deposit execution args and preview fields", () => {
    expect(
      validatePreparedActionFollowUp("execute_tool", {
        ...lighterDepositCandidate(),
        args: {
          ...lighterDepositCandidate().args,
          amountIn: "1000000",
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("execute_tool", {
        ...lighterDepositCandidate(),
        approvalPreview: {
          ...lighterDepositCandidate().approvalPreview,
          criticalArgs: {
            ...lighterDepositCandidate().approvalPreview.criticalArgs,
            recipient: "0x2222222222222222222222222222222222222222",
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
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
