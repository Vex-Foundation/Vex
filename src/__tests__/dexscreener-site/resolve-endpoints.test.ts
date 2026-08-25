/**
 * The S3 endpoint clients, driven by a scripted transport over REAL captured
 * bytes.
 *
 * The three behaviours under test are the three that would silently produce a
 * wrong answer rather than a failure:
 *
 *  1. FRAME DISPATCH. Both channels answer with a protobuf oneof whose first
 *     arm is often not the one the caller wants, so the scripts below put the
 *     answer first, last, and never.
 *  2. THE V8 COMMAND. The bytes we put on the wire decide which identities the
 *     provider resolves. A command that dropped or reordered ids would return
 *     a plausible answer to a different question, so the encoder is asserted
 *     byte-identical to the command a real browser sent.
 *  3. NOT_FOUND IS AN ABSENCE. The measured "this token has no insight" answer
 *     must come back as a reported absence, never as an error and never as an
 *     empty string that reads like an empty blurb.
 *
 * The transport is a fake because a transport is exactly the boundary a fake
 * belongs at: the bytes it hands back are the provider's own, from fixtures.
 */

import { describe, expect, it } from "vitest";
import { fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import {
  fetchPairSnapshot,
  fetchPairReactions,
  parsePairReactions,
  readTokenInsightFrames,
  PAIR_FIRST_ATTEMPT_FRAMES,
  PAIR_RETRY_FRAMES,
} from "../../tools/dexscreener/endpoints/pair-live.js";
import {
  fetchSpotlight,
  parseSpotlight,
} from "../../tools/dexscreener/endpoints/spotlight.js";
import {
  fetchPairsBatch,
  chunkIdentities,
  BATCH_FIRST_ATTEMPT_FRAMES,
  BATCH_RETRY_FRAMES,
  rowKey,
  baseTokenKey,
  type BatchIdentity,
} from "../../tools/dexscreener/endpoints/pairs-batch.js";
import {
  parseSearchResponse,
  searchPairs,
  SEARCH_DEFAULT_MAX_CHAINS,
  SEARCH_PROVIDER_WINDOW,
} from "../../tools/dexscreener/endpoints/search.js";
import {
  decodeDexScreenerMessageToJson,
  getDexScreenerMessageDescriptor,
  getDexScreenerProtoRegistry,
} from "../../tools/dexscreener/codec/protobuf.js";
import { encodeDexScreenerCommand } from "../../tools/dexscreener/codec/encode.js";
import { DexScreenerSiteErrorCodes } from "../../tools/dexscreener/site-errors.js";
import type {
  DexScreenerTransport,
  HttpGetOptions,
  WsExchangeOptions,
} from "../../tools/dexscreener/transport.js";
import { VexError } from "../../errors.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { registerDexScreenerTransport } from "../../tools/dexscreener/transport.js";
import { loadFixture } from "./_fixtures.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ISSUER_NAME_MAX_CHARS } from "../../tools/dexscreener/sanitize.js";

const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const LATEST_BLOCK_FRAME = loadFixture("screener-latestblock-solana").bytes;
const REACTIONS_BODY = loadFixture("reactions-ethereum-pepe").bytes;
const INSIGHT_NOT_FOUND = loadFixture("token-insight-not-found").bytes;
const SPOTLIGHT_BODY = loadFixture("spotlight-v10").bytes;
const SEARCH_BODY = loadFixture("search-cat-plain").bytes;
const BATCH_KNOWN_COMMAND = loadFixture("v8-batch-known-three.command").bytes;
const BATCH_KNOWN_FRAME = loadFixture("v8-batch-known-three.frame").bytes;
const BATCH_DUP_FRAME = loadFixture("v8-batch-invalid-and-duplicate.frame").bytes;

interface WsCall {
  readonly url: string;
  readonly options: WsExchangeOptions;
}
interface HttpCall {
  readonly url: string;
  readonly options: HttpGetOptions;
}

/** A transport replaying a scripted sequence, recording what it was asked. */
function scripted(options: {
  readonly ws?: readonly (readonly Uint8Array[])[];
  readonly http?: readonly { status: number; body: Uint8Array }[];
}): {
  readonly transport: DexScreenerTransport;
  readonly wsCalls: WsCall[];
  readonly httpCalls: HttpCall[];
} {
  const wsCalls: WsCall[] = [];
  const httpCalls: HttpCall[] = [];
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url, httpOptions) => {
      httpCalls.push({ url, options: httpOptions });
      const next = options.http?.[httpCalls.length - 1];
      if (next === undefined) {
        return Promise.reject(new Error("no scripted HTTP response left"));
      }
      return Promise.resolve({
        url,
        status: next.status,
        headers: new Map<string, string>(),
        body: next.body,
      });
    },
    wsExchange: (url, wsOptions) => {
      wsCalls.push({ url, options: wsOptions });
      const batch = options.ws?.[wsCalls.length - 1];
      if (batch === undefined) {
        return Promise.reject(new Error("no scripted WS batch left"));
      }
      return Promise.resolve([...batch]);
    },
  };
  return { transport, wsCalls, httpCalls };
}

/* ------------------------------------------------------------------ */

