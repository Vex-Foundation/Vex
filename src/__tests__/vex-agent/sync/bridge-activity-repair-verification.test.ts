/**
 * bridge-activity-repair — PURE helpers: provider status mapping (dossier §2) +
 * R6 identity correlation (Blocker 7), the canonical Relay status contract
 * (Blocker 6), fair scheduling (B6), and SSRF-controlled RPC selection (B4).
 *
 * These are the sweep's decision core, isolated from IO. The DB-level behavior
 * (raw scheduling SQL, viem/Solana RPC probing) is covered by the real-Postgres
 * integration suite (`integration/agent-scan/bridge-sweep.int.test.ts`); the
 * orchestration wiring is covered by `bridge-activity-repair.test.ts`.
 */

import { describe, it, expect } from "vitest";

import {
  mapKhalaniOrderOutcome,
  mapRelayStatusOutcome,
  relayDestinationHashes,
  compareBridgeFairness,
  bridgeScheduleClock,
  isSsrfSafeRpcUrl,
  isPrivateOrLoopbackHost,
  selectVerificationRpcUrls,
  type KhalaniOrderView,
  type RelayStatusView,
  type StoredBridgeRoute,
  type StoredBridgeCorrelation,
  type BridgeSweepRow,
} from "@vex-agent/sync/bridge-activity-repair.js";

const ROUTE: StoredBridgeRoute = {
  fromChainId: 8453,
  fromChainFamily: "eip155",
  toChainId: 42161,
  toChainFamily: "eip155",
};

// The stored logical-row identity every terminal observation is correlated
// against (R6). Providers echo these fields; a disagreement is a mismatch.
const CORR: StoredBridgeCorrelation = {
  route: ROUTE,
  providerOrderId: "order-1",
  tokenInAddress: "0xInToken",
  tokenOutAddress: "0xOutToken",
  author: "0xAuthor",
  depositTxHash: "0xDeposit",
  quoteId: "Q-1",
  routeId: "R-1",
};

function khalaniOrder(status: string, overrides: Partial<KhalaniOrderView> = {}): KhalaniOrderView {
  return {
    id: "order-1",
    status,
    fromChainId: 8453,
    toChainId: 42161,
    quoteId: "Q-1",
    routeId: "R-1",
    fromToken: "0xInToken",
    toToken: "0xOutToken",
    author: "0xAuthor",
    depositTxHash: "0xDeposit",
    transactions: {},
    ...overrides,
  };
}

// ── Khalani status mapping (dossier §2 table) ───────────────────────────────

