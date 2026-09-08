/**
 * THE LIGHTER REST FIELD NAMES, table-tested against Lighter's own descriptor
 * rather than against themselves.
 *
 * THE DEFECT THIS PINS. `types.ts` and `validation.ts` spell out every field
 * Vex reads off a Lighter trade or market record. Rule 10 item 2 forbids
 * hand-spelled wire names for the reason this file exists to enforce: nothing
 * fails when the provider renames `taker_position_size_before` or changes
 * `usd_amount` from a decimal string to a number. The validator's
 * `.passthrough()` keeps the response valid, the optional field reads
 * `undefined`, the projection shows null, the campaign row reports a null
 * volume, and the first evidence is a number a human disbelieves. A test that
 * re-listed the same names by hand would pin the typo instead of the contract.
 *
 * THE ARTIFACT. `src/tools/lighter/wire/openapi-fields.json` is produced by
 * `scripts/extract-lighter-openapi-fields.mjs` from
 * `agents-colab/lighter-python/openapi.json`, the descriptor the official
 * Python SDK's models are generated from, and carries that descriptor's
 * sha256, the clone's git commit and the SDK version. This test reads ONLY the
 * committed artifact: the clone is gitignored, so a test that reached into it
 * would pass on one machine, fail in CI, and pin whatever revision that
 * machine happened to have. It is the same rule
 * `lighter-wire-codes.test.ts` follows for the signer's integers.
 *
 * BOTH DIRECTIONS, which is what makes it a table test:
 *  - every field the VALIDATOR accepts exists in the descriptor with the type
 *    Vex reads it as, so a rename or a retype fails here;
 *  - every field the DESCRIPTOR declares is either validated or named in
 *    `DELIBERATELY_UNREAD` with a reason, so a NEW provider field lands here
 *    and gets a decision instead of going unnoticed (the provider-depth
 *    decree: an undeclared depth gap is a defect, not a backlog item);
 *  - every field a PROJECTION reads is one the validator accepts, so nothing
 *    is projected out of an unvalidated corner of a passthrough object.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  LIGHTER_MARKET_DETAIL_VALIDATED_FIELDS,
  LIGHTER_TRADE_VALIDATED_FIELDS,
} from "@tools/lighter/validation.js";

const ARTIFACT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../tools/lighter/wire/openapi-fields.json",
);

interface WireProperty {
  readonly name: string;
  readonly type: string;
  readonly format: string | null;
  readonly ref: string | null;
  readonly enum: readonly string[] | null;
  readonly description: string | null;
}

interface WireSchema {
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, WireProperty>>;
}

interface WireArtifact {
  readonly source: string;
  readonly generator: string;
  readonly regenerate: string;
  readonly descriptorPath: string;
  readonly descriptorSha256: string;
  readonly openapiVersion: string | null;
  readonly sdkCommit: string | null;
  readonly sdkVersion: string | null;
  readonly extractedAt: string;
  readonly schemas: Readonly<Record<string, WireSchema>>;
}

const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as WireArtifact;

/**
 * The JSON type Vex reads each Trade field as. The VALUE compared against is
 * the descriptor's, never this table's: a disagreement means Lighter changed
 * the wire and Vex's parser is now wrong about it.
 */
const TRADE_WIRE_TYPES: Readonly<Record<string, string>> = {
  trade_id: "integer",
  trade_id_str: "string",
  tx_hash: "string",
  type: "string",
  market_id: "integer",
  size: "string",
  price: "string",
  usd_amount: "string",
  ask_id: "integer",
  ask_id_str: "string",
  bid_id: "integer",
  bid_id_str: "string",
  ask_account_id: "integer",
  bid_account_id: "integer",
  is_maker_ask: "boolean",
  block_height: "integer",
  timestamp: "integer",
  transaction_time: "integer",
  integrator_maker_fee: "integer",
  integrator_taker_fee: "integer",
  integrator_maker_fee_collector_index: "integer",
  integrator_taker_fee_collector_index: "integer",
  taker_fee: "integer",
  maker_fee: "integer",
  ask_client_id: "integer",
  bid_client_id: "integer",
  ask_client_id_str: "string",
  bid_client_id_str: "string",
  taker_position_size_before: "string",
  taker_entry_quote_before: "string",
  taker_initial_margin_fraction_before: "integer",
  taker_position_sign_changed: "boolean",
  maker_position_size_before: "string",
  maker_entry_quote_before: "string",
  maker_initial_margin_fraction_before: "integer",
  maker_position_sign_changed: "boolean",
  ask_account_pnl: "string",
  bid_account_pnl: "string",
  taker_allocated_margin_usdc_before: "integer",
  taker_allocated_margin_usdc_after: "integer",
  maker_allocated_margin_usdc_before: "integer",
  maker_allocated_margin_usdc_after: "integer",
  ask_order_version: "integer",
  bid_order_version: "integer",
};

/**
 * Descriptor fields Vex deliberately does not read, each with the reason. A
 * NEW provider field is absent from both tables and fails the completeness
 * check below, which is the point: the decision is made here, in the open.
 */