describe("fetchPairSnapshot", () => {
  it("lowercases the pair address in the path and returns the row from the pair arm", async () => {
    const { transport, wsCalls } = scripted({ ws: [[PAIR_FRAME]] });
    const result = await fetchPairSnapshot({
      chainId: "ethereum",
      // Deliberately EVM checksum casing: the channel is served lowercase.
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      transport,
      timeoutMs: 1000,
    });
    expect(wsCalls[0]?.url).toBe(
      "wss://io.dexscreener.com/dex/screener/v7/pair/ethereum/0xa43fe16908251ee70ef74718545e4fe6c5ccec9f"
    );
    // The row keeps the PROVIDER's own spelling; we did not rewrite it.
    expect((result.row as Record<string, unknown>)["pairAddress"]).toBe(
      "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f"
    );
    expect(result.attempts).toBe(1);
  });

  it("skips a latestBlock frame arriving before the snapshot", async () => {
    const { transport } = scripted({ ws: [[LATEST_BLOCK_FRAME, PAIR_FRAME]] });
    const result = await fetchPairSnapshot({
      chainId: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      transport,
      timeoutMs: 1000,
    });
    expect((result.row as Record<string, unknown>)["chainId"]).toBe("ethereum");
    expect(result.framesReceived).toBe(2);
  });

  it("retries once, then fails by naming what did arrive instead of claiming the pair is unknown", async () => {
    const { transport, wsCalls } = scripted({
      ws: [[LATEST_BLOCK_FRAME], [LATEST_BLOCK_FRAME]],
    });
    await expect(
      fetchPairSnapshot({
        chainId: "ethereum",
        pairAddress: "0xabc",
        transport,
        timeoutMs: 1000,
      })
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.PAIR_NO_SNAPSHOT_FRAME,
    });
    expect(wsCalls).toHaveLength(2);
    expect(wsCalls[0]?.options.expect.binaryFrames).toBe(PAIR_FIRST_ATTEMPT_FRAMES);
    expect(wsCalls[1]?.options.expect.binaryFrames).toBe(PAIR_RETRY_FRAMES);
  });
});

describe("pair reactions", () => {
  it("parses the real counter document", () => {
    const parsed = parsePairReactions(REACTIONS_BODY);
    expect(parsed?.totals).toEqual({
      poop: 1074,
      fire: 1152,
      rocket: 11045,
      triangular_flag_on_post: 922,
    });
  });

  it("degrades to null on a non-200 rather than failing the caller's snapshot", async () => {
    const { transport } = scripted({
      http: [{ status: 503, body: new Uint8Array() }],
    });
    await expect(
      fetchPairReactions({
        chainId: "ethereum",
        pairAddress: "0xabc",
        transport,
        timeoutMs: 1000,
      })
    ).resolves.toBeNull();
  });

  it("returns null for a body that is not the measured shape", () => {
    expect(parsePairReactions(new TextEncoder().encode("{}"))).toBeNull();
    expect(parsePairReactions(new TextEncoder().encode("nonsense"))).toBeNull();
  });
});

describe("readTokenInsightFrames", () => {
  it("reports the measured NOT_FOUND answer as an absence, not an error", () => {
    // The captured frame answers cid 30; that is the cid the capture used.
    const insight = readTokenInsightFrames([INSIGHT_NOT_FOUND], 30);
    expect(insight).not.toBeNull();
    expect(insight?.code).toBe("WS_COMMAND_CODE_NOT_FOUND");
    expect(insight?.title).toBeNull();
    expect(insight?.content).toBeNull();
  });

  it("ignores an answer carrying somebody else's correlation id", () => {
    expect(readTokenInsightFrames([INSIGHT_NOT_FOUND], 1)).toBeNull();
  });
});

describe("parseSpotlight", () => {
  const document = parseSpotlight(SPOTLIGHT_BODY);

  it("projects all three feeds at their measured sizes", () => {
    expect(document.topBoosts).toHaveLength(30);
    expect(document.recentBoosts).toHaveLength(30);
    expect(document.latestProfiles).toHaveLength(36);
  });

  it("keeps the just-purchased amount separate from the running total on the recent feed", () => {
    const recent = document.recentBoosts[0];
    expect(recent?.justPurchasedAmount).not.toBeNull();
    // The distinction the feed exists to make: the top feed carries no
    // just-purchased amount at all, and that is an absence rather than a zero.
    expect(document.topBoosts[0]?.justPurchasedAmount).toBeNull();
    expect(document.topBoosts[0]?.totalBoostAmount).not.toBeNull();
  });

  it("carries issuer-authored profile text through verbatim for the caller to sanitize", () => {
    const withText = document.latestProfiles.find(
      (row) => row.description !== null
    );
    expect(withText?.description).toBeTypeOf("string");
    expect(withText?.chainId).toBeTypeOf("string");
  });

  it("rejects a non-200 by name instead of reporting empty feeds", async () => {
    const { transport } = scripted({
      http: [{ status: 500, body: new Uint8Array() }],
    });
    await expect(
      fetchSpotlight({ transport, timeoutMs: 1000 })
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.SPOTLIGHT_INVALID,
    });
  });

  it("projects the issuer-authored link label (FI9): measured present on 22 of 61 links in this capture", () => {
    // The measured defect: `label` reached no field on `SpotlightProfileLink`
    // at all, so a link with no `type` reached the model as a bare URL with
    // no way to know the issuer called it "Website". REVERT-DETECTOR: this
    // goes red the moment `readLinks` in spotlight.ts stops reading `label`.
    const allLinks = document.latestProfiles.flatMap((row) => row.links);
    const withLabel = allLinks.filter((link) => link.label !== null);
    expect(withLabel.length).toBeGreaterThan(0);
    expect(withLabel[0]?.label).toBeTypeOf("string");
  });
});

/* ------------------------------------------------------------------ */
/* Spotlight, through the real handler: sanitize and content-field claim */
/* ------------------------------------------------------------------ */

