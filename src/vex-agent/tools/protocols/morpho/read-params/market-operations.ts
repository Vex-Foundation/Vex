/**
 * Input contract for the SEVEN Morpho Blue MARKET tools: the preview and the six
 * operations that move real funds.
 *
 * ── ONE OWNER FOR THE OPERATION VOCABULARY ──────────────────────────────────
 *
 * The quote takes a `direction` and each execute IS a direction, exactly as the
 * vault lane splits `morpho.vault.quote` from its two executes. What must NOT be
 * split is the mapping between a direction, the engine operation it means, and
 * the amount key that belongs to it: three facts that have to agree or a
 * collateral amount ends up funding a borrow. They are one table in one file
 * here, and both parsers read it.
 *
 * ── WHY EACH OPERATION HAS ITS OWN AMOUNT KEY ───────────────────────────────
 *
 * `borrowAmountRaw` and `supplyCollateralAmountRaw` are denominated in DIFFERENT
 * TOKENS at different scales: the market this lane was proven against pairs
 * 8-decimal cbBTC collateral against 6-decimal USDC debt. A single `amountRaw`
 * key shared by six operations would let a caller send a collateral-scaled
 * number to a borrow and be off by a hundredfold with nothing to catch it. Each
 * key names its own operation, and ANOTHER operation's key arriving at the wrong
 * tool is REFUSED BY NAME rather than dropped: a silent drop hides an attempt to
 * move a different token in a different direction (rules/90).
 *
 * ── NO FEE, NO LIMIT, NO DESTINATION, NO RECIPIENT ──────────────────────────
 *
 * There is no recipient param on any of these tools. Borrowed assets and
 * withdrawn collateral land in the SIGNING WALLET by construction, and the
 * engine sets `recipient` from the session's own resolved wallet, never from
 * model input. There is no fee and no limit param either. A caller that supplies
 * an unknown key is already rejected upstream by the dispatcher.
 */

import { describeUnsupportedChain, resolveMorphoChainId } from "@tools/morpho/chains.js";
import { MORPHO_SUPPORTED_CHAIN_SLUGS } from "@tools/morpho/chains.js";
import type { MorphoBorrowOperation } from "@tools/morpho/mutations.js";

import { resolveMorphoSlippageBps } from "../../slippage-policy.js";
import {
  ADDRESS_PATTERN,
  MARKET_ID_PATTERN,
  readOptionalBool,
  readOptionalString,
  reject,
  type MorphoParams,
} from "./_primitives.js";

/** A whole, non-negative decimal integer with no sign, exponent or separator. */
const RAW_AMOUNT_PATTERN = /^[0-9]+$/;

/**
 * The agent-facing name of each operation. One tool per member, plus the quote.
 *
 * `supply` and `withdraw` are the LENDER'S side of the same market: assets lent
 * into it to earn the borrow rate, and those assets taken back out. They are not
 * `supplyCollateral` / `withdrawCollateral`, which are the BORROWER'S side and
 * move a different token that earns nothing. The six names are deliberately not
 * abbreviated to four, because the two sides answer different questions and a
 * shared name would let a lender's amount fund a borrower's position.
 */
export type MorphoMarketDirection =
  | "supplyCollateral"
  | "withdrawCollateral"
  | "borrow"
  | "repay"
  | "supply"
  | "withdraw";

export const MORPHO_MARKET_DIRECTIONS: readonly MorphoMarketDirection[] = [
  "supplyCollateral",
  "withdrawCollateral",
  "borrow",
  "repay",
  "supply",
  "withdraw",
] as const;

/** Direction to the engine's own operation name. The only place these are paired. */
const ENGINE_OPERATION: Readonly<Record<MorphoMarketDirection, MorphoBorrowOperation>> = {
  supplyCollateral: "supply_collateral",
  withdrawCollateral: "withdraw_collateral",
  borrow: "borrow",
  repay: "repay",
  supply: "supply",
  withdraw: "withdraw",
};