describe("mapKhalaniOrderOutcome — every status branch", () => {
  it.each(["created", "deposited", "published", "refund_pending"])(
    "non-terminal %s → pending (never terminalized, no SLA)",
    (status) => {
      expect(mapKhalaniOrderOutcome(khalaniOrder(status), CORR)).toEqual({ kind: "pending", providerStatus: status });
    },
  );

  it("filled WITH a destination fill hash → confirmable (ALL fill hashes carried)", () => {
    const order = khalaniOrder("filled", { transactions: { fill: { txHash: "0xfill", chainId: 42161 } } });
    expect(mapKhalaniOrderOutcome(order, CORR)).toEqual({
      kind: "confirmable",
      providerStatus: "filled",
      fillTxHashes: ["0xfill"],
      destChainId: 42161,
      destChainFamily: "eip155",
    });
  });

  it("filled but NO fill transaction → filled_no_hash anomaly (dossier §5 — never fabricate)", () => {
    expect(mapKhalaniOrderOutcome(khalaniOrder("filled"), CORR)).toEqual({
      kind: "filled_no_hash",
      providerStatus: "filled",
    });
  });

  it("filled but fill entry has no txHash → filled_no_hash anomaly", () => {
    const order = khalaniOrder("filled", { transactions: { fill: { chainId: 42161 } } });
    expect(mapKhalaniOrderOutcome(order, CORR)).toEqual({ kind: "filled_no_hash", providerStatus: "filled" });
  });

  it("filled but the fill OMITS its destination chain → chain_mismatch (a missing fill chain is NOT confirmable, Blocker 7)", () => {
    const order = khalaniOrder("filled", { transactions: { fill: { txHash: "0xfill" } } });
    expect(mapKhalaniOrderOutcome(order, CORR)).toEqual({ kind: "chain_mismatch", providerStatus: "filled" });
  });

  it("filled but order chain ids do not match the stored route → chain_mismatch", () => {
    const order = khalaniOrder("filled", { toChainId: 999, transactions: { fill: { txHash: "0xx", chainId: 999 } } });
    expect(mapKhalaniOrderOutcome(order, CORR)).toEqual({ kind: "chain_mismatch", providerStatus: "filled" });
  });

  it("filled but the fill executed on the wrong chain → chain_mismatch", () => {
    const order = khalaniOrder("filled", { transactions: { fill: { txHash: "0xx", chainId: 1 } } });
    expect(mapKhalaniOrderOutcome(order, CORR)).toEqual({ kind: "chain_mismatch", providerStatus: "filled" });
  });

  it("refunded WITH a refund hash → refunded + evidence coordinates (money back != success)", () => {
    const order = khalaniOrder("refunded", { transactions: { refund: { txHash: "0xrefund", chainId: 8453 } } });
    expect(mapKhalaniOrderOutcome(order, CORR)).toEqual({
      kind: "refunded",
      providerStatus: "refunded",
      refundTxHash: "0xrefund",
      refundChainId: 8453,
      refundChainFamily: "eip155",
    });
  });

  it("refunded WITHOUT a refund hash → refunded, no evidence, refund chain defaults to origin", () => {
    expect(mapKhalaniOrderOutcome(khalaniOrder("refunded"), CORR)).toEqual({
      kind: "refunded",
      providerStatus: "refunded",
      refundTxHash: null,
      refundChainId: 8453,
      refundChainFamily: "eip155",
    });
  });

  it("failed → failed (bridge_failed terminal)", () => {
    expect(mapKhalaniOrderOutcome(khalaniOrder("failed"), CORR)).toEqual({ kind: "failed", providerStatus: "failed" });
  });

  it("an unrecognized status stays pending (never terminalize on the unknown)", () => {
    expect(mapKhalaniOrderOutcome(khalaniOrder("some_new_status"), CORR)).toEqual({
      kind: "pending",
      providerStatus: "some_new_status",
    });
  });
});

// ── Khalani R6 correlation (Blocker 7) ──────────────────────────────────────

describe("mapKhalaniOrderOutcome — R6 identity correlation on EVERY terminal transition", () => {
  const filled = (o: Partial<KhalaniOrderView>) =>
    khalaniOrder("filled", { transactions: { fill: { txHash: "0xfill", chainId: 42161 } }, ...o });

  it.each([
    ["order_id", { id: "order-2" }],
    ["author", { author: "0xEvil" }],
    ["deposit_hash", { depositTxHash: "0xOtherDeposit" }],
    ["from_token", { fromToken: "0xOther" }],
    ["to_token", { toToken: "0xOther" }],
    ["quote_id", { quoteId: "Q-9" }],
    ["route_id", { routeId: "R-9" }],
  ])("a filled order with a mismatched %s → correlation_mismatch (stays pending, never confirms)", (field, over) => {
    expect(mapKhalaniOrderOutcome(filled(over), CORR)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "filled",
      field,
    });
  });

  it("correlation runs for REFUNDED too — a mismatched author refund is not terminalized", () => {
    const order = khalaniOrder("refunded", { author: "0xEvil", transactions: { refund: { txHash: "0xr", chainId: 8453 } } });
    expect(mapKhalaniOrderOutcome(order, CORR)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "refunded",
      field: "author",
    });
  });

  it("correlation runs for FAILED too — a mismatched route_id failure is not terminalized", () => {
    expect(mapKhalaniOrderOutcome(khalaniOrder("failed", { routeId: "R-9" }), CORR)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "failed",
      field: "route_id",
    });
  });

  it("EVM identity comparison is case-insensitive (checksummed vs lowercased still matches)", () => {
    const order = khalaniOrder("filled", { author: "0xAUTHOR", depositTxHash: "0xDEPOSIT", transactions: { fill: { txHash: "0xfill", chainId: 42161 } } });
    expect(mapKhalaniOrderOutcome(order, CORR).kind).toBe("confirmable");
  });

  it("a field the payload OMITS is named-degraded, not a mismatch (author absent → still confirmable)", () => {
    const order = khalaniOrder("filled", { author: undefined, transactions: { fill: { txHash: "0xfill", chainId: 42161 } } });
    expect(mapKhalaniOrderOutcome(order, CORR).kind).toBe("confirmable");
  });

  it("a field Vex never STORED is named-degraded, not a mismatch (no stored quoteId → order quoteId ignored)", () => {
    const degraded: StoredBridgeCorrelation = { ...CORR, quoteId: null };
    const order = khalaniOrder("filled", { quoteId: "Q-anything", transactions: { fill: { txHash: "0xfill", chainId: 42161 } } });
    expect(mapKhalaniOrderOutcome(order, degraded).kind).toBe("confirmable");
  });
});

