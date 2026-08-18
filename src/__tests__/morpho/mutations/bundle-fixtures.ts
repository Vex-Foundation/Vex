/**
 * REAL Morpho vault transactions, captured live on Base, byte for byte.
 *
 * PROVENANCE. Produced on 2026-08-17 by `agents_dm/morpho-e3/capture-bundles.ts`
 * against Base mainnet state, `@morpho-org/morpho-sdk@5.5.0`. `buildTx` is a
 * pure synchronous encode, so these are the exact bytes a real deposit or
 * withdrawal would carry; the only network traffic in the capture was the vault
 * reads that fed it. Nothing was signed and nothing was sent. The `userAddress`
 * is a throwaway key generated inside the capture, used only as an address, and
 * discarded, so it identifies nobody.
 *
 * WHY CAPTURED AND NOT HAND-WRITTEN. A decoder tested against calldata composed
 * from the decoder's own assumptions tests only that the assumptions are
 * self-consistent. The capture is the independent half, and it already earned
 * its keep: it is what proved a withdrawal is NOT a bundle at all but a direct
 * `withdraw(assets, receiver, owner)` call on the vault, which a hand-written
 * "bundle fixture" would never have shown.
 *
 * The tamper cases below are DERIVED from these bytes rather than captured, and
 * each is annotated with the single field it changes.
 */

import { generalAdapter1Abi } from "@morpho-org/morpho-sdk/abis";
import { decodeFunctionData, encodeFunctionData, type Abi, type Address } from "viem";

import { MORPHO_BUNDLER_ENTRY_CALL, type MorphoVaultIntent } from "@tools/morpho/mutations.js";

export const BASE_CHAIN_ID = 8453;

/** The wallet in the capture. A throwaway address; it holds nothing and is nobody. */
export const CAPTURED_USER: Address = "0xa02E5C16Ef47C6b7F14289F6bc546a455BAe90EA";
/** 1 USDC at 6 decimals. */
export const CAPTURED_AMOUNT_RAW = 1_000_000n;
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_BUNDLER3: Address = "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4";
export const BASE_GENERAL_ADAPTER_1: Address = "0xb98c948CFA24072e58935BC004a8A7b376AE746A";
export const BASE_PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Steakhouse Prime USDC, a V2 vault. */
export const VAULT_V2: Address = "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9";
/** Moonwell Flagship USDC, a V1 (MetaMorpho) vault. */
export const VAULT_V1: Address = "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca";

/** The `maxSharePrice` the SDK put in the captured V2 deposit, in its own scaled unit. */
export const CAPTURED_V2_MAX_SHARE_PRICE = 1_037_443_568_689_419n;
export const CAPTURED_V1_MAX_SHARE_PRICE = 1_085_178_920_434_265n;

export const V2_DEPOSIT_TX = {
  to: BASE_BUNDLER3 as string,
  value: 0n,
  data:
    "0x374f435d0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000180000000000000000000000000b98c948cfa24072e58935bc004a8a7b376ae746a00000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064d96ca0b9000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000b98c948cfa24072e58935bc004a8a7b376ae746a00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000b98c948cfa24072e58935bc004a8a7b376ae746a00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000846ef5eeae000000000000000000000000beef0e0834849acc03f0089f01f4f1eeb06873c900000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000003af8ca762e10b000000000000000000000000a02e5c16ef47c6b7f14289f6bc546a455bae90ea00000000000000000000000000000000000000000000000000000000",
} as const;

export const V1_DEPOSIT_TX = {
  to: BASE_BUNDLER3 as string,
  value: 0n,
  data:
    "0x374f435d0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000180000000000000000000000000b98c948cfa24072e58935bc004a8a7b376ae746a00000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064d96ca0b9000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000b98c948cfa24072e58935bc004a8a7b376ae746a00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000b98c948cfa24072e58935bc004a8a7b376ae746a00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000846ef5eeae000000000000000000000000c1256ae5ff1cf2719d4937adb3bbccab2e00a2ca00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000003daf6e811fa59000000000000000000000000a02e5c16ef47c6b7f14289f6bc546a455bae90ea00000000000000000000000000000000000000000000000000000000",
} as const;

