/**
 * The `instructions` size lints, BOTH bounds (stage A4a, spec item 4).
 *
 * These are the only two numbers in the plan that a wording edit can break
 * without anybody noticing, because the string is delivered once at handshake
 * and never rendered inside Vex. So both are asserted here, on the authored
 * text, before it can reach a client.
 *
 * The exact instruction BYTES on both eras (legacy `initialize` and the modern
 * discovery path) are stage A4a-2's test: they need the server and the
 * transport, which this pass does not build.
 */

import { describe, it, expect } from "vitest";

import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import {
  CANONICAL_HUMAN_AMOUNT_SENTENCE,
  CANONICAL_RAW_AMOUNT_SENTENCE,
} from "@vex-agent/tools/protocols/conventions.js";
import {
  STUDIO_MCP_INSTRUCTIONS,
  STUDIO_SAFETY_PREFIX,
  STUDIO_INSTRUCTIONS_MAX_BYTES,
  STUDIO_SAFETY_PREFIX_MAX_CHARS,
} from "@vex-agent/mcp/instructions.js";

describe("the studio MCP instructions", () => {
  it("keeps the safety prefix within 512 characters", () => {
    expect(STUDIO_SAFETY_PREFIX.length).toBeLessThanOrEqual(
      STUDIO_SAFETY_PREFIX_MAX_CHARS,
    );
  });

  it("keeps the whole string within the 2000-byte budget (O23)", () => {
    expect(Buffer.byteLength(STUDIO_MCP_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(
      STUDIO_INSTRUCTIONS_MAX_BYTES,
    );
  });

  it("opens with the safety prefix, so a head-only reader gets all three rules", () => {
    // The bound is worth nothing if the prefix is not actually first: a client
    // that shows or forwards the first 512 characters must receive the approval
    // rule, the quote-before-execute rule and the decimals rule, whole.
    expect(STUDIO_MCP_INSTRUCTIONS.startsWith(STUDIO_SAFETY_PREFIX)).toBe(true);
    const head = STUDIO_MCP_INSTRUCTIONS.slice(0, STUDIO_SAFETY_PREFIX_MAX_CHARS);
    expect(head).toMatch(/APPROVAL:/);
    expect(head).toMatch(/QUOTE FIRST:/);
    expect(head).toMatch(/AMOUNTS:/);
  });

  it("states that Vex moves real funds before it states anything else", () => {
    expect(STUDIO_MCP_INSTRUCTIONS).toMatch(/^Vex moves REAL funds/);
  });

  it("is GENERIC: no per-project or per-permission content", () => {
    // `instructions` are sent once at handshake; a project's permission and
    // wallet selection can change at any moment afterwards. Naming the current
    // value here would put a stale authorization claim in front of the agent,
    // which is exactly what the per-call scope snapshot exists to prevent.
    //
    // The words `restricted` and `permission` DO appear, describing how the
    // mechanism works. What must never appear is an interpolation: the string is
    // a module constant with no template holes and no parameters.
    expect(STUDIO_MCP_INSTRUCTIONS).not.toMatch(/\$\{/);
    expect(STUDIO_MCP_INSTRUCTIONS).not.toMatch(/\bproject id\b|\bprojectId\b/i);
    expect(STUDIO_MCP_INSTRUCTIONS).not.toMatch(/0x[0-9a-fA-F]{8,}/);
    // "read fresh on every call" is the honest description of the mechanism and
    // is what makes the text safe to send once.
    expect(STUDIO_MCP_INSTRUCTIONS).toMatch(/read fresh on every call/);
  });

  it("is ASCII, so no client re-encodes it", () => {
    expect(STUDIO_MCP_INSTRUCTIONS).toMatch(/^[\x20-\x7E\n]+$/);
    // ASCII means the character bound and the byte bound measure the same text.
    expect(Buffer.byteLength(STUDIO_MCP_INSTRUCTIONS, "utf8")).toBe(
      STUDIO_MCP_INSTRUCTIONS.length,
    );
  });

  it("names vex_ToolSearch exactly as the inventory exports it", () => {
    expect(STUDIO_MCP_INSTRUCTIONS).toContain("vex_ToolSearch");
  });
});

/**
 * THE MIXED-UNIT PIN (money path).
 *
 * The exported surface carries BOTH unit styles, so a server-wide "send raw
 * integer amounts" rule is not a simplification, it is a 10^6 error waiting to
 * be made in a full-permission project. These cases read the LIVE registry
 * descriptions rather than restating them, so a drift in either direction -
 * a human field re-documented as raw, a raw field re-documented as human, or
 * the instructions reverting to one global rule - fails here.
 */
function exportedParamDescription(publicName: string, param: string): string {
  const tool = buildStudioInventory().find((item) => item.publicName === publicName);
  if (tool === undefined) throw new Error(`${publicName} is not exported`);
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> })
    .properties;
  const field = properties?.[param] as { description?: string } | undefined;
  const description = field?.description;
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`${publicName}.${param} has no description`);
  }
  return description;
}

describe("the exported surface is MIXED-UNIT, and the instructions say so", () => {
  it("pins WalletSendPrepare.amountIn as a HUMAN decimal field", () => {
    expect(exportedParamDescription("WalletSendPrepare", "amountIn")).toContain(
      CANONICAL_HUMAN_AMOUNT_SENTENCE,
    );
  });

  it("pins RAW-unit fields on the SAME exported surface", () => {
    // The two conventions reach one agent through one `tools/list`, which is
    // why a server-wide unit rule cannot be true.
    expect(exportedParamDescription("khalani__bridge_execute", "amountRaw")).toContain(
      CANONICAL_RAW_AMOUNT_SENTENCE,
    );
    expect(exportedParamDescription("BridgeExecute", "amountRaw")).toMatch(
      /raw atomic units/i,
    );
  });

  it("never states one global unit rule", () => {
    // The exact sentence this fix removed, and the shapes it could come back as.
    expect(STUDIO_MCP_INSTRUCTIONS).not.toMatch(/send raw integer amounts/i);
    expect(STUDIO_MCP_INSTRUCTIONS).not.toMatch(/always send (raw|human)/i);
  });

  it("tells the agent the units are per field and to read the field", () => {
    expect(STUDIO_MCP_INSTRUCTIONS).toMatch(/PER FIELD/);
    expect(STUDIO_MCP_INSTRUCTIONS).toMatch(/never guess/i);
    expect(STUDIO_MCP_INSTRUCTIONS).toMatch(/human decimal/i);
    expect(STUDIO_MCP_INSTRUCTIONS).toMatch(/raw or atomic units/i);
    expect(STUDIO_MCP_INSTRUCTIONS).toMatch(/never round/i);
  });
});
