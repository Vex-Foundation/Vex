/**
 * `WalletBalances` reads Solana direct from RPC, never through Khalani.
 *
 * THE DEFECT THIS PINS. Khalani's Solana scan answers ZERO tokens, and this
 * tool routed the whole `solana` family to it. A funded Solana wallet therefore
 * came back `tokenCount: 0, totalUsd: 0` while the Portfolio sidebar showed the
 * real balance for the same address at the same moment (owner screenshot,
 * 2026-08-28). The prompts point the agent here to confirm "did the swap land",
 * so a landed Solana buy read as not delivered and could be re-attempted.
 *
 * The handler under test is the REAL one. Only the provider boundaries are
 * scripted: the RPC bytes go through the reader's own injectable seam, and the
 * DexScreener / Jupiter / Khalani-price modules are mocked. Everything from the
 * RPC response to the emitted token row is the production code path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

import type { SolanaBalanceRpc } from "@tools/solana-ecosystem/balances/read-wallet-balances.js";
import { WALLET_TOOLS } from "@vex-agent/tools/registry/wallet.js";
import type { ChainFamily } from "@tools/khalani/types.js";
import { makeTestContext } from "../../_test-context.js";

const SOLANA_CHAIN_ID = 20_011_000_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const UNLABELLED_MINT = "2dnH9aPEtnJ2PcGvCUqmGH8xq4PZzwZJrBf6aiDJJ5eC";
const SPL_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLANA_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const ACCOUNT_A = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../../vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: (_r: unknown, _p: unknown, family: string) =>
    family === "solana" ? SOLANA_ADDRESS : EVM_ADDRESS,
}));

// No local EVM chains: this suite is about the Solana arm.
vi.mock("@tools/evm-chains/registry.js", () => ({
  listLocalChains: () => [],
  getLocalChain: () => undefined,
}));

/**
 * The Khalani scan, watched. It must NEVER be called as a Solana BALANCE
 * source - that is the regression this whole arc removes.
 */
const mockKhalaniScan = vi.fn();
vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return {
    ...original,
    parseBalanceChainSelection: async (raw: string | undefined) => ({
      rawProvided: raw !== undefined,
      byFamily: new Map<ChainFamily, number[]>([
        ["eip155", raw === undefined || raw.includes("1") ? [1] : []],
        ["solana", raw === undefined || raw.includes("solana") ? [SOLANA_CHAIN_ID] : []],
      ]),
    }),
    getTokenBalancesAcrossChains: (...args: unknown[]) => mockKhalaniScan(...args),
  };
});

// Provider boundaries under the Solana reader.
const mockReadTokensPairs = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
  // The shared Khalani price enrichment runs on this path too and may spend its
  // bounded pool-list rescue; it answers nothing here, so the EVM rows this
  // Solana suite carries stay exactly as the scan produced them.
  readTokenPools: () => Promise.resolve([]),
}));
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  getJupiterTokensByMint: async () => [],
}));
vi.mock("@tools/solana-ecosystem/shared/solana-token-cache.js", () => ({
  getCachedSolanaToken: () => undefined,
  cacheSolanaTokens: () => undefined,
}));

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);
const { readSolanaWalletSnapshot } = await import(
  "@tools/solana-ecosystem/balances/wallet-snapshot.js"
);

// ── Scripted RPC ────────────────────────────────────────────────

interface AccountScript {
  pubkey: string;
  mint: string;
  amount: string;
  decimals: number;
  /** Replaces the whole parsed payload, to script a response that cannot be trusted. */
  malformed?: boolean;
}

function parsedAccount(script: AccountScript) {
  return {
    pubkey: new PublicKey(script.pubkey),
    account: {
      data: script.malformed === true
        ? { parsed: { type: "account", info: { mint: script.mint } } }
        : {
            parsed: {
              type: "account",
              info: {
                mint: script.mint,
                owner: SOLANA_ADDRESS,
                state: "initialized",
                tokenAmount: { amount: script.amount, decimals: script.decimals },
              },
            },
          },
    },
  };
}

