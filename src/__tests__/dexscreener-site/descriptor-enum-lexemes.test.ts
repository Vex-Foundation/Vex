/**
 * Every protobuf enum lexeme this surface EMITS, resolved against the
 * checked-in descriptor set.
 *
 * Rule 10 ("Live Provider Verification"), item 2: wire names come from machine
 * artifacts, never convention. Every enum member the code emits is read from
 * the checked-in descriptor or schema artifact, and a table test enumerates
 * all of them against that artifact. A hand-spelled wire name is a defect even
 * when it happens to be correct.
 *
 * This gate exists because convention lost to the descriptor once already, in
 * production: `sortBy: "marketCap"` on `dexscreener__pairs_batch_get` was
 * spelled `RANK_BY_KEY_MARKET_CAP` from habit while the descriptor says
 * `RANK_BY_KEY_MARKETCAP`. The command could not be built at all, so the tool
 * answered "a dex_screener.PairsSearchChannelCommand command could not be
 * built ... Nothing was sent" for a value its own manifest advertised and its
 * own runtime gate accepted. Nothing in the suite covered it: the four other
 * rank keys were exercised, the fifth was not, and a green run proved only
 * that the tested four were right.
 *
 * Two complementary halves, because either alone is escapable:
 *
 *   1. TABLE: the exported lookup tables are enumerated member by member. This
 *      is the direct guard on the tables a reviewer would think to check.
 *   2. SCAN: every enum-shaped string literal in the namespace's production
 *      source is resolved against the descriptor, whatever file it lives in.
 *      This is what makes the gate hold for wire names that are written inline
 *      rather than tabulated, and for tables added after this test was
 *      written. Half 1 cannot catch a new literal in a new file; half 2 can.
 *
 * The expectations are DERIVED from the descriptor at run time - no enum
 * member is transcribed into this file - so the gate cannot drift from the
 * artifact it checks. When the provider genuinely adds a member, the registry
 * gains it and this test keeps passing; when we invent one, it fails.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getDexScreenerProtoRegistry } from "../../tools/dexscreener/codec/protobuf.js";
import {
  BATCH_PRICE_CHANGE_RANK_KEYS,
  BATCH_RANK_KEYS,
} from "../../vex-agent/tools/protocols/dexscreener/handlers/resolve.js";

const REPO_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

/** The production trees that build DexScreener wire commands. */
const SOURCE_ROOTS = [
  path.join(REPO_SRC, "tools/dexscreener"),
  path.join(REPO_SRC, "vex-agent/tools/protocols/dexscreener"),
];

/* ------------------------------------------------------------------ */
/* The descriptor set, reduced to what a wire name must satisfy        */
/* ------------------------------------------------------------------ */

/** Enum type name -> its member names, straight from the checked-in registry. */
function enumsFromRegistry(): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const type of getDexScreenerProtoRegistry()) {
    if (type.kind !== "enum") continue;
    if (type.typeName.startsWith("google.protobuf.")) continue;
    out.set(
      type.typeName,
      new Set(type.values.map((value) => value.name))
    );
  }
  return out;
}

/**
 * The shared prefix of an enum's members, e.g. `RANK_BY_KEY_`.
 *
 * protobuf convention prefixes every member with its type's screaming-snake
 * name, which is what lets a bare string literal in the source be attributed
 * to an enum without knowing the call site's type. Cut at the last underscore
 * so the prefix is a whole set of words, never half of one.
 */
function sharedPrefix(members: ReadonlySet<string>): string | null {
  const names = [...members];
  const first = names[0];
  if (first === undefined || names.length < 2) return null;
  let end = first.length;
  for (const name of names) {
    let index = 0;
    while (index < end && index < name.length && name[index] === first[index]) {
      index += 1;
    }
    end = index;
  }
  const cut = first.slice(0, end).lastIndexOf("_");
  return cut <= 0 ? null : first.slice(0, cut + 1);
}