const TRADE_DELIBERATELY_UNREAD: Readonly<Record<string, string>> = {};

const MARKET_DETAIL_WIRE_TYPES: Readonly<Record<string, string>> = {
  symbol: "string",
  market_id: "integer",
  market_type: "string",
  base_asset_id: "integer",
  quote_asset_id: "integer",
  status: "string",
  taker_fee: "string",
  maker_fee: "string",
  liquidation_fee: "string",
  min_base_amount: "string",
  min_quote_amount: "string",
  supported_size_decimals: "integer",
  supported_price_decimals: "integer",
  supported_quote_decimals: "integer",
  order_quote_limit: "string",
  is_maker_fee_enabled: "boolean",
  is_taker_fee_enabled: "boolean",
  size_decimals: "integer",
  price_decimals: "integer",
  quote_multiplier: "integer",
  default_initial_margin_fraction: "integer",
  min_initial_margin_fraction: "integer",
  maintenance_margin_fraction: "integer",
  closeout_margin_fraction: "integer",
  last_trade_price: "number",
  daily_trades_count: "integer",
  daily_base_token_volume: "number",
  daily_quote_token_volume: "number",
  daily_price_low: "number",
  daily_price_high: "number",
  daily_price_change: "number",
  daily_chart: "object",
  open_interest: "number",
  market_config: "object",
  strategy_index: "integer",
  funding_clamp_small: "string",
  funding_clamp_big: "string",
  base_interest_rate: "string",
  mark_price: "string",
  index_price: "string",
};

/**
 * Order-book detail fields Vex does not read, with the reason each is left on
 * the wire. Every one of these is a declared depth gap under the
 * provider-depth decree, not an oversight.
 */
const MARKET_DETAIL_DELIBERATELY_UNREAD: Readonly<Record<string, string>> = {
  created_at: "market listing time; no surface asks when a market was created",
  multiplier: "spot contract multiplier; Vex sizes spot orders from the decimals, not the multiplier",
  market_flags: "an undocumented provider bitfield; reading bits nobody has decoded would be guesswork",
  funding_premium_multiplier:
    "an input to Lighter's own funding formula; Vex reports funding as the provider computes it and never recomputes it",
};

/**
 * The wire fields each projection reads. Checked against the validator list
 * below, so a projection can never read out of the passthrough corner of a
 * response nobody validated.
 */
const PROJECTED_TRADE_FIELDS: readonly string[] = [
  "trade_id",
  "trade_id_str",
  "type",
  "market_id",
  "price",
  "size",
  "usd_amount",
  "is_maker_ask",
  "ask_account_id",
  "bid_account_id",
  "ask_id",
  "ask_id_str",
  "bid_id",
  "bid_id_str",
  "block_height",
  "timestamp",
  "transaction_time",
  "tx_hash",
  "maker_fee",
  "taker_fee",
  "integrator_maker_fee",
  "integrator_taker_fee",
  "integrator_maker_fee_collector_index",
  "integrator_taker_fee_collector_index",
  "taker_position_size_before",
  "taker_entry_quote_before",
  "taker_initial_margin_fraction_before",
  "taker_position_sign_changed",
  "maker_position_size_before",
  "maker_entry_quote_before",
  "maker_initial_margin_fraction_before",
  "maker_position_sign_changed",
  "ask_account_pnl",
  "bid_account_pnl",
];

const PROJECTED_MARKET_DETAIL_FIELDS: readonly string[] = [
  "market_id",
  "symbol",
  "market_type",
  "status",
  "base_asset_id",
  "quote_asset_id",
  "min_base_amount",
  "min_quote_amount",
  "order_quote_limit",
  "supported_size_decimals",
  "supported_price_decimals",
  "supported_quote_decimals",
  "maker_fee",
  "taker_fee",
  "liquidation_fee",
  "is_maker_fee_enabled",
  "is_taker_fee_enabled",
  "last_trade_price",
  "open_interest",
  "daily_trades_count",
  "daily_base_token_volume",
  "daily_quote_token_volume",
  "daily_price_low",
  "daily_price_high",
  "daily_price_change",
  "size_decimals",
  "price_decimals",
  "quote_multiplier",
  "strategy_index",
  "default_initial_margin_fraction",
  "min_initial_margin_fraction",
  "maintenance_margin_fraction",
  "closeout_margin_fraction",
  "mark_price",
  "index_price",
  "funding_clamp_small",
  "funding_clamp_big",
  "base_interest_rate",
];

/** The two order-book detail schemas together: a perp field is absent from the spot one. */
const marketDetailProperties: Readonly<Record<string, WireProperty>> = {
  ...artifact.schemas.SpotOrderBookDetail.properties,
  ...artifact.schemas.PerpsOrderBookDetail.properties,
};

