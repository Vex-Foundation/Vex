import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePreparedActionFollowUp } from "../../../vex-agent/tools/registry/prepared-action-follow-ups.js";
import { buildLighterDepositCalldata } from "@tools/lighter/wallet-funding/deposit-calldata.js";
import { LIGHTER_CORE_WITHDRAW_GATEWAY_ABI } from "@tools/lighter/withdrawal/core-preflight.js";
import { encodeFunctionData, formatEther } from "viem";

const INTENT_ID = "intent-00000000-0000-4000-8000-000000000001";
const LIGHTER_INTENT_ID = "lighter-exec-00000000-0000-4000-8000-000000000001";
const LIGHTER_LIFECYCLE_INTENT_ID = "lighter-lifecycle-00000000-0000-4000-8000-000000000001";
const LIGHTER_DEPOSIT_INTENT_ID = "lighter-onboard-00000000-0000-4000-8000-000000000001";
const LIGHTER_WITHDRAWAL_INTENT_ID = "lighter-withdrawal-00000000-0000-4000-8000-000000000001";
const LIGHTER_WITHDRAWAL_CLAIM_ID = "lighter-withdrawal-claim-00000000-0000-4000-8000-000000000001";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const LIGHTER_KEY_PUBLIC_KEY = "ab".repeat(40);
const LIGHTER_KEY_FINGERPRINT = createHash("sha256")
  .update(Buffer.from(LIGHTER_KEY_PUBLIC_KEY, "hex"))
  .digest("hex");

function candidate() {
  return {
    toolName: "WalletSendConfirm",
    args: { walletFamily: "solana", intentId: INTENT_ID },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "WalletSendConfirm",
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
        marketType: "perp",
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

function lighterCancelAllCandidate() {
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.order.cancelAll", params: { intentId: LIGHTER_LIFECYCLE_INTENT_ID } },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "order.cancelAll",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.order.cancelAll",
        intentId: LIGHTER_LIFECYCLE_INTENT_ID,
        actionType: "cancel_all",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        orderCount: 2,
        orderIdentities: "0:1152921504606846975,1:281474976710657",
        timeInForce: 0,
        cancelAtMs: "0",
        matchHash: "c".repeat(64),
        summary: "Immediately cancel exactly two active Lighter orders.",
      },
    },
  };
}

function lighterPositionCloseCandidate() {
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.position.close", params: { intentId: LIGHTER_LIFECYCLE_INTENT_ID } },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "position.close",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.position.close",
        intentId: LIGHTER_LIFECYCLE_INTENT_ID,
        actionType: "close_position",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        marketIndex: 0,
        symbol: "ETH",
        positionSide: "long",
        positionAmount: "1",
        averageEntryPrice: "45",
        closingSide: "sell",
        baseAmount: "1",
        baseAmountInteger: "10000",
        worstAcceptablePrice: "49.5",
        priceInteger: "4950",
        maxSlippageBps: 100,
        reduceOnly: true,
        orderType: "market",
        timeInForce: "immediate-or-cancel",
        matchHash: "d".repeat(64),
        summary: "Close the entire ETH long with a reduce-only market IOC order.",
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

function lighterWithdrawalCandidate(environment: "core" | "rhc" = "core") {
  const isCore = environment === "core";
  const amountUnits = isCore ? "2000000" : "1000000";
  const amountDisplay = isCore ? "2 USDC" : "1 USDG";
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
        environment,
        operationClass: "secure_l2_withdrawal",
        accountIndex: 42,
        apiKeyIndex: 7,
        walletAddress: "0x1111111111111111111111111111111111111111",
        destinationAddress: "0x1111111111111111111111111111111111111111",
        signingChainId: isCore ? 304 : 466324,
        settlementChainId: isCore ? 1 : 4663,
        settlementNetworkName: isCore ? "Ethereum mainnet" : "Robinhood Chain mainnet",
        assetIndex: 3,
        assetSymbol: isCore ? "USDC" : "USDG",
        assetDecimals: 6,
        settlementTokenAddress: isCore
          ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
          : "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        routeType: 0,
        route: "secure",
        amountUnits,
        amountDisplay,
        minimumWithdrawalUnits: "1000000",
        availableBalanceUnits: isCore ? "8000000" : "1000000",
        collateralUnits: isCore ? "10000000" : "1000000",
        initialMarginUnits: isCore ? "1000000" : "0",
        pendingOrderCount: 0,
        openPositionCount: 0,
        activeOrderCount: 0,
        withdrawalDelaySeconds: 1227,
        estimatedClaimableAt: "2030-01-01T00:20:27.000Z",
        gatewayAddress: isCore
          ? "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7"
          : "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
        gatewayImplementation: isCore
          ? "0x8D692294a4824d868e35B3CEcd734aCf41B2342e"
          : "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
        gatewayCodeHash: `0x${"1".repeat(64)}`,
        settlementTokenCodeHash: `0x${"2".repeat(64)}`,
        preflightObservedAt: "2030-01-01T00:00:00.000Z",
        summary: isCore
          ? "Withdraw 2 USDC from Core to the same wallet on Ethereum."
          : "Withdraw 1 USDG from RHC to the same wallet on Robinhood Chain.",
        scopeNote: "Manual claim, if required, needs separate approval.",
      },
    },
  };
}

