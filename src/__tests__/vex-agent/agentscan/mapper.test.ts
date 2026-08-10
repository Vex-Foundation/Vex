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

// ── Server contract mirror (provenance: vex-agentscan@ccf26ea packages/contract/src) ──
const EVENT_KINDS = ["swap", "bridge"] as const;
const EVENT_ROLES = ["swap", "bridge_deposit", "bridge_fill_expected", "bridge_fill_observed", "bridge_refund"] as const;
const EVENT_STATUSES = ["pending", "confirmed", "definitively_failed"] as const;
const CHAIN_FAMILIES = ["eip155", "solana"] as const;
const FAILURE_CODES = ["route_not_found", "slippage", "deadline_expired", "insufficient_liquidity", "allowance_or_balance", "chain_unsupported", "simulation_reverted", "mined_revert", "broadcast_error", "confirmation_timeout", "unknown", "bridge_failed", "bridge_refunded"] as const;

const rawAmount = z.string().regex(/^\d+$/);
const usdString = z.string().regex(/^\d+(\.\d+)?$/);
const isoDate = z.iso.datetime();
const token = z.object({ address: z.string().min(1), symbol: z.string().max(16), decimals: z.number().int() });

const serverEventSchema = z.object({
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
    confirmed_at: new Date("2026-07-28T11:58:41.940Z"),
    created_at: new Date("2026-07-28T11:58:03.101Z"),
    updated_at: new Date("2026-07-28T11:58:41.940Z"),
  };
}