function scriptedRpc(input: {
  lamports?: number | (() => Promise<number>);
  spl?: AccountScript[];
  token2022?: AccountScript[];
} = {}): SolanaBalanceRpc {
  const lamports = input.lamports ?? 2_500_000_000;
  return {
    getBalance: typeof lamports === "function" ? lamports : async () => lamports,
    async getParsedTokenAccountsByOwner(_owner, filter) {
      const program = filter.programId.toBase58();
      const accounts = program === SPL_PROGRAM ? (input.spl ?? []) : (input.token2022 ?? []);
      if (program !== SPL_PROGRAM && program !== TOKEN_2022_PROGRAM) {
        throw new Error(`unexpected program filter ${program}`);
      }
      return { value: accounts.map(parsedAccount) };
    },
  };
}

/**
 * The REAL snapshot service over a scripted RPC. This is the injectable seam
 * the handler takes; nothing about the handler's own logic is stubbed.
 */
function withRpc(rpc: SolanaBalanceRpc) {
  return {
    readSolanaSnapshot: (address: string, options?: { signal?: AbortSignal }) =>
      readSolanaWalletSnapshot(address, { rpc, signal: options?.signal }),
  };
}

/** A DexScreener pair row, in the provider's own shape. */
function pair(mint: string, priceUsd: string) {
  return {
    chainId: "solana",
    baseToken: { address: mint, symbol: "X", name: "X" },
    quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
    priceUsd,
    liquidity: { usd: 5_000_000 },
  };
}

const baseContext = makeTestContext();

beforeEach(() => {
  vi.clearAllMocks();
  mockReadTokensPairs.mockResolvedValue([pair(SOL_MINT, "200"), pair(UNLABELLED_MINT, "0.00002")]);
  mockKhalaniScan.mockResolvedValue({
    address: EVM_ADDRESS,
    family: "eip155",
    tokens: [],
    scannedChainIds: [1],
    chainErrors: [],
    totalUsd: 0,
  });
});

function solanaSnapshotOf(output: string) {
  const data = JSON.parse(output);
  const snapshot = data.wallets.find((wallet: { wallet: string }) => wallet.wallet === "solana");
  if (!snapshot) throw new Error("no solana snapshot in the answer");
  return snapshot;
}

/**
 * 32 deterministic bytes per index: any 32 bytes are a valid `PublicKey`, so
 * this mints as many distinct account addresses as a bound test needs without
 * hand-writing base58.
 */
function accountAt(index: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, byte) => (byte === 0 ? index + 1 : 9))).toBase58();
}

