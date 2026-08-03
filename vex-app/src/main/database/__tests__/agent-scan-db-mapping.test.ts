/**
 * `agent-scan-db-mappers` tests — row → `AgentScanEntry`.
 *
 * No DB mocking here: the mapper is a pure function, so these call it directly.
 * Every case additionally re-parses the mapped entry through
 * `agentScanEntrySchema`, because the mapper's real contract is not "produces
 * plausible fields" but "produces something the IPC boundary will accept" — a
 * mapper that emits an out-of-bounds string would 500 the whole page at output
 * validation, and only a round-trip assertion catches that.
 */

import { describe, expect, it } from "vitest";
import {
  mapAgentScanRow,
  STALLED_VERIFICATION_ATTEMPTS,
} from "../agent-scan-db-mappers.js";
import { agentScanEntrySchema } from "@shared/schemas/agent-scan-feed.js";
import type { AgentScanRow } from "../agent-scan-db-types.js";

const BASE_CHAIN_ID = 8453;
const ARBITRUM_CHAIN_ID = 42161;
const BSC_CHAIN_ID = 56;
const SOLANA_PROVIDER_CHAIN_ID = 20011000000;

function row(overrides: Partial<AgentScanRow> = {}): AgentScanRow {
  return {
    source_id: "42",
    created_at: new Date("2026-05-21T10:00:00.000Z"),
    cursor_ts: "2026-05-21T10:00:00.000000Z",
    activity_kind: "swap",
    event_role: "swap",
    status: "confirmed",
    protocol: "kyberswap",
    // node-postgres hands BIGINT back as a STRING.
    chain_id: String(BASE_CHAIN_ID),
    chain_family: "eip155",
    chain_slug: "base",
    from_chain_id: null,
    from_chain_slug: null,
    to_chain_id: null,
    to_chain_slug: null,
    token_in_address: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
    token_in_symbol: "USDC",
    token_in_decimals: 6,
    amount_in_human: "1.5",
    amount_in_raw: "1500000",
    executed_amount_in_human: null,
    executed_amount_in_raw: "1400000",
    usd_in_est: "1.50",
    token_out_address: "0xcafecafecafecafecafecafecafecafecafecafe",
    token_out_symbol: "WETH",
    token_out_decimals: 18,
    amount_out_human: "0.0005",
    amount_out_raw: "500000000000000",
    executed_amount_out_human: null,
    executed_amount_out_raw: "400000000000000",
    usd_out_est: "1.49",
    usd_fee_est: null,
    vex_fee_token_symbol: null,
    vex_fee_amount_human: null,
    failure_code: null,
    failure_reason: null,
    tx_hash: "0xdeadbeef",
    provider_order_id: null,
    last_checked_at: null,
    verification_attempts: 0,
    last_verification_reason: null,
    legs: null,
    ...overrides,
  };
}

/** Map, then prove the result survives the IPC output schema. */
function mapValid(source: AgentScanRow) {
  const entry = mapAgentScanRow(source);
  const parsed = agentScanEntrySchema.safeParse(entry);
  expect(parsed.success).toBe(true);
  return entry;
}

// ── Identity / coercion ───────────────────────────────────────────────────

describe("mapAgentScanRow identity", () => {
  it("coerces a BIGINT-as-string chain id back to a number", () => {
    expect(mapValid(row()).chainId).toBe(BASE_CHAIN_ID);
  });

  it("declines an unreadable chain id rather than guessing one", () => {
    const entry = mapValid(row({ chain_id: "not-a-number", chain_slug: null, tx_hash: "0xa" }));
    expect(entry.chainId).toBeNull();
    // No chain identity means no link — never a guessed host.
    expect(entry.explorerUrl).toBeNull();
  });

  it("normalizes a Date created_at to ISO", () => {
    expect(mapValid(row()).createdAt).toBe("2026-05-21T10:00:00.000Z");
  });

  it("carries the canonical vocabulary through untouched", () => {
    const entry = mapValid(row({ activity_kind: "wrap", event_role: "unwrap" }));
    expect(entry.activityKind).toBe("wrap");
    expect(entry.eventRole).toBe("unwrap");
  });

  it("collapses a raw definitively_failed status defensively", () => {
    // SQL already collapses it; the mapper must not DEPEND on that.
    expect(mapValid(row({ status: "definitively_failed" })).status).toBe("failed");
  });

  it("keeps an unknown status as a tolerant label instead of failing", () => {
    expect(mapValid(row({ status: "settling" })).status).toBe("settling");
  });
});

