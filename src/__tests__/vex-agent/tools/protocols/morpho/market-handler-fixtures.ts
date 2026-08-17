/**
 * Fixtures for the FIVE Morpho Blue MARKET handlers: the quote and the four
 * executes.
 *
 * The engine behind them (`previewMorphoMarketOperation`, the market gate, the
 * planner, the builder) is not under test in the handler suites, so it is
 * stubbed and its RESULT is shaped here, once, in the same style
 * `./vault-fixtures.ts` serves the vault lane.
 *
 * TWO TOKENS, TWO SCALES, ON PURPOSE. The market below pairs 8-decimal cbBTC
 * collateral against 6-decimal USDC debt, exactly like the market this lane was
 * proven against. A fixture whose two tokens shared one decimal scale would let
 * a handler read the wrong side's decimals and still produce a human amount that
 * looked right, which is the thousandfold error rules/90 names.
 *
 * The numbers that the handlers RENDER (health factors, liquidity, allowance
 * steps) are real `bigint`s here rather than pre-rendered strings, because the
 * projection code under test is what turns them into text.
 */

import type { MorphoBorrowOperation } from "@tools/morpho/mutations.js";

export const MARKET_ID = `0x${"9a".repeat(32)}`;
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
export const ORACLE = "0x663becd10dae6c4a3dcd89f1d76c1174199639b9";
export const IRM = "0x46415998764c29ab2a25cbea6254146d50d22687";
export const GENERAL_ADAPTER_1 = "0xb98c948cfa24072e02935fb420683e2f2a0b6a3d";
export const BUNDLER3 = "0x6bfd8137e702540e7a42b74178a4a49ba43920c4";
export const MORPHO_BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";

export const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
/** The same account a caller may legitimately send in mixed case. */
export const WALLET_MIXED = "0xAAAAbbbbCCCCddddEEEEffff0000111122223333";
export const PRIVATE_KEY = `0x${"11".repeat(32)}`;

/** 1 cbBTC at 8 decimals, and 500 USDC at 6. Deliberately different scales. */
export const COLLATERAL_AMOUNT_RAW = "100000000";
export const LOAN_AMOUNT_RAW = "500000000";

const IDENTITY = {
  chainId: 8453,
  marketId: MARKET_ID,
  loanToken: USDC,
  loanDecimals: 6,
  loanSymbol: "USDC",
  collateralToken: CBBTC,
  collateralDecimals: 8,
  collateralSymbol: "cbBTC",
  oracle: ORACLE,
  irm: IRM,
  lltvRaw: "860000000000000000",
} as const;

const POLICY = {
  chainId: 8453,
  marketId: MARKET_ID,
  irm: IRM,
  oracle: ORACLE,
  oracleProvenance: "chainlink-oracle-factory",
  lltvRaw: "860000000000000000",
  lltvDecimal: "0.86",
  explanation: "This market's oracle was minted by the chain's pinned Morpho Chainlink oracle factory.",
} as const;

/** 12,000 USDC of free liquidity, in the LOAN token's own scale. */
const SNAPSHOT = {
  totalSupplyAssetsRaw: 20_000_000_000n,
  totalBorrowAssetsRaw: 8_000_000_000n,
  availableLiquidityRaw: 12_000_000_000n,
} as const;

export function marketState(): Record<string, unknown> {
  return { identity: IDENTITY, policy: POLICY, snapshot: SNAPSHOT };
}

/** Which token an operation moves, and which way, relative to the wallet. */
const LEG_SHAPE: Readonly<Record<MorphoBorrowOperation, { direction: "in" | "out"; token: "loan" | "collateral" }>> = {
  supply_collateral: { direction: "in", token: "collateral" },
  withdraw_collateral: { direction: "out", token: "collateral" },
  borrow: { direction: "out", token: "loan" },
  repay: { direction: "in", token: "loan" },
};

/** The operations that PULL a token, and therefore approve one. */
function pullsFromWallet(operation: MorphoBorrowOperation): boolean {
  return operation === "supply_collateral" || operation === "repay";
}

export function defaultAmountRaw(operation: MorphoBorrowOperation): string {
  return LEG_SHAPE[operation].token === "loan" ? LOAN_AMOUNT_RAW : COLLATERAL_AMOUNT_RAW;
}

/**
 * One resolved intent, in the shape `resolveMorphoBorrowIntent` returns.
 *
 * `describeMorphoBorrowLeg` runs FOR REAL against this in the execute suite, so
 * the market identity here has to carry both tokens and both scales.
 */
