/**
 * bridge-activity-repair — the deBridge (DLN) fill-hash BOUNDARY (Card F2).
 *
 * Khalani orders routed through DeBridge reach `status: "filled"` carrying only
 * the deposit transaction: the destination fill hash exists ONLY in deBridge's
 * own stats API, keyed by the order's `externalOrderId`. Recovering it means
 * trusting a THIRD provider, so the recovered hash is admitted only when the DLN
 * record proves it settles OUR order: exact order-id echo, an allow-listed
 * fulfilment state, the destination chain (across the two providers' different
 * Solana numbering), the destination token, the recipient, and the exact final
 * amount. Anything unproven — including an expectation Vex never recorded — is
 * refused; the row stays pending. The on-chain B4 verification still runs
 * afterwards, so this gate never confirms anything by itself.
 *
 * Payloads are the REAL captured DLN responses (see `fixtures/debridge-fill-hash/README.md`);
 * only identities are substituted. The synthetic identities are asserted as
 * literals so a fixture regenerated from a different capture fails loudly.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, afterEach } from "vitest";

import logger from "@utils/logger.js";
import {
  fetchDebridgeFillHash,
  resolveDebridgeFillHash,
  DEBRIDGE_STATS_BASE_URL,
} from "@vex-agent/sync/bridge-activity-repair-debridge-lookup.js";
import type { DebridgeFillHashLookup } from "@vex-agent/sync/bridge-activity-repair.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/debridge-fill-hash/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const SOLANA_DEST = fixture("dln-order-solana-destination");
const EVM_DEST = fixture("dln-order-evm-destination");

// ── Khalani-side expectations for the two captured orders ────────────────────
// Chain ids / tokens / amounts are the REAL values Khalani reported; recipients
// and order ids are the fixtures' substituted identities.

/** Execution 191 / row #81: Base → Solana USDC. Our stored dest chain id is Khalani's 20011000000. */
const SOLANA_EXPECTATION: DebridgeFillHashLookup = {
  externalOrderId: "0x330cb7083b04bf00330cb7083b04bf00330cb7083b04bf00330cb7083b04bf00",
  expectedDestChainId: 20011000000,
  expectedDestChainFamily: "solana",
  expectedTokenOutAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  expectedRecipient: "mfSnq7L8ZPU4m3QaoPYzBmpWToaQwunGPjAp19WpD7xA",
  expectedDestAmount: "17279551",
};
const SOLANA_FILL_SIGNATURE =
  "XDk6X1UJBXntVTzGXRigZm82sh4WfyEgjwgCh5SzHfaaoXLpuReGjhpS93UxBM2rRPEGojGeyReiRXCtMKxYRyni";

/** Execution 229 / row #96: Solana → Base USDC. */
const EVM_EXPECTATION: DebridgeFillHashLookup = {
  externalOrderId: "0x7f40fb447748f34c7f40fb447748f34c7f40fb447748f34c7f40fb447748f34c",
  expectedDestChainId: 8453,
  expectedDestChainFamily: "eip155",
  expectedTokenOutAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  expectedRecipient: "0x6cdba493ec5b24136cdba493ec5b24136cdba493",
  expectedDestAmount: "22073193",
};
const EVM_FILL_HASH = "0xbb843f80b38c3788bb843f80b38c3788bb843f80b38c3788bb843f80b38c3788";

/** Deep-clone + patch a nested path on a captured payload (fixtures stay immutable). */
function patched(payload: unknown, path: readonly string[], value: unknown): unknown {
  const clone = structuredClone(payload) as Record<string, unknown>;
  let node = clone;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const leaf = path[path.length - 1];
  if (leaf !== undefined) node[leaf] = value;
  return clone;
}