/**
 * Prefix -> every member of every enum carrying it.
 *
 * A union rather than a single enum because two nested `...Type` enums share
 * the bare `TYPE_` prefix (`Swap.Type` and `JoinExit.Type`). Attributing a
 * literal to "some enum with this prefix" still catches a misspelling, which
 * is what this gate is for, and it never has to guess which of the two a given
 * call site meant.
 */
function membersByPrefix(
  enums: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const members of enums.values()) {
    const prefix = sharedPrefix(members);
    if (prefix === null) continue;
    const bucket = out.get(prefix) ?? new Set<string>();
    for (const member of members) bucket.add(member);
    out.set(prefix, bucket);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* What the source actually emits                                      */
/* ------------------------------------------------------------------ */

/**
 * Every string-literal VALUE in a TypeScript source, comments excluded.
 *
 * Hand-written rather than regex-driven because the two things that must not
 * be confused here are a wire name and prose ABOUT a wire name: the doctrine
 * comment beside the corrected rank table quotes the wrong old spelling
 * `RANK_BY_KEY_MARKET_CAP` on purpose, to record what went wrong, and a regex
 * over raw text would read that comment as an emitted lexeme and fail the
 * build for documenting the bug it guards. Tracking string, template and
 * comment state is what keeps "emitted" and "discussed" apart.
 */
function stringLiterals(source: string): readonly string[] {
  const out: string[] = [];
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      let value = "";
      while (index < length && source[index] !== quote) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      out.push(value);
      continue;
    }
    index += 1;
  }
  return out;
}

function sourceFiles(root: string): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (statSync(full).size > 4 * 1024 * 1024) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

/* ------------------------------------------------------------------ */

describe("DexScreener protobuf enum lexemes match the checked-in descriptor", () => {
  const enums = enumsFromRegistry();
  const byPrefix = membersByPrefix(enums);

  it("the descriptor set actually carries the enums this gate reads", () => {
    // Without this, every assertion below could pass vacuously against an
    // empty registry, which is the failure mode a schema-comparison test is
    // most likely to have and least likely to notice.
    expect(enums.size).toBeGreaterThan(0);
    expect(byPrefix.size).toBeGreaterThan(0);
    expect([...enums.keys()]).toContain("dex_screener_schema.RankByKey");
    const rankKeys = enums.get("dex_screener_schema.RankByKey");
    expect(rankKeys?.size ?? 0).toBeGreaterThan(1);
  });

  it("every batch rank key resolves to a real RankByKey member", () => {
    const rankKeys = enums.get("dex_screener_schema.RankByKey");
    expect(rankKeys).toBeDefined();
    const table = Object.entries(BATCH_RANK_KEYS);
    // The whole advertised vocabulary, not a sample: the defect this guards
    // was the ONE key of five that no test exercised.
    expect(table.length).toBeGreaterThan(0);
    for (const [param, wireName] of table) {
      expect(
        rankKeys?.has(wireName),
        `BATCH_RANK_KEYS.${param} emits "${wireName}", which is not a member of dex_screener_schema.RankByKey`
      ).toBe(true);
    }
  });

  it("every windowed price-change rank key resolves to a real RankByKey member", () => {
    const rankKeys = enums.get("dex_screener_schema.RankByKey");
    const table = Object.entries(BATCH_PRICE_CHANGE_RANK_KEYS);
    expect(table.length).toBeGreaterThan(0);
    for (const [window, wireName] of table) {
      expect(
        rankKeys?.has(wireName),
        `BATCH_PRICE_CHANGE_RANK_KEYS.${window} emits "${wireName}", which is not a member of dex_screener_schema.RankByKey`
      ).toBe(true);
    }
  });

  it("every enum-shaped literal in the namespace source is a descriptor member", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(root)) {
        for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
          for (const [prefix, members] of byPrefix) {
            if (!literal.startsWith(prefix)) continue;
            checked += 1;
            if (!members.has(literal)) {
              offenders.push(
                `${path.relative(REPO_SRC, file)}: "${literal}" is not a member of any enum with prefix ${prefix}`
              );
            }
          }
        }
      }
    }
    // A scan that matched nothing would pass while proving nothing.
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toStrictEqual([]);
  });
});
