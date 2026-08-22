/**
 * Input contract for `morpho.vault.quote`.
 *
 * THE ONE RULE THAT MAKES THIS FILE DIFFERENT FROM ITS SIBLINGS. Every other
 * Morpho read parses a QUERY: a wrong value returns the wrong rows and the
 * agent can see that it did. This one parses the input to a PRICE GUARD and an
 * amount, and both are consumed as numbers rather than displayed, so a value
 * accepted here that meant something else is not visible anywhere downstream.
 * Nothing is coerced, nothing is clamped, and nothing is inferred.
 *
 * DIRECTION AND AMOUNT ARE CHECKED AGAINST EACH OTHER, not merged. `direction`
 * says what the caller intends and the amount key says what it sent, and a call
 * that says `withdraw` while sending `depositAmountRaw` is refused by name
 * rather than resolved in either direction. Picking a winner there would act on
 * a caller that has contradicted itself, which on a money path is the failure
 * rules/90 names: a mismatch that is silently resolved hides the mistake at the
 * one place it is still cheap to catch.
 *
 * The amount is read as a DECIMAL INTEGER STRING and converted with `BigInt`,
 * never through `Number`. An 18-decimal amount that passes through IEEE-754
 * loses its low digits silently, and the raw units here are the vault ASSET's,
 * which are not the share units the reply reports beside them.
 */

import { MORPHO_SUPPORTED_CHAIN_SLUGS, describeUnsupportedChain, resolveMorphoChainId } from "@tools/morpho/chains.js";
import type { MorphoVaultDirection } from "@tools/morpho/mutations.js";

import { resolveMorphoSlippageBps } from "../../slippage-policy.js";
import {
  ADDRESS_PATTERN,
  MARKET_ID_PATTERN,
  readOptionalString,
  reject,
  type MorphoParams,
} from "./_primitives.js";

/** A whole, non-negative decimal integer with no sign, exponent or separator. */
const RAW_AMOUNT_PATTERN = /^[0-9]+$/;

/** The amount param that belongs to each direction. There is no third pairing. */
const AMOUNT_KEY_FOR_DIRECTION: Record<MorphoVaultDirection, string> = {
  deposit: "depositAmountRaw",
  withdraw: "withdrawAmountRaw",
};

export interface MorphoVaultQuoteQuery {
  readonly vaultAddress: string;
  readonly chainId: number;
  readonly chainSlug: string;
  readonly direction: MorphoVaultDirection;
  /** RAW base units of the vault's ASSET. Never of its shares. */
  readonly amountRaw: bigint;
  readonly slippageBps: number;
  /** Absent means the preview runs against a stand-in address and says so. */
  readonly walletAddress?: string;
  readonly echo: Record<string, unknown>;
}

/**
 * Read one raw asset amount, or refuse.
 *
 * A human-decimal value is the mistake worth catching by name: `"1.5"` is not a
 * smaller amount than `"15"`, it is a different KIND of number, and accepting
 * it by truncation would send a thousandth of the intended size at 3 decimals.
 */
function readRawAmount(raw: unknown, param: string): MorphoParams<bigint> {
  const value = readOptionalString(raw);
  if (value === undefined) {
    return reject(param, `\`${param}\` is required for this direction and must be a whole-number string.`);
  }
  if (!RAW_AMOUNT_PATTERN.test(value)) {
    const looksDecimal = value.includes(".");
    return reject(
      param,
      `\`${param}\` must be RAW base units as a whole-number string, e.g. "1000000". Received "${value}"`
      + (looksDecimal
        ? ". That is a HUMAN decimal amount. Multiply it by 10 to the power of the vault asset's decimals first, "
          + "reading those decimals from the `asset.decimals` field of morpho__vault_get on this same vault."
        : ".")
      + " Vex refuses the value rather than rounding it, because a rounded amount is still an amount it would price.",
    );
  }
  const amount = BigInt(value);
  if (amount <= 0n) {
    return reject(param, `\`${param}\` must be greater than zero. Received "${value}", which prices nothing.`);
  }
  return { ok: true, value: amount };
}

