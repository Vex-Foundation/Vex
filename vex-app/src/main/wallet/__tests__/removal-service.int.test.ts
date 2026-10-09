import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

const isolated = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-wallet-removal-db-"));
  const previous = process.env.VEX_CONFIG_DIR;
  process.env.VEX_CONFIG_DIR = dir;
  process.env.VEX_KEYSTORE_PASSWORD = "Disposable-wallet-password-2026";
  return { dir, previous };
});

import { execute, query, queryOne, withTransaction } from "@vex-agent/db/client.js";
import { createEvmWalletEntry } from "@tools/wallet/inventory-create.js";
import { prepareWalletRemoval, restoreRemovedWallet } from "@tools/wallet/removal.js";
import { listWalletRemovalRecords, writeWalletRemovalRecord } from "@tools/wallet/lifecycle.js";
import { getWalletById } from "@tools/wallet/inventory.js";
import { commitWalletRemoval, recoverWalletRemovals } from "../removal-service.js";
import { inspectRemovalDependencies, lockRemovalDependencies } from "@vex-agent/db/repos/wallet-removal.js";
import { createSession } from "@vex-agent/db/repos/sessions.js";

const password = "Disposable-wallet-password-2026";
beforeEach(async () => {
  const tables = await query<{ tablename: string }>(`SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('schema_version','lighter_schema_marker')`);
  await execute(`TRUNCATE TABLE ${tables.map((table) => `"${table.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  rmSync(isolated.dir, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(isolated.dir, { recursive: true, force: true });
  if (isolated.previous === undefined) delete process.env.VEX_CONFIG_DIR; else process.env.VEX_CONFIG_DIR = isolated.previous;
  delete process.env.VEX_KEYSTORE_PASSWORD;
});

async function setupWallet() {
  await createEvmWalletEntry();
  const wallet = await createEvmWalletEntry();
  const sessionId = randomUUID();
  await createSession(sessionId);
  await execute("UPDATE sessions SET selected_evm_wallet_id = $2, selected_evm_wallet_address = $3 WHERE id = $1", [sessionId, wallet.id, wallet.address]);
  const record = await prepareWalletRemoval("evm", wallet.id, password);
  return { wallet, sessionId, record };
}

describe("wallet removal against real PostgreSQL", () => {
  it("retires pending approvals and unsent proposals, preserves history, and leaves old selection unusable after recovery", async () => {
    const { wallet, sessionId, record } = await setupWallet();
    const approvalId = randomUUID();
    await execute("INSERT INTO approval_queue (id, session_id, tool_call, reasoning) VALUES ($1,$2,'{}','review')", [approvalId, sessionId]);
    await execute(`INSERT INTO wallet_intents (intent_id, session_id, wallet_address, network, to_address, amount, preview_json, expires_at)
      VALUES ($1,$2,$3,'eip155','0xdestination','1','{}',NOW()+interval '5 minutes')`, [randomUUID(), sessionId, wallet.address]);
    await execute("INSERT INTO missions (id, root_session_id, status, allowed_wallets) VALUES ('removal-mission',$1,'running',$2)", [sessionId, [wallet.address]]);
    await execute("INSERT INTO mission_runs (id, mission_id, session_id) VALUES ('removal-run','removal-mission',$1)", [sessionId]);
    await execute(`INSERT INTO loop_wake_requests (session_id,mission_run_id,due_at,status)
      VALUES ($1,'removal-run',NOW()+interval '5 minutes','pending')`, [sessionId]);
    await execute(`INSERT INTO runtime_control_requests (session_id,mission_run_id,kind,requested_by)
      VALUES ($1,'removal-run','resume','user')`, [sessionId]);
    const result = await commitWalletRemoval(record);
    expect(result.sessionIds).toContain(sessionId);
    expect(await queryOne("SELECT status FROM approval_queue WHERE id=$1", [approvalId])).toEqual({ status: "rejected" });
    expect(await queryOne("SELECT status FROM wallet_intents WHERE session_id=$1", [sessionId])).toEqual({ status: "cancelled" });
    expect(await queryOne("SELECT status FROM mission_runs WHERE id='removal-run'")).toEqual({ status: "paused_user" });
    expect(await queryOne("SELECT status,cancelled_reason FROM loop_wake_requests WHERE session_id=$1", [sessionId]))
      .toEqual({ status: "cancelled", cancelled_reason: "wallet_removed" });
    expect(await queryOne("SELECT status,reason FROM runtime_control_requests WHERE session_id=$1", [sessionId]))
      .toEqual({ status: "failed", reason: "wallet_removed" });
    expect(await queryOne("SELECT selected_evm_wallet_id FROM sessions WHERE id=$1", [sessionId])).toEqual({ selected_evm_wallet_id: wallet.id });
    const completed = listWalletRemovalRecords()[0];
    if (!completed) throw new Error("No removal record");
    const restored = await restoreRemovedWallet(completed, password);
    expect(restored.id).not.toBe(wallet.id);
    expect(getWalletById("evm", wallet.id)).toBeNull();
    expect(await query("SELECT * FROM approval_queue WHERE id=$1 AND status='pending'", [approvalId])).toEqual([]);
  });

  it("refuses unresolved execution and leaves the wallet active", async () => {
    const { wallet, sessionId, record } = await setupWallet();
    // More pending proposals than the ordinary money-state reader's display
    // limit must not hide the unresolved execution at the end of the union.
    await execute(`INSERT INTO approval_queue (id,session_id,tool_call,reasoning)
      SELECT gen_random_uuid()::text,$1,'{}','review' FROM generate_series(1,75)`, [sessionId]);
    await execute(`INSERT INTO protocol_executions (tool_id, namespace, session_id, params, result, success, execution_status)
      VALUES ('pending_send','wallet',$1,'{}','{}',false,'intent')`, [sessionId]);
    await expect(commitWalletRemoval(record)).rejects.toThrow("unresolved");
    expect(getWalletById("evm", wallet.id)?.address).toBe(wallet.address);
    expect(listWalletRemovalRecords()).toEqual([]);
  });

  it("refuses unresolved execution without a session rather than assuming it is unrelated", async () => {
    const { wallet, record } = await setupWallet();
    await execute(`INSERT INTO protocol_executions (tool_id, namespace, params, result, success, execution_status)
      VALUES ('pending_send','wallet','{}','{}',false,'intent')`);
    await expect(commitWalletRemoval(record)).rejects.toThrow("unresolved");
    expect(getWalletById("evm", wallet.id)).not.toBeNull();
    expect(listWalletRemovalRecords()).toEqual([]);
  });

  it("retires Studio approvals using authoritative project selection even if its session mirror is stale", async () => {
    const { wallet, sessionId, record } = await setupWallet();
    await execute("UPDATE sessions SET selected_evm_wallet_id=NULL, selected_evm_wallet_address=NULL WHERE id=$1", [sessionId]);
    const projectId = randomUUID();
    await execute(`INSERT INTO projects (id,name,slug,root_path,permission,backing_session_id)
      VALUES ($1,'Removal','removal','removal','full',$2)`, [projectId, sessionId]);
    await execute("INSERT INTO project_wallets (project_id,family,wallet_id,address) VALUES ($1,'evm',$2,$3)", [projectId, wallet.id, wallet.address]);
    const approvalId = randomUUID();
    await execute("INSERT INTO approval_queue (id,session_id,tool_call,reasoning) VALUES ($1,$2,'{}','review')", [approvalId, sessionId]);
    await execute(`INSERT INTO approval_intents (approval_id,session_id,action_kind,risk_level,preview_json,policy_json,origin,project_id)
      VALUES ($1,$2,'user_wallet_broadcast','high','{}','{}','studio_mcp',$3)`, [approvalId, sessionId, projectId]);
    await commitWalletRemoval(record);
    expect(await queryOne("SELECT decision, decision_reason, refusal_reason FROM approval_intents WHERE approval_id=$1", [approvalId]))
      .toEqual({ decision: "rejected_stop", decision_reason: "wallet_removed", refusal_reason: "scope_unavailable" });
    expect(await queryOne("SELECT wallet_id FROM project_wallets WHERE project_id=$1", [projectId])).toEqual({ wallet_id: wallet.id });
  });

  it("refuses trading connections using the real persisted ownership records", async () => {
    const { wallet, record } = await setupWallet();
    await execute("INSERT INTO lighter_integration_settings (environment, wallet_address) VALUES ('core',$1)", [wallet.address.toLowerCase()]);
    await expect(commitWalletRemoval(record)).rejects.toThrow("trading connection");
    expect(getWalletById("evm", wallet.id)).not.toBeNull();
  });

  it("refuses an active agent lease before pausing or deleting anything", async () => {
    const { wallet, sessionId, record } = await setupWallet();
    await execute(`INSERT INTO runner_leases (session_id, owner_id, process_kind, expires_at)
      VALUES ($1,'removal-test','test',NOW()+interval '5 minutes')`, [sessionId]);
    await expect(commitWalletRemoval(record)).rejects.toThrow("agent run is active");
    expect(getWalletById("evm", wallet.id)).not.toBeNull();
    expect(listWalletRemovalRecords()).toEqual([]);
  });

  it("reconciles a durable disabled record after the preceding database transaction rolled back", async () => {
    const { wallet, record } = await setupWallet();
    writeWalletRemovalRecord(record);
    expect(getWalletById("evm", wallet.id)).toBeNull();
    await recoverWalletRemovals();
    expect(listWalletRemovalRecords()[0]?.state).toBe("removed");
    expect(getWalletById("evm", wallet.id)).toBeNull();
  });

  it("checks authorization again after database locks, before durable disablement", async () => {
    const { wallet, record } = await setupWallet();
    await expect(commitWalletRemoval(record, false, () => false)).rejects.toThrow("expired");
    expect(getWalletById("evm", wallet.id)).not.toBeNull();
    expect(listWalletRemovalRecords()).toEqual([]);
  });

  it("actually excludes concurrent money-path writers while checking eligibility", async () => {
    const { sessionId, record } = await setupWallet();
    let finish: () => void = () => undefined;
    let held: () => void = () => undefined;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    let failed: (cause: unknown) => void = () => undefined;
    const locked = new Promise<void>((resolve, reject) => { held = resolve; failed = reject; });
    const check = withTransaction(async (client) => {
      await lockRemovalDependencies(client);
      await inspectRemovalDependencies(client, record);
      held();
      await release;
    }).catch((cause: unknown) => { failed(cause); throw cause; });
    await locked;
    let written = false;
    const writer = execute("INSERT INTO approval_queue (id, session_id, tool_call, reasoning) VALUES ($1,$2,'{}','review')", [randomUUID(), sessionId]).then(() => { written = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(written).toBe(false);
    } finally { finish(); }
    await check;
    await writer;
    expect(written).toBe(true);
  });
});