/** The amount key that belongs to each direction. There is no shared seventh key. */
const AMOUNT_KEY: Readonly<Record<MorphoMarketDirection, string>> = {
  supplyCollateral: "supplyCollateralAmountRaw",
  withdrawCollateral: "withdrawCollateralAmountRaw",
  borrow: "borrowAmountRaw",
  repay: "repayAmountRaw",
  supply: "supplyAmountRaw",
  withdraw: "withdrawAmountRaw",
};

/** Which of the market's two tokens an operation is denominated in. */
const AMOUNT_TOKEN: Readonly<Record<MorphoMarketDirection, "loan" | "collateral">> = {
  supplyCollateral: "collateral",
  withdrawCollateral: "collateral",
  borrow: "loan",
  repay: "loan",
  // The LENDER'S side moves the loan token: it is the asset borrowers draw.
  supply: "loan",
  withdraw: "loan",
};

export function morphoEngineOperation(direction: MorphoMarketDirection): MorphoBorrowOperation {
  return ENGINE_OPERATION[direction];
}

export function morphoAmountKey(direction: MorphoMarketDirection): string {
  return AMOUNT_KEY[direction];
}

export function morphoAmountToken(direction: MorphoMarketDirection): "loan" | "collateral" {
  return AMOUNT_TOKEN[direction];
}

/** What both parsers resolve to. `amountRaw` is null ONLY for a full-debt repayment. */
export interface MorphoMarketOperationQuery {
  readonly direction: MorphoMarketDirection;
  readonly operation: MorphoBorrowOperation;
  readonly marketId: string;
  readonly chainId: number;
  readonly chainSlug: string;
  /**
   * RAW base units of the operation's OWN token. `null` only when
   * `repayFullDebt` is true, where the size is the position's own share count
   * and is read from the chain rather than named by the caller.
   */
  readonly amountRaw: bigint | null;
  /** Routes a repayment to the SHARES path, the only one that can close a debt. */
  readonly repayFullDebt: boolean;
  readonly slippageBps: number;
  readonly echo: Record<string, unknown>;
}

export interface MorphoMarketQuoteQuery extends MorphoMarketOperationQuery {
  /** Whose position to price it against. Read-only: it never selects a signer. */
  readonly walletAddress: string | undefined;
}

export interface MorphoMarketExecuteQuery extends MorphoMarketOperationQuery {
  readonly dryRun: boolean;
}

/**
 * Read one raw amount, or refuse.
 *
 * A human-decimal value is the mistake worth catching by name on a money path:
 * `"1.5"` is not a smaller amount than `"15"`, it is a different KIND of number,
 * and accepting it by truncation would send a thousandth of the intended size at
 * 3 decimals.
 */
