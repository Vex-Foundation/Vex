/**
 * `getAgentScan` PROJECT SCOPE against a REAL PostgreSQL.
 *
 * ## Why a mocked-SQL suite is not enough here
 *
 * The unit suite beside this one proves the query BUILDER emits two
 * `wallet_address = ANY(...)` predicates. It cannot prove that the compiled
 * statement runs, that the second predicate actually intersects with the first
 * rather than shadowing it, or - the part that has bitten this repository
 * before - that a row written by a producer in LOWERCASE is still the user's
 * own history when the inventory holds the checksummed form. Those are
 * properties of the database, and only the database can answer them.
 *
 * So this suite seeds three real `agent_activity` rows through raw SQL - one on
 * the project's EVM wallet stored LOWERCASE, one on its Solana wallet, and one
 * on a DIFFERENT inventory wallet the project never selected - and drives the
 * production `getAgentScan` over them.
 *
 * ## What is mocked, and why only that
 *
 * `@vex-lib/wallet.js` is the OS keystore boundary: it is the one thing a test
 * process cannot have, and both the inventory allow-list and the projects
 * repository's drift check read through it. Everything else is real - the
 * `project_wallets` rows, `readProjectPortfolioScope`, the compiled SQL, the
 * keyset ordering and the row mapping.
 */

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inventory: two EVM wallets and one Solana wallet, checksummed as stored.
 *
 * Hoisted, because the keystore mock factory below is hoisted above every
 * module-level binding and would otherwise read them before initialization.
 */
const INVENTORY = vi.hoisted(() => ({
  PROJECT_EVM: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
  PROJECT_SOL: "So11111111111111111111111111111111111111112",
  OTHER_EVM: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb",
  PROJECT_EVM_ID: "evm_project",
  PROJECT_SOL_ID: "sol_project",
  OTHER_EVM_ID: "evm_other",
}));
const {
  PROJECT_EVM,
  PROJECT_SOL,
  OTHER_EVM,
  PROJECT_EVM_ID,
  PROJECT_SOL_ID,
} = INVENTORY;

vi.mock("../../logger/index.js", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
  configureLogger: (): void => undefined,
  redact: (value: unknown): unknown => value,
  redactArgs: (value: unknown): unknown => value,
}));

vi.mock("@vex-lib/wallet.js", () => {
  const entries = {
    evm: [
      {
        id: INVENTORY.PROJECT_EVM_ID,
        address: INVENTORY.PROJECT_EVM,
        label: "project",
      },
      {
        id: INVENTORY.OTHER_EVM_ID,
        address: INVENTORY.OTHER_EVM,
        label: "other",
      },
    ],
    solana: [
      {
        id: INVENTORY.PROJECT_SOL_ID,
        address: INVENTORY.PROJECT_SOL,
        label: "project",
      },
    ],
  } as const;
  return {
    listWallets: (family: "evm" | "solana") => entries[family],
    getWalletById: (family: "evm" | "solana", id: string) =>
      entries[family].find((entry) => entry.id === id) ?? null,
  };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: (): Promise<{
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  } | null> => {
    const url = process.env.VEX_DB_URL;
    if (url === undefined || url === "") return Promise.resolve(null);
    const parsed = new URL(url);
    return Promise.resolve({
      host: parsed.hostname,
      port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//, ""),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
  },
}));

import { ok } from "@shared/ipc/result.js";
import { getAgentScan } from "../agent-scan-db.js";
import { withClient } from "../sessions/connection.js";

const CORRELATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function sql<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await withClient(async (client) => {
    const rows = await client.query<T>(text, [...values]);
    return ok(rows.rows);
  });
  if (!result.ok) throw new Error(`statement failed: ${text}`);
  return result.data;
}

let projectId = "";
let sessionId = "";
let executionId = 0;

/**
 * One logical swap row, `minutesAgo` back in the feed's ordering.
 *
 * The nonce is not decoration: migration 045's
 * `agent_activity_evm_signed_leg_has_nonce` refuses a locally-signed EVM row
 * that has staged a `tx_hash` without one, and a Solana row must carry NO
 * nonce (049's `agent_activity_solana_no_nonce`). Seeding through raw SQL
 * still has to produce rows production could actually write.
 */
async function seedSwap(
  walletAddress: string,
  txHash: string,
  minutesAgo: number,
  family: "eip155" | "solana",
): Promise<void> {
  const evm = family === "eip155";
  await sql(
    `INSERT INTO agent_activity
       (protocol_execution_id, event_index, event_role, kind, protocol,
        chain_id, chain_slug, chain_family, status, wallet_address, session_id,
        token_in_symbol, amount_in_raw, tx_hash, nonce, created_at)
     VALUES ($1, $2, 'swap', 'swap', 'kyberswap',
             $3, $4, $5, 'pending', $6, $7,
             'USDC', '1000000', $8, $9, NOW() - ($10 || ' minutes')::interval)`,
    [
      executionId,
      minutesAgo,
      evm ? 8453 : 101,
      evm ? "base" : "solana",
      family,
      walletAddress,
      sessionId,
      txHash,
      evm ? minutesAgo : null,
      String(minutesAgo),
    ],
  );
}

