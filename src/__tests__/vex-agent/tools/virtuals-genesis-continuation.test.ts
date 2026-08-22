/**
 * `virtuals.geneses` continuation and truncation disclosure (O4, owner ruling
 * D16; plan v3 section 11 R4).
 *
 * Two independent honesty questions, and the reason they are separate here:
 *
 *  1. WITHIN the page. The handler fetches ONE provider page of `pageSize`
 *     rows and slices it to `limit`, so on the defaults (limit 20, pageSize
 *     100) eighty already-fetched rows used to disappear without a word. The
 *     reply now carries `returned`, `fetched`, `truncated` and, when true, the
 *     knob that brings the rows back.
 *
 *  2. ACROSS pages. `VirtualsPagination` lets `total`, `page` and `pageSize`
 *     be null INDEPENDENTLY, so a present pagination block is not evidence
 *     that `page * pageSize < total` means anything. Unless all three are
 *     finite numbers the reply OMITS `hasMore`/`nextPage` and says which
 *     number was missing. The failure this pins is the tempting one: deriving
 *     "no more pages" from metadata the provider never sent.
 *
 * These live in their own file rather than in virtuals-handlers.test.ts, which
 * is already at 463 lines against this repository's 500-line convention.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import { VIRTUALS_HANDLERS } from "../../../vex-agent/tools/protocols/virtuals/handlers.js";
import { getVirtualsClient } from "@tools/virtuals/client.js";
import type { VirtualsGenesis, VirtualsPagination } from "@tools/virtuals/types.js";
import { makeProtocolContext } from "./_test-context.js";

vi.mock("@tools/virtuals/client.js", () => ({
  getVirtualsClient: vi.fn(),
}));

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CTX = makeProtocolContext({ sessionPermission: "restricted", approved: false });

function genesis(id: number): VirtualsGenesis {
  return {
    id,
    genesisId: String(id),
    status: "FINALIZED",
    startsAt: "2025-10-03T12:00:00.000Z",
    endsAt: "2025-10-04T12:00:00.000Z",
    totalParticipants: 10,
    totalVirtuals: 100,
    agent: null,
  };
}

/** One provider page of `rows` genesis rows, with the pagination block as given. */
function mockGenesesPage(rows: number, pagination: VirtualsPagination | null): void {
  (getVirtualsClient as ReturnType<typeof vi.fn>).mockReturnValue({
    listGeneses: vi.fn().mockResolvedValue({
      geneses: Array.from({ length: rows }, (_, i) => genesis(i + 1)),
      pagination,
    }),
  });
}

type GenesisReply = {
  count: number;
  returned: number;
  fetched: number;
  truncated: boolean;
  truncationNote?: string;
  hasMore?: boolean;
  nextPage?: number;
  continuationNote?: string;
  total: number | null;
  page: number;
  pageSize: number;
  filtersApplied: Record<string, never>;
};

const genesesHandler = VIRTUALS_HANDLERS["virtuals.geneses"];
if (!genesesHandler) throw new Error("virtuals.geneses is not registered in VIRTUALS_HANDLERS");

