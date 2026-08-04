/**
 * `getActiveRunForSession` → the DTO's bounded `lastError`.
 *
 * Two properties matter here and the second is the one with teeth:
 *
 *  1. bounded codes reach the renderer, and
 *  2. the free text NEVER does. `stop_evidence_json` also holds `errorMessage`
 *     — raw provider/exception text, the same untrusted class as
 *     `memory_jobs.last_error`, which this repo excludes from every DTO with a
 *     test asserting the omission. The SELECT extracts four named keys rather
 *     than the column, so there is no code path that could carry the message;
 *     the query-shape assertion below is what keeps it that way through a
 *     future refactor.
 *
 * Evidence written by older engine code carries none of these keys. That is
 * not an error state — the field is simply absent and the renderer falls back
 * to its generic framing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Left as the raw Mock (no QueryFn cast): every case drives it with
  // `mockResolvedValueOnce`, and casting to the call signature hides those
  // helpers from the type checker.
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("pg", () => {
  function MockClient() {
    return { connect: mocks.connect, end: mocks.end, query: mocks.query };
  }
  return { Client: MockClient };
});
vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getActiveRunForSession } = await import("../mission-runs-db.js");

const CORRELATION = "33333333-3333-4333-8333-333333333333";
const SESSION = "00000000-0000-4000-8000-00000000eeee";

function pausedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    session_id: SESSION,
    status: "paused_error",
    started_at: "2026-07-29T09:00:00.000Z",
    last_checkpoint_at: null,
    stop_reason: "system_error",
    iteration_count: "3",
    lease_active: false,
    lease_expires_at: null,
    pending_control_kind: null,
    last_error_type: null,
    last_error_class: null,
    last_error_status: null,
    last_error_cause_code: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runtime DTO lastError", () => {
  it("exposes the four bounded codes", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        pausedRow({
          last_error_type: "rate_limit_exceeded",
          // A REAL OpenRouter SDK class name. The evidence writer stores
          // `signal.errorClass` under `sdkErrorClass`, and that value can only
          // ever come from the closed 24-name dictionary — the old fixture
          // used an OpenAI-shaped name the engine could never produce.
          last_error_class: "TooManyRequestsResponseError",
          last_error_status: "429",
          last_error_cause_code: "ECONNRESET",
        }),
      ],
    });

    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lastError).toEqual({
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      statusCode: 429,
      causeCode: "ECONNRESET",
    });
  });

  it("DROPS an errorClass outside the closed SDK dictionary", async () => {
    // Same validators as the live `EV.engine.error` payload. A value that
    // could not have crossed as an event must not sneak across as a DTO field
    // instead — one vocabulary, or the renderer needs two mapping tables.
    mocks.query.mockResolvedValueOnce({
      rows: [
        pausedRow({
          last_error_type: "rate_limit_exceeded",
          last_error_class: "SomeOtherSdkError",
          last_error_status: "429",
        }),
      ],
    });

    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bad key degrades to ABSENT; the good keys still cross.
    expect(result.data.lastError).toEqual({
      errorType: "rate_limit_exceeded",
      statusCode: 429,
    });
  });

  it("DROPS a status outside the real HTTP range rather than coercing it", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        pausedRow({
          last_error_class: "ConnectionError",
          last_error_status: "0",
        }),
      ],
    });

    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lastError).toEqual({ errorClass: "ConnectionError" });
  });

  it("DROPS a non-errno causeCode and a non-enum-shaped errorType", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        pausedRow({
          last_error_type: "Rate Limit Exceeded, Actually A Sentence",
          last_error_cause_code: "not an errno",
          last_error_status: "429",
        }),
      ],
    });

    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lastError).toEqual({ statusCode: 429 });
  });

  it("selects named evidence keys — never the evidence column or stop_summary", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [pausedRow()] });
    await getActiveRunForSession(SESSION, CORRELATION);

    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain("stop_evidence_json->>'errorType'");
    expect(sql).toContain("stop_evidence_json->>'causeCode'");
    // The message and the summary must have no path out of the main process.
    expect(sql).not.toContain("errorMessage");
    expect(sql).not.toContain("stop_summary");
  });

  it("omits lastError entirely for evidence written before these keys existed", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [pausedRow()] });
    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lastError).toBeUndefined();
    expect("lastError" in result.data).toBe(false);
  });

  it("survives a row that has no lastError columns at all", async () => {
    // Absent property, not null — the shape a partial fixture or an older
    // query gives back. Reading untrusted row data must not assume which
    // flavour of absence it gets.
    const { last_error_type, last_error_class, last_error_status, last_error_cause_code, ...bare } =
      pausedRow();
    void [last_error_type, last_error_class, last_error_status, last_error_cause_code];
    mocks.query.mockResolvedValueOnce({ rows: [bare] });

    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lastError).toBeUndefined();
  });

  it("keeps the keys that survive and drops the ones that do not", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        pausedRow({
          last_error_type: "server_error",
          // Over the 120-char bound → dropped, not truncated: a truncated
          // provider code is not a code.
          last_error_class: "x".repeat(200),
          // Not an integer → dropped, never coerced to 0.
          last_error_status: "not-a-number",
          last_error_cause_code: "   ",
        }),
      ],
    });

    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lastError).toEqual({ errorType: "server_error" });
  });
});