describe("resolveDebridgeFillHash — happy path on the REAL captures", () => {
  it("recovers the base58 fill signature for a SOLANA destination (actualFulfillAmount is null — not required)", () => {
    expect(resolveDebridgeFillHash(SOLANA_DEST, SOLANA_EXPECTATION)).toEqual({ txHash: SOLANA_FILL_SIGNATURE });
  });

  it("recovers the 0x fill hash for an EVM destination", () => {
    expect(resolveDebridgeFillHash(EVM_DEST, EVM_EXPECTATION)).toEqual({ txHash: EVM_FILL_HASH });
  });

  it("compares finalAmount, NOT actualFulfillAmount (which is legitimately null on Solana fulfilments)", () => {
    // Blanking actualFulfillAmount on the EVM capture must not change the outcome.
    const withoutActual = patched(EVM_DEST, ["actualFulfillAmount"], null);
    expect(resolveDebridgeFillHash(withoutActual, EVM_EXPECTATION)).toEqual({ txHash: EVM_FILL_HASH });
  });

  it("an EVM order-id echo differing only in case still matches (hex is case-insensitive)", () => {
    const expectation = { ...EVM_EXPECTATION, externalOrderId: EVM_EXPECTATION.externalOrderId.toUpperCase().replace("0X", "0x") };
    expect(resolveDebridgeFillHash(EVM_DEST, expectation)).toEqual({ txHash: EVM_FILL_HASH });
  });
});

describe("resolveDebridgeFillHash — an unproven claim is REFUSED (row stays pending)", () => {
  it("rejects an order-id echo that is not the id we asked for", () => {
    const other = `0x${"ab".repeat(32)}`;
    expect(resolveDebridgeFillHash(SOLANA_DEST, { ...SOLANA_EXPECTATION, externalOrderId: other })).toBeNull();
  });

  it.each(["Fulfilled", "SentUnlock", "ClaimedUnlock"])("accepts the settled state %s", (state) => {
    expect(resolveDebridgeFillHash(patched(EVM_DEST, ["state"], state), EVM_EXPECTATION)).toEqual({
      txHash: EVM_FILL_HASH,
    });
  });

  it.each([
    "Created",
    "Fulfilling",
    "OrderCancelled",
    "SentOrderCancel",
    "ClaimedOrderCancel",
    "ArchivalCreated",
    "",
    "fulfilled",
  ])("rejects the non-settled / unknown state %s", (state) => {
    expect(resolveDebridgeFillHash(patched(EVM_DEST, ["state"], state), EVM_EXPECTATION)).toBeNull();
  });

  it("rejects a take-chain that is not our stored destination", () => {
    expect(resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, expectedDestChainId: 42161 })).toBeNull();
  });

  it("rejects a take-token that is not our stored destination token", () => {
    const expectation = { ...EVM_EXPECTATION, expectedTokenOutAddress: "0x4200000000000000000000000000000000000006" };
    expect(resolveDebridgeFillHash(EVM_DEST, expectation)).toBeNull();
  });

  it("rejects a receiver that is not our recipient", () => {
    const expectation = { ...EVM_EXPECTATION, expectedRecipient: "0x1111111111111111111111111111111111111111" };
    expect(resolveDebridgeFillHash(EVM_DEST, expectation)).toBeNull();
  });

  it("rejects a Solana receiver whose base58 differs only in CASE (base58 is case-sensitive)", () => {
    const expectation = { ...SOLANA_EXPECTATION, expectedRecipient: SOLANA_EXPECTATION.expectedRecipient?.toLowerCase() ?? null };
    expect(resolveDebridgeFillHash(SOLANA_DEST, expectation)).toBeNull();
  });

  it("rejects a finalAmount that does not match our destination amount EXACTLY (no tolerance)", () => {
    expect(resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, expectedDestAmount: "22073192" })).toBeNull();
    expect(resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, expectedDestAmount: "22073194" })).toBeNull();
  });

  it("compares amounts numerically, so an equal value with leading zeros still matches", () => {
    expect(resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, expectedDestAmount: "0022073193" })).toEqual({
      txHash: EVM_FILL_HASH,
    });
  });

  it("rejects a non-numeric destination amount instead of coercing it", () => {
    expect(resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, expectedDestAmount: "22073193.0" })).toBeNull();
    expect(resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, expectedDestAmount: "-1" })).toBeNull();
  });

  it("rejects a fill hash whose syntax does not match the destination family", () => {
    const evmHashOnSolanaRoute = patched(
      SOLANA_DEST,
      ["fulfilledDstEventMetadata", "transactionHash", "stringValue"],
      EVM_FILL_HASH,
    );
    expect(resolveDebridgeFillHash(evmHashOnSolanaRoute, SOLANA_EXPECTATION)).toBeNull();

    const base58HashOnEvmRoute = patched(
      EVM_DEST,
      ["fulfilledDstEventMetadata", "transactionHash", "stringValue"],
      SOLANA_FILL_SIGNATURE,
    );
    expect(resolveDebridgeFillHash(base58HashOnEvmRoute, EVM_EXPECTATION)).toBeNull();
  });

  it.each([
    ["a missing fulfilment block (order never filled)", ["fulfilledDstEventMetadata"], null],
    ["a missing take offer", ["takeOfferWithMetadata"], null],
    ["a missing give offer", ["giveOfferWithMetadata"], null],
    ["a missing receiver", ["receiverDst"], null],
    ["a numeric fill hash", ["fulfilledDstEventMetadata", "transactionHash", "stringValue"], 42],
    ["an empty fill hash", ["fulfilledDstEventMetadata", "transactionHash", "stringValue"], ""],
  ])("rejects a malformed payload: %s", (_label, path, value) => {
    expect(resolveDebridgeFillHash(patched(EVM_DEST, path, value), EVM_EXPECTATION)).toBeNull();
  });

  it.each([null, undefined, "a string", 7, []])("rejects a non-object payload (%s)", (payload) => {
    expect(resolveDebridgeFillHash(payload, EVM_EXPECTATION)).toBeNull();
  });
});

