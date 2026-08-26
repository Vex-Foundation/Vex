/**
 * THE APPROVAL HEADLINE CARRIES WHOLE ADDRESSES, ON BOTH CARD RENDERERS.
 *
 * The label is the sentence a human reads before authorizing an irreversible
 * transfer. It used to elide addresses to a ten-character prefix and a
 * six-character suffix, which is precisely the shape an address-poisoning
 * attack grinds a lookalike against: an attacker who matches both visible ends
 * renders BYTE-IDENTICALLY to the honest card while sending funds elsewhere.
 *
 * These tests are the regression guard. Each one builds a POISONED counterpart
 * that collides with the honest address under the old ellipsis rule, and
 * asserts the rendered labels differ. Revert either renderer to the ellipsis
 * and every case here goes red, because the two labels collapse onto the same
 * string.
 *
 * The `criticalArgs` panel was never elided and is asserted here too, so a
 * future "just shorten the headline" change cannot quietly take the panel with
 * it.
 */

import { describe, it, expect } from "vitest";

import type {
  DecodedWalletTransaction,
  WalletTransactionFeeBounds,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { canonicalTransactionPreview } from
  "@vex-agent/tools/internal/wallet/transaction/preview.js";
import { buildWalletIntentPreview } from "@vex-agent/tools/internal/wallet/send-types.js";

/** An EIP-55-length address of a single repeated nibble. */
const addressOf = (nibble: string): string => `0x${nibble.repeat(40)}`;

/**
 * The lookalike: same length, same first ten and last six characters as
 * `address`, different in the middle. This is exactly what the old
 * `value.slice(0, 10) + "..." + value.slice(-6)` rendered identically.
 */
function poison(address: string): string {
  const poisoned = `${address.slice(0, 10)}${"9".repeat(address.length - 16)}${address.slice(-6)}`;
  // The fixture is only meaningful if it really is an old-rule collision.
  expect(poisoned).toHaveLength(address.length);
  expect(poisoned.slice(0, 10)).toBe(address.slice(0, 10));
  expect(poisoned.slice(-6)).toBe(address.slice(-6));
  expect(poisoned).not.toBe(address);
  return poisoned;
}

const LEGACY_FEE_BOUNDS: WalletTransactionFeeBounds = {
  mode: "legacy",
  gasLimit: "21000",
  gasPriceWei: "1000000000",
  maxTotalFeeWei: "21000000000000",
};

function nativeTransfer(recipient: string): DecodedWalletTransaction {
  return {
    family: "eip155",
    role: "native_transfer",
    standard: "native",
    functionName: "nativeTransfer",
    contract: null,
    criticalArgs: { recipient, valueWei: "1" },
    unlimitedApproval: false,
    warnings: [],
  };
}

function erc20Approve(spender: string, token: string): DecodedWalletTransaction {
  return {
    family: "eip155",
    role: "approve",
    standard: "erc20",
    functionName: "approve",
    contract: token,
    criticalArgs: { spender, token, amountRaw: "1", tokenIdentityVerified: "true" },
    unlimitedApproval: false,
    warnings: [],
  };
}

const cardFor = (decoded: DecodedWalletTransaction) =>
  canonicalTransactionPreview({
    family: "eip155",
    chainAlias: "base",
    decoded,
    feeBounds: LEGACY_FEE_BOUNDS,
    evmValueWei: "1",
  });

describe("the transaction card headline carries whole addresses", () => {
  it("prints a native-transfer recipient in full, not elided", () => {
    const recipient = addressOf("2");
    const label = cardFor(nativeTransfer(recipient)).label;

    expect(label).toContain(recipient);
    expect(label).not.toContain("...");
    expect(label).not.toContain("…");
  });

  it("distinguishes a POISONED recipient that the old ellipsis rendered identically", () => {
    const honest = addressOf("2");
    const attacker = poison(honest);

    expect(cardFor(nativeTransfer(honest)).label)
      .not.toBe(cardFor(nativeTransfer(attacker)).label);
  });

  it("prints an approve spender and token in full", () => {
    const spender = addressOf("3");
    const token = addressOf("4");
    const label = cardFor(erc20Approve(spender, token)).label;

    expect(label).toContain(spender);
    expect(label).toContain(token);
    expect(label).not.toContain("...");
  });

  it("distinguishes a POISONED approve SPENDER, the address that receives the allowance", () => {
    const spender = addressOf("3");
    const token = addressOf("4");

    expect(cardFor(erc20Approve(spender, token)).label)
      .not.toBe(cardFor(erc20Approve(poison(spender), token)).label);
  });

  it("distinguishes a POISONED approve TOKEN, so a lookalike contract is visible", () => {
    const spender = addressOf("3");
    const token = addressOf("4");

    expect(cardFor(erc20Approve(spender, token)).label)
      .not.toBe(cardFor(erc20Approve(spender, poison(token))).label);
  });

  it("still carries the whole address in the bound criticalArgs panel", () => {
    const spender = addressOf("3");
    const token = addressOf("4");
    const card = cardFor(erc20Approve(spender, token));

    expect(card.criticalArgs.spender).toBe(spender);
    expect(card.criticalArgs.token).toBe(token);
  });
});

describe("the transfer card headline carries whole addresses", () => {
  it("prints the recipient in full, not elided", () => {
    const to = addressOf("5");
    const preview = buildWalletIntentPreview({
      network: "evm",
      chain: "base",
      to,
      amount: "1.5",
      token: null,
    });

    expect(preview.label).toContain(to);
    expect(preview.label).not.toContain("…");
    expect(preview.label).not.toContain("...");
    // The chain suffix still lands after the whole address.
    expect(preview.label).toBe(`Send 1.5 native to ${to} on base`);
  });

  it("distinguishes a POISONED recipient that the old ellipsis rendered identically", () => {
    const honest = addressOf("5");
    const args = { network: "evm", chain: "base", amount: "1.5", token: null };

    expect(buildWalletIntentPreview({ ...args, to: honest }).label)
      .not.toBe(buildWalletIntentPreview({ ...args, to: poison(honest) }).label);
  });

  it("still carries the whole address in the criticalArgs panel", () => {
    const to = addressOf("5");
    const preview = buildWalletIntentPreview({
      network: "evm",
      chain: "base",
      to,
      amount: "1.5",
      token: null,
    });

    expect(preview.criticalArgs.to).toBe(to);
  });
});
