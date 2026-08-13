/**
 * Trench discovery marks the session wallet's OWN launches (C4).
 *
 * The live failure: `trench.tokens` returned the agent's own test launches as
 * market opportunities, and the agent had to recognise its own creator address
 * mid-reasoning and argue them away. `trench.search` shares the projector and
 * had the same defect.
 *
 * The flag is TRI-STATE on purpose (rule 90 - never claim more than the
 * evidence supports): present-true on a creator match, present-false on a known
 * creator that differs, and ABSENT when the provider gave no creator or the
 * session wallet could not be resolved. "Could not tell" is never encoded as
 * `false`, because a false would read to the agent as "verified: not yours".
 *
 * Wallet state must never be able to break discovery: an unresolvable wallet
 * degrades to no flags and a list that still succeeds.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { TRENCH_HANDLERS } from "@vex-agent/tools/protocols/trench/handlers.js";
import { getTrenchExpressClient } from "@tools/trench-express/client.js";
import type { TrenchToken } from "@tools/trench-express/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import { makeProtocolContext } from "../../_test-context.js";

const SESSION_EVM = "0x33eF000000000000000000000000000000000001";
const OTHER_CREATOR = "0x9999000000000000000000000000000000009999";

/** The default-source context the existing trench suite already invokes these handlers with. */
const DEFAULT_CTX: ProtocolExecutionContext = makeProtocolContext();

function sessionContext(): ProtocolExecutionContext {
  return makeProtocolContext({
    sessionId: "own-launch-flag",
    walletResolution: { source: "session", evm: { id: "w1", address: SESSION_EVM }, solana: null },
  });
}

/** Pretend the session wallet resolves; the resolver has its own suite. */
function stubResolvedWallet(evm: string | null): void {
  const spy = vi.spyOn(walletResolve, "resolveSelectedAddressForRead");
  if (evm === null) {
    spy.mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_NOT_CONFIGURED, "no wallet configured");
    });
  } else {
    spy.mockReturnValue(evm);
  }
}

function token(over: Partial<TrenchToken> & { token: string }): TrenchToken {
  return {
    token: over.token,
    price: 1,
    supply: 1000,
    time: 1_700_000_000_000,
    creator: over.creator === undefined ? "0xCreator" : over.creator,
    name: over.name ?? "Name",
    symbol: over.symbol ?? "SYM",
    description: null,
    imageCid: null,
    links: [],
    holders: 0,
    stats24h: null,
    ruggedFlagged: null,
    _id: null,
    graduated: false,
  } as TrenchToken;
}

interface FlaggedRow {
  token: string;
  isOwnLaunch?: boolean;
}

function rowsOf(output: string): FlaggedRow[] {
  return (JSON.parse(output) as { tokens: FlaggedRow[] }).tokens;
}

function stubTokens(rows: TrenchToken[]): void {
  vi.spyOn(getTrenchExpressClient(), "walkTokens").mockResolvedValue(rows);
}

function stubSearch(rows: TrenchToken[]): void {
  vi.spyOn(getTrenchExpressClient(), "search").mockResolvedValue(rows);
}

async function listTokens(context: ProtocolExecutionContext) {
  return TRENCH_HANDLERS["trench.tokens"]!({}, context);
}

async function searchTokens(context: ProtocolExecutionContext) {
  return TRENCH_HANDLERS["trench.search"]!({ query: "vex" }, context);
}

afterEach(() => vi.restoreAllMocks());