/** A withdrawal is a DIRECT vault call. This is the finding, not a simplification. */
export const V2_WITHDRAW_TX = {
  to: VAULT_V2 as string,
  value: 0n,
  data:
    "0xb460af9400000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000a02e5c16ef47c6b7f14289f6bc546a455bae90ea000000000000000000000000a02e5c16ef47c6b7f14289f6bc546a455bae90ea",
} as const;

export const V1_WITHDRAW_TX = {
  to: VAULT_V1 as string,
  value: 0n,
  data: V2_WITHDRAW_TX.data,
} as const;

function intent(direction: "deposit" | "withdraw", vaultAddress: Address): MorphoVaultIntent {
  return {
    chainId: BASE_CHAIN_ID,
    direction,
    vaultAddress,
    assetAddress: BASE_USDC,
    assetDecimals: 6,
    shareDecimals: 18,
    amountRaw: CAPTURED_AMOUNT_RAW,
    userAddress: CAPTURED_USER,
    recipient: CAPTURED_USER,
  };
}

export const V2_DEPOSIT_INTENT = intent("deposit", VAULT_V2);
export const V1_DEPOSIT_INTENT = intent("deposit", VAULT_V1);
export const V2_WITHDRAW_INTENT = intent("withdraw", VAULT_V2);
export const V1_WITHDRAW_INTENT = intent("withdraw", VAULT_V1);

/** A ceiling that comfortably admits the captured guard, for the happy path. */
export const V2_GENEROUS_CEILING = CAPTURED_V2_MAX_SHARE_PRICE + 1_000n;

/**
 * Swap one 32-byte word inside the calldata by matching its hex, so a tamper
 * case changes EXACTLY the field it names and nothing else. Used only where the
 * change is a selector, which no re-encode could express.
 */
export function tamper(data: string, find: string, replace: string): string {
  const needle = find.toLowerCase().replace(/^0x/, "");
  const haystack = data.toLowerCase();
  if (!haystack.includes(needle)) {
    throw new Error(`tamper() found no "${needle}" to replace; the fixture changed under the test.`);
  }
  return haystack.replace(needle, replace.toLowerCase().replace(/^0x/, ""));
}

/** The Bundler3 leg tuple, as the decoder sees it. */
export interface CapturedLeg {
  to: Address;
  data: `0x${string}`;
  value: bigint;
  skipRevert: boolean;
  callbackHash: `0x${string}`;
}

/**
 * Decode the captured deposit's legs, let a test rewrite them, and re-encode.
 *
 * Re-encoding beats string surgery for every tamper case that is not a selector
 * swap: the result is always structurally valid calldata, so a rejection proves
 * the CHECK fired rather than that the bytes became unparseable.
 */
/**
 * Rebuild the captured pull leg with a different receiver, leaving the token
 * and the amount exactly as captured.
 *
 * Re-encoded from the ABI rather than string-patched because GeneralAdapter1's
 * address appears several times in the calldata (it is also every leg's
 * target), so a textual swap would move more than the one field this names.
 */
export function pullLegWithReceiver(legs: readonly CapturedLeg[], receiver: Address): readonly CapturedLeg[] {
  return legs.map((leg, index) => {
    if (index !== 0) return leg;
    const decoded = decodeFunctionData({ abi: generalAdapter1Abi as Abi, data: leg.data });
    const [asset, , amount] = (decoded.args ?? []) as [Address, Address, bigint];
    return {
      ...leg,
      data: encodeFunctionData({
        abi: generalAdapter1Abi as Abi,
        functionName: "erc20TransferFrom",
        args: [asset, receiver, amount],
      }),
    };
  });
}

export function reencodeDepositBundle(
  rewrite: (legs: readonly CapturedLeg[]) => readonly CapturedLeg[],
): { to: string; data: string; value: bigint } {
  const decoded = decodeFunctionData({
    abi: MORPHO_BUNDLER_ENTRY_CALL.abi,
    data: V2_DEPOSIT_TX.data as `0x${string}`,
  });
  const legs = decoded.args?.[0] as readonly CapturedLeg[];
  return {
    to: V2_DEPOSIT_TX.to,
    value: 0n,
    data: encodeFunctionData({
      abi: MORPHO_BUNDLER_ENTRY_CALL.abi,
      functionName: "multicall",
      args: [rewrite(legs)],
    }),
  };
}