const CONTRACT_KEYS = [
  "sourceRowId", "sourceExecutionId", "eventIndex", "kind", "eventRole", "status",
  "protocol", "chainFamily", "chainId", "fromChainId", "toChainId",
  "tokenIn", "tokenOut", "amountInRaw", "amountOutRaw", "executedInRaw", "executedOutRaw",
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
    expect(event.confirmedAt).toBe("2026-07-28T11:58:41.940Z");
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

/**
 * The widened reporting predicate (migration 076) pulls `lend`, `prediction`,
 * `wrap`, `yield` and `launch` rows into the outbox. Those kinds sit NEXT TO
 * genuinely re-identifying data — a prediction position handle is joinable to
 * its owner wallet through a public API, and a token launch is inherently
 * self-identifying.
 *
 * Each row below is loaded with that data ON PURPOSE, beyond what a real
 * `SELECT * FROM agent_activity` would even return, so the assertion proves the
 * ALLOWLIST rather than the accident that a column happened to be absent: the
 * mapper reads named fields only, so an extra key on the input cannot reach the
 * output whatever it is called.
 */
const POSITION_PUBKEY = "7Yx4mQnKpL2vR8sT1uW3zA5bC6dE9fG0hJ2kM4nP6qRs";
const MARKET_ID = "market-id-11ff-secret";
const VAULT_ID = "vault-id-22ee-secret";
const POSITION_ID = "position-id-33dd-secret";
const PENDLE_MARKET = "0x" + "7".repeat(40);
const PT_ADDRESS = "0x" + "8".repeat(40);
const LAUNCH_NAME = "My Very Personal Token Name";
const LAUNCH_SYMBOL = "MVPTN";
const LAUNCH_DESCRIPTION = "a description written by the user themselves";
const LAUNCH_LINK = "https://x.com/the-users-own-handle";

/** Every banned key spelling, snake and camel, the contract forbids. */
const BANNED_KEYS = [
  "wallet_address", "walletAddress", "from_address", "fromAddress",
  "session_id", "sessionId", "nonce",
  "failure_reason", "failureReason", "route_provenance", "routeProvenance",
];

function expectNoLeak(json: string, secrets: readonly string[]): void {
  for (const bannedKey of BANNED_KEYS) {
    expect(json).not.toContain(`"${bannedKey}"`);
  }
  for (const secret of secrets) {
    expect(json).not.toContain(secret);
  }
}

describe("mapActivityToEvent — privacy under the widened vocabulary", () => {
  it("a prediction row leaks neither its positionPubkey nor its market/side", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "prediction",
      event_role: "predict_sell",
      protocol: "jupiter",
      chain_family: "solana",
      route_provenance: {
        prediction_order: { version: 1, positionPubkey: POSITION_PUBKEY },
      },
      // Never on agent_activity — these live on protocol_executions.params,
      // which the outbox claim never selects and never joins.
      market_id: MARKET_ID,
      side: "yes",
    };
    const json = JSON.stringify(mapActivityToEvent(row, { status: "confirmed" }));
    expectNoLeak(json, [POSITION_PUBKEY, MARKET_ID]);
    expect(json).not.toContain("prediction_order");
    expect(json).not.toContain("positionPubkey");
  });

  it("a launch row leaks none of its self-identifying sibling metadata", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "launch",
      event_role: "token_launch",
      protocol: "trench",
      // Never on agent_activity — these live on token_launch_intents /
      // launched_tokens, separate tables the outbox claim never reads.
      name: LAUNCH_NAME,
      symbol: LAUNCH_SYMBOL,
      description: LAUNCH_DESCRIPTION,
      links: { x: LAUNCH_LINK },
    };
    const json = JSON.stringify(mapActivityToEvent(row, { status: "confirmed" }));
    expectNoLeak(json, [LAUNCH_NAME, LAUNCH_DESCRIPTION, LAUNCH_LINK]);
    for (const bannedKey of ["description", "links"]) {
      expect(json).not.toContain(`"${bannedKey}"`);
    }
  });

  it("a lend row leaks neither vaultId/positionId nor its position pubkey", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "lend",
      event_role: "lend_deposit",
      protocol: "morpho",
      route_provenance: { vaultId: VAULT_ID, positionId: POSITION_ID },
      // protocol_executions.external_refs territory — never selected here.
      external_refs: { positionPubkey: POSITION_PUBKEY },
    };
    const json = JSON.stringify(mapActivityToEvent(row, { status: "confirmed" }));
    expectNoLeak(json, [VAULT_ID, POSITION_ID, POSITION_PUBKEY]);
    expect(json).not.toContain("external_refs");
  });

  it("a yield row leaks none of its Pendle market or PT/YT/SY addresses", () => {
    const row = {
      ...confirmedSwapRow(),
      kind: "yield",
      event_role: "yield_pt",
      protocol: "pendle",
      route_provenance: {
        pendle: { marketAddress: PENDLE_MARKET, ptAddress: PT_ADDRESS },
      },
    };
    const json = JSON.stringify(mapActivityToEvent(row, { status: "confirmed" }));
    expectNoLeak(json, [PENDLE_MARKET, PT_ADDRESS]);
    expect(json).not.toContain("marketAddress");
  });

  it("emits exactly the contract key set for every widened kind", () => {
    for (const [kind, eventRole] of [
      ["lend", "lend_deposit"],
      ["prediction", "predict_buy"],
      ["wrap", "wrap"],
      ["yield", "yield_claim"],
      ["launch", "token_launch"],
    ]) {
      const event = mapActivityToEvent(
        { ...confirmedSwapRow(), kind, event_role: eventRole },
        { status: "confirmed" },
      );
      expect(Object.keys(event).sort(), `kind=${kind}`).toEqual(CONTRACT_KEYS);
      expect(event.kind).toBe(kind);
      expect(event.eventRole).toBe(eventRole);
    }
  });
});

describe("mapActivityToEvent — superseded_unproven is terminal, not a failure", () => {
  it("emits no failureCode, no executed amounts and no confirmedAt", () => {
    const row = { ...confirmedSwapRow(), status: "superseded_unproven", failure_code: "slippage" };
    const event = mapActivityToEvent(row, { status: "superseded_unproven" });
    expect(event.status).toBe("superseded_unproven");
    expect(event.failureCode).toBeNull();
    expect(event.executedInRaw).toBeNull();
    expect(event.executedOutRaw).toBeNull();
    expect(event.confirmedAt).toBeNull();
  });
});
