/**
 * Parameter validation for the two Morpho vault EXECUTE tools.
 *
 * It is a separate module from `read-params/quote.ts` rather than a widening of
 * it, because the two lanes genuinely disagree about two params and pretending
 * otherwise would weaken one of them:
 *
 *   `direction`     the quote takes it; the execute tools ARE the direction, one
 *                   tool each. Accepting it here would create a second, softer
 *                   way to say which way the money moves.
 *   `walletAddress` the quote takes it to choose whose allowance to report; the
 *                   execute NEVER takes an address from model input. The wallet
 *                   that signs is the session's selected wallet and nothing a
 *                   model sends can redirect it.
 *
 * There is no fee, limit or destination param on either tool, and there is no
 * recipient: the proceeds land in the signing wallet by construction. A caller
 * that supplies an unknown key is already rejected upstream by the dispatcher.
 */

import {
  describeUnsupportedChain,
  resolveMorphoChainId,
} from "@tools/morpho/chains.js";
import { MORPHO_SUPPORTED_CHAIN_SLUGS } from "@tools/morpho/chains.js";
import type { MorphoVaultDirection } from "@tools/morpho/mutations.js";

import { resolveMorphoSlippageBps } from "../../../slippage-policy.js";
import {
  ADDRESS_PATTERN,
  MARKET_ID_PATTERN,
  readOptionalBool,
  readOptionalString,
  reject,
  type MorphoParams,
} from "../../read-params/_primitives.js";

/** A whole, non-negative decimal integer with no sign, exponent or separator. */
const RAW_AMOUNT_PATTERN = /^[0-9]+$/;

/** The amount key that belongs to each direction. There is no third pairing. */
const AMOUNT_KEY: Record<MorphoVaultDirection, string> = {
  deposit: "depositAmountRaw",
  withdraw: "withdrawAmountRaw",
};

export interface MorphoVaultExecuteQuery {
  readonly direction: MorphoVaultDirection;
  readonly vaultAddress: string;
  readonly chainId: number;
  readonly chainSlug: string;
  /** RAW base units of the vault's ASSET. Never of its shares. */
  readonly amountRaw: bigint;
  readonly slippageBps: number;
  readonly dryRun: boolean;
  readonly echo: Record<string, unknown>;
}

/**
 * Read one raw asset amount, or refuse.
 *
 * A human-decimal value is the mistake worth catching by name on a money path:
 * `"1.5"` is not a smaller amount than `"15"`, it is a different KIND of number,
 * and accepting it by truncation would send a thousandth of the intended size at
 * 3 decimals.
 */
function readRawAmount(raw: unknown, key: string): MorphoParams<bigint> {
  const value = readOptionalString(raw);
  if (value === undefined) {
    return reject(key, `\`${key}\` is required and must be the amount in the vault asset's RAW base units.`);
  }
  if (!RAW_AMOUNT_PATTERN.test(value)) {
    return reject(
      key,
      `\`${key}\` must be a whole number of RAW base units as a string, for example "1000000" for 1 USDC at 6 `
      + `decimals. Received "${value}". A human decimal amount is refused rather than rounded, because the two are `
      + "different kinds of number and guessing between them can move a thousandfold wrong amount.",
    );
  }
  const amount = BigInt(value);
  if (amount <= 0n) {
    return reject(key, `\`${key}\` must be greater than zero. Received "${value}".`);
  }
  return { ok: true, value: amount };
}

export function parseMorphoVaultExecuteParams(
  toolId: string,
  direction: MorphoVaultDirection,
  p: Record<string, unknown>,
): MorphoParams<MorphoVaultExecuteQuery> {
  const vaultAddress = readOptionalString(p["vaultAddress"]);
  if (vaultAddress === undefined) {
    return reject("vaultAddress", "`vaultAddress` is required. Read one from morpho__vaults_discover.");
  }
  if (!ADDRESS_PATTERN.test(vaultAddress)) {
    return reject(
      "vaultAddress",
      `\`vaultAddress\` must be a 0x-prefixed 40-hex contract address. Received "${vaultAddress}"`
      + (MARKET_ID_PATTERN.test(vaultAddress)
        ? ", which is a 64-hex MARKET id. Markets are not vaults and this tool operates on vaults only."
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

  // The OTHER direction's amount key, refused by name. A silent drop would hide
  // an attempt to move money the other way (rules/90).
  const wrongKey = AMOUNT_KEY[direction === "deposit" ? "withdraw" : "deposit"];
  if (readOptionalString(p[wrongKey]) !== undefined) {
    return reject(
      wrongKey,
      `\`${wrongKey}\` was supplied to ${toolId}, which only ${direction}s. Those disagree about which way the money `
      + `moves, so Vex refuses the call rather than choosing one of them. Send \`${AMOUNT_KEY[direction]}\`, or call `
      + "the other tool.",
    );
  }

  const amount = readRawAmount(p[AMOUNT_KEY[direction]], AMOUNT_KEY[direction]);
  if (!amount.ok) return amount;

  const slippage = resolveMorphoSlippageBps(`Parameter \`slippageBps\` for ${toolId}`, p["slippageBps"]);
  if (!slippage.ok) return reject("slippageBps", slippage.reason);

  const dryRun = readOptionalBool(p["dryRun"], "dryRun");
  if (!dryRun.ok) return dryRun;

  const chainSlug = chainInput.toLowerCase();
  return {
    ok: true,
    value: {
      direction,
      vaultAddress: vaultAddress.toLowerCase(),
      chainId,
      chainSlug,
      amountRaw: amount.value,
      slippageBps: slippage.bps,
      dryRun: dryRun.value === true,
      echo: {
        vaultAddress: vaultAddress.toLowerCase(),
        chain: chainSlug,
        [AMOUNT_KEY[direction]]: amount.value.toString(),
        slippageBps: slippage.bps,
      },
    },
  };
}