function readRawAmount(raw: unknown, key: string): MorphoParams<bigint> {
  const value = readOptionalString(raw);
  if (value === undefined) {
    return reject(key, `\`${key}\` is required and must be the amount in the token's RAW base units.`);
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

function readMarketId(p: Record<string, unknown>): MorphoParams<string> {
  const marketId = readOptionalString(p["marketId"]);
  if (marketId === undefined) {
    return reject("marketId", "`marketId` is required. Read one from morpho.markets.discover or morpho.positions.get.");
  }
  if (!MARKET_ID_PATTERN.test(marketId)) {
    return reject(
      "marketId",
      `\`marketId\` must be a 0x-prefixed 64-hex market id. Received "${marketId}"`
      + (ADDRESS_PATTERN.test(marketId)
        ? ", which is a 40-hex CONTRACT ADDRESS. A vault has an address; a Blue market has a 64-hex id, and this "
          + "tool operates on markets only."
        : ".")
      + " Read one from morpho.markets.discover.",
    );
  }
  return { ok: true, value: marketId.toLowerCase() };
}

function readChain(p: Record<string, unknown>): MorphoParams<{ chainId: number; chainSlug: string }> {
  const chainInput = readOptionalString(p["chain"]);
  if (chainInput === undefined) {
    return reject(
      "chain",
      `\`chain\` is required - a market id is chain-scoped and the same id on the wrong chain resolves to nothing. `
      + `Supported: ${MORPHO_SUPPORTED_CHAIN_SLUGS.join(", ")}.`,
    );
  }
  const chainId = resolveMorphoChainId(chainInput);
  if (chainId === undefined) return reject("chain", `\`chain\`: ${describeUnsupportedChain(chainInput)}`);
  return { ok: true, value: { chainId, chainSlug: chainInput.toLowerCase() } };
}

/**
 * Refuse ANOTHER operation's amount key by name.
 *
 * The vault lane refuses the opposite direction's key for the same reason, and
 * here there are FIVE wrong keys rather than one. Two of them name a different
 * TOKEN as well as a different operation, so accepting one silently would move
 * the wrong asset at the wrong scale, and two more name the LENDER'S side of a
 * market the caller addressed as a borrower (or the reverse), which is the same
 * token in a different position entirely.
 */
function rejectForeignAmountKeys(
  subject: string,
  direction: MorphoMarketDirection,
  p: Record<string, unknown>,
): MorphoParams<true> {
  for (const other of MORPHO_MARKET_DIRECTIONS) {
    if (other === direction) continue;
    const key = AMOUNT_KEY[other];
    if (readOptionalString(p[key]) === undefined) continue;
    const sameToken = AMOUNT_TOKEN[other] === AMOUNT_TOKEN[direction];
    return reject(
      key,
      `\`${key}\` was supplied to ${subject}, which performs a ${direction}. Those name different operations`
      + (sameToken
        ? `, which both move the market's ${AMOUNT_TOKEN[direction]} token but are not interchangeable.`
        : `, and they are denominated in different tokens: a ${direction} moves the market's `
          + `${AMOUNT_TOKEN[direction]} token while a ${other} moves its ${AMOUNT_TOKEN[other]} token, and the two `
          + "rarely share a decimal scale.")
      + ` Vex refuses the call rather than choosing one of them. Send \`${AMOUNT_KEY[direction]}\`.`,
    );
  }
  return { ok: true, value: true };
}

/**
 * The repayment size: an explicit partial amount, or the whole debt by shares.
 *
 * THESE TWO ARE MUTUALLY EXCLUSIVE AND BOTH TOGETHER IS A REFUSAL. They disagree
 * about how much debt to clear, and picking one would be Vex deciding a money
 * question the caller was ambiguous about.
 */
function readRepaySize(
  subject: string,
  p: Record<string, unknown>,
): MorphoParams<{ amountRaw: bigint | null; repayFullDebt: boolean }> {
  const flag = readOptionalBool(p["repayFullDebt"], "repayFullDebt");
  if (!flag.ok) return flag;
  const full = flag.value === true;
  const named = readOptionalString(p[AMOUNT_KEY.repay]) !== undefined;

  if (full && named) {
    return reject(
      "repayFullDebt",
      `${subject} received BOTH \`repayFullDebt: true\` and \`${AMOUNT_KEY.repay}\`. They disagree about how much `
      + "debt to clear, so Vex refuses rather than choosing. Send `repayFullDebt: true` to close the position "
      + `completely, or \`${AMOUNT_KEY.repay}\` alone to repay exactly that much and leave the rest open.`,
    );
  }
  if (full) return { ok: true, value: { amountRaw: null, repayFullDebt: true } };

  const amount = readRawAmount(p[AMOUNT_KEY.repay], AMOUNT_KEY.repay);
  if (!amount.ok) return amount;
  return { ok: true, value: { amountRaw: amount.value, repayFullDebt: false } };
}

/** The shared body of both parsers: market, chain, size and slippage. */
function parseCommon(
  subject: string,
  direction: MorphoMarketDirection,
  p: Record<string, unknown>,
): MorphoParams<MorphoMarketOperationQuery> {
  const marketId = readMarketId(p);
  if (!marketId.ok) return marketId;
  const chain = readChain(p);
  if (!chain.ok) return chain;

  const foreign = rejectForeignAmountKeys(subject, direction, p);
  if (!foreign.ok) return foreign;

  let amountRaw: bigint | null;
  let repayFullDebt = false;
  if (direction === "repay") {
    const size = readRepaySize(subject, p);
    if (!size.ok) return size;
    amountRaw = size.value.amountRaw;
    repayFullDebt = size.value.repayFullDebt;
  } else {
    if (p["repayFullDebt"] !== undefined) {
      return reject(
        "repayFullDebt",
        `\`repayFullDebt\` was supplied to ${subject}, which performs a ${direction} rather than a repayment. It `
        + "would have no meaning here, and Vex refuses a parameter it cannot honour rather than ignoring it.",
      );
    }
    const amount = readRawAmount(p[AMOUNT_KEY[direction]], AMOUNT_KEY[direction]);
    if (!amount.ok) return amount;
    amountRaw = amount.value;
  }

  const slippage = resolveMorphoSlippageBps(`Parameter \`slippageBps\` for ${subject}`, p["slippageBps"]);
  if (!slippage.ok) return reject("slippageBps", slippage.reason);

  return {
    ok: true,
    value: {
      direction,
      operation: ENGINE_OPERATION[direction],
      marketId: marketId.value,
      chainId: chain.value.chainId,
      chainSlug: chain.value.chainSlug,
      amountRaw,
      repayFullDebt,
      slippageBps: slippage.bps,
      echo: {
        marketId: marketId.value,
        chain: chain.value.chainSlug,
        direction,
        ...(amountRaw === null ? {} : { [AMOUNT_KEY[direction]]: amountRaw.toString() }),
        ...(direction === "repay" ? { repayFullDebt } : {}),
        slippageBps: slippage.bps,
      },
    },
  };
}

/** `morpho.market.quote`. Takes a `direction`; the executes each ARE one. */
export function parseMorphoMarketQuoteParams(
  p: Record<string, unknown>,
): MorphoParams<MorphoMarketQuoteQuery> {
  const raw = readOptionalString(p["direction"]);
  if (raw === undefined) {
    return reject(
      "direction",
      `\`direction\` is required. One of: ${MORPHO_MARKET_DIRECTIONS.join(", ")}.`,
    );
  }
  const direction = MORPHO_MARKET_DIRECTIONS.find((entry) => entry === raw);
  if (direction === undefined) {
    return reject(
      "direction",
      `\`direction\` must be one of ${MORPHO_MARKET_DIRECTIONS.join(", ")}. Received "${raw}".`,
    );
  }

  const common = parseCommon("morpho.market.quote", direction, p);
  if (!common.ok) return common;

  const walletAddress = readOptionalString(p["walletAddress"]);
  if (walletAddress !== undefined && !ADDRESS_PATTERN.test(walletAddress)) {
    return reject(
      "walletAddress",
      `\`walletAddress\` must be a 0x-prefixed 40-hex address. Received "${walletAddress}".`,
    );
  }

  return {
    ok: true,
    value: {
      ...common.value,
      walletAddress: walletAddress === undefined ? undefined : walletAddress.toLowerCase(),
      echo: {
        ...common.value.echo,
        ...(walletAddress === undefined ? {} : { walletAddress: walletAddress.toLowerCase() }),
      },
    },
  };
}

/**
 * One of the six executes. It takes NO `direction` and NO `walletAddress`: the
 * tool is the direction, and the wallet that signs is the session's own.
 */
export function parseMorphoMarketExecuteParams(
  toolId: string,
  direction: MorphoMarketDirection,
  p: Record<string, unknown>,
): MorphoParams<MorphoMarketExecuteQuery> {
  if (readOptionalString(p["direction"]) !== undefined) {
    return reject(
      "direction",
      `\`direction\` was supplied to ${toolId}, which only performs a ${direction}. Accepting it would create a `
      + "second, softer way to say which way the money moves. Call the tool that matches the operation instead.",
    );
  }
  if (readOptionalString(p["walletAddress"]) !== undefined) {
    return reject(
      "walletAddress",
      `\`walletAddress\` was supplied to ${toolId}. An execute NEVER takes an address from model input: it signs `
      + "with the session's selected wallet, and borrowed assets or withdrawn collateral land in that same wallet. "
      + "Use morpho.market.quote if you want to price this against another address.",
    );
  }

  const common = parseCommon(toolId, direction, p);
  if (!common.ok) return common;

  const dryRun = readOptionalBool(p["dryRun"], "dryRun");
  if (!dryRun.ok) return dryRun;

  return { ok: true, value: { ...common.value, dryRun: dryRun.value === true } };
}