// ── Relay canonical status contract (Blocker 6) + mapping ───────────────────

function relayStatus(status: string, overrides: Partial<RelayStatusView> = {}): RelayStatusView {
  return { status, originChainId: 8453, destinationChainId: 42161, inTxHashes: ["0xDeposit"], ...overrides };
}

describe("relayDestinationHashes — one normalization point (txHashes canonical, destinationTxHashes tolerated)", () => {
  it("prefers the canonical txHashes[]", () => {
    expect(relayDestinationHashes({ status: "success", txHashes: ["0xa"] })).toEqual(["0xa"]);
  });
  it("falls back to legacy destinationTxHashes[] when txHashes is empty", () => {
    expect(relayDestinationHashes({ status: "success", txHashes: [], destinationTxHashes: ["0xb"] })).toEqual(["0xb"]);
  });
  it("falls back to legacy destinationTxHashes[] when txHashes is absent", () => {
    expect(relayDestinationHashes({ status: "success", destinationTxHashes: ["0xc"] })).toEqual(["0xc"]);
  });
  it("canonical txHashes[] WINS over a legacy list", () => {
    expect(relayDestinationHashes({ status: "success", txHashes: ["0xnew"], destinationTxHashes: ["0xold"] })).toEqual(["0xnew"]);
  });
  it("neither present → empty", () => {
    expect(relayDestinationHashes({ status: "success" })).toEqual([]);
  });
});

