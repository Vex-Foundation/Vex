/**
 * AgentScan mapper — the privacy allowlist made executable.
 *
 * Three claims pinned here:
 *
 *   1. A mapped event carries EXACTLY the contract-v1 field set — key-for-key.
 *      Privacy is structural (the mapper builds from named fields), and this
 *      suite is the tripwire: adding a field to the payload means consciously
 *      editing the expected key list below.
 *   2. Nothing confidential survives serialization: the banned column names
 *      and their VALUES (wallet address, session id, from address, nonce, free
 *      -text failure reason, route provenance) never appear in the JSON.
 *   3. The output validates against a mirror of the server's own zod schema
 *      (vendored below verbatim from
 *      vex-agentscan/packages/contract/src/event.ts + enums.ts) — drift in our
 *      payload shape fails HERE, not in production per-item rejections.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { mapActivityToEvent } from "../../../vex-agent/agentscan/mapper.js";

// ── Server contract mirror (provenance: vex-agentscan@c52fe3d packages/contract/src) ──
const EVENT_KINDS = ["swap", "bridge", "lend", "prediction", "wrap", "yield", "launch"] as const;
const EVENT_ROLES = [
  "swap", "trench_fee", "swap_fee",
  "bridge_deposit", "bridge_fee", "bridge_fill_expected", "bridge_fill_observed", "bridge_refund",
  "lend_deposit", "lend_withdraw", "lend_borrow_operate",
  "predict_buy", "predict_sell", "predict_claim", "predict_close",
  "wrap", "unwrap",
  "yield_pt", "yield_yt", "yield_py", "yield_lp", "yield_sy", "yield_claim",
  "token_launch",
] as const;
const EVENT_STATUSES = ["pending", "confirmed", "definitively_failed", "superseded_unproven"] as const;
const CHAIN_FAMILIES = ["eip155", "solana"] as const;
const FAILURE_CODES = ["route_not_found", "slippage", "deadline_expired", "insufficient_liquidity", "allowance_or_balance", "chain_unsupported", "simulation_reverted", "mined_revert", "broadcast_error", "confirmation_timeout", "unknown", "bridge_failed", "bridge_refunded", "solana_signature_expired", "venue_unavailable"] as const;

const ROLES_BY_KIND: Record<(typeof EVENT_KINDS)[number], readonly (typeof EVENT_ROLES)[number][]> = {
  swap: ["swap", "trench_fee", "swap_fee"],
  bridge: ["bridge_deposit", "bridge_fee", "bridge_fill_expected", "bridge_fill_observed", "bridge_refund"],
  lend: ["lend_deposit", "lend_withdraw", "lend_borrow_operate"],
  prediction: ["predict_buy", "predict_sell", "predict_claim", "predict_close"],
  wrap: ["wrap", "unwrap"],
  yield: ["yield_pt", "yield_yt", "yield_py", "yield_lp", "yield_sy", "yield_claim"],
  launch: ["token_launch", "trench_fee"],
};
const SECOND_LEG_ROLES: readonly string[] = ["yield_py", "yield_lp"];
const INPUT_LEG_FORBIDDEN_ROLES: readonly string[] = ["yield_claim"];

const rawAmount = z.string().regex(/^\d+$/);
const usdString = z.string().regex(/^\d+(\.\d+)?$/);
const isoDate = z.iso.datetime();
const token = z.object({ address: z.string().min(1), symbol: z.string().max(16), decimals: z.number().int() });

const eventShape = z.object({
  sourceRowId: z.string().min(1),
  sourceExecutionId: z.string().min(1),
  eventIndex: z.number().int().min(0),
  kind: z.enum(EVENT_KINDS),
  eventRole: z.enum(EVENT_ROLES),
  status: z.enum(EVENT_STATUSES),
  protocol: z.string().min(1).max(32),
  chainFamily: z.enum(CHAIN_FAMILIES),
  chainId: z.coerce.bigint(),
  fromChainId: z.coerce.bigint().nullish().default(null),
  toChainId: z.coerce.bigint().nullish().default(null),
  tokenIn: token.nullish().default(null),
  tokenOut: token.nullish().default(null),
  amountInRaw: rawAmount.nullish().default(null),
  amountOutRaw: rawAmount.nullish().default(null),
  executedInRaw: rawAmount.nullish().default(null),
  executedOutRaw: rawAmount.nullish().default(null),
  tokenIn2: token.nullish().default(null),
  tokenOut2: token.nullish().default(null),
  amountIn2Raw: rawAmount.nullish().default(null),
  amountOut2Raw: rawAmount.nullish().default(null),
  executedIn2Raw: rawAmount.nullish().default(null),
  executedOut2Raw: rawAmount.nullish().default(null),
  usdInEst: usdString.nullish().default(null),
  usdOutEst: usdString.nullish().default(null),
  usdFeeEst: usdString.nullish().default(null),
  usdSource: z.string().max(32).nullish().default(null),
  txHash: z.string().nullish().default(null),
  failureCode: z.enum(FAILURE_CODES).nullish().default(null),
  createdAt: isoDate,
  confirmedAt: isoDate.nullish().default(null),
  observedAt: isoDate.nullish().default(null),
});

type EventShape = z.output<typeof eventShape>;

const SECOND_LEG_FIELDS = ["tokenIn2", "tokenOut2", "amountIn2Raw", "amountOut2Raw", "executedIn2Raw", "executedOut2Raw"] as const;
const INPUT_LEG_FIELDS = ["tokenIn", "amountInRaw", "executedInRaw"] as const;

function populated(event: EventShape, fields: readonly (keyof EventShape)[]): readonly (keyof EventShape)[] {
  return fields.filter((field) => event[field] !== null && event[field] !== undefined);
}

/** The server's own superRefine, mirrored: these rules reject a whole event. */
const serverEventSchema = eventShape.superRefine((event, ctx) => {
  const addIssue = (path: keyof EventShape, message: string): void => {
    ctx.addIssue({ code: "custom", path: [path], message });
  };
  if (!ROLES_BY_KIND[event.kind].includes(event.eventRole)) {
    addIssue("eventRole", `role '${event.eventRole}' is not valid for kind '${event.kind}'`);
  }
  if (!SECOND_LEG_ROLES.includes(event.eventRole)) {
    for (const field of populated(event, SECOND_LEG_FIELDS)) {
      addIssue(field, `second leg '${String(field)}' is not allowed for role '${event.eventRole}'`);
    }
  }
  if (event.tokenIn2 == null) {
    for (const field of populated(event, ["amountIn2Raw", "executedIn2Raw"])) {
      addIssue(field, `'${String(field)}' requires tokenIn2 carrying its decimals`);
    }
  }
  if (event.tokenOut2 == null) {
    for (const field of populated(event, ["amountOut2Raw", "executedOut2Raw"])) {
      addIssue(field, `'${String(field)}' requires tokenOut2 carrying its decimals`);
    }
  }
  if (INPUT_LEG_FORBIDDEN_ROLES.includes(event.eventRole)) {
    for (const field of populated(event, INPUT_LEG_FIELDS)) {
      addIssue(field, `role '${event.eventRole}' spends nothing and must not carry '${String(field)}'`);
    }
  }
  if (event.status === "superseded_unproven" && event.failureCode != null) {
    addIssue("failureCode", "'superseded_unproven' carries no failureCode");
  }
});
// ── end mirror ──