// ── Symbols: sanitized vs display ─────────────────────────────────────────

describe("mapAgentScanRow symbols", () => {
  it("annotates an EVM native leg on displaySymbol only", () => {
    const entry = mapValid(row({ token_out_symbol: "NATIVE" }));
    expect(entry.output.symbol).toBe("NATIVE");
    expect(entry.output.displaySymbol).toBe("NATIVE (ETH)");
  });

  it("annotates with the CHAIN'S OWN ticker, not a hardcoded ETH", () => {
    const entry = mapValid(
      row({ chain_id: String(BSC_CHAIN_ID), chain_slug: "bsc", token_out_symbol: "NATIVE" }),
    );
    expect(entry.output.displaySymbol).toBe("NATIVE (BNB)");
  });

  it("degrades to the bare sentinel on an unresolvable chain", () => {
    const entry = mapValid(
      row({ chain_id: "987654321", chain_slug: null, token_out_symbol: "NATIVE" }),
    );
    // A vague-but-true label beats a confident wrong one.
    expect(entry.output.displaySymbol).toBe("NATIVE");
  });

  it("leaves a Solana leg's SOL bare — it is a real ticker, not the sentinel", () => {
    const entry = mapValid(
      row({
        chain_id: String(SOLANA_PROVIDER_CHAIN_ID),
        chain_family: "solana",
        chain_slug: "solana",
        token_in_symbol: "SOL",
        token_out_symbol: "USDC",
      }),
    );
    expect(entry.input.symbol).toBe("SOL");
    expect(entry.input.displaySymbol).toBe("SOL");
  });

  it("sanitizes a hostile stored symbol on BOTH fields", () => {
    // Cyrillic lookalike — rejected by the ASCII allowlist.
    const entry = mapValid(row({ token_in_symbol: "USDС" }));
    expect(entry.input.symbol).toBeNull();
    expect(entry.input.displaySymbol).toBeNull();
  });

  it("never lets an annotated symbol reach the sanitized field", () => {
    // The annotation contains a space and parentheses, which the sanitizer
    // rejects by design — this is why the two fields cannot be merged.
    const entry = mapValid(row({ token_out_symbol: "NATIVE" }));
    expect(entry.output.symbol).not.toContain("(");
  });
});

// ── Amount honesty ────────────────────────────────────────────────────────