function lighterWithdrawalClaimCandidate(environment: "core" | "rhc" = "core") {
  const isCore = environment === "core";
  const ownerAddress = "0x1111111111111111111111111111111111111111";
  const amountUnits = isCore ? "2000000" : "1000000";
  const networkFeeCeilingWei = "4000000000000000";
  return {
    toolName: "execute_tool",
    args: {
      toolId: "lighter.withdraw.claim",
      params: { claimId: LIGHTER_WITHDRAWAL_CLAIM_ID },
    },
    expiresAt: EXPIRES_AT,
    approvalPreview: {
      toolName: "claim",
      namespace: "lighter",
      criticalArgs: {
        toolId: "lighter.withdraw.claim",
        claimId: LIGHTER_WITHDRAWAL_CLAIM_ID,
        withdrawalIntentId: LIGHTER_WITHDRAWAL_INTENT_ID,
        previewId: "lwcp_aaaaaaaaaaaaaaaaaaaaaaaa",
        matchHash: "a".repeat(64),
        operationClass: isCore ? "manual_core_usdc_claim" : "manual_rhc_usdg_claim",
        settlementChainId: isCore ? 1 : 4663,
        settlementNetworkName: isCore ? "Ethereum mainnet" : "Robinhood Chain mainnet",
        walletAddress: ownerAddress,
        ownerAddress,
        gatewayAddress: isCore
          ? "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7"
          : "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
        gatewayImplementation: isCore
          ? "0x8D692294a4824d868e35B3CEcd734aCf41B2342e"
          : "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
        gatewayCodeHash: `0x${"1".repeat(64)}`,
        settlementTokenAddress: isCore
          ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
          : "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        settlementTokenCodeHash: `0x${"2".repeat(64)}`,
        assetIndex: 3,
        assetSymbol: isCore ? "USDC" : "USDG",
        assetDecimals: 6,
        amountUnits,
        amountDisplay: isCore ? "2 USDC" : "1 USDG",
        calldata: encodeFunctionData({
          abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
          functionName: "withdrawPendingBalance",
          args: [ownerAddress, 3, BigInt(amountUnits)],
        }),
        valueWei: "0",
        gasLimit: "100000",
        quotedMaxFeePerGasWei: "10000000000",
        quotedPriorityFeePerGasWei: "1000000000",
        networkFeeCeilingWei,
        networkFeeCeilingDisplay: `${formatEther(BigInt(networkFeeCeilingWei))} ETH`,
        preflightBlockNumber: "23456789",
        preflightObservedAt: "2030-01-01T00:00:00.000Z",
        summary: `Claim the exact ${isCore ? "USDC" : "USDG"} pending balance.`,
        scopeNote: "This approval spends ETH only for gas and cannot redirect the recipient.",
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
        gatewayImplementationAddress: "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
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
  it("allows and canonicalizes WalletSendPrepare → WalletSendConfirm", () => {
    const input = candidate();
    const result = validatePreparedActionFollowUp("WalletSendPrepare", input);
    expect(result).toEqual({
      ok: true,
      followUp: input,
    });
  });

  it("allows immutable lighter.order.create.prepare → lighter.order.create", () => {
    const input = lighterCandidate();
    const result = validatePreparedActionFollowUp("lighter.order.create.prepare", input);
    expect(result).toEqual({
      ok: true,
      followUp: input,
    });
  });

  it("rejects a public-name projection that was not resolved to immutable identity", () => {
    const input = lighterCandidate();
    const result = validatePreparedActionFollowUp("lighter__order_create_prepare", input);
    expect(result).toEqual({ ok: false, reason: "unknown_mapping" });
  });

  it.each(["lighter.order.cancel.prepare"])(
    "allows %s to hand off an exact Lighter cancel intent",
    (sourceToolName) => {
      const input = lighterCancelCandidate();
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({ ok: true, followUp: input });
    },
  );

  it("rejects rounded or altered Lighter cancel identity", () => {
    const input = lighterCancelCandidate();
    expect(validatePreparedActionFollowUp("lighter.order.cancel.prepare", {
      ...input,
      approvalPreview: {
        ...input.approvalPreview,
        criticalArgs: { ...input.approvalPreview.criticalArgs, providerOrderId: "1152921504606846976" },
      },
    })).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it.each(["lighter.order.modify.prepare"])(
    "allows %s to hand off an exact Lighter modify intent",
    (sourceToolName) => {
      const input = lighterModifyCandidate();
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({ ok: true, followUp: input });
    },
  );

  it("rejects an out-of-range Lighter modify amount", () => {
    const input = lighterModifyCandidate();
    expect(validatePreparedActionFollowUp("lighter.order.modify.prepare", {
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

  it.each(["lighter.order.cancelAll.prepare"])(
    "allows %s to hand off an exact Lighter cancel-all intent",
    (sourceToolName) => {
      const input = lighterCancelAllCandidate();
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({ ok: true, followUp: input });
    },
  );

  it("rejects a cancel-all approval with an altered order count", () => {
    const input = lighterCancelAllCandidate();
    expect(validatePreparedActionFollowUp("lighter.order.cancelAll.prepare", {
      ...input,
      approvalPreview: {
        ...input.approvalPreview,
        criticalArgs: { ...input.approvalPreview.criticalArgs, orderCount: 1 },
      },
    })).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it.each(["lighter.position.close.prepare"])(
    "allows %s to hand off an exact Lighter position-close intent",
    (sourceToolName) => {
      const input = lighterPositionCloseCandidate();
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({ ok: true, followUp: input });
    },
  );

  it("rejects a position close whose side would increase exposure", () => {
    const input = lighterPositionCloseCandidate();
    expect(validatePreparedActionFollowUp("lighter.position.close.prepare", {
      ...input,
      approvalPreview: {
        ...input.approvalPreview,
        criticalArgs: { ...input.approvalPreview.criticalArgs, closingSide: "buy" },
      },
    })).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it.each(["lighter.deposit.prepare"])(
    "allows %s to hand off an exact Lighter deposit intent",
    (sourceToolName) => {
      const input = lighterDepositCandidate();
      const result = validatePreparedActionFollowUp(sourceToolName, input);
      expect(result).toEqual({ ok: true, followUp: input });
    },
  );

  it("allows an exact environment-bound RHC USDG deposit preparation", () => {
    const input = lighterRhcDepositCandidate();
    expect(validatePreparedActionFollowUp("lighter.deposit.prepare", input)).toEqual({
      ok: true,
      followUp: input,
    });
  });

  it.each(["lighter.withdraw.prepare"])(
    "allows %s to hand off an exact Core withdrawal intent",
    (sourceToolName) => {
      const input = lighterWithdrawalCandidate();
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({
        ok: true,
        followUp: input,
      });
    },
  );

  it.each(["lighter.withdraw.prepare"])(
    "allows %s to hand off an exact RHC USDG withdrawal intent",
    (sourceToolName) => {
      const input = lighterWithdrawalCandidate("rhc");
      expect(validatePreparedActionFollowUp(sourceToolName, input)).toEqual({
        ok: true,
        followUp: input,
      });
    },
  );

  it("rejects a cross-environment RHC withdrawal approval tuple", () => {
    const input = lighterWithdrawalCandidate("rhc");
    expect(validatePreparedActionFollowUp("lighter.withdraw.prepare", {
      ...input,
      approvalPreview: {
        ...input.approvalPreview,
        criticalArgs: {
          ...input.approvalPreview.criticalArgs,
          signingChainId: 304,
        },
      },
    })).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it.each(["core", "rhc"] as const)(
    "allows an exact immutable %s manual withdrawal-claim handoff",
    (environment) => {
      const input = lighterWithdrawalClaimCandidate(environment);
      expect(
        validatePreparedActionFollowUp("lighter.withdraw.claim.prepare", input),
      ).toEqual({ ok: true, followUp: input });
    },
  );

  it("rejects a crossed manual withdrawal-claim settlement identity", () => {
    const input = lighterWithdrawalClaimCandidate("rhc");
    expect(validatePreparedActionFollowUp("lighter.withdraw.claim.prepare", {
      ...input,
      approvalPreview: {
        ...input.approvalPreview,
        criticalArgs: {
          ...input.approvalPreview.criticalArgs,
          settlementChainId: 1,
        },
      },
    })).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it("rejects a claim target from the ordinary withdrawal prepare source", () => {
    expect(
      validatePreparedActionFollowUp(
        "lighter.withdraw.prepare",
        lighterWithdrawalClaimCandidate(),
      ),
    ).toEqual({ ok: false, reason: "unknown_mapping" });
  });

  it.each([
    ["lighter.key.register.prepare", "core"],
    ["lighter.key.register.prepare", "rhc"],
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
    expect(validatePreparedActionFollowUp("lighter.key.register.prepare", {
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
        validatePreparedActionFollowUp("lighter.key.register.prepare", {
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
        validatePreparedActionFollowUp("lighter.deposit.prepare", {
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
      validatePreparedActionFollowUp("lighter.deposit.prepare", {
        ...lighterDepositCandidate(),
        args: {
          ...lighterDepositCandidate().args,
          amountIn: "1000000",
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("lighter.deposit.prepare", {
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
      validatePreparedActionFollowUp("TokenFind", candidate()),
    ).toEqual({ ok: false, reason: "unknown_mapping" });
    expect(
      validatePreparedActionFollowUp("WalletSendPrepare", {
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
      validatePreparedActionFollowUp("lighter.order.create.prepare", {
        ...lighterCandidate(),
        approvalPreview: {
          ...lighterCandidate().approvalPreview,
          namespace: undefined,
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("lighter.order.create.prepare", {
        ...lighterCandidate(),
        approvalPreview: {
          ...lighterCandidate().approvalPreview,
          toolName: "execute_tool",
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("lighter.order.create.prepare", {
        ...lighterCandidate(),
        args: {
          toolId: "lighter.order.create",
          params: { intentId: "not-a-lighter-intent" },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    for (const apiKeyIndex of [0, 1, 2, 3, 255]) {
      expect(
        validatePreparedActionFollowUp("lighter.order.create.prepare", {
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
      { marketType: "all" },
      { baseAmountDisplay: "not-a-number" },
      { baseAmountDisplay: "-1" },
      { priceDisplay: "3,000" },
      { notionalDisplay: "" },
      { orderExpiryIso: "whenever" },
    ];
    for (const override of overrides) {
      expect(
        validatePreparedActionFollowUp("lighter.order.create.prepare", {
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
      validatePreparedActionFollowUp("WalletSendPrepare", {
        ...candidate(),
        args: { ...candidate().args, to: "model-supplied" },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
    expect(
      validatePreparedActionFollowUp("WalletSendPrepare", {
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
      validatePreparedActionFollowUp("WalletSendPrepare", {
        ...candidate(),
        args: { walletFamily: "solana", intentId: "not-a-uuid" },
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it("rejects an unparsable expiry", () => {
    expect(
      validatePreparedActionFollowUp("WalletSendPrepare", {
        ...candidate(),
        expiresAt: "not-a-date",
      }),
    ).toEqual({ ok: false, reason: "invalid_contract" });
  });

  it("rejects an eip155 preview missing a chain and a solana preview carrying one", () => {
    expect(
      validatePreparedActionFollowUp("WalletSendPrepare", {
        toolName: "WalletSendConfirm",
        args: { walletFamily: "eip155", intentId: INTENT_ID },
        expiresAt: EXPIRES_AT,
        approvalPreview: {
          toolName: "WalletSendConfirm",
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
      validatePreparedActionFollowUp("WalletSendPrepare", {
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