async function callGeneses(params: Record<string, unknown>): Promise<GenesisReply> {
  const res = await genesesHandler(params, CTX);
  expect(res.success).toBe(true);
  return res.data as GenesisReply;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("virtuals.geneses - within-page truncation", () => {
  it("is not truncated when the provider page holds exactly `limit` rows", async () => {
    mockGenesesPage(5, { page: 1, pageSize: 5, pageCount: 1, total: 5 });
    const data = await callGeneses({ limit: 5, pageSize: 5 });
    expect(data.returned).toBe(5);
    expect(data.fetched).toBe(5);
    expect(data.truncated).toBe(false);
    expect(data.truncationNote).toBeUndefined();
  });

  it("is truncated one row later, and names the rows as already fetched", async () => {
    mockGenesesPage(6, { page: 1, pageSize: 6, pageCount: 1, total: 6 });
    const data = await callGeneses({ limit: 5, pageSize: 6 });
    expect(data.returned).toBe(5);
    expect(data.fetched).toBe(6);
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("1 row fetched");
    expect(String(data.truncationNote)).toContain("(5 of 6 kept)");
    // 6 fetched rows fit under the `limit` ceiling of 100, so re-reading the
    // SAME page with limit 6 and the same pageSize is the recovery that exists.
    expect(String(data.truncationNote)).toContain("re-read this same `page` (1) with `limit` 6 and the SAME `pageSize`");
  });

  it("phrases the recovery from `fetched` and the CURRENT page, not from the requested pageSize", async () => {
    // Page 2 at pageSize 30: the dropped rows are offsets 50..59 of the
    // calendar. Changing pageSize would renumber the pages, so the only
    // recovery that returns THESE rows is the same page, same pageSize,
    // a larger limit.
    mockGenesesPage(30, { page: 2, pageSize: 30, pageCount: 4, total: 100 });
    const data = await callGeneses({ limit: 20, page: 2, pageSize: 30 });
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("re-read this same `page` (2) with `limit` 30 and the SAME `pageSize`");
    expect(String(data.truncationNote)).not.toContain("lower `pageSize`");
  });

  it("sends the agent back to page 1 with a smaller pageSize when the page exceeds what `limit` can return", async () => {
    mockGenesesPage(150, { page: 1, pageSize: 150, pageCount: 2, total: 400 });
    const data = await callGeneses({ limit: 20, pageSize: 150 });
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("restart from `page` 1 with `pageSize` at most 20");
    expect(String(data.truncationNote)).toContain("changing `pageSize` changes where every page starts");
    expect(String(data.truncationNote)).not.toContain("re-read this same `page`");
  });

  it("on page 2 of an oversized pageSize the restart still begins at page 1, never at page 2", async () => {
    // Regression for the page-boundary mistake: page 2 at size 150 covers
    // offsets 150..299; page 2 at size 20 covers 20..39. "Lower pageSize and
    // stay on this page" would fetch unrelated rows.
    mockGenesesPage(150, { page: 2, pageSize: 150, pageCount: 3, total: 400 });
    const data = await callGeneses({ limit: 20, page: 2, pageSize: 150 });
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toContain("restart from `page` 1");
    expect(String(data.truncationNote)).not.toContain("`page` (2)");
  });

  it("keeps the fields it already emitted untouched", async () => {
    mockGenesesPage(3, { page: 2, pageSize: 3, pageCount: 5, total: 14 });
    const data = await callGeneses({ limit: 20, page: 2, pageSize: 3 });
    expect(data.count).toBe(3);
    expect(data.total).toBe(14);
    expect(data.page).toBe(2);
    expect(data.pageSize).toBe(3);
    // page_window class: the filters that ran, and this read has none.
    expect(data.filtersApplied).toEqual({});
  });
});

describe("virtuals.geneses - continuation with sufficient provider metadata", () => {
  it("says hasMore with the next page when the provider's own numbers prove more exist", async () => {
    mockGenesesPage(20, { page: 2, pageSize: 20, pageCount: 5, total: 100 });
    const data = await callGeneses({ limit: 20, page: 2, pageSize: 20 });
    // 2 * 20 = 40 < 100.
    expect(data.hasMore).toBe(true);
    expect(data.nextPage).toBe(3);
    expect(data.continuationNote).toBeUndefined();
  });

  it("says hasMore:false and omits nextPage on the last page", async () => {
    mockGenesesPage(20, { page: 5, pageSize: 20, pageCount: 5, total: 100 });
    const data = await callGeneses({ limit: 20, page: 5, pageSize: 20 });
    // 5 * 20 = 100, not below 100: the window ends here.
    expect(data.hasMore).toBe(false);
    expect(data.nextPage).toBeUndefined();
    expect(data.continuationNote).toBeUndefined();
  });

  it("reads the PROVIDER's page numbers, not the request's", async () => {
    // The request asks for page 5; the provider answers that it served page 1
    // of 100 rows. The honest hasMore follows the provider.
    mockGenesesPage(20, { page: 1, pageSize: 20, pageCount: 5, total: 100 });
    const data = await callGeneses({ limit: 20, page: 5, pageSize: 20 });
    expect(data.hasMore).toBe(true);
    expect(data.nextPage).toBe(2);
  });
});

describe("virtuals.geneses - insufficient provider metadata never claims an end", () => {
  it("omits hasMore entirely when the provider sent no pagination block", async () => {
    mockGenesesPage(3, null);
    const data = await callGeneses({ limit: 20, pageSize: 100 });
    expect(data).not.toHaveProperty("hasMore");
    expect(data).not.toHaveProperty("nextPage");
    expect(String(data.continuationNote)).toContain("`total`");
    expect(String(data.continuationNote)).toContain("`page`");
    expect(String(data.continuationNote)).toContain("`pageSize`");
    expect(String(data.continuationNote)).toContain("UNKNOWN");
  });

  it("omits hasMore when every pagination field is null", async () => {
    mockGenesesPage(3, { page: null, pageSize: null, pageCount: null, total: null });
    const data = await callGeneses({ limit: 20, pageSize: 100 });
    expect(data).not.toHaveProperty("hasMore");
    expect(data.total).toBeNull();
    expect(String(data.continuationNote)).toContain("Request the next `page`");
  });

  it("omits hasMore on PARTIAL metadata: total present, page null", async () => {
    mockGenesesPage(3, { page: null, pageSize: 100, pageCount: 4, total: 363 });
    const data = await callGeneses({ limit: 20, pageSize: 100 });
    expect(data).not.toHaveProperty("hasMore");
    expect(data).not.toHaveProperty("nextPage");
    // The echoed `total` still reports what the provider did send.
    expect(data.total).toBe(363);
    expect(String(data.continuationNote)).toContain("`page`");
    expect(String(data.continuationNote)).not.toContain("`total`");
  });

  it("omits hasMore on PARTIAL metadata: page and pageSize present, total null", async () => {
    mockGenesesPage(3, { page: 1, pageSize: 100, pageCount: null, total: null });
    const data = await callGeneses({ limit: 20, pageSize: 100 });
    expect(data).not.toHaveProperty("hasMore");
    expect(String(data.continuationNote)).toContain("`total`");
    expect(String(data.continuationNote)).not.toContain("`pageSize`");
  });

  it("still reports within-page truncation when the metadata is insufficient", async () => {
    mockGenesesPage(50, null);
    const data = await callGeneses({ limit: 20, pageSize: 50 });
    expect(data.truncated).toBe(true);
    expect(data.fetched).toBe(50);
    expect(data.returned).toBe(20);
    expect(String(data.truncationNote)).toContain("30 rows fetched");
    expect(data).not.toHaveProperty("hasMore");
    expect(data.continuationNote).toBeDefined();
  });
});
