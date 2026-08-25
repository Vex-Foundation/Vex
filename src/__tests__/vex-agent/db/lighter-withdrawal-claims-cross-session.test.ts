import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  queryOneWith: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  queryOne: (...args: unknown[]) => mocks.queryOne(...args),
  queryOneWith: (...args: unknown[]) => mocks.queryOneWith(...args),
}));

const claims = await import("@vex-agent/db/repos/lighter-withdrawal-claims.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cross-session withdrawal claim repository boundaries", () => {
  it("binds a current-session claim to an exact globally unique recovered parent", async () => {
    mocks.queryOneWith
      .mockResolvedValueOnce({ intent_id: "withdrawal-old" })
      .mockResolvedValueOnce(claimRow());

    const created = await claims.createManualClaimAttemptWith({} as never, {
      claimId: "claim-new",
      preview: claimPreview() as never,
    });

    const [parentSql, parentParams] = mocks.queryOneWith.mock.calls[0]!.slice(1);
    expect(parentSql).toContain("WHERE intent_id = $1 AND environment = $2");
    expect(parentSql).not.toContain("session_id");
    expect(parentSql).toContain("LOWER(wallet_address) = LOWER($6)");
    expect(parentSql).toContain("pending_balance_units = $12");
    expect(parentParams).toEqual([
      "withdrawal-old", "rhc", 4663, "Robinhood Chain mainnet", "USDG",
      OWNER, OWNER, GATEWAY, GATEWAY_HASH, TOKEN, TOKEN_HASH, "1000000",
    ]);
    const insertParams = mocks.queryOneWith.mock.calls[1]![2] as unknown[];
    expect(insertParams[2]).toBe("session-new");
    expect(created).toMatchObject({
      claimId: "claim-new",
      withdrawalIntentId: "withdrawal-old",
      sessionId: "session-new",
    });
  });

  it("restores the recovered parent by intent identity, not by the claim session", async () => {
    mocks.queryOneWith
      .mockResolvedValueOnce({ withdrawal_intent_id: "withdrawal-old" })
      .mockResolvedValueOnce({ intent_id: "withdrawal-old" });

    await expect(claims.expirePreparedWith({} as never, "claim-new", "session-new"))
      .resolves.toBe(true);

    const [parentSql, parentParams] = mocks.queryOneWith.mock.calls[1]!.slice(1);
    expect(parentSql).toContain("WHERE intent_id = $1 AND execution_state = 'manual_claim_prepared'");
    expect(parentSql).not.toContain("session_id");
    expect(parentParams).toEqual(["withdrawal-old"]);
  });

  it("lets the originating-session reconciler finalize a claim continued elsewhere", async () => {
    mocks.queryOne.mockResolvedValueOnce({ claim_id: "claim-new" });

    await expect(claims.markReconciledOutcome({
      sessionId: "session-old",
      withdrawalIntentId: "withdrawal-old",
      transactionHash: `0x${"a".repeat(64)}`,
      outcome: "confirmed",
      receipt: { status: "success" },
    })).resolves.toBe(true);

    const [sql, params] = mocks.queryOne.mock.calls[0]!;
    expect(sql).toContain("parent.intent_id = $2 AND parent.session_id = $1");
    expect(sql).not.toContain("WHERE session_id = $1 AND withdrawal_intent_id = $2");
    expect(params[0]).toBe("session-old");
    expect(params[1]).toBe("withdrawal-old");
  });
});

const OWNER = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const GATEWAY = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d";
const IMPLEMENTATION = "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90";
const TOKEN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const GATEWAY_HASH = `0x${"1".repeat(64)}`;
const TOKEN_HASH = `0x${"2".repeat(64)}`;
const NOW = "2030-01-01T00:00:00.000Z";
const EXPIRES = "2030-01-01T00:03:00.000Z";

function claimSnapshot() {
  return {
    observedAt: NOW, expiresAt: EXPIRES, settlementChainId: 4663,
    settlementNetworkName: "Robinhood Chain mainnet", blockNumber: "100",
    blockHash: `0x${"b".repeat(64)}`, walletAddress: OWNER, ownerAddress: OWNER,
    gatewayAddress: GATEWAY, gatewayImplementation: IMPLEMENTATION,
    gatewayCodeHash: GATEWAY_HASH, settlementTokenAddress: TOKEN,
    settlementTokenCodeHash: TOKEN_HASH, assetIndex: 3, assetSymbol: "USDG",
    assetDecimals: 6, amountUnits: "1000000", pendingBalanceUnits: "1000000",
    calldata: "0x1234", valueWei: "0", nativeBalanceWei: "1000000000000000000",
    gasEstimate: "100000", gasLimit: "200000", quotedMaxFeePerGasWei: "10",
    quotedPriorityFeePerGasWei: "2", feeCeilingPerGasWei: "40",
    priorityFeeCeilingWei: "8", networkFeeCeilingWei: "8000000",
  };
}

function claimPreview() {
  const snapshot = claimSnapshot();
  return {
    previewId: "lwcp_aaaaaaaaaaaaaaaaaaaaaaaa",
    matchHash: "a".repeat(64),
    identity: {
      sessionId: "session-new",
      withdrawalIntentId: "withdrawal-old",
    },
    snapshot,
  };
}

function claimRow() {
  const snapshot = claimSnapshot();
  return {
    claim_id: "claim-new", withdrawal_intent_id: "withdrawal-old", session_id: "session-new",
    preview_id: "lwcp_aaaaaaaaaaaaaaaaaaaaaaaa", approval_id: null, match_hash: "a".repeat(64),
    operation_class: "manual_rhc_usdg_claim", settlement_chain_id: 4663,
    settlement_network_name: "Robinhood Chain mainnet", wallet_address: OWNER,
    owner_address: OWNER, gateway_address: GATEWAY, gateway_implementation: IMPLEMENTATION,
    gateway_code_hash: GATEWAY_HASH, settlement_token_address: TOKEN,
    settlement_token_code_hash: TOKEN_HASH, asset_index: 3, asset_symbol: "USDG",
    asset_decimals: 6, amount_units: "1000000", calldata: "0x1234", value_wei: "0",
    preflight_json: snapshot, preflight_observed_at: NOW, preflight_block_number: "100",
    native_balance_wei: "1000000000000000000", gas_estimate: "100000", gas_limit: "200000",
    quoted_max_fee_per_gas_wei: "10", quoted_priority_fee_per_gas_wei: "2",
    fee_ceiling_per_gas_wei: "40", priority_fee_ceiling_wei: "8",
    network_fee_ceiling_wei: "8000000", state: "prepared", decision_reason: null,
    decided_at: null, tx_hash: null, replacement_tx_hash: null, from_address: null,
    nonce: null, receipt_json: null, ambiguous_reason: null, staged_at: null,
    submitted_at: null, confirmed_at: null, created_at: NOW, updated_at: NOW,
    expires_at: EXPIRES,
  };
}
