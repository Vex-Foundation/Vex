/**
 * W9a (SPEC §2.6, §5) — `virtuals.list` / `virtuals.graduations` windowing.
 *
 * The bug these tests pin is the audit's only BLOCKING finding (F1): the
 * handler fetched ONE page of 50 rows sorted by market cap and then applied a
 * client-side status filter, so `status:"undergrad"` on a 54,785-row chain was
 * STRUCTURALLY always empty — bonding-curve agents have low market caps and
 * cannot appear in the top 50 by mcap. The agent read "no bonding-curve agents
 * on Base" and had no way to tell that answer from a real one.
 *
 * Two properties make the tool honest again, and both are asserted here:
 *   1. it PAGES, up to a disclosed budget, so the filter can be satisfied; and
 *   2. every reply carries a `windowNote` naming the slice it searched.
 *
 * Plus reject-not-clamp on every window param, per `runtime/list-params.ts`'s
 * doctrine that a silently ignored parameter is indistinguishable from one that
 * had no matching rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualsAgent } from "@tools/virtuals/types.js";
import { makeProtocolContext } from "./_test-context.js";

const listVirtuals = vi.fn();
const listGeneses = vi.fn();

vi.mock("@tools/virtuals/client.js", () => ({
  getVirtualsClient: () => ({ listVirtuals, listGeneses, getVirtual: vi.fn() }),
}));

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { VIRTUALS_HANDLERS } = await import("@vex-agent/tools/protocols/virtuals/handlers.js");

/** Virtuals list/graduations are read-only: least-privilege context is honest here. */
const READ_CTX = makeProtocolContext();

type Row = VirtualsAgent;

/** A NORMALIZED agent row, exactly as `@tools/virtuals/validation.ts` produces it. */
function agent(id: number, status: string, lpCreatedAt: string | null = null): Row {
  return {
    id,
    name: `Agent ${id}`,
    symbol: `A${id}`,
    chain: "BASE",
    status,
    factory: "BONDING_V5",
    category: null,
    tokenAddress: `0x${id.toString(16).padStart(40, "0")}`,
    preToken: null,
    migrateTokenAddress: null,
    lpAddress: null,
    lpCreatedAt,
    createdAt: "2026-07-03T16:34:58.003Z",
    mcapInVirtual: 1000,
    fdvInVirtual: null,
    liquidityUsd: null,
    volume24h: null,
    priceChangePercent24h: null,
    holderCount: 10,
    top10HolderPercentage: null,
    totalSupply: null,
    isVerified: false,
    launchInfo: null,
    socials: [],
    description: null,
    overview: null,
    tokenUtility: null,
    tokenomics: [],
    tokenomicsStatus: null,
  };
}

/** A page of `size` rows; `pagination.total` is the whole chain, as Strapi reports it. */
function page(rows: Row[], total = 54785): unknown {
  return { agents: rows, pagination: { page: 1, pageSize: rows.length, pageCount: 1, total } };
}

function outputOf(result: { success: boolean; output: string }): Record<string, unknown> {
  expect(result.success).toBe(true);
  return JSON.parse(result.output) as Record<string, unknown>;
}