describe("mapAgentScanRow amount honesty", () => {
  it("shows a confirmed SWAP the EXECUTED amount, never the quote echo", () => {
    const entry = mapValid(row());
    expect(entry.input.displayAmount).toBe("1.4");
    expect(entry.output.displayAmount).toBe("0.0004");
    // The quote-time echo is still carried, but only as audit data.
    expect(entry.input.amountHuman).toBe("1.5");
    expect(entry.amountBasis).toBe("executed");
  });

  it("labels a confirmed SWAP with NO executed legs as an ESTIMATE rather than blanking", () => {
    // Reachable since the owner's 2026-07-30 decree: the status-only repair
    // sweep confirms from the chain's success/revert answer alone and writes no
    // executed amounts (migration 061 dropped the CHECKs that forbade it). The
    // quote is shown, explicitly labelled — never as settlement truth.
    const entry = mapValid(
      row({ executed_amount_in_raw: null, executed_amount_out_raw: null }),
    );
    expect(entry.input.displayAmount).toBe("1.5");
    expect(entry.output.displayAmount).toBe("0.0005");
    expect(entry.amountBasis).toBe("estimated");
  });

  it("shows a pending SWAP the requested echo (nothing has settled yet), labelled as an estimate", () => {
    const entry = mapValid(
      row({ status: "pending", executed_amount_in_raw: null, executed_amount_out_raw: null }),
    );
    expect(entry.input.displayAmount).toBe("1.5");
    expect(entry.amountBasis).toBe("estimated");
  });

  it("shows a failed SWAP NOTHING even when residual executed_* raws survive on the row", () => {
    // A row can carry executed legs AND still end `definitively_failed` (a
    // partially-decoded attempt, a later re-classification). Formatting the raw
    // before consulting the status rendered that as settled truth.
    const entry = mapValid(
      row({
        status: "failed",
        failure_code: "slippage",
        executed_amount_in_raw: "1400000",
        executed_amount_out_raw: "400000000000000",
      }),
    );
    expect(entry.input.displayAmount).toBeNull();
    expect(entry.output.displayAmount).toBeNull();
    expect(entry.amountBasis).toBeNull();
  });

  it("shows NOTHING for an UNRECOGNIZED status — the fail-closed case, not a quote", () => {
    const entry = mapValid(
      row({
        status: "some_future_status",
        executed_amount_in_raw: null,
        executed_amount_out_raw: null,
      }),
    );
    expect(entry.input.displayAmount).toBeNull();
    expect(entry.output.displayAmount).toBeNull();
    expect(entry.amountBasis).toBeNull();
  });

  it("labels MIXED-provenance legs conservatively: one quoted leg makes the row 'estimated'", () => {
    // The renderer applies ONE row-level basis to BOTH legs, so taking the
    // output leg's optimistic "executed" would silently present the quoted
    // INPUT leg as settled truth.
    const entry = mapValid(row({ executed_amount_in_raw: null }));
    expect(entry.input.displayAmount).toBe("1.5");
    expect(entry.output.displayAmount).toBe("0.0004");
    expect(entry.amountBasis).toBe("estimated");
  });

  it("shows a failed SWAP NOTHING rather than a near-miss amount", () => {
    const entry = mapValid(
      row({
        status: "failed",
        failure_code: "slippage",
        executed_amount_in_raw: null,
        executed_amount_out_raw: null,
      }),
    );
    expect(entry.input.displayAmount).toBeNull();
    expect(entry.output.displayAmount).toBeNull();
  });

  it("labels a confirmed-but-undecoded BRIDGE as an estimate instead of blanking", () => {
    const entry = mapValid(
      row({
        activity_kind: "bridge",
        event_role: "bridge_fill_expected",
        executed_amount_in_raw: null,
        executed_amount_out_raw: null,
      }),
    );
    expect(entry.output.displayAmount).toBe("0.0005");
    expect(entry.amountBasis).toBe("estimated");
  });

  it("labels a decoded BRIDGE as executed", () => {
    const entry = mapValid(
      row({ activity_kind: "bridge", event_role: "bridge_fill_expected" }),
    );
    expect(entry.output.displayAmount).toBe("0.0004");
    expect(entry.amountBasis).toBe("executed");
  });

  it("applies the estimate-basis rule to lend / prediction / wrap too", () => {
    // Migration 044's confirmed-has-executed-legs CHECK is scoped
    // `event_role <> 'swap'`, so these kinds CAN confirm without decoded
    // amounts — blanking them would hide a real, completed action.
    for (const kind of ["lend", "prediction", "wrap"]) {
      const entry = mapValid(
        row({
          activity_kind: kind,
          event_role: kind === "wrap" ? "wrap" : "lend_deposit",
          executed_amount_in_raw: null,
          executed_amount_out_raw: null,
        }),
      );
      expect(entry.output.displayAmount).toBe("0.0005");
      expect(entry.amountBasis).toBe("estimated");
    }
  });

  it("keeps USD figures as strings and never fabricates a zero", () => {
    const entry = mapValid(row({ usd_in_est: null, usd_out_est: 1.49, usd_fee_est: "0.01" }));
    expect(entry.input.usdEst).toBeNull();
    expect(entry.output.usdEst).toBe("1.49");
    expect(entry.usdFeeEst).toBe("0.01");
  });
});

// ── Bridge route + legs ───────────────────────────────────────────────────

