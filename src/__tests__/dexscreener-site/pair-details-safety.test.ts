/**
 * The five safety defects Codex's final review measured on this surface,
 * each pinned against the archived document that produced it.
 *
 * Every test here is a behavioural regression rather than a shape check,
 * because every one of these defects produced an ORDINARY-LOOKING answer:
 * a supply that read as exact and was not, a listed project that read as
 * having published nothing, an invisible-character payload that read as clean
 * text, a populated honeypot verdict that read as "nothing answered", and ten
 * returned holder rows that read as an absent holder block. None of them would
 * fail a schema test, and all five reach a pre-trade decision as fact.
 */

import { afterEach, describe, expect, it } from "vitest";
import { parsePairDetails } from "@tools/dexscreener/endpoints/pair-details.js";
import { JSON_SOURCE_ACCESS_SUPPORTED } from "@tools/dexscreener/codec/json-lexemes.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";

const CHAIN = "ethereum";
const PAIR = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";
const PAIR_ROUTE = { route: "pair_id", inverted: false } as const;

const CATALOG = loadJsonFixture("chains-by-trending").bytes;
const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const DETAILS_ETH = loadJsonFixture("pair-details-ethereum-pepe").bytes;
const LISTINGS = loadJsonFixture("pair-details-solana-listings").bytes;
const INJECTED = loadJsonFixture("pair-details-listings-injected").bytes;
const POPULATED_HPI = loadJsonFixture("pair-details-populated-hpi").bytes;
const UNSAFE_LEXEME = loadJsonFixture("pair-details-unsafe-number-lexeme").bytes;

/**
 * The exact provider lexeme the unsafe-number fixture carries.
 *
 * Spelled here as well as in the fixture so a test failure names the value it
 * expected; the assertion below proves the fixture really contains it.
 */
const UNSAFE_SUPPLY_LEXEME = "12345678901234567890.123456789";

let release: (() => void) | null = null;

afterEach(() => {
  release?.();
  release = null;
});

function mount(body: Uint8Array): void {
  const transport: DexScreenerTransport = {
    name: "site_bridge",
    capabilities: { site: true, publicApi: true },
    httpGet: (url) => {
      const isCatalog = url.includes("/ds-data/") || url.includes("chains");
      return Promise.resolve({
        url,
        status: 200,
        headers: new Map([["cache-control", "public, max-age=60"]]),
        body: isCatalog ? CATALOG : body,
      });
    },
    wsExchange: () => Promise.resolve([PAIR_FRAME]),
  };
  release = registerDexScreenerTransport(transport);
}

async function call(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = DEXSCREENER_HANDLERS["dexscreener.pair.details"];
  expect(handler).toBeDefined();
  if (handler === undefined) throw new Error("no handler");
  const result = await handler(params, {} as never);
  expect(result.success, result.output).toBe(true);
  return result.data as Record<string, unknown>;
}

function parse(bytes: Uint8Array): ReturnType<typeof parsePairDetails> {
  return parsePairDetails(bytes, PAIR_ROUTE);
}

/* ------------------------------------------------------------------ */
/* D1: amounts survive as lexemes                                      */
/* ------------------------------------------------------------------ */

