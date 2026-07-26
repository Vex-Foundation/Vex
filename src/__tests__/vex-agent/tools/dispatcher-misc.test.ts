import { describe, it, expect } from "vitest";
import "./_dispatcher-test-mocks.js";
import { makeTestContext } from "./_test-context.js";

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const baseContext = makeTestContext();

describe("dispatcher — wallet, unknown, no-stubs", () => {
  // ── Wallet ───────────────────────────────────────────────────────

  it("routes wallet_balances to live handler (not stub)", async () => {
    const result = await dispatchTool(
      { name: "wallet_balances", args: { wallet: "eip155" }, toolCallId: "call_14" },
      baseContext,
    );

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.wallets[0].wallet).toBe("eip155");
    expect(parsed.wallets[0].address).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(result.output).not.toContain("[STUB]");
  });

  it("routes Khalani internal read aliases through live handlers", async () => {
    const result = await dispatchTool(
      { name: "khalani_chains_list", args: {}, toolCallId: "call_14b" },
      baseContext,
    );

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.chains).toBeGreaterThan(0);
    expect(result.output).not.toContain("[STUB]");
  });

  // ── Approval gate (mutating + restricted + !approved) ────────────

  it("wallet_send_confirm under restricted + unapproved → pendingApproval (handler not reached; FINDING-security-005 mutating-gate class)", async () => {
    // baseContext = makeTestContext() → restricted + approved:false. The
    // dispatcher's mutating-tool gate must fire BEFORE the credential derive.
    // Canonical regression for the restricted-mode mutating-approval gate (the
    // FINDING-security-005 class) — `mutating:true` tools must surface an
    // approval card instead of reaching their handler under restricted+unapproved.
    const result = await dispatchTool(
      { name: "wallet_send_confirm", args: {}, toolCallId: "call_send_confirm" },
      baseContext,
    );

    expect(result.pendingApproval).toBe(true);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/approval/i);
  });

  // ── Unknown tool ─────────────────────────────────────────────────

  it("returns error for completely unknown tool", async () => {
    const result = await dispatchTool(
      { name: "nonexistent_tool", args: {}, toolCallId: "call_15" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool");
  });

  it("rejects the retired memory-manage name as unknown tool (name built from parts for the S9 grep gate)", async () => {
    const result = await dispatchTool(
      { name: ["memory", "manage"].join("_"), args: { action: "list" }, toolCallId: "call_15b" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool");
  });

  it("rejects the retired legacy knowledge/memory tool names as unknown (S9 cutover, names from parts)", async () => {
    const retired = [
      ["knowledge", "write"].join("_"),
      ["knowledge", "recall"].join("_"),
      ["memory", "recall"].join("_"),
      ["mark", "outstanding", "resolved"].join("_"),
    ];
    for (const name of retired) {
      const result = await dispatchTool(
        { name, args: {}, toolCallId: `retired_${name}` },
        baseContext,
      );
      expect(result.success, name).toBe(false);
      expect(result.output, name).toContain("Unknown tool");
    }
  });

  // ── No stubs remaining ──────────────────────────────────────────

  it("no internal tool returns [STUB]", async () => {
    const internalTools = [
      { name: "web_research", args: { query: "test" } },
      { name: "web_research", args: { url: "https://example.com" } },
      { name: "long_memory_get", args: { id: 1 } },
      { name: "long_memory_history", args: { id: 1 } },
    ];

    for (const tool of internalTools) {
      const result = await dispatchTool(
        { name: tool.name, args: tool.args, toolCallId: `stub_check_${tool.name}` },
        baseContext,
      );
      expect(result.output).not.toContain("[STUB]");
    }
  });
});
