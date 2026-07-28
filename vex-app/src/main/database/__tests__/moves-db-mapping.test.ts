/**
 * moves-db tests — mapping-layer coverage (local-symbol fallback + the
 * tolerant mapper), split out of `moves-db.test.ts` by domain under test
 * (Card C5, move-only, same pattern as Cards F1/K7/K8: no assertion changes,
 * no coverage loss) once the parent file crossed the repo's 500-line cap.
 * Mirrors `moves-db.test.ts`'s own mock setup (mocked `pg`/`db-config`/
 * `sessions-db`/logger) — deliberately NOT sharing boilerplate across files.
 *
 * Covers: the tolerant mapper passes through a row with `trade_side = null`,
 * `capture_status = 'filled'`, and `value_usd = null`; token symbols are
 * type-checked, length-bounded scalar extractions from the exact capture
 * item, then re-validated in JS by the shared ASCII-allowlist sanitizer
 * (trims whitespace, drops control characters/bidi controls/zero-width
 * characters/Unicode confusables).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryFn = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn() as ReturnType<typeof vi.fn> & QueryFn,
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  getSessionWalletScope: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("pg", () => {
  function MockClient() {
    return {
      connect: mocks.connect,
      end: mocks.end,
      query: mocks.query,
    };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: mocks.buildPoolConfig,
}));

vi.mock("../sessions-db.js", () => ({
  getSessionWalletScope: mocks.getSessionWalletScope,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getMovesForSession } = await import("../moves-db.js");

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const WALLET_A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const WALLET_B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
const SOL_ADDR = "So11111111111111111111111111111111111111112";

function scopeOk(evmAddr: string | null, solAddr: string | null) {
  return {
    ok: true as const,
    data: {
      evm: evmAddr ? { id: "evm_1", address: evmAddr } : null,
      solana: solAddr ? { id: "sol_1", address: solAddr } : null,
    },
  };
}

/** All bound params across every issued query call, flattened. */
function allBoundParams(): unknown[] {
  return mocks.query.mock.calls.flatMap((call) => {
    const params = call[1];
    return Array.isArray(params) ? params.flat() : [];
  });
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

describe("moves-db getMovesForSession — local symbol fallback mapping", () => {
  it("maps and sanitizes a resolved local symbol on either leg", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 11,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: "7jk8UbH339rCgnohpBvqiss4a7bXWmicMPCUCFmDrmYK",
          input_token_symbol: null,
          input_token_local_symbol: "  wif  ",
          input_amount: "100",
          output_token: "AnotherMint1111111111111111111111111111111",
          output_token_symbol: null,
          output_token_local_symbol: null,
          output_amount: "1",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sanitized (trimmed) — the raw column value itself is never echoed.
    expect(result.data[0]?.inputTokenLocalSymbol).toBe("wif");
    // Absent local symbol (no proj_balances row matched) → null, not "".
    expect(result.data[0]?.outputTokenLocalSymbol).toBeNull();
  });

  it("drops a local symbol carrying Unicode confusables (same sanitizer as the captured symbol)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 12,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: "ScamMint111111111111111111111111111111111",
          input_token_symbol: null,
          // Cyrillic Es (U+0405) standing in for Latin S.
          input_token_local_symbol: "ЅOL",
          input_amount: "1",
          output_token: null,
          output_token_symbol: null,
          output_token_local_symbol: null,
          output_amount: null,
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          wallet_address: WALLET_A,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputTokenLocalSymbol).toBeNull();
  });
});