describe("trench.tokens marks the session wallet's own launches", () => {
  it("flags a row whose creator IS the session wallet", async () => {
    stubResolvedWallet(SESSION_EVM);
    stubTokens([token({ token: "0xMine", creator: SESSION_EVM })]);

    const res = await listTokens(sessionContext());

    expect(res.success).toBe(true);
    expect(rowsOf(res.output)[0]!.isOwnLaunch).toBe(true);
  });

  it("marks a row with a known, different creator as NOT ours", async () => {
    stubResolvedWallet(SESSION_EVM);
    stubTokens([token({ token: "0xTheirs", creator: OTHER_CREATOR })]);

    const res = await listTokens(sessionContext());

    expect(res.success).toBe(true);
    expect(rowsOf(res.output)[0]!.isOwnLaunch).toBe(false);
  });

  it("matches case-insensitively (checksummed provider creator vs lowercase wallet)", async () => {
    stubResolvedWallet(SESSION_EVM.toLowerCase());
    stubTokens([token({ token: "0xMine", creator: SESSION_EVM })]);

    const res = await listTokens(sessionContext());

    expect(rowsOf(res.output)[0]!.isOwnLaunch).toBe(true);
  });

  it("omits the field entirely when the provider reported no creator", async () => {
    stubResolvedWallet(SESSION_EVM);
    stubTokens([token({ token: "0xAnon", creator: null })]);

    const res = await listTokens(sessionContext());

    const row = rowsOf(res.output)[0]!;
    expect(res.success).toBe(true);
    expect("isOwnLaunch" in row).toBe(false);
  });

  it("still lists, unflagged, when no wallet can be resolved", async () => {
    // Stubbed rather than relying on the ambient inventory: the real resolver
    // reads this machine's configured wallets, so "no wallet" is not a state a
    // unit test can assume. What is under test is the handler's response to a
    // null wallet, not how the resolver arrived at one.
    stubResolvedWallet(null);
    stubTokens([token({ token: "0xA" }), token({ token: "0xB" })]);

    const res = await listTokens(DEFAULT_CTX);

    expect(res.success).toBe(true);
    const rows = rowsOf(res.output);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect("isOwnLaunch" in row).toBe(false);
  });

  it("flags a default-source context's primary wallet exactly as a session one", async () => {
    // The other half of the default-source pair: the test above pins the
    // degraded shape (nothing resolves), this one pins the resolved shape on
    // the SAME source: "default" context. Both are stubbed, so neither depends
    // on which wallets this machine happens to have configured. The real
    // inventory-backed resolution of a default source is covered end to end by
    // src/__tests__/integration/wallet/default-wallet-resolution.int.test.ts.
    stubResolvedWallet(SESSION_EVM);
    stubTokens([token({ token: "0xMine", creator: SESSION_EVM }), token({ token: "0xTheirs", creator: OTHER_CREATOR })]);

    const res = await listTokens(DEFAULT_CTX);

    expect(res.success).toBe(true);
    expect(rowsOf(res.output).map((row) => row.isOwnLaunch)).toEqual([true, false]);
  });

  it("degrades to no flags when the wallet resolver reports scope drift", async () => {
    vi.spyOn(walletResolve, "resolveSelectedAddressForRead").mockImplementation(() => {
      throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "wallet scope drift");
    });
    stubTokens([token({ token: "0xA", creator: SESSION_EVM })]);

    const res = await listTokens(sessionContext());

    expect(res.success).toBe(true);
    expect("isOwnLaunch" in rowsOf(res.output)[0]!).toBe(false);
  });
});

describe("trench.search marks the session wallet's own launches", () => {
  it("applies the same tri-state to search rows", async () => {
    stubResolvedWallet(SESSION_EVM);
    stubSearch([
      token({ token: "0xMine", creator: SESSION_EVM.toLowerCase() }),
      token({ token: "0xTheirs", creator: OTHER_CREATOR }),
      token({ token: "0xAnon", creator: null }),
    ]);

    const res = await searchTokens(sessionContext());

    expect(res.success).toBe(true);
    const [mine, theirs, anon] = rowsOf(res.output);
    expect(mine!.isOwnLaunch).toBe(true);
    expect(theirs!.isOwnLaunch).toBe(false);
    expect("isOwnLaunch" in anon!).toBe(false);
  });

  it("still searches, unflagged, when no wallet can be resolved", async () => {
    stubResolvedWallet(null);
    stubSearch([token({ token: "0xA" })]);

    const res = await searchTokens(DEFAULT_CTX);

    expect(res.success).toBe(true);
    expect("isOwnLaunch" in rowsOf(res.output)[0]!).toBe(false);
  });
});