describe("mapRelayStatusOutcome — every status branch (canonical fields)", () => {
  it.each(["waiting", "depositing", "pending", "submitted", "delayed"])(
    "non-terminal %s → pending",
    (status) => {
      expect(mapRelayStatusOutcome(relayStatus(status), CORR)).toEqual({ kind: "pending", providerStatus: status });
    },
  );

  it("success WITH canonical txHashes[] → confirmable (all hashes carried)", () => {
    const status = relayStatus("success", { txHashes: ["0xdest"] });
    expect(mapRelayStatusOutcome(status, CORR)).toEqual({
      kind: "confirmable",
      providerStatus: "success",
      fillTxHashes: ["0xdest"],
      destChainId: 42161,
      destChainFamily: "eip155",
    });
  });

  it("success with MULTIPLE txHashes[] → confirmable carries them all (Blocker 9)", () => {
    const status = relayStatus("success", { txHashes: ["0xa", "0xb", "0xc"] });
    const outcome = mapRelayStatusOutcome(status, CORR);
    expect(outcome.kind).toBe("confirmable");
    if (outcome.kind === "confirmable") expect(outcome.fillTxHashes).toEqual(["0xa", "0xb", "0xc"]);
  });

  it("success with ONLY the legacy destinationTxHashes[] is tolerated → confirmable", () => {
    const status = relayStatus("success", { txHashes: undefined, destinationTxHashes: ["0xlegacy"] });
    const outcome = mapRelayStatusOutcome(status, CORR);
    expect(outcome.kind).toBe("confirmable");
    if (outcome.kind === "confirmable") expect(outcome.fillTxHashes).toEqual(["0xlegacy"]);
  });

  it("success with an EMPTY destination list → filled_no_hash anomaly", () => {
    expect(mapRelayStatusOutcome(relayStatus("success", { txHashes: [] }), CORR)).toEqual({
      kind: "filled_no_hash",
      providerStatus: "success",
    });
  });

  it("success with NO destination hashes → filled_no_hash anomaly", () => {
    expect(mapRelayStatusOutcome(relayStatus("success", { txHashes: undefined }), CORR)).toEqual({
      kind: "filled_no_hash",
      providerStatus: "success",
    });
  });

  it("success ignores blank/whitespace hashes → filled_no_hash anomaly", () => {
    expect(mapRelayStatusOutcome(relayStatus("success", { txHashes: ["", "   "] }), CORR)).toEqual({
      kind: "filled_no_hash",
      providerStatus: "success",
    });
  });

  it("success but the echoed destinationChainId does not match the stored route → chain_mismatch (B4 route match)", () => {
    const status = relayStatus("success", { destinationChainId: 999, txHashes: ["0xd"] });
    expect(mapRelayStatusOutcome(status, CORR)).toEqual({ kind: "chain_mismatch", providerStatus: "success" });
  });

  it("success but the echoed originChainId does not match the stored route → chain_mismatch", () => {
    const status = relayStatus("success", { originChainId: 1, txHashes: ["0xd"] });
    expect(mapRelayStatusOutcome(status, CORR)).toEqual({ kind: "chain_mismatch", providerStatus: "success" });
  });

  it("success with the chain echo OMITTED is named-degraded (defers to the RPC eth_chainId echo) → still confirmable", () => {
    const status: RelayStatusView = { status: "success", txHashes: ["0xd"], inTxHashes: ["0xDeposit"] };
    expect(mapRelayStatusOutcome(status, CORR).kind).toBe("confirmable");
  });

  it("success but the stored deposit hash is absent from inTxHashes[] → correlation_mismatch deposit_hash", () => {
    const status = relayStatus("success", { txHashes: ["0xd"], inTxHashes: ["0xSomeoneElsesDeposit"] });
    expect(mapRelayStatusOutcome(status, CORR)).toEqual({
      kind: "correlation_mismatch",
      providerStatus: "success",
      field: "deposit_hash",
    });
  });

  it("refund → refunded, refundTxHash null (keyless Relay has no reliable refund-hash field)", () => {
    expect(mapRelayStatusOutcome(relayStatus("refund"), CORR)).toEqual({
      kind: "refunded",
      providerStatus: "refund",
      refundTxHash: null,
      refundChainId: 8453,
      refundChainFamily: "eip155",
    });
  });

  it("failure → failed", () => {
    expect(mapRelayStatusOutcome(relayStatus("failure"), CORR)).toEqual({ kind: "failed", providerStatus: "failure" });
  });

  it("an unrecognized status stays pending", () => {
    expect(mapRelayStatusOutcome(relayStatus("brand_new"), CORR)).toEqual({ kind: "pending", providerStatus: "brand_new" });
  });
});

// ── Fair scheduling (B6) ────────────────────────────────────────────────────

function schedRow(overrides: Partial<BridgeSweepRow>): BridgeSweepRow {
  return {
    id: 1,
    protocolExecutionId: 1,
    protocol: "khalani",
    providerOrderId: "o",
    fromChainId: 8453,
    toChainId: 42161,
    destChainFamily: "eip155",
    tokenInAddress: "0xin",
    tokenOutAddress: "0xout",
    walletAddress: "0xw",
    depositTxHash: null,
    quoteId: null,
    routeId: null,
    sessionId: "s",
    normalizedRoute: "r",
    lastAttemptedAt: null,
    createdAt: "2026-07-23T09:00:00.000Z",
    ...overrides,
  };
}

describe("fair scheduling (B6 — starvation guarantee)", () => {
  it("a never-attempted row uses its createdAt as the scheduling clock", () => {
    const row = schedRow({ lastAttemptedAt: null, createdAt: "2026-07-23T09:00:00.000Z" });
    expect(bridgeScheduleClock(row)).toBe(Date.parse("2026-07-23T09:00:00.000Z"));
  });

  it("an attempted row uses last_attempted_at as the scheduling clock", () => {
    const row = schedRow({ lastAttemptedAt: "2026-07-23T10:00:00.000Z", createdAt: "2026-07-23T08:00:00.000Z" });
    expect(bridgeScheduleClock(row)).toBe(Date.parse("2026-07-23T10:00:00.000Z"));
  });

  it("an OLD never-attempted row is served before a RECENTLY-attempted row (no starvation)", () => {
    const neverAttempted = schedRow({ id: 2, lastAttemptedAt: null, createdAt: "2026-07-23T09:00:00.000Z" });
    const recentlyAttempted = schedRow({ id: 1, lastAttemptedAt: "2026-07-23T10:00:00.000Z", createdAt: "2026-07-23T08:00:00.000Z" });
    const sorted = [recentlyAttempted, neverAttempted].sort(compareBridgeFairness);
    expect(sorted.map((r) => r.id)).toEqual([2, 1]);
  });

  it("ties break deterministically by id", () => {
    const at = "2026-07-23T09:00:00.000Z";
    const a = schedRow({ id: 5, createdAt: at });
    const b = schedRow({ id: 3, createdAt: at });
    expect([a, b].sort(compareBridgeFairness).map((r) => r.id)).toEqual([3, 5]);
  });
});

