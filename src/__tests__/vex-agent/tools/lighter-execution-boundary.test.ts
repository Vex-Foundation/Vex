import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { LIGHTER_HANDLERS } from "@vex-agent/tools/protocols/lighter/handlers.js";
import { LIGHTER_TOOLS } from "@vex-agent/tools/protocols/lighter/manifest.js";
import {
  isLighterOrderTerminalExecutionState,
  LIGHTER_ORDER_EXECUTION_BOUNDARY,
  LIGHTER_ORDER_EXECUTION_REQUIRED_BOUNDARIES,
  LIGHTER_ORDER_EXECUTION_STATES,
  LIGHTER_ORDER_TERMINAL_EXECUTION_STATES,
  LIGHTER_ORDER_WRITE_ACTION_KIND,
  LIGHTER_ORDER_WRITE_TOOL_IDS,
  isLighterLiveTradingEnabled,
} from "@vex-agent/tools/protocols/lighter/execution-boundary.js";

const ROOT = process.cwd();
const LIGHTER_SOURCE_ROOTS = [
  "src/tools/lighter",
  "src/vex-agent/tools/protocols/lighter",
].map((path) => join(ROOT, path));

const EXECUTION_BOUNDARY_SOURCE = join(
  ROOT,
  "src/vex-agent/tools/protocols/lighter/execution-boundary.ts",
);

const FORBIDDEN_UNTIL_CREATE_MILESTONE =
  /\b(sendTx|sendTxBatch|createOrder|cancelOrder|signOrder|signTransaction)\s*\(/;
const TRADING_CREDENTIAL_ENV_KEY_RE = /\bLIGHTER_(CORE|RHC)_API_PRIVATE_KEY\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Lighter execution boundary", () => {
  it("classifies future order writes as external provider mutations", () => {
    expect(LIGHTER_ORDER_WRITE_ACTION_KIND).toBe("external_post");
    expect(LIGHTER_ORDER_EXECUTION_BOUNDARY.writeActionKind).toBe("external_post");
    expect(LIGHTER_ORDER_EXECUTION_BOUNDARY.writeToolIds).toEqual([
      "lighter.order.create",
      "lighter.order.cancel.preview",
      "lighter.order.cancel",
    ]);
  });

  it("keeps API acceptance distinct from terminal provider outcomes", () => {
    expect(LIGHTER_ORDER_EXECUTION_STATES).toEqual([
      "previewed",
      "approval_pending",
      "signed",
      "submitted",
      "api_accepted",
      "sequencer_pending",
      "open",
      "partially_filled",
      "filled",
      "canceled",
      "rejected",
      "ambiguous",
    ]);
    expect(LIGHTER_ORDER_TERMINAL_EXECUTION_STATES).toEqual([
      "filled",
      "canceled",
      "rejected",
    ]);
    expect(isLighterOrderTerminalExecutionState("api_accepted")).toBe(false);
    expect(isLighterOrderTerminalExecutionState("sequencer_pending")).toBe(false);
    expect(isLighterOrderTerminalExecutionState("ambiguous")).toBe(false);
    expect(isLighterOrderTerminalExecutionState("filled")).toBe(true);
  });

  it("names every boundary that must close before create/cancel can submit", () => {
    expect(LIGHTER_ORDER_EXECUTION_REQUIRED_BOUNDARIES).toEqual([
      "fresh_matching_lighter_order_preview",
      "approval_disclosure_from_persisted_preview_and_live_reads",
      "encrypted_vault_trading_credential_reference",
      "privileged_runtime_signing_only",
      "nonce_lock_per_environment_account_api_key",
      "durable_activity_intent_before_submit",
      "api_acceptance_not_final_execution",
      "provider_evidence_before_terminal_state",
      "explicit_live_trading_release_gate",
    ]);
    expect(LIGHTER_ORDER_EXECUTION_BOUNDARY.liveTradingEnabled).toBe(false);
    expect(isLighterLiveTradingEnabled()).toBe(false);
  });

  it("registers create only through the approval-gated execution path", () => {
    const toolIds = new Set(LIGHTER_TOOLS.map((tool) => tool.toolId));
    const handlerIds = new Set(Object.keys(LIGHTER_HANDLERS));
    expect(toolIds.has("lighter.order.create.prepare")).toBe(true);
    expect(handlerIds.has("lighter.order.create.prepare")).toBe(true);
    expect(toolIds.has("lighter.order.create")).toBe(true);
    expect(handlerIds.has("lighter.order.create")).toBe(true);

    const prepare = LIGHTER_TOOLS.find((tool) => tool.toolId === "lighter.order.create.prepare");
    expect(prepare).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    const create = LIGHTER_TOOLS.find((tool) => tool.toolId === "lighter.order.create");
    expect(create).toMatchObject({
      mutating: true,
      actionKind: LIGHTER_ORDER_WRITE_ACTION_KIND,
    });

    expect(toolIds.has("lighter.order.cancel.preview")).toBe(false);
    expect(handlerIds.has("lighter.order.cancel.preview")).toBe(false);
    expect(toolIds.has("lighter.order.cancel")).toBe(false);
    expect(handlerIds.has("lighter.order.cancel")).toBe(false);
  });

  it("keeps Lighter source free of submit, cancel, signer, and trading-key hooks", () => {
    const offenders: string[] = [];
    for (const root of LIGHTER_SOURCE_ROOTS) {
      for (const file of walk(root)) {
        if (file === EXECUTION_BOUNDARY_SOURCE) continue;
        const source = readFileSync(file, "utf-8");
        if (
          FORBIDDEN_UNTIL_CREATE_MILESTONE.test(source)
          || TRADING_CREDENTIAL_ENV_KEY_RE.test(source)
        ) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
