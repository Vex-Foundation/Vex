/**
 * The `param-alias` rule.
 *
 * The rule exists because an alias is the one field in a manifest that can make
 * the boundary accept a key the schema does not declare. Each branch below is a
 * way that power goes wrong: a spelling the convention never retired (a second
 * vocabulary invented by one manifest), a collision with a live key (the rewrite
 * would overwrite a value the caller deliberately sent), the same alias on two
 * params (the rewrite's target would depend on declaration order), and a missing
 * removal condition (rule 03: a shim that never gets removed).
 */

import { describe, it, expect } from "vitest";

import { lintParamAliases, type LintParam } from "@vex-agent/tools/protocols/_manifest-lint/rules.js";

function param(overrides: Partial<LintParam> & Pick<LintParam, "key">): LintParam {
  return {
    type: "string",
    description: "A fixture param used only to pin the alias rule.",
    required: false,
    ...overrides,
  };
}

const REMOVE_AFTER = "D5 owner acceptance.";

describe("lintParamAliases", () => {
  it("accepts a retired spelling with a removal condition", () => {
    const issues = lintParamAliases("test.tool", [
      param({ key: "walletFamily", aliases: [{ key: "wallet", removeAfter: REMOVE_AFTER }] }),
    ]);

    expect(issues).toEqual([]);
  });

  it("accepts a tool that declares no alias at all", () => {
    expect(lintParamAliases("test.tool", [param({ key: "walletFamily" })])).toEqual([]);
  });

  it("refuses an alias that is not a retired spelling", () => {
    const issues = lintParamAliases("test.tool", [
      param({ key: "walletFamily", aliases: [{ key: "purse", removeAfter: REMOVE_AFTER }] }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe("param-alias");
    expect(issues[0].detail).toBe("purse");
    expect(issues[0].message).toContain("not a RETIRED spelling");
    expect(issues[0].message).toContain("BANNED_PARAM_KEYS");
  });

  it("refuses an alias that is a CANONICAL key of its own", () => {
    const issues = lintParamAliases("test.tool", [
      param({ key: "walletFamily", aliases: [{ key: "limit", removeAfter: REMOVE_AFTER }] }),
    ]);

    // `limit` is canonical and not banned, so it trips both membership branches.
    expect(issues.map((i) => i.message).join(" ")).toContain("which is CANONICAL");
  });

  it("refuses an alias that collides with a live key of the same tool", () => {
    const issues = lintParamAliases("test.tool", [
      param({ key: "walletFamily", aliases: [{ key: "address", removeAfter: REMOVE_AFTER }] }),
      param({ key: "address" }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("also declares as a real param");
  });

  it("refuses the same alias declared on two params", () => {
    const issues = lintParamAliases("test.tool", [
      param({ key: "walletFamily", aliases: [{ key: "wallet", removeAfter: REMOVE_AFTER }] }),
      param({ key: "walletAddress", aliases: [{ key: "wallet", removeAfter: REMOVE_AFTER }] }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("declared twice");
    expect(issues[0].message).toContain("declaration order");
  });

  it("refuses an alias with a blank removal condition", () => {
    const issues = lintParamAliases("test.tool", [
      param({ key: "walletFamily", aliases: [{ key: "wallet", removeAfter: "   " }] }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("removeAfter");
  });
});
