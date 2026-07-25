/**
 * Jupiter Lend Borrow REST wire-first contracts (`/lend/v1/borrow/*`).
 *
 * Rebuilt (Agent Scan Phase 3 Batch 5, card B3 — a Codex batch-5 blocker on
 * B1's original contract) from a LIVE, sanitized fixture recording — see
 * `../../../../../__tests__/solana/fixtures/lend-borrow/README.md` for the
 * full recording session, citations, and the two unit-contract DOCS-GAP
 * closures (REST position/vault numeric units; `dustBorrow` vs `borrow`).
 * `recon-docs-lend.md` §3.2 had ALREADY documented this real shape
 * (`docs/openapi-spec/lend/borrow.yaml`) — B1 missed it and modeled
 * `supplyToken`/`borrowToken` as bare mint-address strings and
 * `collateralFactor`/`liquidationThreshold` as JSON numbers; both are wrong.
 * Fixtures beat docs beat types: this file matches the recorded fixtures.
 *
 * The Borrow domain is a SEPARATE program family from Earn (`../earn-api/`) —
 * collateralized positions tracked as NFTs, one shared `/operate` endpoint
 * modeling the full lifecycle (create/deposit/withdraw/borrow/repay) via
 * signed collateral/debt deltas. `/operate-instructions` is DELIBERATELY
 * EXCLUDED (owner decision, B1 card) — this shelf never composes/signs raw
 * instructions itself, only the ready-made `/operate` transaction.
 */

import { JUPITER_LEND_API_BASE_URL } from "../constants.js";

export const JUPITER_LEND_BORROW_API_BASE_URL = `${JUPITER_LEND_API_BASE_URL}/borrow`;

/**
 * Borrow has two disjoint markets (docs: "vault/position IDs differ between
 * markets"). Every endpoint accepts an optional `market` query param
 * (verified live: "All borrow endpoints accept an optional `market`
 * parameter... Pass it as a query parameter (`?market=ethena`) on any
 * endpoint"); omitted = `"main"`.
 */
export type JupiterLendBorrowMarket = "main" | "ethena";

export const JUPITER_LEND_BORROW_MARKETS: readonly JupiterLendBorrowMarket[] = ["main", "ethena"];

export const JUPITER_LEND_BORROW_DEFAULT_MARKET: JupiterLendBorrowMarket = "main";

/**
 * `colAmount`/`debtAmount` sentinel for "repay all" / "withdraw all"
 * (verified live, quoted verbatim: MIN_I128 = "the literal string
 * -170141183460469231731687303715884105728"). Applied to `debtAmount` to
 * clear all debt including accrued-interest dust, or to `colAmount` to
 * withdraw all collateral.
 */
export const JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL = "-170141183460469231731687303715884105728";

/** `positionId: 0` means "create a new position" (verified live). */
export const JUPITER_LEND_BORROW_NEW_POSITION_ID = 0;

/**
 * Nested token descriptor on a `BorrowVault`'s `supplyToken`/`borrowToken` —
 * confirmed live (fixture: `vaults-main.json`), NOT a bare mint-address
 * string as B1 modeled it. `decimals` is the ONLY field this shelf's own math
 * depends on beyond `address` (raw amounts elsewhere in this file are always
 * base units of the relevant token's OWN `decimals` — see the fixture
 * README's unit-contract section).
 */
export interface JupiterLendBorrowToken {
  readonly address: string;
  readonly chainId: string;
  readonly name: string;
  readonly symbol: string;
  readonly uiSymbol: string;
  readonly decimals: number;
  /** Provider USD price, decimal string. */
  readonly price: string;
}

/**
 * `GET /borrow/vaults` row. `collateralFactor`/`liquidationThreshold` are
 * JSON STRINGS on the wire (confirmed live — B1 modeled them as `number`,
 * which is wrong) — scale verified live, quoted verbatim: "Each vault
 * reports `collateralFactor` (max LTV, where `800` corresponds to 80%)" —
 * i.e. raw/10 = percent, ONE implied decimal digit. `liquidationThreshold`'s
 * OWN scale is not independently documented by prose; the recorded fixtures
 * (`vaults-main.json` id 1: 800/850; id 40: 500/700; `vaults-ethena.json`
 * id 5: 920/940) are all consistent with the SAME raw/10 scale and a
 * plausible collateralFactor < liquidationThreshold < liquidationMaxLimit
 * ordering, so this shelf projects it with that scale — flagged as a
 * DOCS-GAP (not independently confirmed by prose) in
 * `../../../../vex-agent/tools/protocols/solana-jupiter/borrow-projector.ts`
 * and surfaced to the human approver (never silently assumed) — see
 * `../../../../vex-agent/engine/core/approval-intent-preview.ts`.
 */