describe("dexscreener__spotlight_get: issuer-authored link label", () => {
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

  /**
   * The real captured spotlight body with the FIRST latestProfiles row's
   * FIRST link label replaced by one carrying a zero-width space, so the
   * sanitizer has something to remove. Derived from the committed
   * `spotlight-v10` fixture by decoding it with the production descriptor and
   * re-encoding one mutated field, rather than inventing raw bytes: every
   * value other than the one label is the provider's own captured data.
   */
  function spotlightBodyWithHostileLabel(): Uint8Array {
    const descriptor = getDexScreenerMessageDescriptor(
      "dex_search.SpotlightResponse"
    );
    const decoded = decodeDexScreenerMessageToJson(
      "dex_search.SpotlightResponse",
      SPOTLIGHT_BODY,
      { maxBytes: 1_000_000 }
    ) as {
      readonly latestProfiles?: readonly {
        readonly token?: {
          readonly links?: readonly Record<string, unknown>[];
        };
      }[];
    };
    const profiles = decoded.latestProfiles ?? [];
    const hostileLabel = `We${ZERO_WIDTH_SPACE}bsite`;
    let planted = false;
    const mutatedProfiles = profiles.map((profile) => {
      const links = profile.token?.links ?? [];
      if (planted || links.length === 0) return profile;
      const [firstLink, ...restLinks] = links;
      planted = true;
      return {
        ...profile,
        token: {
          ...profile.token,
          links: [{ ...firstLink, label: hostileLabel }, ...restLinks],
        },
      };
    });
    if (!planted) {
      throw new Error(
        "no latestProfiles link found in the fixture to plant a hostile label on"
      );
    }
    return toBinary(
      descriptor,
      fromJson(descriptor, {
        ...decoded,
        latestProfiles: mutatedProfiles,
      } as unknown as JsonValue)
    );
  }

  it("sanitizes a hostile label and reports the exact field path, and lists it in externalContentFields", async () => {
    const body = spotlightBodyWithHostileLabel();
    const transport: DexScreenerTransport = {
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      httpGet: () =>
        Promise.resolve({
          url: "https://io.dexscreener.com/dex/search/spotlight/v10",
          status: 200,
          headers: new Map<string, string>(),
          body,
        }),
      wsExchange: () => Promise.reject(new Error("not used by spotlight")),
    };
    const release = registerDexScreenerTransport(transport);
    try {
      const handler = DEXSCREENER_HANDLERS["dexscreener.spotlight"];
      expect(handler).toBeDefined();
      if (handler === undefined) throw new Error("no handler");
      const result = await handler(
        { feed: "latestProfiles", fields: "links", limit: 36 },
        {} as never
      );
      expect(result.success, result.output).toBe(true);
      const data = result.data as Record<string, unknown>;
      const profiles = data["latestProfiles"] as Record<string, unknown>[];
      const withLink = profiles.find(
        (row) => (row["links"] as unknown[] | undefined)?.length
      );
      expect(withLink).toBeDefined();
      const links = withLink?.["links"] as Record<string, unknown>[];
      const label = links[0]?.["label"];
      // SANITIZED: the zero-width space is gone. REVERT-DETECTOR: with the
      // pre-fix code (label never read into the projection, or read but not
      // passed through sanitizeIssuerField) this is either undefined or still
      // carries the zero-width character.
      expect(label).toBe("Website");
      // REPORTED: the exact field path is named, not merely "something was
      // cleaned". This is the safety claim `sanitize.ts` makes in writing for
      // profile link labels; before FI9 nothing ever set this because label
      // never reached sanitizeIssuerField.
      expect(data["sanitizedFields"]).toContain(
        "latestProfiles[].links[].label"
      );
      // LISTED as external content: a model reading this answer must be told
      // the label is issuer-authored, not DexScreener's own classification.
      expect(data["externalContentFields"]).toContain(
        "latestProfiles[].links[].label"
      );
    } finally {
      release();
    }
  });
});

describe("search", () => {
  it("decodes the provider window and reports it as capped at 30", () => {
    const rows = parseSearchResponse(SEARCH_BODY);
    expect(rows.length).toBe(SEARCH_PROVIDER_WINDOW);
  });

  it("sends only q and chainId, never the parameters the provider ignores", async () => {
    const { transport, httpCalls } = scripted({
      http: [{ status: 200, body: SEARCH_BODY }],
    });
    await searchPairs({
      query: "CAT",
      chainIds: ["solana"],
      transport,
      timeoutMs: 1000,
    });
    const url = new URL(httpCalls[0]?.url ?? "");
    expect([...url.searchParams.keys()].sort()).toEqual(["chainId", "q"]);
  });

  it("issues one request PER chain, because the window is applied per request", async () => {
    const { transport, httpCalls } = scripted({
      http: [
        { status: 200, body: SEARCH_BODY },
        { status: 200, body: SEARCH_BODY },
      ],
    });
    const result = await searchPairs({
      query: "CAT",
      chainIds: ["solana", "base"],
      transport,
      timeoutMs: 1000,
    });
    expect(httpCalls).toHaveLength(2);
    expect(result.requestsIssued).toBe(2);
    expect(result.perChain.map((entry) => entry.chainId)).toEqual([
      "solana",
      "base",
    ]);
  });

  it("no longer refuses a wide fan-out of its own accord: the tool owns that bound", async () => {
    // The endpoint used to throw above SEARCH_MAX_CHAINS. It does not any
    // more (plan 14.6 item 4): `maxChains` is the tool's policy and the
    // deadline is the real bound, so the endpoint issues what it was asked
    // for and reports every request it made.
    const wanted = SEARCH_DEFAULT_MAX_CHAINS + 3;
    const { transport, httpCalls } = scripted({
      http: Array.from({ length: wanted }, () => ({
        status: 200,
        body: SEARCH_BODY,
      })),
    });
    const result = await searchPairs({
      query: "CAT",
      chainIds: Array.from({ length: wanted }, (_, index) => `c${index}`),
      transport,
      timeoutMs: 1000,
    });
    expect(httpCalls).toHaveLength(wanted);
    expect(result.requestsIssued).toBe(wanted);
  });

  it("refuses a query shorter than the provider's minimum", async () => {
    const { transport } = scripted({});
    await expect(
      searchPairs({ query: "a", transport, timeoutMs: 1000 })
    ).rejects.toBeInstanceOf(VexError);
  });
});

