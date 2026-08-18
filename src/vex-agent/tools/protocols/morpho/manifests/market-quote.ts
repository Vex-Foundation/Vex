import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_BORROW_EXECUTE_DISCOVERY } from "../../embeddings/morpho/execute-borrow.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";
import {
  MORPHO_HEALTH_FLOOR_SENTENCE,
  MORPHO_MARKET_CHAIN_PARAM,
  MORPHO_MARKET_ID_PARAM,
  MORPHO_MARKET_SLIPPAGE_PARAM,
  MORPHO_ONE_LEG_SENTENCE,
  MORPHO_ORACLE_VOUCHING_SENTENCE,
} from "./market-execute-shared.js";

/**
 * `morpho.market.quote` - price ONE Blue market operation without performing it.
 *
 * THE GATE IN FRONT OF SIX SPENDING TOOLS, and the only Morpho market tool that
 * commits nothing. It runs the execute's own path - the same market gate, the
 * same health-factor projection, the same builder and decoder, the same
 * allowance planner - so it REFUSES exactly where the execute would refuse, and
 * it does so before the user has spent anything.
 *
 * THE DIRECTION IS THE POINT. A quote authorizes exactly one execute, the one
 * matching its direction, and the description says so twice because the failure
 * mode is a real one: a collateral quote authorizing a borrow would let the
 * cheapest, safest operation to price stand in as consent for the one that
 * creates liquidation risk.
 */