// ── SSRF-controlled RPC selection (B4) ──────────────────────────────────────

describe("isSsrfSafeRpcUrl — rejection matrix", () => {
  it.each([
    ["https://mainnet.base.org", true],
    ["https://arb1.arbitrum.io/rpc", true],
    ["https://[2606:4700:4700::1111]", true], // public IPv6
    ["http://mainnet.base.org", false], // not https
    ["ftp://example.com", false], // wrong scheme
    ["https://user:pass@rpc.example.com", false], // embedded credentials
    ["https://localhost", false],
    ["https://rpc.internal.localhost", false], // .localhost suffix
    ["https://127.0.0.1", false], // loopback
    ["https://0.0.0.0", false], // unspecified
    ["https://10.1.2.3", false], // private /8
    ["https://192.168.1.1", false], // private /16
    ["https://172.16.0.1", false], // private /12 low
    ["https://172.31.255.255", false], // private /12 high
    ["https://172.15.0.1", true], // just below /12 → public
    ["https://172.32.0.1", true], // just above /12 → public
    ["https://169.254.169.254", false], // cloud metadata (link-local)
    ["https://100.64.0.1", false], // CGNAT
    ["https://100.63.0.1", true], // just below CGNAT → public
    ["https://224.0.0.1", false], // multicast
    ["https://[::1]", false], // IPv6 loopback
    ["https://[fe80::1]", false], // IPv6 link-local
    ["https://[fc00::1]", false], // IPv6 unique-local
    ["https://[fd12:3456::1]", false], // IPv6 unique-local
    ["https://[::ffff:127.0.0.1]", false], // v4-mapped loopback
    ["not a url", false],
    ["", false],
  ])("%s → safe:%s", (url, expected) => {
    expect(isSsrfSafeRpcUrl(url)).toBe(expected);
  });
});

describe("isPrivateOrLoopbackHost — host classification", () => {
  it("treats a bracketed IPv6 literal the same as its bare form", () => {
    expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
  });

  it("allows a public DNS name (syntactic check only — no resolution, defended by redirect-off + chain echo)", () => {
    expect(isPrivateOrLoopbackHost("rpc.ankr.com")).toBe(false);
  });
});

describe("selectVerificationRpcUrls — curated first, SSRF-filtered fallback", () => {
  it("curated URLs come first and are NOT SSRF-filtered (trusted local overrides)", () => {
    const result = selectVerificationRpcUrls({
      curated: ["http://localhost:8545"], // a trusted local override — allowed
      providerRegistry: ["https://provider.example"],
    });
    expect(result).toEqual(["http://localhost:8545", "https://provider.example"]);
  });

  it("provider-registry URLs are dropped when they fail SSRF validation", () => {
    const result = selectVerificationRpcUrls({
      curated: [],
      providerRegistry: ["http://evil.example", "https://192.168.0.1", "https://good.example"],
    });
    expect(result).toEqual(["https://good.example"]);
  });

  it("de-duplicates while preserving order (curated wins the slot)", () => {
    const result = selectVerificationRpcUrls({
      curated: ["https://shared.example"],
      providerRegistry: ["https://shared.example", "https://other.example"],
    });
    expect(result).toEqual(["https://shared.example", "https://other.example"]);
  });

  it("returns [] when nothing is safe (fail-closed → verifier reports unverifiable)", () => {
    expect(selectVerificationRpcUrls({ curated: [], providerRegistry: ["http://x.local", "https://10.0.0.1"] })).toEqual([]);
  });
});
