/**
 * FIX 2 — unit spec for the limit-order EIP-712 sign-message guards.
 *
 * These prove the fail-closed cross-checks that stop blind-signing:
 *  - only DSLOProtocol is an accepted verifyingContract (legacy single-sig
 *    protocol is rejected for new orders);
 *  - domain.chainId must match the requested chain;
 *  - every economic create-order field (maker, assets, amounts, receiver) must
 *    equal the locally computed intent;
 *  - expiry lives ABI-encoded inside `predicate` (timestampBelow selector
 *    0x63592c2b + the 32-byte expiry word), NOT a top-level message field.
 *
 * The create fixture mirrors the REAL DSLO Order struct shape captured from a
 * live sign-message (chainId 42161): 0x6a5d4f20 === 1784500000 === expiredAt.
 */

import { describe, it, expect } from "vitest";
import {
  verifyCreateOrderSignMessage,
  verifyCancelOrderSignMessage,
  type CreateOrderIntent,
} from "@tools/kyberswap/limit-order/sign-message-verification.js";
import { DSLO_PROTOCOL } from "@tools/kyberswap/constants.js";
import type { LimitOrderEip712Message } from "@tools/kyberswap/limit-order/types.js";

const LEGACY_PROTOCOL = "0x227B0c196eA8db17A665EA6824D972A64202E936";
const MAKER = "0x1111111111111111111111111111111111111111";
const MAKER_ASSET = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // Arbitrum USDC
const TAKER_ASSET = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // Arbitrum WETH
const EXPIRED_AT = 1784500000; // 0x6a5d4f20

const INTENT: CreateOrderIntent = {
  chainId: 42161,
  maker: MAKER,
  makerAsset: MAKER_ASSET,
  takerAsset: TAKER_ASSET,
  makingAmount: "5000000",
  takingAmount: "1000000000000000",
  expiredAt: EXPIRED_AT,
};

/** 32-byte zero-padded expiry word, as embedded in the ABI-encoded predicate. */
function expiryWord(ts: number): string {
  return ts.toString(16).padStart(64, "0");
}

/** Realistic predicate: timestampBelow(uint256) selector + padded expiry word. */
function predicateFor(ts: number): string {
  return "0xda061db0" + "0".repeat(48) + "63592c2b" + expiryWord(ts);
}

function validCreateMessage(): LimitOrderEip712Message {
  return {
    domain: { name: "Kyber DSLO Protocol", version: "1", chainId: 42161, verifyingContract: DSLO_PROTOCOL },
    types: { Order: [{ name: "maker", type: "address" }] },
    primaryType: "Order",
    message: {
      salt: "12345678901234567890",
      makerAsset: MAKER_ASSET.toLowerCase(),
      takerAsset: TAKER_ASSET.toLowerCase(),
      maker: MAKER.toLowerCase(),
      receiver: MAKER.toLowerCase(),
      allowedSender: "0x0000000000000000000000000000000000000000",
      makingAmount: "5000000",
      takingAmount: "1000000000000000",
      feeConfig: "0",
      makerAssetData: "0x",
      takerAssetData: "0x",
      getMakerAmount: "0x",
      getTakerAmount: "0x",
      predicate: predicateFor(EXPIRED_AT),
      interaction: "0x",
    },
  };
}

describe("verifyCreateOrderSignMessage", () => {
  it("accepts a live-shaped message that matches the intent (happy path)", () => {
    expect(() => verifyCreateOrderSignMessage(validCreateMessage(), INTENT)).not.toThrow();
  });

  it("accepts a differently-cased (checksum) verifyingContract", () => {
    const msg = validCreateMessage();
    msg.domain.verifyingContract = DSLO_PROTOCOL.toLowerCase() as `0x${string}`;
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).not.toThrow();
  });

  it("refuses the legacy single-signature protocol as verifyingContract", () => {
    const msg = validCreateMessage();
    msg.domain.verifyingContract = LEGACY_PROTOCOL as `0x${string}`;
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/verifyingContract/);
  });

  it("refuses a mismatched domain.chainId", () => {
    const msg = validCreateMessage();
    msg.domain.chainId = 1;
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/chainId/);
  });

  it("refuses a tampered makingAmount", () => {
    const msg = validCreateMessage();
    msg.message.makingAmount = "4999999";
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/makingAmount/);
  });

  it("refuses a tampered takingAmount", () => {
    const msg = validCreateMessage();
    msg.message.takingAmount = "1";
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/takingAmount/);
  });

  it("refuses a tampered maker", () => {
    const msg = validCreateMessage();
    msg.message.maker = "0x4444444444444444444444444444444444444444";
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/message\.maker/);
  });

  it("refuses a tampered makerAsset", () => {
    const msg = validCreateMessage();
    msg.message.makerAsset = "0x4444444444444444444444444444444444444444";
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/makerAsset/);
  });

  it("refuses a tampered takerAsset", () => {
    const msg = validCreateMessage();
    msg.message.takerAsset = "0x4444444444444444444444444444444444444444";
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/takerAsset/);
  });

  it("refuses a tampered receiver (output-redirect vector)", () => {
    const msg = validCreateMessage();
    msg.message.receiver = "0x4444444444444444444444444444444444444444";
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/receiver/);
  });

  it("refuses a predicate whose expiry word does not match the requested expiry", () => {
    const msg = validCreateMessage();
    msg.message.predicate = predicateFor(EXPIRED_AT + 1);
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/predicate/);
  });

  it("refuses a predicate missing the timestampBelow selector", () => {
    const msg = validCreateMessage();
    msg.message.predicate = "0x" + expiryWord(EXPIRED_AT); // expiry word but no 63592c2b
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/predicate/);
  });

  it("refuses a missing/wrong-typed predicate field", () => {
    const msg = validCreateMessage();
    delete (msg.message as Record<string, unknown>).predicate;
    expect(() => verifyCreateOrderSignMessage(msg, INTENT)).toThrow(/predicate/);
  });
});

describe("verifyCancelOrderSignMessage", () => {
  function validCancelMessage(): LimitOrderEip712Message {
    return {
      domain: { name: "Kyber DSLO Protocol", version: "1", chainId: 42161, verifyingContract: DSLO_PROTOCOL },
      types: { CancelOrder: [{ name: "orderIds", type: "uint256[]" }] },
      primaryType: "CancelOrder",
      message: { salt: "1", orderIds: [1, 2] },
    };
  }

  it("accepts a cancel message on the allowlisted protocol + requested chain", () => {
    expect(() => verifyCancelOrderSignMessage(validCancelMessage(), { chainId: 42161 })).not.toThrow();
  });

  it("refuses the legacy protocol as verifyingContract", () => {
    const msg = validCancelMessage();
    msg.domain.verifyingContract = LEGACY_PROTOCOL as `0x${string}`;
    expect(() => verifyCancelOrderSignMessage(msg, { chainId: 42161 })).toThrow(/verifyingContract/);
  });

  it("refuses a mismatched chainId", () => {
    expect(() => verifyCancelOrderSignMessage(validCancelMessage(), { chainId: 1 })).toThrow(/chainId/);
  });
});