export const MORPHO_MARKET_QUOTE_TOOL: ProtocolToolManifest = {
  toolId: "morpho.market.quote",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "Read-only. PRICE one Morpho Blue market operation without performing it: supplying collateral, borrowing, "
    + "repaying, withdrawing collateral, lending the loan asset into the market, or taking what was lent back out. "
    + "It signs NOTHING, sends nothing, approves nothing and moves no funds, so "
    + "there is "
    + "never a reason to hesitate over calling it. Use it whenever the user asks what an operation WOULD do: how "
    + "close to liquidation it leaves them, how much they can safely borrow, whether the market can fund it, what "
    + "they would have to approve first. "
    + "IT REFUSES WHERE THE EXECUTE WOULD REFUSE, because it runs the same gates: an unvouched market, a health "
    + "factor below the floor, a market without the liquidity, or a repayment that cannot close its debt all fail "
    + "here first, for free. "
    + `${MORPHO_ORACLE_VOUCHING_SENTENCE} `
    + `${MORPHO_HEALTH_FLOOR_SENTENCE} `
    + "IT IS ALSO MANDATORY: each of the six executes is REFUSED without a fresh quote of ITS OWN direction for the "
    + "same market, chain, amount and slippageBps. A quote of one direction NEVER authorizes another - a "
    + "supplyCollateral quote cannot authorize a borrow - because supplying collateral is safe on its own while "
    + "borrowing against it is the operation that can be liquidated. "
    + `${MORPHO_ONE_LEG_SENTENCE} `
    + "RETURNS the vouching verdict and which oracle earned it, the health factor BEFORE and AFTER against the 1.25 "
    + "floor, the position's current collateral and debt, the market's free liquidity, the allowance plan with any "
    + "approval still needed, the fully decoded transaction, a gas bound and a simulation verdict. Every projection "
    + "belongs to ONE wallet: the one named, else the session's selected wallet, else a stand-in with NO position, "
    + "which the reply says out loud rather than implying the numbers are somebody's.",
  mutating: false,
  // A fact about what it does, not a hint: this tool has no code path that could
  // sign, approve or broadcast, and it holds a PUBLIC client that could not sign
  // if asked.
  actionKind: "read",
  params: [
    {
      key: "direction",
      type: "string",
      required: true,
      enum: ["supplyCollateral", "withdrawCollateral", "borrow", "repay", "supply", "withdraw"],
      description:
        "Which operation to price. `supplyCollateral` moves the collateral token onto the market (raises the health "
        + "factor), `borrow` takes the loan token out against it (lowers it, and is the only one that creates "
        + "liquidation risk), `repay` pays debt down (raises it), `withdrawCollateral` takes collateral back off "
        + "(lowers it whenever debt remains). `supply` and `withdraw` are the LENDER'S side and move the LOAN token: "
        + "`supply` lends into the market to earn its borrow rate and `withdraw` takes that back out. Neither moves "
        + "any health factor, and neither is `supplyCollateral`/`withdrawCollateral`, which move the other token. The "
        + "quote authorizes only the execute matching this direction.",
    },
    {
      key: "marketId",
      type: "string",
      required: true,
      description: MORPHO_MARKET_ID_PARAM,
    },
    {
      key: "chain",
      type: "string",
      required: true,
      description: `${MORPHO_MARKET_CHAIN_PARAM} ${CANONICAL_CHAIN_SENTENCE}`,
    },
    {
      key: "supplyCollateralAmountRaw",
      type: "string",
      description:
        "Required when `direction` is `supplyCollateral`. RAW base units of the COLLATERAL token, whose decimals are "
        + "usually NOT the loan token's: read `collateralAsset.decimals` from `morpho.market.get`. Another "
        + "direction's amount key is refused by name rather than dropped.",
    },
    {
      key: "withdrawCollateralAmountRaw",
      type: "string",
      description:
        "Required when `direction` is `withdrawCollateral`. RAW base units of the COLLATERAL token, at that token's "
        + "own decimals.",
    },
    {
      key: "borrowAmountRaw",
      type: "string",
      description:
        "Required when `direction` is `borrow`. RAW base units of the LOAN token, at that token's own decimals "
        + "(`loanAsset.decimals` from `morpho.market.get`).",
    },
    {
      key: "repayAmountRaw",
      type: "string",
      description:
        "Used when `direction` is `repay` and the repayment is PARTIAL. RAW base units of the LOAN token, at that "
        + "token's own decimals: read `loanAsset.decimals` from `morpho.market.get`, not from token_find, because the "
        + "market names its own loan asset. Omit it and send `repayFullDebt: true` to price closing the debt "
        + "completely; sending both is refused.",
    },
    {
      key: "repayFullDebt",
      type: "boolean",
      description:
        "Set true with `direction: repay` to price closing the debt COMPLETELY. It reads the position's own borrow "
        + "shares from the chain, which is the only denomination that reaches zero: an amount always leaves accruing "
        + "dust behind. Only meaningful for a repayment.",
    },
    {
      key: "supplyAmountRaw",
      type: "string",
      description:
        "Required when `direction` is `supply`. RAW base units of the LOAN token being LENT into the market, at that "
        + "token's own decimals (`loanAsset.decimals` from `morpho.market.get`). This is the lender's side; "
        + "`supplyCollateralAmountRaw` is a different operation on a different token and is refused by name.",
    },
    {
      key: "withdrawAmountRaw",
      type: "string",
      description:
        "Required when `direction` is `withdraw`. RAW base units of the LOAN token being taken back out of the "
        + "market, at that token's own decimals. Bounded by the wallet's own supplied position AND by the market's "
        + "free liquidity, each refused by name rather than clamped.",
    },
    {
      key: "walletAddress",
      type: "string",
      description:
        "Whose position to price this against. A health factor has no meaning without one, so when this is omitted "
        + "the quote uses the session's selected EVM wallet, and when there is none it uses a stand-in with NO "
        + "position and says so. Read-only: it never selects a signer, and the executes refuse this parameter "
        + "outright.",
    },
    {
      key: "slippageBps",
      type: "number",
      unit: "bps",
      description: MORPHO_MARKET_SLIPPAGE_PARAM,
    },
  ],
  exampleParams: {
    direction: "borrow",
    marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
    chain: "base",
    borrowAmountRaw: "500000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_BORROW_EXECUTE_DISCOVERY["morpho.market.quote"],
};