// ── The two providers number Solana differently — pin BOTH directions ────────

describe("resolveDebridgeFillHash — Solana chain-id pinning", () => {
  it("deBridge's 7565164 satisfies our stored Khalani id 20011000000", () => {
    expect(resolveDebridgeFillHash(SOLANA_DEST, SOLANA_EXPECTATION)).toEqual({ txHash: SOLANA_FILL_SIGNATURE });
  });

  it("a stored Khalani Solana id is NOT satisfied by an EVM take-chain", () => {
    const expectation = { ...EVM_EXPECTATION, expectedDestChainId: 20011000000, expectedDestChainFamily: "solana" as const };
    expect(resolveDebridgeFillHash(EVM_DEST, expectation)).toBeNull();
  });

  it("deBridge's Solana take-chain is NOT accepted for a non-Solana stored destination", () => {
    const expectation = { ...SOLANA_EXPECTATION, expectedDestChainId: 7565164, expectedDestChainFamily: "eip155" as const };
    expect(resolveDebridgeFillHash(SOLANA_DEST, expectation)).toBeNull();
  });

  it("RELAY's Solana chain id (792703809) is REJECTED — it is a third numbering, never a deBridge destination", () => {
    const expectation = { ...SOLANA_EXPECTATION, expectedDestChainId: 792703809 };
    expect(resolveDebridgeFillHash(SOLANA_DEST, expectation)).toBeNull();
    const relayIdInPayload = patched(SOLANA_DEST, ["takeOfferWithMetadata", "chainId", "bigIntegerValue"], 792703809);
    expect(resolveDebridgeFillHash(relayIdInPayload, { ...SOLANA_EXPECTATION, expectedDestChainId: 792703809 })).toBeNull();
  });
});

// ── A recording gap is never a reason to relax confirmation ──────────────────

