/**
 * `src/tools/khalani/native-token-identity.ts` — the closed EVM native-alias
 * predicate shared by the Khalani deposit executor and the bridge-activity
 * repair sweep's R6 token correlation (F3).
 *
 * The alias set is a CLOSED three-member set. Anything else — most importantly
 * wrapped native (WETH) — is a different ERC-20 and must NOT be treated as the
 * native asset: accepting it would let a wrapped-token settlement correlate onto
 * a native-asset row.
 */

import { describe, it, expect } from "vitest";

import { isKhalaniNativeAlias } from "@tools/khalani/native-token-identity.js";
import { isNativeTransferToken } from "@tools/khalani/bridge-executor/approval-normalization.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** The checksummed sentinel Vex stores (the form the model/tool layer echoes). */
const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

describe("isKhalaniNativeAlias — the closed 3-alias EVM native set", () => {
  it.each([
    ["the zero address (Khalani's Hyperstream wire form)", ZERO_ADDRESS],
    ["the checksummed 0xEeee… sentinel Vex stores", NATIVE_SENTINEL],
    ["the lowercase 0xeeee… sentinel", NATIVE_SENTINEL.toLowerCase()],
    ["the uppercase 0xEEEE… sentinel", `0x${"E".repeat(40)}`],
    ["the literal \"native\"", "native"],
    ["the literal \"NATIVE\" (case-insensitive)", "NATIVE"],
    ["a surrounding-whitespace variant", `  ${ZERO_ADDRESS}  `],
  ])("accepts %s", (_label, token) => {
    expect(isKhalaniNativeAlias(token)).toBe(true);
  });

  it.each([
    ["wrapped native on Base (WETH)", "0x4200000000000000000000000000000000000006"],
    ["wrapped native on Ethereum (WETH)", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
    ["USDC on Base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
    ["a Solana mint", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ["the empty string", ""],
    ["a near-miss with one character short", `0x${"e".repeat(39)}`],
    ["a near-miss with one character extra", `0x${"e".repeat(41)}`],
    ["the word inside a longer string", "native-filler"],
  ])("rejects %s", (_label, token) => {
    expect(isKhalaniNativeAlias(token)).toBe(false);
  });
});

describe("approval-normalization reuses the leaf (one owner for the alias set)", () => {
  it.each([ZERO_ADDRESS, NATIVE_SENTINEL, "native", "0x4200000000000000000000000000000000000006", "usdc"])(
    "agrees with isNativeTransferToken for %s",
    (token) => {
      expect(isNativeTransferToken(token)).toBe(isKhalaniNativeAlias(token));
    },
  );
});