const WALLET = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const SESSION = "session-abc-123";
const FROM = "0x1122334455667788990011223344556677889900";
const PROVENANCE_MARKER = "provenance-secret-marker";
const FAILURE_REASON_TEXT = "free text with wallet " + WALLET;

/** A fully-populated confirmed swap row, shaped like a raw pg result. */
function confirmedSwapRow(): Record<string, unknown> {
  return {
    id: "44210",
    protocol_execution_id: "9021",
    event_index: 0,
    event_role: "swap",
    record_version: 1,
    kind: "swap",
    protocol: "kyberswap",
    chain_id: "4663",
    chain_slug: "robinhood",
    status: "confirmed",
    failure_code: null,
    failure_reason: FAILURE_REASON_TEXT,
    token_in_address: "0x" + "1".repeat(40),
    token_in_symbol: "ETH",
    token_in_decimals: 18,
    amount_in_human: "1.0",
    amount_in_raw: "1000000000000000000",
    token_out_address: "0x" + "2".repeat(40),
    token_out_symbol: "VEX",
    token_out_decimals: 18,
    amount_out_human: "2410.0",
    amount_out_raw: "2410000000000000000000",
    executed_amount_in_human: "1.0",
    executed_amount_in_raw: "1000000000000000000",
    executed_amount_out_human: "2407.113",
    executed_amount_out_raw: "2407113000000000000000",
    usd_in_est: "3312.44",
    usd_out_est: "3305.12",
    usd_fee_est: "3.31",
    usd_source: "dexscreener",
    tx_hash: "0x" + "ab".repeat(32),
    from_address: FROM,
    nonce: "7",
    wallet_address: WALLET,
    session_id: SESSION,
    route_provenance: { marker: PROVENANCE_MARKER },
    from_chain_id: null,
    to_chain_id: null,
    chain_family: "eip155",
    observed_at: null,
    broadcast_at: new Date("2026-07-28T11:58:10.000Z"),
    // The LOCAL observation time, which must never reach the wire.
    confirmed_at: new Date("2026-07-28T11:58:41.940Z"),
    // The chain's own block time (migration 078) — the only time we report.
    settled_block_time: new Date("2026-07-28T11:58:35.000Z"),
    settlement_source: "tool_response",
    created_at: new Date("2026-07-28T11:58:03.101Z"),
    updated_at: new Date("2026-07-28T11:58:41.940Z"),
  };
}