export function marketIntent(
  operation: MorphoBorrowOperation,
  overrides: { amountRaw?: bigint | null; sharesRaw?: bigint | null; repayMode?: "assets" | "shares" | null } = {},
): Record<string, unknown> {
  const repayMode = "repayMode" in overrides
    ? overrides.repayMode
    : operation === "repay" ? "assets" : null;
  return {
    operation,
    market: IDENTITY,
    userAddress: WALLET,
    recipient: WALLET,
    amountRaw: "amountRaw" in overrides ? overrides.amountRaw : BigInt(defaultAmountRaw(operation)),
    sharesRaw: "sharesRaw" in overrides ? overrides.sharesRaw : null,
    repayMode,
  };
}

function leg(operation: MorphoBorrowOperation, amountRaw: string | null): Record<string, unknown> {
  const shape = LEG_SHAPE[operation];
  const isLoan = shape.token === "loan";
  return {
    direction: shape.direction,
    tokenAddress: isLoan ? USDC : CBBTC,
    tokenSymbol: isLoan ? "USDC" : "cbBTC",
    decimals: isLoan ? 6 : 8,
    amountRaw,
  };
}

/** A position with collateral and debt, so the health factor is a real number. */
const POSITION_BEFORE = {
  collateralRaw: 100_000_000n,
  borrowSharesRaw: 500_000_000_000_000n,
  borrowAssetsRaw: 500_000_001n,
  maxBorrowAssetsRaw: 860_000_000n,
  healthFactorWad: 1_720_000_000_000_000_000n,
  ltvWad: 500_000_000_000_000_000n,
} as const;

function allowancePlan(amountRaw: string): Record<string, unknown> {
  return {
    shape: "approve",
    token: USDC,
    spender: GENERAL_ADAPTER_1,
    spenderRole: "GeneralAdapter1",
    requiredAmountRaw: BigInt(amountRaw),
    currentAllowanceRaw: 0n,
    steps: [
      {
        kind: "approve",
        amountRaw: BigInt(amountRaw),
        explanation: "Approve exactly this amount to the chain's pinned GeneralAdapter1.",
      },
    ],
  };
}

/**
 * The preview the engine would return for one operation.
 *
 * `overrides` is shallow on purpose: a case that needs a different position or a
 * different preflight states the whole block, so a reader sees exactly what the
 * case is asserting against rather than a diff against something off-screen.
 */
export function marketPreview(
  operation: MorphoBorrowOperation,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildPreview(operation, defaultAmountRaw(operation), marketIntent(operation), overrides);
}

function buildPreview(
  operation: MorphoBorrowOperation,
  legAmountRaw: string | null,
  intent: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const amountRaw = defaultAmountRaw(operation);
  const pulls = pullsFromWallet(operation);
  return {
    market: marketState(),
    plan: {
      operation,
      market: IDENTITY,
      userAddress: WALLET,
      leg: leg(operation, legAmountRaw),
      positionBefore: POSITION_BEFORE,
      healthFactorAfterWad: 1_310_000_000_000_000_000n,
      marketSnapshot: SNAPSHOT,
      explanation: `Vex checked this ${operation} against the market gate and the health-factor floor.`,
    },
    intent,
    transaction: {
      txParams: {
        to: pulls ? BUNDLER3.toUpperCase() : MORPHO_BLUE.toUpperCase(),
        data: "0xdeadbeef",
        value: 0n,
      },
      pullAmountRaw: pulls ? BigInt(amountRaw) : null,
      approvalAmountRaw: pulls ? BigInt(amountRaw) : null,
      pullToken: pulls ? USDC : null,
      decoded: pulls
        ? { shape: "bundler3-multicall", report: { calls: ["erc20TransferFrom", "morphoRepay"] } }
        : { shape: "direct-blue-call", report: { functionName: operation, onBehalf: WALLET } },
    },
    allowance: pulls ? allowancePlan(amountRaw) : null,
    preflight: {
      verdict: pulls ? "reverted" : "ok",
      revertReason: pulls ? "insufficient allowance" : null,
      explanation: pulls
        ? "The approval does not exist yet, which is the expected shape before it lands."
        : "The node simulated this call successfully.",
    },
    gas: {
      nodeEstimate: "180000",
      vexGasLimit: "234000",
      unavailableReason: null,
      note: "Vex signs its own bound, never the provider's advertised figure.",
    },
    walletAddressWasSupplied: true,
    ...overrides,
  };
}

/** A full-debt repayment: no asset amount at all, a share count instead. */
export function fullDebtRepayPreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return buildPreview(
    "repay",
    null,
    marketIntent("repay", { amountRaw: null, sharesRaw: 500_000_000_000_000n, repayMode: "shares" }),
    overrides,
  );
}