describe("WalletBalances - the Solana family", () => {
  it("describes the structural native/wSOL identity and fee boundary to the model", () => {
    const description = WALLET_TOOLS.find((tool) => tool.name === "WalletBalances")?.description;
    expect(description).toContain("Only `assetKind: native` identifies account SOL");
    expect(description).toContain("only that account balance can pay network fees");
    expect(description).toContain("native SOL and wSOL share the same Jupiter route/pricing mint");
  });

  it("reports a funded wallet's real holdings instead of Khalani's zero-token answer", async () => {
    const result = await handleWalletBalances(
      { walletFamily: "solana" },
      baseContext,
      withRpc(scriptedRpc({
        spl: [{ pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "1000000000", decimals: 5 }],
      })),
    );

    expect(result.success).toBe(true);
    const snapshot = solanaSnapshotOf(result.output);
    expect(snapshot.address).toBe(SOLANA_ADDRESS);
    expect(snapshot.tokenCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.totalUsd).toBeGreaterThan(0);
    expect(snapshot.scannedChainIds).toContain(SOLANA_CHAIN_ID);

    // The native row: 2.5 account SOL at $200. The structural marker, not the
    // shared route mint, is what makes it native and spendable for fees.
    const sol = snapshot.tokens.find((token: { address: string }) => token.address === SOL_MINT);
    expect(sol).toMatchObject({
      symbol: "SOL",
      name: "Solana",
      assetKind: "native",
      nativeAssetId: "slip44:501",
      routeMint: SOL_MINT,
      pricingMint: SOL_MINT,
      chainId: SOLANA_CHAIN_ID,
      decimals: 9,
      balanceRaw: "2500000000",
      // The human amount travels BESIDE the raw one so the model never divides.
      balance: "2.5",
      valueUsd: "500",
      priceUsd: "200",
    });
    expect(snapshot.totalUsd).toBeCloseTo(500.2, 4);
  });

  it("reports native SOL and wSOL as separate model rows with separate spendability", async () => {
    const result = await handleWalletBalances(
      { walletFamily: "solana" },
      baseContext,
      withRpc(scriptedRpc({
        lamports: 1_000_000_000,
        spl: [
          { pubkey: ACCOUNT_A, mint: SOL_MINT, amount: "500000000", decimals: 9 },
        ],
      })),
    );

    const snapshot = solanaSnapshotOf(result.output);
    const solRows = snapshot.tokens.filter(
      (token: { address: string }) => token.address === SOL_MINT,
    );
    expect(solRows).toHaveLength(2);
    expect(solRows[0]).toMatchObject({
      symbol: "SOL",
      assetKind: "native",
      balanceRaw: "1000000000",
      balance: "1",
    });
    expect(solRows[1]).toMatchObject({
      symbol: "wSOL",
      name: "Wrapped SOL",
      assetKind: "spl",
      nativeAssetId: null,
      balanceRaw: "500000000",
      balance: "0.5",
    });
  });

  it("keeps the native zero row outside a concise priced-row limit", async () => {
    const result = await handleWalletBalances(
      { walletFamily: "solana", response_format: "concise", limit: 1 },
      baseContext,
      withRpc(scriptedRpc({
        lamports: 0,
        spl: [
          { pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "1000000000", decimals: 5 },
        ],
      })),
    );

    const snapshot = solanaSnapshotOf(result.output);
    expect(snapshot.tokens).toHaveLength(2);
    expect(snapshot.tokens[0]).toMatchObject({
      assetKind: "native",
      balanceRaw: "0",
      balance: "0",
    });
    expect(snapshot.tokens[1]).toMatchObject({
      assetKind: "spl",
      address: UNLABELLED_MINT,
    });
  });

  it("never asks Khalani for Solana BALANCES", async () => {
    await handleWalletBalances({ walletFamily: "solana" }, baseContext, withRpc(scriptedRpc()));

    const solanaScans = mockKhalaniScan.mock.calls.filter(
      ([input]) => (input as { family?: string })?.family === "solana",
    );
    expect(solanaScans).toEqual([]);
  });

  it("keeps an unlabelled non-zero SPL holding, with symbol and name honestly null", async () => {
    mockReadTokensPairs.mockResolvedValue([pair(SOL_MINT, "200")]);
    const result = await handleWalletBalances(
      { walletFamily: "solana" },
      baseContext,
      withRpc(scriptedRpc({
        spl: [{ pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "777000000", decimals: 5 }],
      })),
    );

    const snapshot = solanaSnapshotOf(result.output);
    const row = snapshot.tokens.find((token: { address: string }) => token.address === UNLABELLED_MINT);
    expect(row).toBeDefined();
    expect(row.symbol).toBeNull();
    expect(row.name).toBeNull();
    // The mint is never substituted as a label, and the holding is never dropped.
    expect(row.balanceRaw).toBe("777000000");
    expect(row.balance).toBe("7770");
    // No price feed: null plus the flag, never a zero that reads as worthless.
    expect(row.priceUsd).toBeNull();
    expect(row.valueUsd).toBeNull();
    expect(row.priceUnavailable).toBe(true);
  });

  it("surfaces an untrusted token account as an accountError and still returns the readable rows", async () => {
    const result = await handleWalletBalances(
      { walletFamily: "solana" },
      baseContext,
      withRpc(scriptedRpc({
        spl: [{ pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "1", decimals: 5, malformed: true }],
      })),
    );

    expect(result.success).toBe(true);
    const snapshot = solanaSnapshotOf(result.output);
    // Never an empty snapshot: the native holding is still reported.
    expect(snapshot.tokens.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.accountErrors).toEqual([
      { chainId: SOLANA_CHAIN_ID, accountAddress: ACCOUNT_A, reason: "schema-parse-failed" },
    ]);
    // The ACCOUNT pubkey never leaks into tokenErrors, whose address means a mint.
    expect(snapshot.tokenErrors).toEqual([]);
  });

  it("carries an empty accountErrors on a clean read", async () => {
    const result = await handleWalletBalances(
      { walletFamily: "solana" },
      baseContext,
      withRpc(scriptedRpc()),
    );

    expect(solanaSnapshotOf(result.output).accountErrors).toEqual([]);
  });

  it("walletFamily 'all': the EVM family survives a failed Solana read, and vice versa", async () => {
    mockKhalaniScan.mockResolvedValue({
      address: EVM_ADDRESS,
      family: "eip155",
      tokens: [
        { address: "0xUSDC", chainId: 1, symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "100000000", price: { usd: "1.00" } } },
      ],
      scannedChainIds: [1],
      chainErrors: [],
      totalUsd: 100,
    });
    const result = await handleWalletBalances(
      { walletFamily: "all" },
      baseContext,
      withRpc(scriptedRpc({ lamports: () => Promise.reject(new Error("rpc down")) })),
    );

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.wallets.map((wallet: { wallet: string }) => wallet.wallet)).toEqual(["eip155", "solana"]);
    const evm = data.wallets[0];
    expect(evm.tokens).toHaveLength(1);
    expect(evm.totalUsd).toBe(100);
    // The Solana family answers with a per-chain error, not a lost snapshot.
    const solana = solanaSnapshotOf(result.output);
    expect(solana.tokens).toEqual([]);
    expect(solana.chainErrors).toHaveLength(1);
    expect(solana.chainErrors[0].chainId).toBe(SOLANA_CHAIN_ID);
    expect(solana.chainErrors[0].message).toContain("Solana RPC read failed");
  });

  it("an operator abort stays a CANCELLATION and is never filed as a Solana chain error", async () => {
    const controller = new AbortController();
    const context = makeTestContext({ abortSignal: controller.signal });
    // Controlled: the abort lands while the read is between RPC legs, with no
    // wall-clock sleep anywhere.
    const rpc = scriptedRpc({
      lamports: async () => {
        controller.abort();
        return 2_500_000_000;
      },
    });

    // The cancellation leaves the handler as a THROW. It is NOT converted into
    // a failed ToolResult here: the dispatcher owns the turn's one canonical
    // user-stop outcome, and `fail("solana wallet error: ...")` would reach the
    // model as a wallet FAILURE it might retry. It is likewise not relabelled
    // as the reader's deadline expiry, nor swallowed into chainErrors as a
    // provider failure.
    const outcome = await handleWalletBalances({ walletFamily: "solana" }, context, withRpc(rpc)).then(
      (result) => ({ threw: false as const, result }),
      (err: unknown) => ({ threw: true as const, err }),
    );

    expect(outcome.threw).toBe(true);
    if (!outcome.threw) {
      throw new Error(
        `expected the cancellation to propagate, got a ToolResult: ${JSON.stringify(outcome.result)}`,
      );
    }
    const message = outcome.err instanceof Error ? outcome.err.message : String(outcome.err);
    expect(message).toMatch(/abort/i);
    expect(message).not.toContain("Solana RPC read failed");
    expect(message).not.toMatch(/deadline/i);
    expect(message).not.toContain("wallet error");
  });

  it("an abort under walletFamily 'all' propagates instead of being buried in walletErrors", async () => {
    // The other half of the same contract. With a second family in the call,
    // converting the Stop would file it in `walletErrors` and return the EVM
    // snapshot as a SUCCESS - reporting a completed read for a turn the
    // operator stopped.
    const controller = new AbortController();
    const context = makeTestContext({ abortSignal: controller.signal });
    const rpc = scriptedRpc({
      lamports: async () => {
        controller.abort();
        return 2_500_000_000;
      },
    });

    const outcome = await handleWalletBalances({ walletFamily: "all" }, context, withRpc(rpc)).then(
      (result) => ({ threw: false as const, result }),
      (err: unknown) => ({ threw: true as const, err }),
    );

    expect(outcome.threw).toBe(true);
    if (!outcome.threw) {
      throw new Error(
        `expected the cancellation to propagate, got a ToolResult: ${JSON.stringify(outcome.result)}`,
      );
    }
    expect(outcome.err instanceof Error ? outcome.err.message : String(outcome.err)).toMatch(/abort/i);
  });

  it("a PARTIAL read keeps the valid SPL row: a zero-lamport wallet does not lose it to a broken sibling account", async () => {
    // THE DECISIVE CASE. The reader used to answer `tokens: []` whenever ANY
    // account failed, throwing away every holding it had successfully read.
    // This wallet has a native zero row plus one valid SPL holding beside one
    // broken account. The required zero row must never mask deletion of the
    // valid SPL row.
    // The surviving row must come back PRICED, so enrichment is proven to run
    // on a partial read rather than being skipped along with the lost rows.
    mockReadTokensPairs.mockResolvedValue([pair(SOL_MINT, "200"), pair(BONK_MINT, "0.5")]);
    const result = await handleWalletBalances(
      { walletFamily: "solana" },
      baseContext,
      withRpc(scriptedRpc({
        lamports: 0,
        spl: [
          { pubkey: ACCOUNT_A, mint: UNLABELLED_MINT, amount: "1", decimals: 5, malformed: true },
          { pubkey: accountAt(1), mint: BONK_MINT, amount: "4000000", decimals: 5 },
        ],
      })),
    );

    expect(result.success).toBe(true);
    const snapshot = solanaSnapshotOf(result.output);
    const bonk = snapshot.tokens.find((row: { address: string }) => row.address === BONK_MINT);
    expect(bonk).toBeDefined();
    expect(bonk.balanceRaw).toBe("4000000");
    expect(bonk.balance).toBe("40");
    // The failure is still reported: partial is partial, not silently whole.
    expect(snapshot.accountErrors).toEqual([
      { chainId: SOLANA_CHAIN_ID, accountAddress: ACCOUNT_A, reason: "schema-parse-failed" },
    ]);
    // And the read is still ENRICHED, so the surviving row carries its price.
    expect(snapshot.totalUsd).toBeGreaterThan(0);
  });

  it("bounds accountErrors at 20 and counts the rest in accountErrorsOmitted", async () => {
    const broken = Array.from({ length: 26 }, (_, index) => ({
      pubkey: accountAt(index),
      mint: UNLABELLED_MINT,
      amount: "1",
      decimals: 5,
      malformed: true,
    }));

    const result = await handleWalletBalances(
      { walletFamily: "solana" },
      baseContext,
      withRpc(scriptedRpc({ spl: broken })),
    );

    expect(result.success).toBe(true);
    const snapshot = solanaSnapshotOf(result.output);
    expect(snapshot.accountErrors).toHaveLength(20);
    // The agent is told exactly what the cap left out, never silently trimmed.
    expect(snapshot.accountErrorsOmitted).toBe(6);
    // An account the read could not trust is a HOLDING that is absent from
    // `tokens`, so it is an inventory gap - and the bounded list does not bound
    // the axis.
    expect(snapshot.inventoryComplete).toBe(false);
    expect(snapshot.inventoryIncompleteReason).toBe("account_read_failed");
  });

  it("attributes the Solana lane to its own exhaustive RPC source", async () => {
    mockReadTokensPairs.mockResolvedValue([pair(SOL_MINT, "200")]);
    const result = await handleWalletBalances(
      { walletFamily: "solana" },
      baseContext,
      withRpc(scriptedRpc({ lamports: 1_000_000_000, spl: [] })),
    );

    expect(result.success).toBe(true);
    const snapshot = solanaSnapshotOf(result.output);
    expect(snapshot.inventorySources).toEqual([
      {
        chainId: SOLANA_CHAIN_ID,
        source: "solana_rpc_accounts",
        result: "read",
        exhaustive: true,
        observedAt: expect.any(String),
      },
    ]);
  });
});