export interface JupiterLendBorrowVault {
  readonly id: number;
  readonly address: string;
  readonly supplyToken: JupiterLendBorrowToken;
  readonly borrowToken: JupiterLendBorrowToken;
  /** Max LTV, provider-scaled STRING (see module doc — verified raw/10 = percent). */
  readonly collateralFactor: string;
  /** Liquidation threshold, ASSUMED same scale as `collateralFactor` (DOCS-GAP). */
  readonly liquidationThreshold: string;
  /** Available liquidity to borrow, raw atomic units of `borrowToken.decimals`. */
  readonly borrowable: string;
  /** Available liquidity to withdraw, raw atomic units of `supplyToken.decimals`. */
  readonly withdrawable: string;
  /** Smallest non-zero debt allowed, raw atomic units of `borrowToken.decimals`. */
  readonly minimumBorrowing: string;
}

export type JupiterLendBorrowVaultsResponse = JupiterLendBorrowVault[];

export interface JupiterLendBorrowVaultsParams {
  market?: JupiterLendBorrowMarket;
}

/**
 * `GET /borrow/positions` row (verified live field list — see
 * `recon-docs-lend.md` §3.2 and the fixture README). `supply`/`borrow`/
 * `dustBorrow` are raw atomic units of the OWNING vault's `supplyToken`/
 * `borrowToken`/`borrowToken` `decimals` respectively — the SAME base-units
 * convention `colAmount`/`debtAmount` use (see the fixture README's
 * unit-contract citation), NOT the Read SDK's own internal fixed-1e9 "shares"
 * scale (a different, internal surface). `dustBorrow` is ADDITIONAL residual
 * debt (accrued interest not yet folded into `borrow`) — true existing debt
 * is `borrow + dustBorrow` (see the fixture README's `dustBorrow` citation;
 * `../../../../vex-agent/tools/protocols/solana-jupiter/borrow-risk-preview.ts`
 * adds both). `ownerAddress` is used for a defense-in-depth owner match
 * against the wallet the risk preview is being computed for (never trust
 * `positionId` alone to identify "this wallet's position").
 */
export interface JupiterLendBorrowPosition {
  readonly id: number;
  readonly vaultId: number;
  readonly ownerAddress: string;
  readonly supply: string;
  readonly borrow: string;
  readonly dustBorrow: string;
  /**
   * The protocol's own liquidation flag (W4). Listed in the interactive API
   * reference's example row — see the fixture README — but NOT confirmed by a
   * recorded live response, because the only recording of this endpoint is
   * `[]`. Optional/nullable for exactly that reason: a safety signal must not
   * be strict enough to fail the whole positions read when the provider omits
   * it. Absence is NEVER `false` downstream — `../../../../../vex-agent/tools/
   * protocols/solana-jupiter/borrow-health.ts`'s `readLiquidationStatus` maps
   * it to the named `"unknown"` state instead.
   */
  readonly isLiquidated?: boolean | null;
}

export type JupiterLendBorrowPositionsResponse = JupiterLendBorrowPosition[];

export interface JupiterLendBorrowPositionsParams {
  users: string[];
  market?: JupiterLendBorrowMarket;
}

/**
 * `POST /borrow/operate` request (verified live "OperatePayload"). One
 * endpoint models the full lifecycle via the sign of `colAmount`/`debtAmount`
 * — see `../../../../vex-agent/tools/protocols/solana-jupiter/
 * borrow-operate-params.ts` for the Vex-side agent param → signed-delta
 * translation.
 */
export interface JupiterLendBorrowOperateRequest {
  vaultId: number;
  /** `0` creates a new position. */
  positionId: number;
  /** Defaults to `signer` upstream when omitted — not exposed as a Vex agent param (YAGNI: no known use case yet). */
  positionOwner?: string;
  signer: string;
  /** Signed integer string, raw atomic units of the vault's `supplyToken`. */
  colAmount: string;
  /** Signed integer string, raw atomic units of the vault's `borrowToken`. */
  debtAmount: string;
}

/**
 * `POST /borrow/operate` response (verified live: `nftId` + `transaction`,
 * base64 unsigned `VersionedTransaction` — NO `blockhashWithMetadata`, same
 * transaction-only shape as Earn deposit/withdraw, so `prepareVersionedTx`
 * always runs REPLACE/MANDATORY-HEIGHT mode, per design REVISION 2 R2b).
 * `nftId` is a JSON integer (confirmed live — see `operate-doc-example.json`).
 */
export interface JupiterLendBorrowOperateResponse {
  /** The position NFT id — newly assigned when the request's `positionId` was `0`. */
  nftId: number;
  transaction: string;
}
