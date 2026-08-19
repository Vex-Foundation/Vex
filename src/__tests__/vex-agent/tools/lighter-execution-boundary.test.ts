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
const ORDER_CREATE_EXECUTION_SOURCE = join(
  ROOT,
  "src/vex-agent/tools/protocols/lighter/order-create-execution.ts",
);
const ORDER_LIFECYCLE_EXECUTION_SOURCE = join(
  ROOT,
  "src/vex-agent/tools/protocols/lighter/order-lifecycle.ts",
);
const WITHDRAWAL_EXECUTION_SOURCE = join(
  ROOT,
  "src/vex-agent/tools/protocols/lighter/withdrawal-execution.ts",
);
const LOW_LEVEL_SUBMIT_CLIENT_SOURCE = join(ROOT, "src/tools/lighter/client.ts");

const FORBIDDEN_AGENT_SUBMIT_RE = /\b(sendTx|sendTxBatch|createOrder|cancelOrder)\s*\(/;
const FORBIDDEN_SIGNER_RE = /\b(signOrder|signTransaction)\s*\(/;
const FORBIDDEN_SIGNED_ARTIFACT_RE =
  /\b(signature|signedPayload|signedTransaction|transactionHash|sendTxPayload)\b/;
const TRADING_CREDENTIAL_ENV_KEY_RE = /\bLIGHTER_(CORE|RHC)_API_PRIVATE_KEY\b/;
const FORBIDDEN_TRADING_SECRET_SHORTCUT_RE =
  /\b(process\.env|readUnlockedSecret|writeSecretVaultSecrets|VAULT_SECRET_KEYS)\b/;
const OBSOLETE_OPERATOR_GATE_RE =
  /\b(?:VEX_LIGHTER_(?:LIVE_TRADING_RELEASE_GATE|DEPOSIT_RELEASE_GATE|DEPOSIT_ROLLOUT_POLICY|DEPOSIT_KILL_SWITCH|DEPOSIT_WALLET_ALLOWLIST|DEPOSIT_MAX_USDC|DEPOSIT_ROLLING_24H_MAX_USDC|KEY_REGISTRATION_RELEASE_GATE)|liveTradingEnabled|depositGateEnabled|releaseGateEnabled|LighterDepositRolloutCapError)\b/;

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
      "lighter.order.cancel.prepare",
      "lighter.order.cancel",
      "lighter.order.modify.prepare",
      "lighter.order.modify",
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

  it("names every permanent boundary that must close before an order lifecycle action can submit", () => {
    expect(LIGHTER_ORDER_EXECUTION_REQUIRED_BOUNDARIES).toEqual([
      "fresh_matching_lighter_order_preview",
      "approval_disclosure_from_persisted_preview_and_live_reads",
      "encrypted_vault_trading_credential_reference",
      "privileged_runtime_signing_only",
      "nonce_lock_per_environment_account_api_key",
      "durable_activity_intent_before_submit",
      "api_acceptance_not_final_execution",
      "provider_evidence_before_terminal_state",
    ]);
  });

  it("registers create, cancel, and modify only through approval-gated execution paths", () => {
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

    expect(LIGHTER_TOOLS.find((tool) => tool.toolId === "lighter.order.cancel.prepare")).toMatchObject({
      mutating: false,
      actionKind: "approval_prepare",
    });
    expect(handlerIds.has("lighter.order.cancel.prepare")).toBe(true);
    expect(LIGHTER_TOOLS.find((tool) => tool.toolId === "lighter.order.cancel")).toMatchObject({
      mutating: true,
      actionKind: LIGHTER_ORDER_WRITE_ACTION_KIND,
    });
    expect(handlerIds.has("lighter.order.cancel")).toBe(true);
    expect(toolIds.has("lighter.order.modify.prepare")).toBe(true);
    expect(handlerIds.has("lighter.order.modify.prepare")).toBe(true);
    expect(toolIds.has("lighter.order.modify")).toBe(true);
    expect(handlerIds.has("lighter.order.modify")).toBe(true);
  });

  it("keeps agent Lighter source free of submit, cancel, signer, and trading-key hooks outside the execution pipeline", () => {
    const offenders: string[] = [];
    for (const root of [join(ROOT, "src/vex-agent/tools/protocols/lighter")]) {
      for (const file of walk(root)) {
        if (file === EXECUTION_BOUNDARY_SOURCE) continue;
        if (file === ORDER_CREATE_EXECUTION_SOURCE) continue;
        if (file === ORDER_LIFECYCLE_EXECUTION_SOURCE) continue;
        if (file === WITHDRAWAL_EXECUTION_SOURCE) continue;
        const source = readFileSync(file, "utf-8");
        if (
          FORBIDDEN_AGENT_SUBMIT_RE.test(source)
          || FORBIDDEN_SIGNER_RE.test(source)
          || TRADING_CREDENTIAL_ENV_KEY_RE.test(source)
        ) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the low-level submit client isolated from agent handlers and signer code", () => {
    const offenders: string[] = [];
    for (const root of LIGHTER_SOURCE_ROOTS) {
      for (const file of walk(root)) {
        if (file === LOW_LEVEL_SUBMIT_CLIENT_SOURCE) continue;
        if (file === EXECUTION_BOUNDARY_SOURCE) continue;
        if (file === ORDER_CREATE_EXECUTION_SOURCE) continue;
        if (file === ORDER_LIFECYCLE_EXECUTION_SOURCE) continue;
        if (file === WITHDRAWAL_EXECUTION_SOURCE) continue;
        const source = readFileSync(file, "utf-8");
        if (/\bsendTx\s*\(/.test(source) || /\bsendTxBatch\s*\(/.test(source)) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the trading secret boundary away from env and managed-vault shortcuts", () => {
    const file = join(ROOT, "src/tools/lighter/trading-secret.ts");
    const source = readFileSync(file, "utf-8");
    expect(source).not.toMatch(FORBIDDEN_TRADING_SECRET_SHORTCUT_RE);
    expect(source).not.toMatch(TRADING_CREDENTIAL_ENV_KEY_RE);
  });

  it("keeps removed operator rollout gates out of production Lighter code", () => {
    const offenders: string[] = [];
    for (const root of [
      join(ROOT, "src/tools/lighter"),
      join(ROOT, "src/vex-agent/tools/protocols/lighter"),
      join(ROOT, "vex-app/src/main/lighter"),
    ]) {
      for (const file of walk(root)) {
        const source = readFileSync(file, "utf-8");
        if (OBSOLETE_OPERATOR_GATE_RE.test(source)) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the signer-order adapter unsigned and provider-disconnected", () => {
    const file = join(ROOT, "src/tools/lighter/signer-order.ts");
    const source = readFileSync(file, "utf-8");
    expect(source).not.toMatch(FORBIDDEN_AGENT_SUBMIT_RE);
    expect(source).not.toMatch(FORBIDDEN_SIGNER_RE);
    expect(source).not.toMatch(FORBIDDEN_SIGNED_ARTIFACT_RE);
  });

  it("keeps the signer adapter disconnected from provider submission", () => {
    const file = join(ROOT, "src/tools/lighter/signer-adapter.ts");
    const source = readFileSync(file, "utf-8");
    expect(source).not.toMatch(/\b(sendTx|sendTxBatch)\s*\(/);
    expect(source).not.toMatch(/\bprice_protection\b/);
    expect(source).not.toMatch(TRADING_CREDENTIAL_ENV_KEY_RE);
  });

  it("keeps agent Lighter handlers away from trading secret material", () => {
    const file = join(ROOT, "src/vex-agent/tools/protocols/lighter/handlers/write.ts");
    const source = readFileSync(file, "utf-8");
    expect(source).not.toContain("trading-secret");
    expect(source).not.toContain("loadLighterTradingSecretMaterial");
  });

  it("keeps the order-create execution pipeline behind injected privileged dependencies", () => {
    const source = readFileSync(ORDER_CREATE_EXECUTION_SOURCE, "utf-8");
    expect(source).toContain("loadLighterTradingSecretMaterial");
    expect(source).toContain("signLighterCreateOrderWithAdapter");
    expect(source).toContain("markSubmitted");
    expect(source).toContain("sendTx");
    expect(source).not.toContain("vex-app/src/main");
    expect(source).not.toMatch(TRADING_CREDENTIAL_ENV_KEY_RE);
    expect(source).not.toMatch(FORBIDDEN_TRADING_SECRET_SHORTCUT_RE);
  });
});