describe("resolveDebridgeFillHash — a NULL expectation keeps the row pending", () => {
  it.each(["expectedTokenOutAddress", "expectedRecipient", "expectedDestAmount"] as const)(
    "refuses when %s was never recorded",
    (field) => {
      expect(resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, [field]: null })).toBeNull();
    },
  );

  it("names the unrecorded field in a warn — a recording gap is reported, never silently skipped", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, expectedDestAmount: null });
    const events = warnSpy.mock.calls.map((args) => String(Array.from(args)[0]));
    expect(events).toContain("bridge.repair.debridge_expectation_unrecorded");
    const call = warnSpy.mock.calls.find(
      (args) => String(Array.from(args)[0]) === "bridge.repair.debridge_expectation_unrecorded",
    );
    const metadata = call === undefined ? undefined : Array.from(call)[1];
    expect(isRecord(metadata) ? metadata.field : undefined).toBe("expectedDestAmount");
    warnSpy.mockRestore();
  });

  it("logs a rejection reason CODE and the order id, never a raw provider value", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    resolveDebridgeFillHash(EVM_DEST, { ...EVM_EXPECTATION, expectedDestAmount: "22073192" });
    const call = warnSpy.mock.calls.find(
      (args) => String(Array.from(args)[0]) === "bridge.repair.debridge_lookup_rejected",
    );
    expect(call).toBeDefined();
    const metadata = call === undefined ? undefined : Array.from(call)[1];
    expect(isRecord(metadata) ? metadata.reason : undefined).toBe("dest_amount_mismatch");
    // The provider's own numbers/identities never reach the log line.
    expect(JSON.stringify(metadata)).not.toContain("22073193");
    warnSpy.mockRestore();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── The network boundary ─────────────────────────────────────────────────────

describe("fetchDebridgeFillHash — SSRF-guarded transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["a path traversal", "../../admin"],
    ["an absolute URL", "https://evil.example/api/Orders/x"],
    ["a short hex id", `0x${"ab".repeat(16)}`],
    ["a non-hex id", `0x${"zz".repeat(32)}`],
    ["an unprefixed id", "ab".repeat(32)],
    ["an empty id", ""],
    ["a trailing-slash id", `0x${"ab".repeat(32)}/`],
  ])("never issues a request for %s", async (_label, externalOrderId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchDebridgeFillHash({ ...EVM_EXPECTATION, externalOrderId })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never issues a request when an expectation was never recorded", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchDebridgeFillHash({ ...EVM_EXPECTATION, expectedRecipient: null })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests the FIXED deBridge host with redirects off and a bounded timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(EVM_DEST), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDebridgeFillHash(EVM_EXPECTATION)).resolves.toEqual({ txHash: EVM_FILL_HASH });

    expect(DEBRIDGE_STATS_BASE_URL).toBe("https://stats-api.dln.trade");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`https://stats-api.dln.trade/api/Orders/${EVM_EXPECTATION.externalOrderId}`);
    expect(new URL(String(url)).origin).toBe(DEBRIDGE_STATS_BASE_URL);
    expect(init).toMatchObject({ redirect: "error" });
    expect((init as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    expect((init as { headers?: Record<string, string> }).headers).toEqual({ accept: "application/json" });
  });

  it.each([400, 404, 422, 429, 500, 503])("returns null on HTTP %s without throwing", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
    await expect(fetchDebridgeFillHash(EVM_EXPECTATION)).resolves.toBeNull();
  });

  it("returns null (never throws into the sweep batch) on a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET https://stats-api.dln.trade/api/Orders/0xsecret")));
    await expect(fetchDebridgeFillHash(EVM_EXPECTATION)).resolves.toBeNull();
  });

  it("returns null on a timeout abort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "TimeoutError")));
    await expect(fetchDebridgeFillHash(EVM_EXPECTATION)).resolves.toBeNull();
  });

  it("returns null on a non-JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>proxy error</html>", { status: 200 })));
    await expect(fetchDebridgeFillHash(EVM_EXPECTATION)).resolves.toBeNull();
  });

  it("returns null when a 200 body is a DIFFERENT order (the echo gate runs on the live path too)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(SOLANA_DEST), { status: 200 })));
    await expect(fetchDebridgeFillHash(EVM_EXPECTATION)).resolves.toBeNull();
  });
});