describe("provider amounts never cross binary floating point", () => {
  it("has the runtime support the lossless path depends on", () => {
    // Asserted directly because the failure mode is quiet: without source
    // access the parser refuses the document rather than rounding it, so every
    // pair-details call would fail for a reason that reads like a provider
    // problem. This test names the real cause.
    expect(JSON_SOURCE_ACCESS_SUPPORTED).toBe(true);
  });

  it("keeps a supply lexeme no IEEE-754 double can hold, byte for byte", () => {
    // The premise, asserted rather than assumed: a plain JSON.parse of this
    // document loses the value. If this ever stops holding the test below
    // proves nothing.
    const viaDouble = JSON.parse(new TextDecoder().decode(UNSAFE_LEXEME)) as {
      readonly su: { readonly circulatingSupply: number };
    };
    expect(String(viaDouble.su.circulatingSupply)).not.toBe(UNSAFE_SUPPLY_LEXEME);
    expect(String(viaDouble.su.circulatingSupply)).toBe("12345678901234567000");

    const supply = parse(UNSAFE_LEXEME).supply;
    expect(supply?.circulatingSupply).toBe(UNSAFE_SUPPLY_LEXEME);
    expect(supply?.totalSupply).toBe(UNSAFE_SUPPLY_LEXEME);
  });

  it("emits the exact lexeme through the real handler, under the note that promises it", async () => {
    mount(UNSAFE_LEXEME);
    const data = await call({ chain: CHAIN, pairAddress: PAIR, fields: "supply" });
    const supply = data["supply"] as Record<string, unknown>;
    expect(supply["circulatingSupply"]).toBe(UNSAFE_SUPPLY_LEXEME);
    expect(String(supply["note"])).toContain("never floating-point");
    // And the claim is checkable end to end: the serialized output the model
    // reads carries the digits, not a rounded stand-in.
    expect(JSON.stringify(data)).toContain(UNSAFE_SUPPLY_LEXEME);
    expect(JSON.stringify(data)).not.toContain("12345678901234567000");
  });

  it("keeps a real capture's fractional supply digits exactly as sent", () => {
    // Live solana capture, 2026-08-24. The numeric path is not hypothetical.
    const supply = parse(LISTINGS).supply;
    expect(supply?.totalSupply).toBe("729988329.5371597");
    expect(supply?.circulatingSupply).toBe("729988456.1814611");
  });

  it("keeps holder balances and lock amounts as lexemes too", () => {
    const parsed = parse(DETAILS_ETH);
    for (const row of parsed.goPlus?.holders ?? []) {
      // A balance that had gone through a double would be spelled in
      // exponential form or with a rounded tail. Both are caught by requiring
      // the string to be plain decimal digits.
      expect(row.balance ?? "0").toMatch(/^\d+(\.\d+)?$/);
    }
    expect(parse(LISTINGS).liquidityLocks?.rows[0]?.amount).toBe("490815.647672221");
  });

  it("still reads counts as numbers, because a count is not an amount", () => {
    expect(parse(DETAILS_ETH).goPlus?.holderCount).toBe(580_992);
  });
});

/* ------------------------------------------------------------------ */
/* D2: the CURRENT listing shapes                                      */
/* ------------------------------------------------------------------ */