describe("the v8 batch command", () => {
  it("encodes byte-identically to the command a real browser sent", () => {
    const captured = decodeDexScreenerMessageToJson(
      "dex_screener.PairsSearchChannelCommand",
      BATCH_KNOWN_COMMAND,
      { maxBytes: 1_000_000 }
    );
    const rebuilt = encodeDexScreenerCommand(
      "dex_screener.PairsSearchChannelCommand",
      captured
    );
    expect([...rebuilt]).toEqual([...BATCH_KNOWN_COMMAND]);
  });

  it("refuses to encode a message that is not an allowlisted command", () => {
    expect(() =>
      encodeDexScreenerCommand(
        "dex_search.SearchPairsResponse" as never,
        {}
      )
    ).toThrow(VexError);
  });
});

/**
 * A `pairs` answer frame holding `rows` rows and claiming `pairsCount` in
 * total, encoded through the real descriptor so the page walk is exercised
 * over wire bytes rather than a hand-built object.
 */
function pairsFrame(rows: number, pairsCount: number, tag = "p"): Uint8Array {
  // Built through the SAME descriptor the wire uses. The production encoder
  // deliberately refuses response messages (it may only emit commands), so the
  // test reaches for the descriptor directly rather than widening that gate.
  const descriptor = getDexScreenerMessageDescriptor(
    "dex_screener.PairsSearchChannelMessage"
  );
  const message = fromJson(
    descriptor,
    {
      pairs: {
        pairs: Array.from({ length: rows }, (_unused, index) => ({
          chainId: "solana",
          pairAddress: `pair-${tag}-${index}`,
        })),
        pairsCount,
      },
    },
    { registry: getDexScreenerProtoRegistry() }
  );
  return toBinary(descriptor, message);
}

/** The `page` the command in one scripted WS call asked for. */
function pageNumberOf(call: { options: WsExchangeOptions } | undefined): unknown {
  const sent = call?.options.send?.[0];
  if (!(sent instanceof Uint8Array)) throw new Error("no binary command sent");
  const decoded = decodeDexScreenerMessageToJson(
    "dex_screener.PairsSearchChannelCommand",
    sent,
    { maxBytes: 1_000_000 }
  ) as { subscribe: { page?: unknown } };
  return decoded.subscribe.page;
}