export function parseMorphoVaultQuoteParams(p: Record<string, unknown>): MorphoParams<MorphoVaultQuoteQuery> {
  const vaultAddress = readOptionalString(p["vaultAddress"]);
  if (vaultAddress === undefined) {
    return reject("vaultAddress", "`vaultAddress` is required - the vault's 0x-prefixed 40-hex contract address.");
  }
  if (!ADDRESS_PATTERN.test(vaultAddress)) {
    const looksLikeMarketId = MARKET_ID_PATTERN.test(vaultAddress);
    return reject(
      "vaultAddress",
      `\`vaultAddress\` must be a 0x-prefixed 40-hex contract address. Received "${vaultAddress}"`
      + (looksLikeMarketId
        ? ", which is a 64-hex MARKET id. Markets are not vaults and this tool prices vault deposits only."
        : ".")
      + " Read one from morpho__vaults_discover.",
    );
  }

  const chainInput = readOptionalString(p["chain"]);
  if (chainInput === undefined) {
    return reject(
      "chain",
      `\`chain\` is required - a vault address is chain-scoped. Supported: ${MORPHO_SUPPORTED_CHAIN_SLUGS.join(", ")}.`,
    );
  }
  const chainId = resolveMorphoChainId(chainInput);
  if (chainId === undefined) return reject("chain", `\`chain\`: ${describeUnsupportedChain(chainInput)}`);

  const directionInput = readOptionalString(p["direction"]);
  if (directionInput === undefined) {
    return reject("direction", "`direction` is required and must be `deposit` or `withdraw`.");
  }
  const direction = (["deposit", "withdraw"] as const)
    .find((candidate) => candidate === directionInput.toLowerCase());
  if (direction === undefined) {
    return reject("direction", `\`direction\` must be \`deposit\` or \`withdraw\`. Received "${directionInput}".`);
  }

  const expectedKey = AMOUNT_KEY_FOR_DIRECTION[direction];
  const wrongKey = AMOUNT_KEY_FOR_DIRECTION[direction === "deposit" ? "withdraw" : "deposit"];
  if (readOptionalString(p[wrongKey]) !== undefined) {
    return reject(
      wrongKey,
      `\`direction\` is "${direction}" but \`${wrongKey}\` was supplied. Those disagree about which way the money `
      + `moves, so Vex refuses the call rather than choosing one of them. Send \`${expectedKey}\` with `
      + `direction "${direction}", or change \`direction\` to match the amount you meant.`,
    );
  }

  const amount = readRawAmount(p[expectedKey], expectedKey);
  if (!amount.ok) return amount;

  const slippage = resolveMorphoSlippageBps(`Parameter \`slippageBps\` for morpho__vault_quote`, p["slippageBps"]);
  if (!slippage.ok) return reject("slippageBps", slippage.reason);

  const walletInput = readOptionalString(p["walletAddress"]);
  if (walletInput !== undefined && !ADDRESS_PATTERN.test(walletInput)) {
    return reject(
      "walletAddress",
      `\`walletAddress\` must be a 0x-prefixed 40-hex account address. Received "${walletInput}". `
      + "Omit it entirely to preview without a wallet; do not substitute a placeholder of your own.",
    );
  }

  const wallet = walletInput?.toLowerCase();
  return {
    ok: true,
    value: {
      vaultAddress: vaultAddress.toLowerCase(),
      chainId,
      chainSlug: chainInput.trim().toLowerCase(),
      direction,
      amountRaw: amount.value,
      slippageBps: slippage.bps,
      ...(wallet === undefined ? {} : { walletAddress: wallet }),
      echo: {
        vaultAddress: vaultAddress.toLowerCase(),
        chain: chainInput.trim().toLowerCase(),
        direction,
        [expectedKey]: amount.value.toString(),
        slippageBps: slippage.bps,
        ...(wallet === undefined ? {} : { walletAddress: wallet }),
      },
    },
  };
}