describe("listing venues are parsed in the shapes they actually send", () => {
  it("reads CoinGecko websites and socials from OBJECT rows, not string arrays", () => {
    const cg = parse(LISTINGS).listings.find((entry) => entry.venue === "coingecko");
    expect(cg?.websites).toEqual([
      { url: "https://cyberleek.ar.io/", label: "cyberleek.ar.io", kind: "website" },
    ]);
    expect(cg?.socials).toEqual([
      { url: "https://twitter.com/cyberleek_ar_io", label: null, kind: "Twitter" },
    ]);
    expect(cg?.categories.map((entry) => entry.name)).toEqual([
      "Solana Ecosystem",
      "Meme",
      "Solana Meme",
    ]);
  });

  it("reads CoinMarketCap tags from OBJECT rows and keeps their slug and group", () => {
    const cmc = parse(LISTINGS).listings.find(
      (entry) => entry.venue === "coinmarketcap"
    );
    expect(cmc?.categories).toEqual([
      { name: "Memes", slug: "memes", group: "INDUSTRY" },
      { name: "Solana Ecosystem", slug: "solana-ecosystem", group: "PLATFORM" },
    ]);
  });

  it("splits the CoinMarketCap urls map by group and drops none of it", () => {
    const cmc = parse(LISTINGS).listings.find(
      (entry) => entry.venue === "coinmarketcap"
    );
    expect(cmc?.websites.map((link) => link.url)).toEqual(["https://cyberleek.ar.io/"]);
    expect(cmc?.socials.map((link) => link.kind)).toEqual(["twitter"]);
    // An explorer link is neither a website nor a social, and used to vanish.
    expect(cmc?.otherLinks).toEqual([
      {
        url: "https://solscan.io/token/ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
        label: null,
        kind: "explorer",
      },
    ]);
  });

  it("still accepts the plain-string form, so a venue reverting cannot empty the block", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        cg: {
          id: "x",
          websites: ["https://a.example/"],
          social: ["https://x.com/a"],
          categories: ["Meme"],
        },
      })
    );
    const cg = parse(body).listings[0];
    expect(cg?.websites).toEqual([
      { url: "https://a.example/", label: null, kind: "website" },
    ]);
    expect(cg?.socials).toEqual([{ url: "https://x.com/a", label: null, kind: null }]);
    expect(cg?.categories).toEqual([{ name: "Meme", slug: null, group: null }]);
  });

  it("names every venue field it does not project instead of dropping it", () => {
    const cg = parse(LISTINGS).listings.find((entry) => entry.venue === "coingecko");
    expect(cg?.unprojectedKeys).toContain("imageUrl");
  });

  it("reaches the model: the handler emits the links rather than empty arrays", async () => {
    mount(LISTINGS);
    const data = await call({ chain: CHAIN, pairAddress: PAIR, fields: "listings" });
    const listings = data["listings"] as readonly Record<string, unknown>[];
    const cg = listings.find((entry) => entry["venue"] === "coingecko");
    expect((cg?.["websites"] as readonly unknown[]).length).toBe(1);
    expect((cg?.["socials"] as readonly unknown[]).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* D3: every emitted external string is sanitized AND reported          */
/* ------------------------------------------------------------------ */

/**
 * The removal set, spelled as code points.
 *
 * Built from numbers for the same reason the implementation's table is: a test
 * fixture made of invisible characters cannot be reviewed in a diff.
 */
const INVISIBLE = /[\u{00ad}\u{180e}\u{200b}\u{200c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e0001}\u{e0020}-\u{e007f}]/u;

/** Every string anywhere in the emitted answer, with its path. */
function everyString(value: unknown, path: string): readonly (readonly [string, string])[] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => everyString(entry, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      everyString(entry, path === "" ? key : `${path}.${key}`)
    );
  }
  return [];
}

describe("no invisible character reaches the model unreported", () => {
  it("strips BiDi and zero-width payloads from listing urls, not only from prose", async () => {
    mount(INJECTED);
    const data = await call({ chain: CHAIN, pairAddress: PAIR, fields: "listings" });

    // The fixture really carries the payload: without this the test could pass
    // on a fixture that lost its invisible characters in an editor.
    const rawText = new TextDecoder().decode(INJECTED);
    expect(INVISIBLE.test(rawText)).toBe(true);

    for (const [path, text] of everyString(data, "")) {
      expect(INVISIBLE.test(text), `${path} carries an invisible character`).toBe(false);
    }
  });

  it("names the url fields it cleaned, so the removal is auditable", async () => {
    mount(INJECTED);
    const data = await call({ chain: CHAIN, pairAddress: PAIR, fields: "listings" });
    const fields = data["sanitizedFields"] as readonly string[];
    // The two fields that were silently passed through raw before.
    expect(fields).toContain("listings.coinmarketcap.websites[0].url");
    expect(fields).toContain("listings.coinmarketcap.socials[0].url");
    // And the two that were already covered, so the fix widened coverage
    // rather than moving it.
    expect(fields).toContain("listings.coinmarketcap.name");
    expect(fields).toContain("listings.coinmarketcap.description");
  });

  it("keeps every visible character of the cleaned url", async () => {
    mount(INJECTED);
    const data = await call({ chain: CHAIN, pairAddress: PAIR, fields: "listings" });
    const listings = data["listings"] as readonly Record<string, unknown>[];
    const cmc = listings.find((entry) => entry["venue"] === "coinmarketcap");
    const websites = cmc?.["websites"] as readonly Record<string, unknown>[];
    // Sanitization is never a length bound: only the unrenderable character
    // between "visi" and "ble" was removed.
    expect(websites[0]?.["url"]).toBe("https://example.com/visible");
  });
});

/* ------------------------------------------------------------------ */
/* D4: a populated block this tool cannot read is never hidden          */
/* ------------------------------------------------------------------ */

describe("populated hpi and ti blocks are declared, never counted as answered", () => {
  it("reports a populated hpi block with its size and its field names", () => {
    const parsed = parse(POPULATED_HPI);
    const hpi = parsed.presentButUnprojected.find((entry) => entry.key === "hpi");
    expect(hpi?.source).toBe("honeypot.is");
    expect(hpi?.reason).toBe("shape_never_measured");
    expect(hpi?.rawBytes).toBeGreaterThan(0);
    expect(hpi?.keys).toEqual([
      "buyTax",
      "holderCount",
      "isHoneypot",
      "isOpenSource",
      "sellTax",
    ]);
    // It is not an answered block, and it does not make the document all-null.
    expect(parsed.allBlocksNull).toBe(false);
    expect(parsed.coverage.every((entry) => !entry.present)).toBe(true);
  });

  it("says so in the summary the model reads first", async () => {
    mount(POPULATED_HPI);
    const data = await call({ chain: CHAIN, pairAddress: PAIR });
    const summary = String(data["summary"]);
    expect(summary).toContain("hpi");
    expect(summary).toContain("cannot read");
    expect(summary).toContain("not counted as answered");
    const availability = data["availability"] as Record<string, unknown>;
    const listed = availability["presentButUnprojected"] as readonly Record<
      string,
      unknown
    >[];
    expect(listed.map((entry) => entry["key"])).toEqual(["hpi"]);
    expect(String(availability["presentButUnprojectedNote"])).toContain(
      "unknown rather than clean"
    );
  });

  it("reports a block it DOES read that returned nothing, with the other reason", () => {
    // `ta` with no solana sub-object: the projection reads this key and got
    // nothing out of it, which means the shape moved rather than that it was
    // never measured. The two need different fixes, so they are named apart.
    const body = new TextEncoder().encode(JSON.stringify({ ta: { aptos: {} } }));
    const entry = parse(body).presentButUnprojected.find((row) => row.key === "ta");
    expect(entry?.reason).toBe("projection_returned_nothing");
    expect(entry?.keys).toEqual(["aptos"]);
  });

  it("keeps an all-null document all-null: nothing populated, nothing declared", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ gp: null, hpi: null, ti: null, ts: null, su: null })
    );
    const parsed = parse(body);
    expect(parsed.allBlocksNull).toBe(true);
    expect(parsed.presentButUnprojected).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* D5: holder coverage names its source                                 */
/* ------------------------------------------------------------------ */

describe("holder coverage distinguishes the native block from GoPlus", () => {
  it("reports the GoPlus holder rows as present on a response that carries them", () => {
    const coverage = parse(DETAILS_ETH).coverage;
    const byBlock = new Map(coverage.map((entry) => [entry.block, entry.present]));
    // Ten GoPlus token holders and ten GoPlus LP holders arrived in this
    // document. The single `holders` row used to report them as absent.
    expect(byBlock.get("holders.goplus")).toBe(true);
    expect(byBlock.get("lpHolders.goplus")).toBe(true);
    expect(byBlock.get("holders.native")).toBe(false);
    expect(byBlock.get("lpHolders.native")).toBe(false);
    expect(byBlock.has("holders")).toBe(false);
  });

  it("reports the mirror case on the Solana class: native present, GoPlus absent", () => {
    const byBlock = new Map(
      parse(LISTINGS).coverage.map((entry) => [entry.block, entry.present])
    );
    expect(byBlock.get("holders.native")).toBe(true);
    expect(byBlock.get("lpHolders.native")).toBe(true);
    expect(byBlock.get("holders.goplus")).toBe(false);
  });

  it("makes availability agree with the holder rows the answer actually returns", async () => {
    mount(DETAILS_ETH);
    const data = await call({ chain: CHAIN, pairAddress: PAIR, fields: "holders" });
    const availability = data["availability"] as Record<string, unknown>;
    const present = availability["presentBlocks"] as readonly string[];
    const absent = availability["absentBlocks"] as readonly string[];
    const token = (data["holders"] as Record<string, unknown>)["token"] as Record<
      string,
      unknown
    >;
    expect(token["source"]).toBe("goplus");
    expect(token["rowsCovered"]).toBe(10);
    // The contradiction Codex measured: rows returned, block reported absent.
    expect(present).toContain("holders.goplus");
    expect(absent).not.toContain("holders.goplus");
    expect(absent).toContain("holders.native");
  });
});