beforeEach(async () => {
  projectId = randomUUID();
  sessionId = randomUUID();
  await sql(
    "INSERT INTO sessions (id, mode, scope) VALUES ($1, 'agent', 'vex_studio')",
    [sessionId],
  );
  await sql(
    `INSERT INTO projects (id, name, slug, root_path, permission,
                           backing_session_id, scope_version)
     VALUES ($1, $2, $3, $3, 'restricted', $4, 1)`,
    [projectId, "Scope", `scope-${projectId.slice(0, 8)}`, sessionId],
  );
  await sql(
    `INSERT INTO project_wallets (project_id, family, wallet_id, address)
     VALUES ($1, 'evm', $2, $3), ($1, 'solana', $4, $5)`,
    [projectId, PROJECT_EVM_ID, PROJECT_EVM, PROJECT_SOL_ID, PROJECT_SOL],
  );

  const executions = await sql<{ id: number }>(
    `INSERT INTO protocol_executions (tool_id, namespace, session_id, success)
     VALUES ('kyberswap.swap', 'kyberswap', $1, true) RETURNING id`,
    [sessionId],
  );
  executionId = executions[0]?.id ?? 0;

  // The project's EVM row is stored LOWERCASE - the casing receipt and intent
  // writers canonicalize to, while the inventory holds the checksummed form.
  await seedSwap(
    PROJECT_EVM.toLowerCase(),
    `0xproject-evm-${projectId}`,
    1,
    "eip155",
  );
  await seedSwap(PROJECT_SOL, `sol-project-${projectId}`, 2, "solana");
  // A DIFFERENT inventory wallet, which this project never selected.
  await seedSwap(OTHER_EVM.toLowerCase(), `0xother-evm-${projectId}`, 3, "eip155");
});

afterEach(async () => {
  await sql("DELETE FROM agent_activity WHERE protocol_execution_id = $1", [
    executionId,
  ]);
  await sql("DELETE FROM protocol_executions WHERE id = $1", [executionId]);
  await sql("DELETE FROM project_wallets WHERE project_id = $1", [projectId]);
  await sql("DELETE FROM projects WHERE id = $1", [projectId]);
  await sql("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

describe("getAgentScan project scope on a real database", () => {
  it("returns the project's rows in BOTH families, and not the wallet it never selected", async () => {
    const outcome = await getAgentScan(
      { cursor: null, filters: { projectId } },
      CORRELATION_ID,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.status).toBe("available");
    if (outcome.data.status !== "available") return;

    const hashes = outcome.data.entries.map((row) => row.txHash);
    // The EVM row matched despite the casing difference: the project's stored
    // checksummed address is expanded to its lookup variants, exactly as the
    // inventory allow-list is. Without that, a funded project reads as
    // "nothing executed yet".
    expect(hashes).toContain(`0xproject-evm-${projectId}`);
    expect(hashes).toContain(`sol-project-${projectId}`);
    // The intersection is real: another inventory wallet's execution is not
    // this project's activity, and quoting a project id must not reach it.
    expect(hashes).not.toContain(`0xother-evm-${projectId}`);
    expect(outcome.data.entries).toHaveLength(2);
  });

  it("reads the WIDER inventory when no project is named - the project only ever narrows", async () => {
    const outcome = await getAgentScan({ cursor: null, filters: {} }, CORRELATION_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.data.status !== "available") return;
    const hashes = outcome.data.entries.map((row) => row.txHash);
    // The same three rows the project read narrowed to two. This is the
    // control that proves the second predicate REMOVED rows rather than the
    // fixture simply lacking them.
    expect(hashes).toContain(`0xother-evm-${projectId}`);
    expect(hashes).toContain(`0xproject-evm-${projectId}`);
  });

  it("a project with NOTHING selected returns the empty page, not the inventory", async () => {
    await sql(
      `UPDATE project_wallets SET wallet_id = NULL, address = NULL
        WHERE project_id = $1`,
      [projectId],
    );
    const outcome = await getAgentScan(
      { cursor: null, filters: { projectId } },
      CORRELATION_ID,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual({
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("a TOMBSTONED project is refused, never widened back to the inventory", async () => {
    await sql(
      `UPDATE projects SET deleted_at = NOW(), cleanup_state = 'pending'
        WHERE id = $1`,
      [projectId],
    );
    const outcome = await getAgentScan(
      { cursor: null, filters: { projectId } },
      CORRELATION_ID,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("projects.not_found");
  });

  it("a DRIFTED selection is refused - the inventory no longer backs the stored address", async () => {
    await sql(
      `UPDATE project_wallets SET address = $2
        WHERE project_id = $1 AND family = 'evm'`,
      [projectId, "0xCCCCccccCCCCccccCCCCccccCCCCccccCCCCcccc"],
    );
    const outcome = await getAgentScan(
      { cursor: null, filters: { projectId } },
      CORRELATION_ID,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // A drifted selection means Vex cannot say whose activity this would be.
    // An empty page, or the Solana half alone, would both be answers it has no
    // right to give.
    expect(outcome.error.code).toBe("projects.wallet_drift");
  });

  it("still applies the ordinary filters underneath the project scope", async () => {
    const outcome = await getAgentScan(
      { cursor: null, filters: { projectId, chainFamily: "solana" } },
      CORRELATION_ID,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.data.status !== "available") return;
    expect(outcome.data.entries.map((row) => row.txHash)).toEqual([
      `sol-project-${projectId}`,
    ]);
  });
});
