/**
 * The shared `response_format` vocabulary (owner ruling D17).
 *
 * WHAT IS AT RISK: this module replaced six inline enum declarations and three
 * separate read mechanisms with one contract. The failure mode consolidation
 * introduces is a silently changed DEFAULT or a collapsed state - in
 * particular, treating "retired" as "absent", which is precisely the silent
 * drop `TwitterAccount`'s by-name rejection exists to prevent.
 *
 * So this file asserts the four states through the module's public surface,
 * and the per-tool defaults are asserted at their own handlers (the wallet,
 * long-memory and mission suites), where the real read happens.
 */

import { describe, it, expect } from "vitest";

import {
  RESPONSE_FORMATS,
  RESPONSE_FORMAT_PARAM_KEY,
  RETIRED_RESPONSE_FORMAT_PARAM,
  readResponseFormat,
  rejectRetiredResponseFormat,
  responseFormatParam,
  responseFormatSchema,
} from "@vex-agent/response-format.js";

describe("response_format vocabulary", () => {
  it("advertises exactly the two accepted values, in manifest order", () => {
    expect(RESPONSE_FORMATS).toEqual(["concise", "detailed"]);
    expect(RESPONSE_FORMAT_PARAM_KEY).toBe("response_format");
  });
});

describe("responseFormatParam - the manifest fragment (states 1 and 2)", () => {
  it("names the tool's default and what the other format changes", () => {
    const param = responseFormatParam({
      default: "concise",
      whatDetailedAdds: "adds the full body",
    });

    expect(param.type).toBe("string");
    expect(param.enum).toEqual(["concise", "detailed"]);
    // The default must be readable from the description itself: the JSON
    // schema has no `default` keyword here, so the sentence is the only place
    // the model learns what a bare call returns.
    expect(param.description).toContain("Default 'concise'");
    expect(param.description).toContain("adds the full body");
  });

  it("carries the detailed default verbatim for the ratified exception", () => {
    const param = responseFormatParam({
      default: "detailed",
      whatDetailedAdds: "returns every row",
    });
    expect(param.description).toContain("Default 'detailed'");
    expect(param.description).not.toContain("Default 'concise'");
  });

  it("hands back a fresh, mutable enum array per call", () => {
    // The JSON-schema property type wants `string[]`, and two manifests must
    // never share one array instance that a later projection could mutate.
    const first = responseFormatParam({ default: "concise", whatDetailedAdds: "x" });
    const second = responseFormatParam({ default: "concise", whatDetailedAdds: "x" });
    expect(first.enum).not.toBe(second.enum);
    expect(first.enum).not.toBe(RESPONSE_FORMATS);
  });
});

describe("responseFormatSchema - the Zod fragment", () => {
  it("resolves an absent value to the tool's default, either way round", () => {
    expect(responseFormatSchema("concise").parse(undefined)).toBe("concise");
    expect(responseFormatSchema("detailed").parse(undefined)).toBe("detailed");
  });

  it("accepts both declared values unchanged", () => {
    expect(responseFormatSchema("detailed").parse("concise")).toBe("concise");
    expect(responseFormatSchema("concise").parse("detailed")).toBe("detailed");
  });

  it("REJECTS an unrecognised value rather than falling back to the default", () => {
    // A schema site can afford to be strict, and must be: silently answering a
    // `response_format: "verbose"` call with the default would tell the model
    // its knob worked.
    expect(responseFormatSchema("concise").safeParse("verbose").success).toBe(false);
    expect(responseFormatSchema("concise").safeParse(7).success).toBe(false);
  });
});

describe("readResponseFormat - the raw-params reader for .strict() handlers", () => {
  it("returns the declared value when the caller supplied one", () => {
    expect(readResponseFormat({ response_format: "detailed" }, "concise")).toBe("detailed");
    expect(readResponseFormat({ response_format: "concise" }, "detailed")).toBe("concise");
  });

  it("falls back to the default when absent, non-string, or unrecognised", () => {
    // This tolerance is the PRE-EXISTING contract at all three raw-read sites
    // (`enumField(...) ?? default`), preserved deliberately: consolidating the
    // vocabulary must not quietly tighten validation on live tools. The strict
    // reading lives at the schema sites above.
    expect(readResponseFormat({}, "concise")).toBe("concise");
    expect(readResponseFormat({ response_format: "verbose" }, "concise")).toBe("concise");
    expect(readResponseFormat({ response_format: 3 }, "detailed")).toBe("detailed");
    expect(readResponseFormat({ response_format: null }, "detailed")).toBe("detailed");
  });

  it("does not mutate the params object it reads", () => {
    const params = { response_format: "detailed", id: 4 };
    readResponseFormat(params, "concise");
    expect(params).toEqual({ response_format: "detailed", id: 4 });
  });
});

describe("rejectRetiredResponseFormat - state 4, retired and refused BY NAME", () => {
  const options = { tool: "TwitterAccount", reason: "There is one response shape now." };

  it("refuses the param whatever its value, naming it and the tool", () => {
    for (const value of ["concise", "detailed", "verbose", "", null, 0]) {
      const message = rejectRetiredResponseFormat({ response_format: value }, options);
      expect(message).toBeDefined();
      expect(message).toContain("response_format");
      expect(message).toContain("TwitterAccount");
      // The tool's own evidence survives the move into the shared mechanism.
      expect(message).toContain("There is one response shape now.");
      expect(message).toContain("Remove the parameter.");
    }
  });

  it("refuses on PRESENCE, even when the value is undefined", () => {
    // `{response_format: undefined}` is a caller that sent the key. A value
    // check would let it through and answer as if nothing had been asked.
    expect(rejectRetiredResponseFormat({ response_format: undefined }, options)).toBeDefined();
  });

  it("says nothing when the caller did not send the param", () => {
    expect(rejectRetiredResponseFormat({}, options)).toBeUndefined();
    expect(rejectRetiredResponseFormat({ action: "user_details" }, options)).toBeUndefined();
  });

  it("keys off the same param name the offering tools declare", () => {
    // State 3 (does not offer) and state 4 (retired) are different states, and
    // they are about the SAME key: if these ever diverged, a retired tool would
    // stop recognising the spelling the model was taught elsewhere.
    expect(RETIRED_RESPONSE_FORMAT_PARAM).toBe(RESPONSE_FORMAT_PARAM_KEY);
  });
});