beforeEach(() => {
  listVirtuals.mockReset();
  listGeneses.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Rows-or-windowNote ──────────────────────────────────────────────

describe("virtuals.list discloses its window", () => {
  it("emits a windowNote naming the slice even when rows were returned", async () => {
    listVirtuals.mockResolvedValueOnce(page([agent(1, "AVAILABLE"), agent(2, "AVAILABLE")]));
    const data = outputOf(await VIRTUALS_HANDLERS["virtuals.list"]({ chain: "base" }, READ_CTX));

    expect(data.count).toBe(2);
    const note = String(data.windowNote);
    expect(note).toContain("Searched 2 rows");
    expect(note).toContain("54785");
    expect(note).toContain("WINDOW, not the whole chain");
  });

  it("an EMPTY result names the window it searched, never an empty chain", async () => {
    listVirtuals.mockResolvedValue(page(Array.from({ length: 100 }, (_, i) => agent(i, "AVAILABLE"))));
    const data = outputOf(
      await VIRTUALS_HANDLERS["virtuals.list"]({ chain: "base", status: "undergrad" }, READ_CTX),
    );

    expect(data.count).toBe(0);
    expect(data.totalOnChain).toBe(54785);
    const note = String(data.windowNote);
    expect(note).toContain("Searched 500 rows");
    expect(note).toContain("0 matched status=undergrad");
    // The precise reason the filter came back empty, named — not left implied.
    expect(note).toContain("mcap-sorted");
    expect(note).toContain('sortBy: "newest"');
    // And the next call the agent can make to search further.
    expect(note).toContain("page: 6");
  });

  it("pages until the filter is satisfied, within the 5-page budget", async () => {
    listVirtuals
      .mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, i) => agent(i, "AVAILABLE"))))
      .mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, i) => agent(100 + i, "UNDERGRAD"))));

    const data = outputOf(
      await VIRTUALS_HANDLERS["virtuals.list"]({ chain: "base", status: "undergrad", limit: 5 }, READ_CTX),
    );

    expect(listVirtuals).toHaveBeenCalledTimes(2);
    expect(data.count).toBe(5);
    expect(String(data.windowNote)).toContain("pages 1-2");
  });

  it("never scans more than 5 pages in one call", async () => {
    listVirtuals.mockResolvedValue(page(Array.from({ length: 100 }, (_, i) => agent(i, "AVAILABLE"))));
    await VIRTUALS_HANDLERS["virtuals.list"]({ chain: "base", status: "undergrad" }, READ_CTX);
    expect(listVirtuals).toHaveBeenCalledTimes(5);
  });

  it("stops at the first page when no filter is applied", async () => {
    listVirtuals.mockResolvedValue(page(Array.from({ length: 100 }, (_, i) => agent(i, "AVAILABLE"))));
    await VIRTUALS_HANDLERS["virtuals.list"]({ chain: "base" }, READ_CTX);
    expect(listVirtuals).toHaveBeenCalledTimes(1);
  });

  it("starts from the requested page and forwards page/pageSize to the provider", async () => {
    listVirtuals.mockResolvedValueOnce(page([agent(1, "AVAILABLE")]));
    await VIRTUALS_HANDLERS["virtuals.list"]({ chain: "base", page: 7, pageSize: 200 }, READ_CTX);
    expect(listVirtuals).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "BASE", page: 7, pageSize: 200 }),
    );
  });

  it("says so when the provider ran out of rows instead of inviting a next page", async () => {
    listVirtuals.mockResolvedValueOnce(page([agent(1, "AVAILABLE")], 1));
    const data = outputOf(await VIRTUALS_HANDLERS["virtuals.list"]({ chain: "base" }, READ_CTX));
    expect(String(data.windowNote)).toContain("no further rows");
    expect(String(data.windowNote)).not.toContain("call again with page");
  });

  it("graduations discloses its window too", async () => {
    listVirtuals.mockResolvedValueOnce(page([agent(1, "AVAILABLE", "2026-07-03T17:04:23.406Z")]));
    const data = outputOf(await VIRTUALS_HANDLERS["virtuals.graduations"]({ chain: "base" }, READ_CTX));
    expect(String(data.windowNote)).toContain("matched status=graduated");
  });
});

// ── Reject, do not clamp ────────────────────────────────────────────

describe("virtuals.list rejects out-of-range and unknown values BY NAME", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["limit above the maximum", { chain: "base", limit: 500 }, '"limit" must be at most 100'],
    ["limit of zero", { chain: "base", limit: 0 }, '"limit" must be at least 1'],
    ["a fractional limit", { chain: "base", limit: 2.5 }, '"limit" must be a whole number'],
    ["page of zero", { chain: "base", page: 0 }, '"page" must be at least 1'],
    ["pageSize above the provider ceiling", { chain: "base", pageSize: 500 }, '"pageSize" must be at most 200'],
    ["an unknown status", { chain: "base", status: "graduatd" }, 'Unknown status "graduatd"'],
    ["an unknown sortBy", { chain: "base", sortBy: "mcaap" }, 'Unknown sortBy "mcaap"'],
    ["an unknown sort alias", { chain: "base", sort: "mcaap" }, 'Unknown sort "mcaap"'],
    ["an unknown chain", { chain: "arbitrum" }, 'Invalid chain "arbitrum"'],
    ["a missing chain", {}, "Missing required: chain"],
  ];

  for (const [label, params, expected] of cases) {
    it(`rejects ${label}`, async () => {
      const result = await VIRTUALS_HANDLERS["virtuals.list"](params, READ_CTX);
      expect(result.success).toBe(false);
      expect(result.output).toContain(expected);
      expect(listVirtuals).not.toHaveBeenCalled();
    });
  }

  it("accepts the legal values it used to coerce", async () => {
    listVirtuals.mockResolvedValue(page([agent(1, "UNDERGRAD")]));
    const data = outputOf(
      await VIRTUALS_HANDLERS["virtuals.list"]({ chain: "base", status: "undergrad", sortBy: "newest", limit: 100 }, READ_CTX),
    );
    expect(data.status).toBe("undergrad");
    expect(data.sort).toBe("newest");
    expect(listVirtuals).toHaveBeenCalledWith(expect.objectContaining({ sort: "createdAt" }));
  });

  it("rejects out-of-range window params on graduations and geneses too", async () => {
    const graduations = await VIRTUALS_HANDLERS["virtuals.graduations"]({ chain: "base", limit: 500 }, READ_CTX);
    expect(graduations.success).toBe(false);
    expect(graduations.output).toContain('"limit" must be at most 100');

    const geneses = await VIRTUALS_HANDLERS["virtuals.geneses"]({ page: 0 }, READ_CTX);
    expect(geneses.success).toBe(false);
    expect(geneses.output).toContain('"page" must be at least 1');
    expect(listGeneses).not.toHaveBeenCalled();
  });
});