describe("moves-db getMovesForSession — tolerant mapping", () => {
  it("trims valid capture symbols and drops symbols containing control characters", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 6,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: SOL_ADDR,
          input_token_symbol: "  SOL  ",
          input_amount: "100",
          output_token: "7jk8UbH339rCgnohpBvqiss4a7bXWmicMPCUCFmDrmYK",
          output_token_symbol: "BAD\nSYMBOL",
          output_amount: "1",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputTokenSymbol).toBe("SOL");
    expect(result.data[0]?.outputTokenSymbol).toBeNull();
  });

  it("drops a captured symbol containing Unicode confusables (e.g. a fake SOL claim)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          source: "success",
          trade_side: "buy",
          product_type: "spot",
          venue: "jupiter",
          input_token: "ScamMint111111111111111111111111111111111",
          // Cyrillic Es (U+0405) standing in for Latin S — never surfaces as "SOL".
          input_token_symbol: "ЅOL",
          input_amount: "1",
          output_token: SOL_ADDR,
          output_token_symbol: "SOL",
          output_amount: "1",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.inputTokenSymbol).toBeNull();
    expect(result.data[0]?.outputTokenSymbol).toBe("SOL");
  });

  it("maps a tolerant row (trade_side=null, capture_status='filled', value_usd=null)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          source: "success",
          trade_side: null,
          product_type: null,
          venue: null,
          input_token: "USDC",
          input_token_symbol: null,
          input_amount: "100",
          output_token: "SOL",
          output_token_symbol: null,
          output_amount: "1.2",
          value_usd: null,
          capture_status: "filled",
          instrument_key: null,
          chain: "solana",
          tx_ref: null,
          wallet_address: SOL_ADDR,
          created_at: "2026-05-21T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        id: "success:7",
        source: "success",
        tradeSide: null,
        productType: null,
        venue: null,
        inputToken: "USDC",
        inputTokenSymbol: null,
        inputTokenLocalSymbol: null,
        inputAmount: "100",
        outputToken: "SOL",
        outputTokenSymbol: null,
        outputTokenLocalSymbol: null,
        outputAmount: "1.2",
        valueUsd: null,
        captureStatus: "filled",
        status: null,
        failureCode: null,
        instrumentKey: null,
        chain: "solana",
        txRef: null,
        walletAddress: SOL_ADDR,
        fromChain: null,
        toChain: null,
        providerOrderId: null,
        amountBasis: null,
        legs: [],
        lastCheckedAt: null,
        // Canonical vocabulary: this fixture predates the SQL columns, so both
        // read as absent — the tolerant contract the DTO exists to guarantee.
        activityKind: null,
        eventRole: null,
        // Migration 053 Option C: yield-only; a legacy row never carries one.
        secondaryInputLeg: null,
        secondaryOutputLeg: null,
        createdAt: "2026-05-21T10:00:00.000Z",
      },
    ]);
  });

  it("maps a bridge row (product_type bridge, venue relay)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 8,
          source: "success",
          trade_side: null,
          product_type: "bridge",
          venue: "relay",
          input_token: "ETH",
          input_token_symbol: "ETH",
          input_amount: "0.001714",
          output_token: "ETH",
          output_token_symbol: "ETH",
          output_amount: "0.001693",
          value_usd: null,
          capture_status: "executed",
          instrument_key: null,
          chain: "4663",
          tx_ref: "0xbridge",
          created_at: "2026-07-05T10:00:00.000Z",
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.productType).toBe("bridge");
    expect(row?.venue).toBe("relay");
    expect(row?.inputToken).toBe("ETH");
    expect(row?.inputTokenSymbol).toBe("ETH");
    expect(row?.inputAmount).toBe("0.001714");
    expect(row?.outputAmount).toBe("0.001693");
  });

  it("coerces a NUMERIC value_usd string to a finite number and a Date created_at to ISO", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    const at = new Date("2026-05-21T10:00:00.000Z");
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 9,
          source: "success",
          trade_side: "buy",
          input_token: "USDC",
          input_amount: "100",
          output_token: "ETH",
          output_amount: "0.03",
          value_usd: "123.45",
          capture_status: "executed",
          instrument_key: "eth-usdc",
          chain: "ethereum",
          tx_ref: "0xdeadbeef",
          created_at: at,
        },
      ],
    });

    const result = await getMovesForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0];
    expect(row?.valueUsd).toBeCloseTo(123.45, 4);
    expect(row?.createdAt).toBe("2026-05-21T10:00:00.000Z");
    expect(row?.chain).toBe("ethereum");
    expect(row?.txRef).toBe("0xdeadbeef");
  });
});