describe("mapAgentScanRow bridge route and legs", () => {
  const bridgeRow = (overrides: Partial<AgentScanRow> = {}) =>
    row({
      activity_kind: "bridge",
      event_role: "bridge_fill_expected",
      chain_id: String(ARBITRUM_CHAIN_ID),
      chain_slug: "arbitrum",
      from_chain_id: String(BASE_CHAIN_ID),
      from_chain_slug: "base",
      to_chain_id: String(ARBITRUM_CHAIN_ID),
      to_chain_slug: "arbitrum",
      provider_order_id: "khalani-order-1",
      ...overrides,
    });

  it("carries route endpoints on a bridge and omits them elsewhere", () => {
    const bridge = mapValid(bridgeRow());
    expect(bridge.fromChain).toEqual({ chainId: BASE_CHAIN_ID, slug: "base" });
    expect(bridge.toChain).toEqual({ chainId: ARBITRUM_CHAIN_ID, slug: "arbitrum" });
    expect(bridge.providerOrderId).toBe("khalani-order-1");

    const swap = mapValid(row());
    expect(swap.fromChain).toBeNull();
    expect(swap.toChain).toBeNull();
  });

  it("annotates each bridge leg against ITS OWN chain, not the row's", () => {
    // The IN leg is on the origin chain, the OUT leg on the destination —
    // annotating both against the row's chain would mislabel one of them.
    const entry = mapValid(
      bridgeRow({
        from_chain_id: String(BSC_CHAIN_ID),
        from_chain_slug: "bsc",
        token_in_symbol: "NATIVE",
        token_out_symbol: "NATIVE",
      }),
    );
    expect(entry.input.displaySymbol).toBe("NATIVE (BNB)");
    expect(entry.output.displaySymbol).toBe("NATIVE (ETH)");
  });

  it("maps EVERY leg, including a role this build has never seen", () => {
    const entry = mapValid(
      bridgeRow({
        legs: [
          {
            role: "bridge_deposit",
            chainId: BASE_CHAIN_ID,
            chainFamily: "eip155",
            chainSlug: "base",
            txHash: "0xaaa",
            status: "confirmed",
            failureCode: null,
          },
          {
            role: "a_role_from_a_future_migration",
            chainId: ARBITRUM_CHAIN_ID,
            chainFamily: "eip155",
            chainSlug: "arbitrum",
            txHash: "0xbbb",
            status: "pending",
            failureCode: null,
          },
        ],
      }),
    );
    // `coerceBridgeLegs` would have silently dropped the second one.
    expect(entry.legs).toHaveLength(2);
    expect(entry.legs[1]?.role).toBe("a_role_from_a_future_migration");
    expect(entry.legs[1]?.txHash).toBe("0xbbb");
  });

  it("survives a malformed leg without losing the row", () => {
    const entry = mapValid(bridgeRow({ legs: [null, { role: "bridge_refund" }, 7] }));
    expect(entry.legs).toHaveLength(3);
    expect(entry.legs[0]?.role).toBeNull();
    expect(entry.legs[1]?.role).toBe("bridge_refund");
  });

  it("treats a non-array legs value as no legs", () => {
    expect(mapValid(bridgeRow({ legs: null })).legs).toEqual([]);
    expect(mapValid(row()).legs).toEqual([]);
  });
});

// ── Explorer URLs (main-resolved) ─────────────────────────────────────────

describe("mapAgentScanRow explorer links", () => {
  it("builds the entry link from the curated allowlist", () => {
    const entry = mapValid(row({ chain_slug: "base", tx_hash: "0xdeadbeef" }));
    expect(entry.explorerUrl).toBe("https://basescan.org/tx/0xdeadbeef");
  });

  it("falls back to the bare decimal chain id when there is no slug", () => {
    const entry = mapValid(row({ chain_slug: null, chain_id: String(BASE_CHAIN_ID) }));
    expect(entry.explorerUrl).toBe("https://basescan.org/tx/0xdeadbeef");
  });

  it("returns null for an uncurated chain rather than guessing a host", () => {
    const entry = mapValid(row({ chain_slug: "some-new-l2", chain_id: "987654321" }));
    expect(entry.explorerUrl).toBeNull();
  });

  it("returns null when there is no tx hash", () => {
    expect(mapValid(row({ tx_hash: null })).explorerUrl).toBeNull();
  });

  it("resolves a solana-family leg by FAMILY, not its provider-native chain id", () => {
    // Khalani reports Solana as 20011000000 and Relay as 792703809; neither is
    // a key in the explorer map, so keying on the id would break the link.
    const entry = mapValid(
      row({
        activity_kind: "bridge",
        event_role: "bridge_fill_expected",
        legs: [
          {
            role: "bridge_fill_expected",
            chainId: SOLANA_PROVIDER_CHAIN_ID,
            chainFamily: "solana",
            chainSlug: null,
            txHash: "5xSig",
            status: "confirmed",
            failureCode: null,
          },
        ],
      }),
    );
    expect(entry.legs[0]?.explorerUrl).toContain("5xSig");
    expect(entry.legs[0]?.explorerUrl).not.toContain("20011000000");
  });

  it("leaves a hashless leg unlinked", () => {
    const entry = mapValid(
      row({
        activity_kind: "bridge",
        event_role: "bridge_fill_expected",
        legs: [
          {
            role: "bridge_fill_expected",
            chainId: BASE_CHAIN_ID,
            chainFamily: "eip155",
            chainSlug: "base",
            txHash: null,
            status: "pending",
            failureCode: null,
          },
        ],
      }),
    );
    expect(entry.legs[0]?.explorerUrl).toBeNull();
  });
});