describe("fetchPairsBatch", () => {
  const identity = (chainId: string, id: string): BatchIdentity => ({
    chainId,
    id,
    kind: "pair",
    raw: `${chainId}:${id}`,
  });

  it("sends the identities as a binary subscribe frame and returns the rows", async () => {
    const { transport, wsCalls } = scripted({ ws: [[BATCH_KNOWN_FRAME]] });
    const result = await fetchPairsBatch(
      {
        identities: [
          identity("ethereum", "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f"),
        ],
        window: "h24",
        rankKey: "RANK_BY_KEY_VOLUME",
        rankOrder: "desc",
      },
      { transport, timeoutMs: 1000 }
    );
    expect(wsCalls[0]?.url).toBe(
      "wss://io.dexscreener.com/dex/screener/v8/pairs-search"
    );
    expect(wsCalls[0]?.options.send?.[0]).toBeInstanceOf(Uint8Array);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.chunks).toHaveLength(1);
  });

  it("lifts the launchpad exclusion on every subscribe, or bonding-curve pairs vanish", async () => {
    // MEASURED (EP4 c2 vs c3): the same 100 live Pump.fun / Meteora DBC ids
    // answered 0 rows with no `filters` field and 100 of 100 with
    // `filters.excludedDEXIds = [""]`. Sending the field at all replaces the
    // channel's hidden default exclusion. Without this the tool reports the
    // exact population this product cares about as `provider_omitted`.
    const { transport, wsCalls } = scripted({ ws: [[BATCH_KNOWN_FRAME]] });
    await fetchPairsBatch(
      {
        identities: [
          identity("ethereum", "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f"),
        ],
        window: "h24",
        rankKey: "RANK_BY_KEY_VOLUME",
        rankOrder: "desc",
      },
      { transport, timeoutMs: 1000 }
    );
    const sent = wsCalls[0]?.options.send?.[0];
    if (!(sent instanceof Uint8Array)) throw new Error("no binary command sent");
    const decoded = decodeDexScreenerMessageToJson(
      "dex_screener.PairsSearchChannelCommand",
      sent,
      { maxBytes: 1_000_000 }
    ) as { subscribe: { filters?: { excludedDEXIds?: unknown }; page?: unknown } };
    // The field name is the descriptor's own spelling, not a hand-written one:
    // this decode round-trips through the same descriptor the wire uses.
    expect(decoded.subscribe.filters?.excludedDEXIds).toStrictEqual([""]);
    // page = 0 answers nothing at all, so the walk must start at 1.
    expect(decoded.subscribe.page).toBe(1);
  });

  it("walks provider pages until pairsCount is satisfied, and reports the walk", async () => {
    // MEASURED: page size 500, `pairsCount` a true total across pages. The
    // scripted frames stand in for that shape at test scale.
    const pageOne = pairsFrame(2, 3, "one");
    const pageTwo = pairsFrame(1, 3, "two");
    const { transport, wsCalls } = scripted({ ws: [[pageOne], [pageTwo]] });
    const result = await fetchPairsBatch(
      {
        identities: [identity("solana", "a")],
        window: "h24",
        rankKey: "RANK_BY_KEY_VOLUME",
        rankOrder: "desc",
      },
      { transport, timeoutMs: 1000 }
    );
    expect(result.rows).toHaveLength(3);
    expect(result.chunks[0]?.pagesFetched).toBe(2);
    expect(result.chunks[0]?.pairsCount).toBe(3);
    expect(pageNumberOf(wsCalls[0])).toBe(1);
    expect(pageNumberOf(wsCalls[1])).toBe(2);
  });

  it("fails rather than returning a short chunk when a page stops before pairsCount", async () => {
    const { transport } = scripted({ ws: [[pairsFrame(2, 9)], [pairsFrame(0, 9)]] });
    await expect(
      fetchPairsBatch(
        {
          identities: [identity("solana", "a")],
          window: "h24",
          rankKey: "RANK_BY_KEY_VOLUME",
          rankOrder: "desc",
        },
        { transport, timeoutMs: 1000 }
      )
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.BATCH_NO_RESULT_FRAME,
    });
  });

  it("collapses the duplicate rows the provider returns for a duplicated input", async () => {
    // The captured frame is the provider's answer to a list containing the SAME
    // ethereum pair twice: it came back as two identical rows.
    const raw = decodeDexScreenerMessageToJson(
      "dex_screener.PairsSearchChannelMessage",
      BATCH_DUP_FRAME,
      { maxBytes: 4_000_000 }
    ) as { pairs: { pairs: unknown[] } };
    expect(raw.pairs.pairs).toHaveLength(2);

    const { transport } = scripted({ ws: [[BATCH_DUP_FRAME]] });
    const result = await fetchPairsBatch(
      {
        identities: [
          identity("ethereum", "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f"),
        ],
        window: "h24",
        rankKey: "RANK_BY_KEY_VOLUME",
        rankOrder: "desc",
      },
      { transport, timeoutMs: 1000 }
    );
    expect(result.rows).toHaveLength(1);
  });

  it("records both the pair key and the base-token key, so a token input can be reconciled", async () => {
    const { transport } = scripted({ ws: [[BATCH_DUP_FRAME]] });
    const result = await fetchPairsBatch(
      {
        identities: [identity("ethereum", "0xA43fe1")],
        window: "h24",
        rankKey: "RANK_BY_KEY_VOLUME",
        rankOrder: "desc",
      },
      { transport, timeoutMs: 1000 }
    );
    expect(
      result.resolvedKeys.has("ethereum:0xa43fe16908251ee70ef74718545e4fe6c5ccec9f")
    ).toBe(true);
    expect(
      result.resolvedKeys.has("ethereum:0x6982508145454ce325ddbe47a25d4ec3d2311933")
    ).toBe(true);
  });

  it("fails the whole call when a chunk never answers, rather than returning a short list", async () => {
    const { transport } = scripted({ ws: [[], []] });
    await expect(
      fetchPairsBatch(
        {
          identities: [identity("ethereum", "0xabc")],
          window: "h24",
          rankKey: "RANK_BY_KEY_VOLUME",
          rankOrder: "desc",
        },
        { transport, timeoutMs: 1000 }
      )
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.BATCH_NO_RESULT_FRAME,
    });
  });

  it("asks for a frame budget both attempts can actually spend inside the deadline", async () => {
    // MEASURED (EP4 d1-cadence-45s): the first binary frame on this channel is
    // `pairs` at 612 ms and every later frame is a byte-identical re-send about
    // 3.2 s apart. There is no latestBlock arm here, so extra frames buy
    // nothing and are paid for in wall clock, because the transport resolves
    // only once the count is reached.
    //
    // The old 6 and 10 cost about 17 s and 30 s against the handlers' 20 s
    // CHANNEL_TIMEOUT_MS: the retry could not finish before the budget expired,
    // so any chunk that needed it timed out with the answer already in hand.
    // This test fails if someone raises the budget past what the deadline can
    // pay for.
    const CHANNEL_TIMEOUT_MS = 20_000;
    const MEASURED_FRAME_INTERVAL_MS = 3_300;
    for (const frames of [BATCH_FIRST_ATTEMPT_FRAMES, BATCH_RETRY_FRAMES]) {
      expect(frames).toBeGreaterThanOrEqual(1);
      expect(frames * MEASURED_FRAME_INTERVAL_MS).toBeLessThan(CHANNEL_TIMEOUT_MS);
    }
    // The retry must be able to see past a lead frame that is not the answer.
    expect(BATCH_RETRY_FRAMES).toBeGreaterThan(BATCH_FIRST_ATTEMPT_FRAMES);

    const { transport, wsCalls } = scripted({ ws: [[BATCH_KNOWN_FRAME]] });
    await fetchPairsBatch(
      {
        identities: [identity("ethereum", "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f")],
        window: "h24",
        rankKey: "RANK_BY_KEY_VOLUME",
        rankOrder: "desc",
      },
      { transport, timeoutMs: CHANNEL_TIMEOUT_MS }
    );
    expect(wsCalls[0]?.options.expect.binaryFrames).toBe(BATCH_FIRST_ATTEMPT_FRAMES);
  });

  it("refuses an empty identity list by name", async () => {
    const { transport } = scripted({});
    await expect(
      fetchPairsBatch(
        {
          identities: [],
          window: "h24",
          rankKey: "RANK_BY_KEY_VOLUME",
          rankOrder: "desc",
        },
        { transport, timeoutMs: 1000 }
      )
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.BATCH_NO_INPUTS,
    });
  });
});

describe("chunkIdentities", () => {
  const many: BatchIdentity[] = Array.from({ length: 301 }, (_, index) => ({
    chainId: "solana",
    id: `id-${index}`,
    kind: "pair",
    raw: `solana:id-${index}`,
  }));

  it("splits without dropping, repeating, or reordering anything", () => {
    const groups = chunkIdentities(many, 140);
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((group) => [...group])).toEqual(many);
  });

  it("rejects a chunk size that is not a positive whole number", () => {
    expect(() => chunkIdentities(many, 0)).toThrow(RangeError);
  });
});

