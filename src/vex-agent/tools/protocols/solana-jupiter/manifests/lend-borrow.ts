/**
 * Jupiter Lend BORROW manifests (Agent Scan Phase 3 Batch 5, card B1).
 * Separate from `./lend.ts` (Earn) — a distinct program family (collateral/
 * debt positions tracked as NFTs, one shared `/operate` endpoint for the
 * full lifecycle). Param resolution for `borrowOperate` lives in
 * `../borrow-operate-params.ts`.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { SOLANA_LEND_BORROW_DISCOVERY } from "../../embeddings/solana-jupiter/lend-borrow.js";

export const LEND_BORROW_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "solana.lend.borrowVaults",
    publicName: "solana__lend_borrow_vaults_list",
    namespace: "solana",
    lifecycle: "active",
    description: "Screen Jupiter Lend BORROW vaults - the collateralized side, where one token is posted in order to borrow another. Returns one row per vault: vaultId, both legs' identity (supplyTokenAddress, supplyTokenSymbol, supplyTokenDecimals, supplyTokenPriceUsd and the matching borrowToken* fields), maxLtvPercent and liquidationThresholdPercent as exact percent strings each with a raw provider-scale sibling, borrowableRaw and withdrawableRaw as the liquidity actually available now, and minimumBorrowingRaw. Every *Raw amount here, and all six solana__lend_borrow_operate amount params, are raw atomic units: use supplyTokenDecimals for the collateral leg and borrowTokenDecimals for the debt leg to read or build them (e.g. a raw \"1047061\" at 6 decimals is 1.047061, at 9 decimals it is 0.001047061). minimumBorrowingRaw is documented in that same debt-token scale, but live vaults with different debt-token decimals disagree by orders of magnitude under that reading - treat it as an unverified provider figure, never as a USD amount. The *PriceUsd fields are Jupiter's own point-in-time quotes, not Vex valuations - treat them as estimates. Read this BEFORE solana__lend_borrow_operate to find a vaultId, its decimals, and its risk thresholds. Covers collateralized Borrow, not solana__lend_earn_rates_list's simple Earn yields.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "market", type: "string", description: "Which Borrow market: \"main\" or \"ethena\" (default \"main\"). Vault ids are scoped per market — the same vaultId in a different market is a different vault. An unrecognized value is rejected." },
      { key: "vaultIds", type: "string", description: "Comma-separated vault-id allow-list (matches the provider's own numeric vault id). Omit for all vaults." },
    ],
    exampleParams: {},
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_BORROW_DISCOVERY["solana.lend.borrowVaults"],
  },
  {
    toolId: "solana.lend.borrowPositions",
    publicName: "solana__lend_borrow_positions_list",
    namespace: "solana",
    lifecycle: "active",
    description: "Read a wallet's open Jupiter Lend BORROW positions - what is posted as collateral and what is owed against it. Use this before adjusting or closing a loan, and whenever the question is the user's own liquidation risk. Returns `positions`, one row per position carrying its id, vaultId, collateral supplied, debt owed and residual dust debt in raw atomic units, plus a `risk` block whose status is computed, undercollateralized or unknown and is NEVER silently healthy; alongside `market`, `howToReadRisk`, and `vaultDataStatus` with `vaultDataReason`, which DISCLOSE a degraded vault lookup instead of failing the whole read - when they report the vault data missing, the risk figures are unknown and must not be presented as safe. These amounts carry no decimals of their own: cross-reference solana__lend_borrow_vaults_list by vaultId for each leg's symbol, decimals, and risk thresholds before interpreting or acting on them. Use a position's id as solana__lend_borrow_operate's positionId to adjust or close it. Covers collateralized Borrow, not solana__lend_earn_positions_list's simple Earn positions.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "walletAddress", type: "string", description: "The wallet account to read, as a Solana address. Defaults to the session's selected Solana wallet." },
      { key: "market", type: "string", description: "Which Borrow market: \"main\" or \"ethena\" (default \"main\"). An unrecognized value is rejected." },
      { key: "vaultIds", type: "string", description: "Comma-separated vault-id allow-list to filter positions to. Omit for all positions." },
    ],
    exampleParams: {},
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_BORROW_DISCOVERY["solana.lend.borrowPositions"],
  },
  {
    toolId: "solana.lend.borrowOperate",
    publicName: "solana__lend_borrow_operate",
    namespace: "solana",
    lifecycle: "active",
    description: "Open, adjust, or close a Jupiter Lend Borrow position in ONE call: deposit/withdraw collateral and/or borrow/repay debt, via the six params below (at least one required). You are responsible for the health of this position: read solana__lend_borrow_vaults_list for maxLtvPercent and liquidationThresholdPercent, and solana__lend_borrow_positions_list for current collateral and debt, and compute the post-operation LTV yourself BEFORE calling this - no preview is shown in an autonomous session. If either risk number is absent or the position reports isLiquidated, treat that as UNKNOWN risk, never as healthy: reduce debt or add collateral rather than increasing exposure. At most one collateral param (depositAmountRaw|withdrawAmountRaw|withdrawAll) and one debt param (borrowAmountRaw|repayAmountRaw|repayAll), and the two must move in OPPOSITE directions: deposit+borrow and withdraw+repay are accepted; deposit+repay and withdraw+borrow are REJECTED before signing, because the ledger records at most one incoming and one outgoing leg per call - run those as two calls. Reads first: solana__lend_borrow_vaults_list for vaultId + thresholds, solana__lend_borrow_positions_list for an existing positionId. Jupiter's /operate endpoint never wraps or unwraps native SOL - depositing or repaying a leg denominated in native SOL requires WRAPPED SOL (WSOL) already sitting in your wallet; this call fails clearly beforehand if that balance is insufficient, rather than broadcasting. This tool broadcasts and returns truthful-pending - it is tracked automatically, do not resubmit.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "vaultId", type: "number", required: true, description: "Vault to operate on - from solana__lend_borrow_vaults_list, which also gives the two legs' decimals every amount param below is expressed in." },
      { key: "positionId", type: "number", description: "Existing position id to adjust - from solana__lend_borrow_positions_list. Omit (or 0) to create a NEW position." },
      { key: "market", type: "string", description: "Which Borrow market: \"main\" or \"ethena\" (default \"main\"). Must match the vault's own market." },
      { key: "depositAmountRaw", type: "string", description: "Add this many raw atomic units of the vault's collateral token (scale = the vault's supplyTokenDecimals). Mutually exclusive with withdrawAmountRaw/withdrawAll." },
      { key: "withdrawAmountRaw", type: "string", description: "Remove this many raw atomic units of collateral (scale = the vault's supplyTokenDecimals). Mutually exclusive with depositAmountRaw/withdrawAll." },
      { key: "withdrawAll", type: "boolean", description: "Withdraw ALL collateral from this position. Mutually exclusive with depositAmountRaw/withdrawAmountRaw." },
      { key: "borrowAmountRaw", type: "string", description: "Borrow this many raw atomic units of the vault's debt token (scale = the vault's borrowTokenDecimals). Mutually exclusive with repayAmountRaw/repayAll." },
      { key: "repayAmountRaw", type: "string", description: "Repay this many raw atomic units of debt (scale = the vault's borrowTokenDecimals). Mutually exclusive with borrowAmountRaw/repayAll." },
      { key: "repayAll", type: "boolean", description: "Repay ALL debt on this position, including accrued-interest dust. Mutually exclusive with borrowAmountRaw/repayAmountRaw." },
    ],
    exampleParams: { vaultId: 1, depositAmountRaw: "30000000" },
    // Four at-most-one groups say what six prose sentences and two handler
    // checks said: one collateral param, one debt param, and — the two
    // DIRECTION groups — never two legs moving the same way, which is the
    // ledger constraint `resolveBorrowOperateRequest` refuses on and which no
    // param description documented. Money in: deposit collateral, repay debt.
    // Money out: withdraw collateral, borrow debt.
    atMostOne: [
      ["depositAmountRaw", "withdrawAmountRaw", "withdrawAll"],
      ["borrowAmountRaw", "repayAmountRaw", "repayAll"],
      ["depositAmountRaw", "repayAmountRaw", "repayAll"],
      ["withdrawAmountRaw", "withdrawAll", "borrowAmountRaw"],
    ],
    // The empty call: legal against every individual param (only vaultId is
    // required), and nothing but a wasted round trip.
    atLeastOneOf: [
      [
        "depositAmountRaw",
        "withdrawAmountRaw",
        "withdrawAll",
        "borrowAmountRaw",
        "repayAmountRaw",
        "repayAll",
      ],
    ],
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_LEND_BORROW_DISCOVERY["solana.lend.borrowOperate"],
  },
];