// ── Fees, failures, bounds ────────────────────────────────────────────────

describe("mapAgentScanRow fees, failures and bounds", () => {
  it("omits vexFee entirely when the row records none", () => {
    expect(mapValid(row()).vexFee).toBeNull();
  });

  it("carries a recorded Vex fee with a sanitized symbol", () => {
    const entry = mapValid(
      row({ vex_fee_token_symbol: "USDC", vex_fee_amount_human: "0.0125" }),
    );
    expect(entry.vexFee).toEqual({ tokenSymbol: "USDC", amountHuman: "0.0125" });
  });

  it("carries a tolerant failure code and reason", () => {
    const entry = mapValid(
      row({
        status: "failed",
        failure_code: "a_code_from_a_future_migration",
        failure_reason: "redacted engine text",
        executed_amount_in_raw: null,
        executed_amount_out_raw: null,
      }),
    );
    expect(entry.failureCode).toBe("a_code_from_a_future_migration");
    expect(entry.failureReason).toBe("redacted engine text");
  });

  it("clamps a drifted over-long display string instead of blanking the page", () => {
    // The alternative — letting it through — fails output validation and takes
    // the WHOLE page down over one bad label.
    const entry = mapValid(row({ protocol: "p".repeat(300), failure_reason: "r".repeat(900) }));
    expect(entry.protocol).toHaveLength(64);
    expect(entry.failureReason).toHaveLength(500);
  });

  it("declines uninterpretable decimals rather than failing the page", () => {
    const entry = mapValid(row({ token_in_decimals: -3, token_out_decimals: 1024 }));
    expect(entry.input.decimals).toBeNull();
    expect(entry.output.decimals).toBeNull();
  });

  it("surfaces lastCheckedAt as ISO when present", () => {
    const entry = mapValid(
      row({ last_checked_at: new Date("2026-05-21T11:00:00.000Z") }),
    );
    expect(entry.lastCheckedAt).toBe("2026-05-21T11:00:00.000Z");
  });

  // ── Wave P: stalled verification is DERIVED, never a stored status ──
  //
  // The row stays `pending` throughout. What changes is only what the UI is
  // TOLD, so a chain whose RPC can never answer stops being an invisible
  // forever-pending row.

  it("derives stalledVerification once the attempt counter crosses the threshold", () => {
    const entry = mapValid(
      row({
        status: "pending",
        verification_attempts: STALLED_VERIFICATION_ATTEMPTS,
        last_verification_reason: "no_safe_rpc",
      }),
    );
    expect(entry.stalledVerification).toBe(true);
    expect(entry.stalledReason).toBe("no_safe_rpc");
    // The status itself is UNTOUCHED — never auto-failed, never rewritten.
    expect(entry.status).toBe("pending");
  });

  it("is NOT stalled one attempt below the threshold", () => {
    const entry = mapValid(
      row({
        status: "pending",
        verification_attempts: STALLED_VERIFICATION_ATTEMPTS - 1,
        last_verification_reason: "receipt_unavailable",
      }),
    );
    expect(entry.stalledVerification).toBe(false);
    // The reason still rides along — it describes the last attempt either way.
    expect(entry.stalledReason).toBe("receipt_unavailable");
  });

  it("never marks a TERMINAL row stalled, however high the counter", () => {
    // A confirmed row is settled; a stale counter on it is history, not a
    // current inability to check, and rendering it as "stalled" would be a lie.
    const entry = mapValid(
      row({
        status: "confirmed",
        verification_attempts: STALLED_VERIFICATION_ATTEMPTS + 50,
        last_verification_reason: "no_safe_rpc",
      }),
    );
    expect(entry.stalledVerification).toBe(false);
  });

  it("treats a pre-065 row (no counter) as not stalled", () => {
    const entry = mapValid(
      row({ status: "pending", verification_attempts: null, last_verification_reason: null }),
    );
    expect(entry.stalledVerification).toBe(false);
    expect(entry.stalledReason).toBeNull();
  });
});