describe("the Lighter OpenAPI field artifact", () => {
  it("records where it came from and how to regenerate itself", () => {
    expect(artifact.generator).toBe("scripts/extract-lighter-openapi-fields.mjs");
    expect(artifact.regenerate).toContain("node scripts/extract-lighter-openapi-fields.mjs");
    expect(artifact.descriptorPath).toBe("agents-colab/lighter-python/openapi.json");
    expect(artifact.descriptorSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(artifact.openapiVersion).toBe("3.0.0");
  });

  it("carries the four schemas Vex projects or stores", () => {
    expect(Object.keys(artifact.schemas).sort()).toEqual([
      "AccountPosition",
      "PerpsOrderBookDetail",
      "SpotOrderBookDetail",
      "Trade",
    ]);
  });
});

describe("Trade fields the validator accepts exist in Lighter's descriptor", () => {
  it.each(LIGHTER_TRADE_VALIDATED_FIELDS.map((field) => ({ field })))(
    "$field is a descriptor property of the type Vex reads",
    ({ field }) => {
      const expectedType = TRADE_WIRE_TYPES[field];
      // A validated field with no entry here is a field nobody stated a wire
      // type for. Add it to the table; do not delete the assertion.
      expect(expectedType, `no wire type declared for ${field}`).toBeDefined();
      expect(artifact.schemas.Trade.properties).toHaveProperty(field);
      expect(artifact.schemas.Trade.properties[field].type).toBe(expectedType);
    },
  );

  it("accounts for every Trade property the descriptor declares", () => {
    const unaccounted = Object.keys(artifact.schemas.Trade.properties).filter(
      (field) =>
        !LIGHTER_TRADE_VALIDATED_FIELDS.includes(field)
        && TRADE_DELIBERATELY_UNREAD[field] === undefined,
    );
    // A NEW provider field lands here. Decide it: validate it, or record why
    // Vex does not read it.
    expect(unaccounted).toEqual([]);
  });

  it("reads the two account PnL fields Lighter documents as the queried account's own", () => {
    // Reading the counterparty's half would report a stranger's realized PnL
    // as the user's, so the descriptor's own wording is pinned.
    expect(artifact.schemas.Trade.properties.ask_account_pnl.description).toContain(
      "Realized PnL for the queried account index",
    );
    expect(artifact.schemas.Trade.properties.bid_account_pnl.description).toContain(
      "reducing a short position",
    );
  });

  it("pins the trade type enum the ledger's CHECK constraint mirrors", () => {
    expect(artifact.schemas.Trade.properties.type.enum).toEqual([
      "trade",
      "liquidation",
      "deleverage",
      "market-settlement",
    ]);
  });

  it("projects nothing the validator did not accept", () => {
    const unvalidated = PROJECTED_TRADE_FIELDS.filter(
      (field) => !LIGHTER_TRADE_VALIDATED_FIELDS.includes(field),
    );
    expect(unvalidated).toEqual([]);
  });
});

describe("Order-book detail fields the validator accepts exist in Lighter's descriptor", () => {
  it.each(LIGHTER_MARKET_DETAIL_VALIDATED_FIELDS.map((field) => ({ field })))(
    "$field is a descriptor property of the type Vex reads",
    ({ field }) => {
      const expectedType = MARKET_DETAIL_WIRE_TYPES[field];
      expect(expectedType, `no wire type declared for ${field}`).toBeDefined();
      expect(marketDetailProperties).toHaveProperty(field);
      expect(marketDetailProperties[field].type).toBe(expectedType);
    },
  );

  it("accounts for every order-book detail property the descriptor declares", () => {
    const unaccounted = Object.keys(marketDetailProperties).filter(
      (field) =>
        !LIGHTER_MARKET_DETAIL_VALIDATED_FIELDS.includes(field)
        && MARKET_DETAIL_DELIBERATELY_UNREAD[field] === undefined,
    );
    expect(unaccounted).toEqual([]);
  });

  it("keeps the margin fractions and the reference prices on the perpetual schema only", () => {
    for (const field of [
      "default_initial_margin_fraction",
      "min_initial_margin_fraction",
      "maintenance_margin_fraction",
      "closeout_margin_fraction",
      "mark_price",
      "index_price",
    ]) {
      expect(artifact.schemas.PerpsOrderBookDetail.properties).toHaveProperty(field);
      // Absent on spot, which is why every one of them is optional and
      // nullable on the DTO rather than required.
      expect(artifact.schemas.SpotOrderBookDetail.properties).not.toHaveProperty(field);
    }
  });

  it("projects nothing the validator did not accept", () => {
    const unvalidated = PROJECTED_MARKET_DETAIL_FIELDS.filter(
      (field) => !LIGHTER_MARKET_DETAIL_VALIDATED_FIELDS.includes(field),
    );
    expect(unvalidated).toEqual([]);
  });
});

describe("AccountPosition, the schema the position snapshot mirrors", () => {
  it("declares the fields the observation payload reports", () => {
    for (const field of [
      "market_id",
      "symbol",
      "sign",
      "position",
      "avg_entry_price",
      "position_value",
      "unrealized_pnl",
      "realized_pnl",
      "liquidation_price",
      "total_funding_paid_out",
      "initial_margin_fraction",
      "allocated_margin",
    ]) {
      expect(artifact.schemas.AccountPosition.properties).toHaveProperty(field);
    }
  });
});