describe("row identity helpers", () => {
  it("returns null rather than a partial key when a row has no identity", () => {
    expect(rowKey({})).toBeNull();
    expect(baseTokenKey({ chainId: "solana" })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* S8 fix round: latency, identity, bounds, classification            */
/* ------------------------------------------------------------------ */

const PAIR_SOLANA_FRAME = loadFixture("pair-ws-solana-known").bytes;
const PAIR_EMPTY_ARM_FRAME = loadFixture("pair-ws-empty-arm-unknown").bytes;
const SEARCH_LONG_NAME_BODY = loadFixture(
  "search-multiword-unbounded-issuer-text"
).bytes;
const CATALOG_BYTES = new Uint8Array(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "chains-by-trending.json"
    )
  )
);

/**
 * A transport routing by URL, for the tools that touch several endpoints in
 * one call (the chain catalog, then a channel or a search).
 *
 * `headers` is the point of several tests below: the cache observation has no
 * other evidence, so a fake that always returned an empty header map could not
 * tell a fix from a regression.
 */
function routed(routes: {
  readonly ws?: readonly Uint8Array[];
  readonly search?: { status: number; body: Uint8Array };
  readonly spotlight?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}): { readonly transport: DexScreenerTransport; readonly wsUrls: string[] } {
  const wsUrls: string[] = [];
  const headers = new Map<string, string>(
    Object.entries(routes.headers ?? {})
  );
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      const reply = (status: number, body: Uint8Array) =>
        Promise.resolve({ url, status, headers, body });
      if (url.includes("/ds-data/v2/chains/")) return reply(200, CATALOG_BYTES);
      if (url.includes("/dex/search/spotlight/")) {
        return reply(200, routes.spotlight ?? SPOTLIGHT_BODY);
      }
      if (url.includes("/dex/search/v12/pairs")) {
        const r = routes.search ?? { status: 200, body: SEARCH_BODY };
        return reply(r.status, r.body);
      }
      if (url.includes("/hype/reactions/")) return reply(404, new Uint8Array());
      return Promise.reject(new Error(`unrouted HTTP url: ${url}`));
    },
    wsExchange: (url) => {
      wsUrls.push(url);
      return Promise.resolve([...(routes.ws ?? [])]);
    },
  };
  return { transport, wsUrls };
}

async function callTool(
  toolId: string,
  params: Record<string, unknown>,
  routes: Parameters<typeof routed>[0]
): Promise<Record<string, unknown>> {
  const { transport } = routed(routes);
  const release = registerDexScreenerTransport(transport);
  try {
    const handler = DEXSCREENER_HANDLERS[toolId];
    if (handler === undefined) throw new Error(`no handler for ${toolId}`);
    const result = await handler(params, {} as never);
    if (!result.success) throw new Error(result.output);
    return JSON.parse(result.output) as Record<string, unknown>;
  } finally {
    release();
  }
}

describe("the pair channel answers in one tick, and says so by what it asks for", () => {
  /**
   * REVERT-DETECTOR for the latency defect. The old value was 6, and the
   * channel re-sends on a ~3.2 s tick, so six frames meant ~13.4 s of wall
   * clock for an answer measured present at 0.468 s. This is not a style
   * preference: `pair_get` gives one attempt 20 s, and the old retry of 10
   * frames needed ~26.2 s, so the retry could never complete.
   */
  it("asks for two frames, not six, and the retry stays inside the caller's deadline", async () => {
    const { transport, wsCalls } = scripted({ ws: [[PAIR_SOLANA_FRAME]] });
    await fetchPairSnapshot({
      chainId: "solana",
      pairAddress: "Gyz6RxJfnB3yjP2J2E7HMoNojGQEKZuxEEUjurncQJ1w",
      transport,
      timeoutMs: 20_000,
    });

    expect(PAIR_FIRST_ATTEMPT_FRAMES).toBe(2);
    expect(wsCalls[0]?.options.expect.binaryFrames).toBe(2);
    // At the measured ~3.2 s re-send tick, the retry must still fit in the
    // 20 s one attempt is given. 4 frames lands near 10 s; 10 frames landed
    // near 26.2 s and was unreachable by arithmetic.
    expect(0.5 + (PAIR_RETRY_FRAMES - 1) * 3.2).toBeLessThan(20);
  });

  it("treats the empty pair arm as the unknown-pair ANSWER: one attempt, no retry, typed failure", async () => {
    const { transport, wsCalls } = scripted({
      // Both frames of the measured live answer for an unindexed pool.
      ws: [[PAIR_EMPTY_ARM_FRAME, PAIR_EMPTY_ARM_FRAME]],
    });

    await expect(
      fetchPairSnapshot({
        chainId: "ethereum",
        pairAddress: "0x000000000000000000000000000000000000dead",
        transport,
        timeoutMs: 20_000,
      })
    ).rejects.toMatchObject({
      // The empty arm is the provider's ANSWER, so it gets its own code. The
      // behaviour under test is that it fails here, on the first attempt,
      // rather than retrying into a transport timeout.
      code: DexScreenerSiteErrorCodes.PAIR_UNKNOWN,
    });

    // THE POINT: exactly ONE exchange. The old code retried (a second 20 s
    // budget) and then reported DEXSCREENER_TRANSPORT_TIMEOUT, so "this pool
    // does not exist" reached the agent as "the provider is down", ~33 s late.
    expect(wsCalls).toHaveLength(1);
  });

  it("names the empty arm in the failure, so the answer is not reported as a missing pair frame", async () => {
    const { transport } = scripted({ ws: [[PAIR_EMPTY_ARM_FRAME]] });
    await expect(
      fetchPairSnapshot({
        chainId: "ethereum",
        pairAddress: "0x000000000000000000000000000000000000dead",
        transport,
        timeoutMs: 20_000,
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("indexes no such pool"),
      hint: expect.stringContaining("not an outage and not a timeout"),
    });
  });

  it("still retries when frames arrived and none of them was a pair arm at all", async () => {
    const { transport, wsCalls } = scripted({
      ws: [[LATEST_BLOCK_FRAME], [LATEST_BLOCK_FRAME]],
    });
    await expect(
      fetchPairSnapshot({
        chainId: "ethereum",
        pairAddress: "0xabc",
        transport,
        timeoutMs: 1000,
      })
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.PAIR_NO_SNAPSHOT_FRAME,
    });
    expect(wsCalls).toHaveLength(2);
  });
});

describe("dexscreener__pair_get: the answered pool is the one in the frame", () => {
  it("reports the frame's pairAddress, and names the provider's own choice when it differs", async () => {
    // The measured trap: the channel accepts a TOKEN address in the pool slot
    // and answers with a pool it picked. Here the caller asks for a solana
    // token address and the frame comes back describing pool Gyz6Rx...
    const tokenInPairSlot = "BKaXDgZxUSC9njpX89xpQ5USh2pnK1yzZvgk8Mg7pump";
    const data = await callTool(
      "dexscreener.pair.get",
      { chain: "solana", pairAddress: tokenInPairSlot },
      { ws: [PAIR_SOLANA_FRAME] }
    );

    expect(data["resolvedPair"]).toBe(
      "Gyz6RxJfnB3yjP2J2E7HMoNojGQEKZuxEEUjurncQJ1w"
    );
    expect(data["requestedPairAddress"]).toBe(tokenInPairSlot);
    // NOT "explicit_pair_address": the caller did not name this pool, the
    // provider chose it. The old answer published two addresses for one
    // identity and claimed the pool had been given explicitly.
    expect(data["resolutionBasis"]).toBe("provider_resolved_from_token");
    expect(String(data["resolutionNote"])).toContain(
      "picks a pool itself"
    );
  });

  it("never names frameVolumeUsd as a missing input, because this channel has no stats at all", async () => {
    // A1. The single-pair channel carries no stats block, so frameVolumeUsd is
    // ABSENT, not missing. Passing an explicit null put it in missingInputs on
    // every pair_get answer forever, which teaches a reader that the list is
    // noise and defeats the one thing the list is for.
    //
    // This asserts through the real handler, not the projection: the defect
    // lived at the CALL SITE, and the projection-level contract is proven
    // separately in screen-project.test.ts. Both halves matter, because the
    // projection can be right while the caller still passes null.
    const data = await callTool(
      "dexscreener.pair.get",
      {
        chain: "solana",
        pairAddress: "Gyz6RxJfnB3yjP2J2E7HMoNojGQEKZuxEEUjurncQJ1w",
      },
      { ws: [PAIR_SOLANA_FRAME] }
    );
    const missing = JSON.stringify(data["missingInputs"] ?? []);
    expect(missing).not.toContain("frameVolumeUsd");
    const whole = JSON.stringify(data);
    expect(whole).not.toContain("frameVolumeUsd");
  });

  it("keeps explicit_pair_address when the frame answers the pool that was asked for", async () => {
    const data = await callTool(
      "dexscreener.pair.get",
      {
        chain: "solana",
        // Lowercased on purpose: the same pool, a different spelling, and a
        // case-sensitive comparison here would invent a provider re-resolution
        // on every solana call.
        pairAddress: "gyz6rxjfnb3yjp2j2e7hmonojgqekzuxeeujurncqj1w",
      },
      { ws: [PAIR_SOLANA_FRAME] }
    );

    expect(data["resolutionBasis"]).toBe("explicit_pair_address");
    expect(data["resolvedPair"]).toBe(
      "Gyz6RxJfnB3yjP2J2E7HMoNojGQEKZuxEEUjurncQJ1w"
    );
    expect(data["resolutionNote"]).toBeUndefined();
  });

  it("a WebSocket answer reports not_cached, because no cache sits between a frame and its socket", async () => {
    const data = await callTool(
      "dexscreener.pair.get",
      {
        chain: "solana",
        pairAddress: "Gyz6RxJfnB3yjP2J2E7HMoNojGQEKZuxEEUjurncQJ1w",
      },
      { ws: [PAIR_SOLANA_FRAME], headers: { "cf-cache-status": "HIT", age: "9" } }
    );
    const observation = data["sourceObservation"] as Record<string, unknown>;
    // The catalog fetch that preceded it WAS an HTTP request with those
    // headers; they must not leak onto an answer that came off a socket.
    expect(observation["cacheState"]).toBe("not_cached");
  });
});

describe("issuer text is bounded and the bound is reported per row", () => {
  it("bounds a 34,090-character live token name and states the length the issuer wrote", async () => {
    const data = await callTool(
      "dexscreener.search",
      { query: "pepe wif hat", chain: "solana", limit: 30 },
      { search: { status: 200, body: SEARCH_LONG_NAME_BODY } }
    );

    const rows = data["rows"] as Record<string, unknown>[];
    const bounded = rows.filter((row) => row["boundedText"] !== undefined);
    expect(bounded).toHaveLength(1);

    const report = bounded[0]?.["boundedText"] as Record<string, unknown>[];
    const byField = new Map(
      report.map((entry) => [entry["field"], entry] as const)
    );
    expect(byField.get("baseTokenName")).toMatchObject({
      bounded: true,
      originalLength: 34_090,
      returnedLength: ISSUER_NAME_MAX_CHARS,
      note: "bounded, original length 34090, nothing else hidden",
    });
    expect(byField.get("baseTokenSymbol")).toMatchObject({
      bounded: true,
      originalLength: 9_575,
    });

    // The row itself carries the bounded value, and nothing pretends the text
    // ended there: no ellipsis, no marker, just the report beside it.
    expect(String(bounded[0]?.["baseTokenName"])).toHaveLength(
      ISSUER_NAME_MAX_CHARS
    );
    expect(String(bounded[0]?.["baseTokenName"]).endsWith("...")).toBe(false);

    // Every other row is untouched and says so by carrying no report at all.
    expect(rows.length - bounded.length).toBe(rows.length - 1);
  });

  it("the whole answer stops being one row's prose: the bounded reply is a fraction of the unbounded one", async () => {
    const data = await callTool(
      "dexscreener.search",
      { query: "pepe wif hat", chain: "solana", limit: 30 },
      { search: { status: 200, body: SEARCH_LONG_NAME_BODY } }
    );
    // Measured unbounded projection of this exact window: 91,531 bytes, most
    // of it one issuer's name and symbol.
    expect(JSON.stringify(data).length).toBeLessThan(60_000);
  });
});

describe("the search endpoint's two failure classes are two different remedies", () => {
  it("a deterministic 4xx is refused as an invalid request, never advertised as retryable", async () => {
    const { transport } = scripted({
      // Measured: HTTP 400 with a ZERO-BYTE body for a query the endpoint
      // will not parse.
      http: [{ status: 400, body: new Uint8Array() }],
    });
    await expect(
      searchPairs({ query: "PE", transport, timeoutMs: 1000 })
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.SEARCH_REQUEST_REFUSED,
      hint: expect.stringContaining("do not retry"),
    });
  });

  /**
   * S9-1. The deterministic-4xx branch above was written for 400 and then
   * applied to the whole 4xx range, so a 429 rate limit and a 408 told the
   * model "this is deterministic, do not retry it, change the query itself".
   * Both are statements about the connection, not about the query, and both
   * already have a transient-policy owner in `../errors.ts`/`../throttle.ts`;
   * these two pin that they are ROUTED there rather than re-classified here.
   */
  it("a 429 is a rate limit, not a verdict on the query", async () => {
    const { transport } = scripted({
      http: [{ status: 429, body: new Uint8Array() }],
    });
    await expect(
      searchPairs({ query: "PEPE", transport, timeoutMs: 1000 })
    ).rejects.toMatchObject({
      code: "DEXSCREENER_RATE_LIMITED",
      retryable: true,
      httpStatus: 429,
    });
  });

  it("a 408 is the provider timing out on a request it never read", async () => {
    const { transport } = scripted({
      http: [{ status: 408, body: new Uint8Array() }],
    });
    await expect(
      searchPairs({ query: "PEPE", transport, timeoutMs: 1000 })
    ).rejects.toMatchObject({
      code: "DEXSCREENER_TIMEOUT",
      retryable: true,
      httpStatus: 408,
    });
  });

  it("a 5xx keeps the retryable class, because it says nothing about the request", async () => {
    const { transport } = scripted({
      http: [{ status: 503, body: new Uint8Array() }],
    });
    await expect(
      searchPairs({ query: "PEPE", transport, timeoutMs: 1000 })
    ).rejects.toMatchObject({
      code: DexScreenerSiteErrorCodes.SCREEN_NO_RESULT_FRAME,
      hint: expect.stringContaining("Retry once"),
    });
  });

  it("carries the response headers out, so the caller's cache observation has evidence", async () => {
    const data = await callTool(
      "dexscreener.search",
      { query: "PEPE", chain: "solana" },
      {
        search: { status: 200, body: SEARCH_BODY },
        headers: { "cf-cache-status": "HIT", age: "3" },
      }
    );
    const observation = data["sourceObservation"] as Record<string, unknown>;
    expect(observation["cacheState"]).toBe("cache_hit");
    expect(observation["cacheAgeMs"]).toBe(3000);
  });
});

