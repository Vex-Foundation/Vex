/**
 * Integration: migration 059 against real Postgres.
 *
 * Two claims that only a real database can settle, and that a mock would
 * cheerfully fake:
 *  - `session_endpoint_switches` exists with the columns and the FK cascade the
 *    runtime writes, so a switch recorded on the failure path of a degraded
 *    turn does not itself fail;
 *  - `usage_log.serving_provider` exists, so `logUsage` — which the turn path
 *    awaits WITHOUT a try/catch — cannot break every turn on a column the code
 *    writes and the schema lacks. That is exactly the failure mode migration
 *    055's own note warned about.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, query, queryOne } from "@vex-agent/db/client.js";
import { logUsage } from "@vex-agent/db/repos/usage.js";
import {
  getLatestEndpointSwitch,
  listEndpointSwitches,
  recordEndpointSwitch,
} from "@vex-agent/db/repos/session-endpoint-switches.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

beforeEach(async () => {
  await resetDb();
});

describe("session_endpoint_switches (migration 059)", () => {
  it("records a switch with previous endpoint, new endpoint and reason class", async () => {
    const sessionId = await makeSession();

    await recordEndpointSwitch({
      sessionId,
      model: "deepseek/deepseek-v4-flash",
      previousEndpoint: "deepinfra/fp4",
      newEndpoint: "baidu/fp8",
      reasonClass: "rate_limited_shared_pool",
    });

    const rows = await listEndpointSwitches(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      model: "deepseek/deepseek-v4-flash",
      previousEndpoint: "deepinfra/fp4",
      newEndpoint: "baidu/fp8",
      reasonClass: "rate_limited_shared_pool",
    });
    expect(typeof rows[0]?.createdAt).toBe("string");
  });

  it("accepts a NULL previous endpoint — an unpinned session has none to name", async () => {
    const sessionId = await makeSession();
    await recordEndpointSwitch({
      sessionId,
      model: "deepseek/deepseek-v4-flash",
      previousEndpoint: null,
      newEndpoint: "baidu/fp8",
      reasonClass: "provider_overloaded",
    });

    expect((await listEndpointSwitches(sessionId))[0]?.previousEndpoint).toBeNull();
  });

  it("getLatestEndpointSwitch is what makes stickiness survive a restart", async () => {
    // CONTRACT (revised 2026-07-30): the runtime switches a session at most
    // ONCE. After a restart it read-throughs to this row and keeps the same
    // endpoint instead of switching again — the earlier behaviour, which this
    // test used to codify, sent the session back to the endpoint that had
    // already run out of capacity.
    const sessionId = await makeSession();
    await recordEndpointSwitch({
      sessionId,
      model: "m/x",
      previousEndpoint: "deepinfra/fp4",
      newEndpoint: "baidu/fp8",
      reasonClass: "rate_limited_shared_pool",
    });

    const latest = await getLatestEndpointSwitch(sessionId);
    expect(latest?.newEndpoint).toBe("baidu/fp8");
    expect(latest?.reasonClass).toBe("rate_limited_shared_pool");
  });

  it("returns null for a session that never switched", async () => {
    const sessionId = await makeSession();
    expect(await getLatestEndpointSwitch(sessionId)).toBeNull();
  });

  it("recovers the NEWEST row when history exists at all", async () => {
    // The schema still carries no unique index — an operator replay or a
    // pre-revision database may hold more than one row — so the read must be
    // unambiguous about which endpoint is current.
    const sessionId = await makeSession();
    for (const tag of ["baidu/fp8", "novita/fp8"]) {
      await recordEndpointSwitch({
        sessionId,
        model: "m/x",
        previousEndpoint: "deepinfra/fp4",
        newEndpoint: tag,
        reasonClass: "upstream_server_error",
      });
    }
    expect(await listEndpointSwitches(sessionId)).toHaveLength(2);
    expect((await getLatestEndpointSwitch(sessionId))?.newEndpoint).toBe("novita/fp8");
  });

  it("scopes rows per session", async () => {
    const [a, b] = [await makeSession(), await makeSession()];
    await recordEndpointSwitch({
      sessionId: a,
      model: "m/x",
      previousEndpoint: null,
      newEndpoint: "baidu/fp8",
      reasonClass: "provider_unavailable",
    });
    expect(await listEndpointSwitches(b)).toEqual([]);
  });

  it("cascades with its session", async () => {
    const sessionId = await makeSession();
    await recordEndpointSwitch({
      sessionId,
      model: "m/x",
      previousEndpoint: null,
      newEndpoint: "baidu/fp8",
      reasonClass: "rate_limited_shared_pool",
    });

    await execute(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    const remaining = await query(`SELECT 1 FROM session_endpoint_switches`);
    expect(remaining).toHaveLength(0);
  });

  it("rejects a switch for a session that does not exist", async () => {
    await expect(
      recordEndpointSwitch({
        sessionId: randomUUID(),
        model: "m/x",
        previousEndpoint: null,
        newEndpoint: "baidu/fp8",
        reasonClass: "rate_limited_shared_pool",
      }),
    ).rejects.toThrow();
  });
});

describe("usage_log.serving_provider (migration 059)", () => {
  it("persists the upstream that actually served the request", async () => {
    const sessionId = await makeSession();

    await logUsage(sessionId, {
      promptTokens: 100,
      completionTokens: 20,
      cost: 0.0004,
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      servingProvider: "Baidu",
    });

    const row = await queryOne<{ provider: string; serving_provider: string | null }>(
      `SELECT provider, serving_provider FROM usage_log WHERE session_id = $1`,
      [sessionId],
    );
    // The two columns say DIFFERENT things — aggregator vs upstream — which is
    // the whole point: `provider` alone could never answer "which endpoint ran
    // this?".
    expect(row?.provider).toBe("openrouter");
    expect(row?.serving_provider).toBe("Baidu");
  });

  it("is NULL, not empty, when the response reported no routing metadata", async () => {
    const sessionId = await makeSession();
    await logUsage(sessionId, {
      promptTokens: 10,
      completionTokens: 1,
      cost: 0,
      provider: "openrouter",
      model: "m/x",
    });

    const row = await queryOne<{ serving_provider: string | null }>(
      `SELECT serving_provider FROM usage_log WHERE session_id = $1`,
      [sessionId],
    );
    expect(row?.serving_provider).toBeNull();
  });
});