const CONTRACT_KEYS = [
  "sourceRowId", "sourceExecutionId", "eventIndex", "kind", "eventRole", "status",
  "protocol", "chainFamily", "chainId", "fromChainId", "toChainId",
  "tokenIn", "tokenOut", "amountInRaw", "amountOutRaw", "executedInRaw", "executedOutRaw",
  "tokenIn2", "tokenOut2", "amountIn2Raw", "amountOut2Raw", "executedIn2Raw", "executedOut2Raw",
  "usdInEst", "usdOutEst", "usdFeeEst", "usdSource", "txHash", "failureCode",
  "createdAt", "confirmedAt", "observedAt",
].sort();

describe("mapActivityToEvent — allowlist shape", () => {
  it("emits exactly the contract key set, nothing more", () => {
    const event = mapActivityToEvent(confirmedSwapRow(), { status: "confirmed" });
    expect(Object.keys(event).sort()).toEqual(CONTRACT_KEYS);
  });

  it("maps a confirmed swap faithfully and validates against the server schema mirror", () => {
    const event = mapActivityToEvent(confirmedSwapRow(), { status: "confirmed" });
    expect(event.sourceRowId).toBe("44210");
    expect(event.sourceExecutionId).toBe("9021");
    expect(event.eventIndex).toBe(0);
    expect(event.chainId).toBe("4663");
    expect(event.tokenIn).toEqual({ address: "0x" + "1".repeat(40), symbol: "ETH", decimals: 18 });
    expect(event.executedInRaw).toBe("1000000000000000000");
    expect(event.executedOutRaw).toBe("2407113000000000000000");
    expect(event.usdInEst).toBe("3312.44");
    expect(event.confirmedAt).toBe("2026-07-28T11:58:35.000Z");
    expect(event.createdAt).toBe("2026-07-28T11:58:03.101Z");
    expect(event.failureCode).toBeNull();

    const parsed = serverEventSchema.safeParse(event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("never leaks banned names or their values into the serialized event", () => {
    const json = JSON.stringify(mapActivityToEvent(confirmedSwapRow(), { status: "confirmed" }));
    for (const bannedKey of ["wallet_address", "walletAddress", "from_address", "fromAddress", "session_id", "sessionId", "nonce", "failure_reason", "failureReason", "route_provenance", "routeProvenance"]) {
      expect(json).not.toContain(`"${bannedKey}"`);
    }
    for (const bannedValue of [WALLET, SESSION, FROM, PROVENANCE_MARKER, FAILURE_REASON_TEXT]) {
      expect(json).not.toContain(bannedValue);
    }
  });
});

describe("mapActivityToEvent — status-snapshot semantics", () => {
  it("a pending snapshot of a now-confirmed row omits executed amounts and confirmedAt", () => {
    const event = mapActivityToEvent(confirmedSwapRow(), { status: "pending" });
    expect(event.status).toBe("pending");
    expect(event.executedInRaw).toBeNull();
    expect(event.executedOutRaw).toBeNull();
    expect(event.confirmedAt).toBeNull();
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("failureCode is emitted only on a definitively_failed snapshot", () => {
    const row = { ...confirmedSwapRow(), status: "definitively_failed", failure_code: "slippage" };
    expect(mapActivityToEvent(row, { status: "definitively_failed" }).failureCode).toBe("slippage");
    expect(mapActivityToEvent(row, { status: "pending" }).failureCode).toBeNull();
  });

  it("maps solana_signature_expired → confirmation_timeout and unknown codes → unknown", () => {
    const base = { ...confirmedSwapRow(), status: "definitively_failed" };
    expect(
      mapActivityToEvent({ ...base, failure_code: "solana_signature_expired" }, { status: "definitively_failed" }).failureCode,
    ).toBe("confirmation_timeout");
    expect(
      mapActivityToEvent({ ...base, failure_code: "some_future_code" }, { status: "definitively_failed" }).failureCode,
    ).toBe("unknown");
  });
});

describe("mapActivityToEvent — malformed-value guards", () => {
  it("nulls out amounts/usd that would fail the server's per-item regexes", () => {
    const row = {
      ...confirmedSwapRow(),
      amount_in_raw: "-5",
      amount_out_raw: "1.5",
      executed_amount_in_raw: "0x10",
      usd_in_est: "-3.31",
      usd_out_est: "NaN",
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.amountInRaw).toBeNull();
    expect(event.amountOutRaw).toBeNull();
    expect(event.executedInRaw).toBeNull();
    expect(event.usdInEst).toBeNull();
    expect(event.usdOutEst).toBeNull();
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("emits a token object only when address+symbol+decimals are all present, clamping symbol to 16", () => {
    const row = {
      ...confirmedSwapRow(),
      token_in_symbol: null,
      token_out_symbol: "AVERYLONGSYMBOLNAME_OVERFLOWING",
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.tokenIn).toBeNull();
    expect(event.tokenOut).toEqual({
      address: "0x" + "2".repeat(40),
      symbol: "AVERYLONGSYMBOLN",
      decimals: 18,
    });
  });

  it("carries bridge chain ids as strings", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "bridge",
      event_role: "bridge_deposit",
      from_chain_id: "8453",
      to_chain_id: "42161",
      observed_at: new Date("2026-07-28T12:00:00.000Z"),
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.fromChainId).toBe("8453");
    expect(event.toChainId).toBe("42161");
    expect(event.observedAt).toBe("2026-07-28T12:00:00.000Z");
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("mapActivityToEvent — the confirmation time is the block time or nothing", () => {
  it("reports settled_block_time, never the local confirmed_at", () => {
    const event = mapActivityToEvent(confirmedSwapRow(), { status: "confirmed" });
    expect(event.confirmedAt).toBe("2026-07-28T11:58:35.000Z");
    expect(JSON.stringify(event)).not.toContain("2026-07-28T11:58:41.940Z");
  });

  it("a status-only sweep confirm with no block time reports NO confirmation time", () => {
    // The sweep proved inclusion and could not read the block: `confirmed_at`
    // is still stamped locally, and still must not travel.
    const row = {
      ...confirmedSwapRow(),
      settled_block_time: null,
      confirmation_source: "receipt_status_only_evm",
      executed_amount_in_raw: null,
      executed_amount_out_raw: null,
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.confirmedAt).toBeNull();
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("a re-registration resend of an old row emits no confirmation time either", () => {
    // `resetOutboxForFullResend` re-owes already-sent rows; every row written
    // before migration 078 has no block time, and its local confirmed_at is
    // the observation clock the server would strike us for.
    const row = { ...confirmedSwapRow() };
    delete row.settled_block_time;
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.confirmedAt).toBeNull();
  });

  it("a bridge fill and a launch confirmed by their own writers report no block time", () => {
    // `confirmBridgeExpectedFill` and `confirmLaunchWithOutputIdentity` write no
    // block time, so their rows report none rather than their observation time.
    for (const shape of [
      { kind: "bridge", event_role: "bridge_fill_expected", executed_amount_in_raw: null },
      { kind: "launch", event_role: "token_launch", protocol: "trench" },
    ]) {
      const row = { ...confirmedSwapRow(), ...shape, settled_block_time: null };
      expect(mapActivityToEvent(row, { status: "confirmed" }).confirmedAt).toBeNull();
    }
  });
});

describe("mapActivityToEvent — second legs (yield_py / yield_lp)", () => {
  function yieldPyRow(): Record<string, unknown> {
    return {
      ...confirmedSwapRow(),
      kind: "yield",
      event_role: "yield_py",
      protocol: "pendle",
      token_out2_address: "0x" + "3".repeat(40),
      token_out2_symbol: "YT-sUSDe",
      token_out2_decimals: 18,
      amount_out2_raw: "5000000000000000000",
      executed_amount_out2_raw: "4999000000000000000",
    };
  }

  it("carries the second leg's token and amounts", () => {
    const event = mapActivityToEvent(yieldPyRow(), { status: "confirmed" });
    expect(event.tokenOut2).toEqual({
      address: "0x" + "3".repeat(40),
      symbol: "YT-sUSDe",
      decimals: 18,
    });
    expect(event.amountOut2Raw).toBe("5000000000000000000");
    expect(event.executedOut2Raw).toBe("4999000000000000000");
    expect(event.tokenIn2).toBeNull();
    expect(event.executedIn2Raw).toBeNull();
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("withholds a second-leg amount whose token ref is incomplete", () => {
    const row = { ...yieldPyRow(), token_out2_symbol: null };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.tokenOut2).toBeNull();
    expect(event.amountOut2Raw).toBeNull();
    expect(event.executedOut2Raw).toBeNull();
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("never sends a second leg on a role the server bars it from", () => {
    const row = { ...yieldPyRow(), kind: "swap", event_role: "swap", protocol: "kyberswap" };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.tokenOut2).toBeNull();
    expect(event.amountOut2Raw).toBeNull();
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("sends no input leg for yield_claim, which spends nothing", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "yield",
      event_role: "yield_claim",
      protocol: "pendle",
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.tokenIn).toBeNull();
    expect(event.amountInRaw).toBeNull();
    expect(event.executedInRaw).toBeNull();
    expect(event.executedOutRaw).toBe("2407113000000000000000");
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("mapActivityToEvent — native legs: one address, one verified slot", () => {
  const SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const SENTINEL_MIXED = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const ZERO = "0x" + "0".repeat(40);

  function nativeInRow(address: string): Record<string, unknown> {
    return { ...confirmedSwapRow(), token_in_address: address, token_in_symbol: "ETH" };
  }

  it("emits every native alias as the SENTINEL, because that is the only address its verifier calls native", () => {
    // A native leg declared with the zero address is cross-checked as an ERC-20
    // token, finds no Transfer log, and takes a strike.
    for (const alias of [SENTINEL, SENTINEL_MIXED, SENTINEL.toUpperCase(), ZERO]) {
      const event = mapActivityToEvent(nativeInRow(alias), { status: "confirmed" });
      expect(event.tokenIn?.address).toBe(SENTINEL);
      expect(serverEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("normalizes every token ref the event carries, not just the input", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "yield",
      event_role: "yield_py",
      protocol: "pendle",
      token_in_address: ZERO,
      token_out_address: SENTINEL_MIXED,
      token_in2_address: ZERO,
      token_in2_symbol: "ETH",
      token_in2_decimals: 18,
      token_out2_address: SENTINEL_MIXED,
      token_out2_symbol: "ETH",
      token_out2_decimals: 18,
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.tokenIn?.address).toBe(SENTINEL);
    expect(event.tokenOut?.address).toBe(SENTINEL);
    expect(event.tokenIn2?.address).toBe(SENTINEL);
    expect(event.tokenOut2?.address).toBe(SENTINEL);
  });

  it("leaves an ERC-20 address exactly as the row stored it", () => {
    const event = mapActivityToEvent(confirmedSwapRow(), { status: "confirmed" });
    expect(event.tokenIn?.address).toBe("0x" + "1".repeat(40));
    expect(event.tokenOut?.address).toBe("0x" + "2".repeat(40));
  });

  it("emits a native INPUT's executed amount: the server checks it against the transaction value", () => {
    for (const alias of [SENTINEL, SENTINEL_MIXED, ZERO]) {
      const event = mapActivityToEvent(nativeInRow(alias), { status: "confirmed" });
      expect(event.executedInRaw).toBe("1000000000000000000");
      // The ERC-20 output of the same row is unaffected either way.
      expect(event.executedOutRaw).toBe("2407113000000000000000");
    }
  });

  it("still withholds a native OUTPUT's executed amount: the server SKIPS that check, which is not the same as passing it", () => {
    for (const alias of [SENTINEL, ZERO]) {
      const row = { ...confirmedSwapRow(), token_out_address: alias, token_out_symbol: "ETH" };
      const event = mapActivityToEvent(row, { status: "confirmed" });
      expect(event.executedOutRaw).toBeNull();
      // The QUOTED amount still travels: it is not a settlement claim.
      expect(event.amountOutRaw).toBe("2410000000000000000000");
      expect(event.executedInRaw).toBe("1000000000000000000");
    }
  });

  it("a mixed row reports BOTH sides: native in by value, ERC-20 out by its Transfer log", () => {
    const event = mapActivityToEvent(nativeInRow(ZERO), { status: "confirmed" });
    expect(event.tokenIn?.address).toBe(SENTINEL);
    expect(event.executedInRaw).toBe("1000000000000000000");
    expect(event.tokenOut?.address).toBe("0x" + "2".repeat(40));
    expect(event.executedOutRaw).toBe("2407113000000000000000");
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("withholds a native SECOND leg's executed amounts — they are not in the verifier's input at all", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "yield",
      event_role: "yield_lp",
      protocol: "pendle",
      token_in2_address: ZERO,
      token_in2_symbol: "ETH",
      token_in2_decimals: 18,
      amount_in2_raw: "8000000000000000",
      executed_amount_in2_raw: "7999000000000000",
      token_out2_address: SENTINEL_MIXED,
      token_out2_symbol: "ETH",
      token_out2_decimals: 18,
      amount_out2_raw: "7000000000000000",
      executed_amount_out2_raw: "6999000000000000",
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.executedIn2Raw).toBeNull();
    expect(event.executedOut2Raw).toBeNull();
    // The quotes still travel, on the normalized address.
    expect(event.amountIn2Raw).toBe("8000000000000000");
    expect(event.amountOut2Raw).toBe("7000000000000000");
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("leaves an ERC-20 second leg completely unchanged", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "yield",
      event_role: "yield_py",
      protocol: "pendle",
      token_out2_address: "0x" + "3".repeat(40),
      token_out2_symbol: "YT-sUSDe",
      token_out2_decimals: 18,
      amount_out2_raw: "5000000000000000000",
      executed_amount_out2_raw: "4999000000000000000",
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.tokenOut2?.address).toBe("0x" + "3".repeat(40));
    expect(event.amountOut2Raw).toBe("5000000000000000000");
    expect(event.executedOut2Raw).toBe("4999000000000000000");
  });

  it("normalizes nothing on a non-EIP-155 row", () => {
    // Solana mints are base58 and can never BE a native alias; the guard exists
    // so the rule stays scoped to the family whose verifier it describes.
    const row = { ...confirmedSwapRow(), chain_family: "solana", protocol: "jupiter" };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.tokenIn?.address).toBe("0x" + "1".repeat(40));
  });

  it("withholds EVERY executed amount when settlement is conflict_quarantined, native input included", () => {
    const row = {
      ...confirmedSwapRow(),
      settlement_source: "conflict_quarantined",
      kind: "yield",
      event_role: "yield_py",
      protocol: "pendle",
      token_in_address: ZERO,
      token_out2_address: "0x" + "3".repeat(40),
      token_out2_symbol: "YT",
      token_out2_decimals: 18,
      executed_amount_out2_raw: "4999000000000000000",
    };
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.executedInRaw).toBeNull();
    expect(event.executedOutRaw).toBeNull();
    expect(event.executedOut2Raw).toBeNull();
    // The quote is untouched — only the settlement claim is withheld.
    expect(event.amountInRaw).toBe("1000000000000000000");
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("leaves a plain ERC-20 settlement alone", () => {
    const event = mapActivityToEvent(confirmedSwapRow(), { status: "confirmed" });
    expect(event.executedInRaw).toBe("1000000000000000000");
    expect(event.executedOutRaw).toBe("2407113000000000000000");
  });

  it("a pending snapshot of a native row still carries no executed amount", () => {
    const event = mapActivityToEvent(nativeInRow(ZERO), { status: "pending" });
    expect(event.executedInRaw).toBeNull();
    expect(event.executedOutRaw).toBeNull();
  });
});

describe("mapActivityToEvent — the widened vocabulary", () => {
  it("carries a superseded_unproven snapshot with no amounts, time, or failure code", () => {
    const row = { ...confirmedSwapRow(), status: "superseded_unproven", failure_code: "mined_revert" };
    const event = mapActivityToEvent(row, { status: "superseded_unproven" });
    expect(event.status).toBe("superseded_unproven");
    expect(event.executedInRaw).toBeNull();
    expect(event.executedOutRaw).toBeNull();
    expect(event.confirmedAt).toBeNull();
    expect(event.failureCode).toBeNull();
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("passes venue_unavailable through instead of degrading it to unknown", () => {
    const row = { ...confirmedSwapRow(), status: "definitively_failed", failure_code: "venue_unavailable" };
    const event = mapActivityToEvent(row, { status: "definitively_failed" });
    expect(event.failureCode).toBe("venue_unavailable");
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it("maps every newly reportable kind/role pair through the server's binding", () => {
    const pairs: readonly (readonly [string, string, string])[] = [
      ["lend", "lend_deposit", "jupiter"],
      ["lend", "lend_withdraw", "jupiter"],
      ["lend", "lend_borrow_operate", "jupiter"],
      ["prediction", "predict_buy", "jupiter"],
      ["prediction", "predict_sell", "jupiter"],
      ["prediction", "predict_claim", "jupiter"],
      ["prediction", "predict_close", "jupiter"],
      ["yield", "yield_pt", "pendle"],
      ["yield", "yield_yt", "pendle"],
      ["yield", "yield_sy", "pendle"],
      ["yield", "yield_py", "pendle"],
      ["yield", "yield_lp", "pendle"],
      ["launch", "token_launch", "trench"],
      ["launch", "trench_fee", "trench"],
      ["swap", "swap_fee", "uniswap"],
      ["swap", "trench_fee", "trench"],
      ["bridge", "bridge_fee", "relay"],
    ];
    for (const [kind, eventRole, protocol] of pairs) {
      const row = { ...confirmedSwapRow(), kind, event_role: eventRole, protocol };
      const parsed = serverEventSchema.safeParse(mapActivityToEvent(row, { status: "confirmed" }));
      expect(parsed.success, `${kind}/${eventRole}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});