describe("dexscreener__spotlight_get: the depth the retired tools carried", () => {
  it("exposes the provider's image references under the media group, and omits them otherwise", async () => {
    const withMedia = await callTool(
      "dexscreener.spotlight",
      { fields: "media", limit: 36 },
      {}
    );
    const top = (withMedia["topBoosts"] as Record<string, unknown>[])[0];
    const profile = (
      withMedia["latestProfiles"] as Record<string, unknown>[]
    )[0];
    expect(String(top?.["tokenImageUrl"])).toContain(
      "cdn.dexscreener.com"
    );
    expect(typeof profile?.["iconId"]).toBe("string");
    expect(profile).toHaveProperty("headerId");

    const withoutMedia = await callTool(
      "dexscreener.spotlight",
      { limit: 36 },
      {}
    );
    const plainTop = (withoutMedia["topBoosts"] as Record<string, unknown>[])[0];
    // Omitted, not nulled: an absent key says "you did not ask for this".
    expect(plainTop).not.toHaveProperty("tokenImageUrl");
    expect(
      (withoutMedia["latestProfiles"] as Record<string, unknown>[])[0]
    ).not.toHaveProperty("iconId");
  });

  it("distinguishes an issuer who published an EMPTY description from one who published none", async () => {
    const data = await callTool(
      "dexscreener.spotlight",
      { feed: "latestProfiles", fields: "description", limit: 36 },
      {}
    );
    const profiles = data["latestProfiles"] as Record<string, unknown>[];

    const empty = profiles.filter(
      (row) => row["description"] === "" && row["descriptionPublished"] === true
    );
    const absent = profiles.filter(
      (row) => row["description"] === null && row["descriptionPublished"] === false
    );
    // Measured in this capture: 33 of 36 rows carry the field, 6 of them
    // empty. Before the fix all nine of "empty" plus "absent" read as null.
    expect(empty).toHaveLength(6);
    expect(absent).toHaveLength(3);
  });

  it("states the tied-rank shuffle and the recent-feed replica divergence on every answer", async () => {
    const data = await callTool("dexscreener.spotlight", {}, {});
    const window = data["providerWindow"] as Record<string, unknown>;
    const note = String(window["repeatCallNote"]);
    expect(note).toContain("reorder between reads");
    expect(note).toContain("OLDER document");
  });

  it("reads cacheState from the response headers instead of asserting freshness", async () => {
    // Measured live: the ORIGIN says `cache-control: no-store` and Cloudflare
    // serves the hop from its edge anyway, `cf-cache-status: HIT`, age 1-4 s.
    const data = await callTool(
      "dexscreener.spotlight",
      {},
      { headers: { "cf-cache-status": "HIT", age: "4", "cache-control": "no-store" } }
    );
    const observation = data["sourceObservation"] as Record<string, unknown>;
    expect(observation["cacheState"]).toBe("cache_hit");
    expect(observation["cacheAgeMs"]).toBe(4000);
  });
});
