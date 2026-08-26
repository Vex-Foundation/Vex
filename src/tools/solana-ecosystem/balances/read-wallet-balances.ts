/**
 * Direct-RPC wallet balance read for Solana, priced with OUR OWN DexScreener
 * read and only then with Khalani's price map.
 *
 * This is the Solana twin of `tools/evm-chains/balances.ts`: RPC + pricing
 * only, no DB access and no fail-soft policy of its own. The sync owner
 * (`vex-agent/sync/solana-balance-sync.ts`) decides what a failure means,
 * because it is the side that performs the whole-chain replace.
 *
 * ## What is read, and why three calls and not one
 *
 * `getBalance` for the native lamports, then `getTokenAccountsByOwner` ONCE
 * PER TOKEN PROGRAM: the RPC filters by exactly one program id, and a wallet's
 * positions are split across the classic SPL Token program and Token-2022 (on
 * the wallet probed 2026-08-26: 7 classic accounts and 5 Token-2022 accounts).
 * Reading one program is reading part of the wallet. The calls are sequential
 * on purpose - one wallet's read is not worth fanning out on a public RPC.
 *
 * ## The parsed account is UNTRUSTED input
 *
 * `jsonParsed` output is provider-shaped JSON, so every account goes through
 * a zod schema before projection, and a single account that does not parse is
 * reported as a FAILURE rather than dropped: a dropped account looks exactly
 * like "you hold none of it" to the caller that replaces the whole chain.
 * `amount` is a u64 STRING and stays a string end to end (BigInt for the
 * per-mint sum); it never passes through `Number`. `decimals` always comes
 * from the parsed account (it is the mint's own property), never from
 * metadata.
 *
 * ## Pricing order (owner decision 2026-08-26)
 *
 * 1. DexScreener best-liquidity pair per mint, via the shared selection rule
 *    in `dexscreener/best-liquidity-price.ts` with base58 case treated as
 *    IDENTITY (the provider echoes the canonical mint in `baseToken.address`,
 *    and `proj_balances` compares `token_address` without `LOWER()`).
 * 2. Khalani's `extensions.price.usd`, read ONLY for mints DexScreener could
 *    not price. It is a price map here and NEVER a balance source.
 * 3. null. The row is still returned and the caller counts it as unpriced;
 *    a holding is never dropped for lacking a price.
 *
 * ## Declared depth gaps (not silent omissions)
 *
 * No NFT classification, no compressed NFTs (DAS), no stake accounts, and no
 * Token-2022 transfer-fee / interest-bearing adjustment: a transfer-fee mint's
 * `amount` is the pre-fee balance, which is what the account holds. `getBalance`
 * answers lamports as a JSON number, so a balance above 2^53 lamports (about
 * 9.0 million SOL) would lose precision; that is the provider's own encoding
 * and is not reachable for a user wallet.
 */

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { createBestLiquidityPriceAccumulator } from "../../dexscreener/best-liquidity-price.js";
import { readTokensPairs } from "../../dexscreener/price-read.js";
import { getTokenBalancesAcrossChains } from "../../khalani/balances.js";
import { getJupiterTokensByMint } from "../jupiter/jupiter-tokens/service.js";
import { jupiterMintInformationToMetadata } from "../jupiter/jupiter-tokens/types.js";
import { solanaPubkey } from "../shared/schemas.js";
import {
  SOL_MINT,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getWellKnownSolanaTokenByMint,
} from "../shared/solana-constants.js";
import { cacheSolanaTokens, getCachedSolanaToken } from "../shared/solana-token-cache.js";
import logger from "../../../utils/logger.js";

/** DexScreener tokens/v1 caps at 30 addresses per request. */
const DEXSCREENER_TOKENS_BATCH = 30;
/** Deadline this reader owns for ONE RPC call, retry excluded. */
const RPC_DEADLINE_MS = 10_000;
/** DexScreener's own chain slug for Solana. */
const SOLANA_DEXSCREENER_SLUG = "solana";

// ── RPC seam ────────────────────────────────────────────────────────

/**
 * The narrow slice of `@solana/web3.js`'s `Connection` this reader uses. A
 * real `Connection` satisfies it structurally, and a test can drive the reader
 * with a scripted object instead of patching globals.
 */
export interface SolanaBalanceRpc {
  getBalance(publicKey: PublicKey): Promise<number>;
  getParsedTokenAccountsByOwner(
    owner: PublicKey,
    filter: { programId: PublicKey },
  ): Promise<{ value: ReadonlyArray<{ pubkey: PublicKey; account: { data: unknown } }> }>;
}

// ── Parsed-account validation ───────────────────────────────────────

const parsedTokenAccountSchema = z.object({
  parsed: z.object({
    type: z.literal("account"),
    info: z.object({
      mint: solanaPubkey,
      owner: solanaPubkey,
      state: z.string().min(1),
      tokenAmount: z.object({
        /** u64 as a decimal string. Never parsed into a float. */
        amount: z.string().regex(/^\d+$/, "expected a u64 decimal string"),
        decimals: z.number().int().min(0).max(32),
      }),
    }),
  }),
});

/** One token account as it arrives from the RPC, before validation. */
export interface RawTokenAccountEntry {
  pubkey: string;
  data: unknown;
}

export type TokenAccountFailureReason = "schema-parse-failed" | "mint-decimals-conflict";

export interface SolanaTokenAccountFailure {
  pubkey: string;
  reason: TokenAccountFailureReason;
}

/** One mint's total holding across every token account that carries it. */
export interface SolanaMintHolding {
  mint: string;
  /** Summed u64 amounts, as a decimal string. */
  amountRaw: string;
  decimals: number;
  /** True when ANY contributing account is frozen. The tokens are still held. */
  frozen: boolean;
  /** How many token accounts contributed (duplicate ATAs are summed, not dropped). */
  accountCount: number;
}

export interface TokenAccountProjection {
  /** Non-zero holdings only, one row per mint. */
  holdings: SolanaMintHolding[];
  /** Accounts that could not be trusted. NEVER conflated with a zero balance. */
  failures: SolanaTokenAccountFailure[];
  zeroSkipped: number;
  frozenAccounts: number;
}

/**
 * Fold raw token accounts into one row per mint.
 *
 * Decisions this encodes, each of them deliberate:
 *  - a zero `amount` produces NO row (parity with the Khalani scan and the EVM
 *    reader), but it is validated first, so a malformed zero account is still
 *    a failure rather than a silent skip;
 *  - several accounts for the SAME mint are SUMMED; emitting two rows would
 *    collide on the `proj_balances` primary key and abort the write;
 *  - `amount: "1", decimals: 0` (NFT-shaped) is kept as an ordinary row - there
 *    is no reliable classifier here and suppressing it would hide a holding;
 *  - a frozen account is kept and counted; the tokens are still held;
 *  - two accounts claiming DIFFERENT decimals for one mint is impossible
 *    on-chain, so it fails closed rather than picking a winner.
 */
export function projectTokenAccounts(
  entries: readonly RawTokenAccountEntry[],
): TokenAccountProjection {
  const byMint = new Map<string, SolanaMintHolding & { amount: bigint }>();
  const failures: SolanaTokenAccountFailure[] = [];
  let zeroSkipped = 0;
  let frozenAccounts = 0;

  for (const entry of entries) {
    const parsed = parsedTokenAccountSchema.safeParse(entry.data);
    if (!parsed.success) {
      failures.push({ pubkey: entry.pubkey, reason: "schema-parse-failed" });
      continue;
    }
    const info = parsed.data.parsed.info;
    const amount = BigInt(info.tokenAmount.amount);
    const frozen = info.state === "frozen";
    if (frozen) frozenAccounts += 1;
    if (amount === 0n) {
      zeroSkipped += 1;
      continue;
    }

    const existing = byMint.get(info.mint);
    if (!existing) {
      byMint.set(info.mint, {
        mint: info.mint,
        amount,
        amountRaw: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
        frozen,
        accountCount: 1,
      });
      continue;
    }
    if (existing.decimals !== info.tokenAmount.decimals) {
      failures.push({ pubkey: entry.pubkey, reason: "mint-decimals-conflict" });
      continue;
    }
    existing.amount += amount;
    existing.amountRaw = existing.amount.toString();
    existing.frozen = existing.frozen || frozen;
    existing.accountCount += 1;
  }

  const holdings = [...byMint.values()].map(({ amount: _amount, ...holding }) => holding);
  return { holdings, failures, zeroSkipped, frozenAccounts };
}

// ── Public read ─────────────────────────────────────────────────────

export interface SolanaTokenHolding extends SolanaMintHolding {
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
}

export interface SolanaWalletBalancesRead {
  /** Native lamports as a decimal string (9 decimals). */
  lamports: string;
  /** SOL's USD price, taken from the wSOL mint. */
  solPriceUsd: number | null;
  tokens: SolanaTokenHolding[];
  /** Non-empty means the read was INCOMPLETE; the caller must not replace. */
  accountFailures: SolanaTokenAccountFailure[];
  stats: {
    accountsScanned: number;
    zeroSkipped: number;
    frozenAccounts: number;
    metadataMissing: number;
    unpriced: number;
  };
}

export interface ReadSolanaWalletBalancesOptions {
  /** Injected RPC seam. Defaults to the shared `getSolanaConnection()`. */
  readonly rpc?: SolanaBalanceRpc;
}

/**
 * Read one wallet's native + token balances and price them. ADDRESS-ONLY: this
 * path never sees key material (it deliberately does not go through
 * `shared/solana-account.ts`, which takes a secret key).
 *
 * RPC failures PROPAGATE - the caller owns the fail-soft decision. Metadata and
 * pricing are fail-soft here: a missing symbol or price still yields the row.
 */
export async function readSolanaWalletBalances(
  ownerAddress: string,
  options: ReadSolanaWalletBalancesOptions = {},
): Promise<SolanaWalletBalancesRead> {
  const owner = new PublicKey(solanaPubkey.parse(ownerAddress));
  const rpc = options.rpc ?? (await defaultRpc());

  const lamports = await callRpc("getBalance", () => rpc.getBalance(owner));
  const splAccounts = await callRpc("getTokenAccountsByOwner.spl", () =>
    rpc.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(SPL_TOKEN_PROGRAM_ID) }),
  );
  const token2022Accounts = await callRpc("getTokenAccountsByOwner.token2022", () =>
    rpc.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(TOKEN_2022_PROGRAM_ID) }),
  );

  const entries: RawTokenAccountEntry[] = [...splAccounts.value, ...token2022Accounts.value].map(
    (account) => ({ pubkey: account.pubkey.toBase58(), data: account.account.data }),
  );
  const projection = projectTokenAccounts(entries);

  // An incomplete read is reported, never priced over: the caller stops here.
  if (projection.failures.length > 0) {
    return {
      lamports: String(lamports),
      solPriceUsd: null,
      tokens: [],
      accountFailures: projection.failures,
      stats: {
        accountsScanned: entries.length,
        zeroSkipped: projection.zeroSkipped,
        frozenAccounts: projection.frozenAccounts,
        metadataMissing: 0,
        unpriced: 0,
      },
    };
  }

  const mints = projection.holdings.map((holding) => holding.mint);
  const metadata = await loadMintMetadata(mints);
  // wSOL prices native SOL, so it joins the pricing set even when the wallet
  // holds no wSOL token account.
  const priceByMint = await priceMints(
    [SOL_MINT, ...mints.filter((mint) => mint !== SOL_MINT)],
    ownerAddress,
  );

  let metadataMissing = 0;
  let unpriced = 0;
  const tokens: SolanaTokenHolding[] = projection.holdings.map((holding) => {
    const meta = metadata.get(holding.mint);
    if (!meta) metadataMissing += 1;
    const priceUsd = priceByMint.get(holding.mint) ?? null;
    if (priceUsd === null) unpriced += 1;
    return {
      ...holding,
      symbol: meta?.symbol ?? null,
      name: meta?.name ?? null,
      priceUsd,
    };
  });

  return {
    lamports: String(lamports),
    solPriceUsd: priceByMint.get(SOL_MINT) ?? null,
    tokens,
    accountFailures: [],
    stats: {
      accountsScanned: entries.length,
      zeroSkipped: projection.zeroSkipped,
      frozenAccounts: projection.frozenAccounts,
      metadataMissing,
      unpriced,
    },
  };
}

// ── RPC plumbing ────────────────────────────────────────────────────

async function defaultRpc(): Promise<SolanaBalanceRpc> {
  const { getSolanaConnection } = await import("../shared/solana-transaction/connection.js");
  return getSolanaConnection();
}

/**
 * One RPC call under a deadline this module owns, with AT MOST one retry.
 *
 * Retry is transport-shaped only: a response the provider actually produced
 * (`SolanaJSONRPCError`, i.e. a JSON-RPC error object) is an answer, not a
 * hiccup, and repeating it only doubles the load. Reads are idempotent, so a
 * retry cannot double an effect. Jitter keeps a fleet of clients from
 * retrying in lockstep.
 *
 * The deadline is enforced by the caller's own signal because `Connection`
 * accepts no `AbortSignal`; the underlying HTTP request is therefore abandoned
 * rather than cancelled (declared gap, bounded by the retry cap of one).
 */
async function callRpc<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await withDeadline(operation);
  } catch (err) {
    if (!isRetryableRpcError(err)) throw err;
    logger.debug("solana.balances.rpc_retry", {
      call: label,
      error: err instanceof Error ? err.name : "unknown",
    });
    await sleep(120 + Math.floor(Math.random() * 180));
    return await withDeadline(operation);
  }
}

async function withDeadline<T>(operation: () => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(RPC_DEADLINE_MS);
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(new Error("SolanaRpcDeadlineExceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isRetryableRpcError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // A JSON-RPC error object means the node answered. Its class name is stable
  // across web3.js versions and is checked by name so this module does not
  // depend on the error class's identity.
  return err.name !== "SolanaJSONRPCError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Metadata ────────────────────────────────────────────────────────

interface MintLabel {
  symbol: string;
  name: string;
}

/**
 * Symbol/name per mint: well-known table, then the 24h file cache, then ONE
 * batched Jupiter lookup whose answers are written back to the cache, then
 * nothing. Metadata is presentation: a mint that resolves to nothing keeps its
 * row with null labels. Decimals never come from here.
 */
async function loadMintMetadata(mints: readonly string[]): Promise<Map<string, MintLabel>> {
  const labels = new Map<string, MintLabel>();
  const missing: string[] = [];

  for (const mint of mints) {
    const wellKnown = getWellKnownSolanaTokenByMint(mint);
    if (wellKnown) {
      labels.set(mint, { symbol: wellKnown.symbol, name: wellKnown.name });
      continue;
    }
    const cached = getCachedSolanaToken(mint);
    if (cached && cached.address === mint) {
      labels.set(mint, { symbol: cached.symbol, name: cached.name });
      continue;
    }
    missing.push(mint);
  }

  if (missing.length === 0) return labels;

  try {
    const resolved = await getJupiterTokensByMint(missing);
    const metadata = resolved.map(jupiterMintInformationToMetadata);
    for (const meta of metadata) {
      labels.set(meta.address, { symbol: meta.symbol, name: meta.name });
    }
    if (metadata.length > 0) cacheSolanaTokens(metadata);
  } catch (err) {
    logger.debug("solana.balances.metadata_lookup_failed", {
      mints: missing.length,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
  return labels;
}

// ── Pricing ─────────────────────────────────────────────────────────

/**
 * Mint -> USD price. DexScreener first (our own read), Khalani's price map as
 * the fallback for whatever it could not price, null last. Both legs are
 * fail-soft: an unpriced mint keeps its row with a null USD value.
 *
 * Base58 case is IDENTITY here. The provider echoes the canonical mint back in
 * `baseToken.address` even when the request lowercased it (probed 2026-08-26),
 * and `proj_balances` compares `token_address` with no `LOWER()`, so
 * lowercasing the key would write a mint no reader can match.
 */
async function priceMints(
  mints: readonly string[],
  ownerAddress: string,
): Promise<Map<string, number>> {
  if (mints.length === 0) return new Map<string, number>();

  const accumulator = createBestLiquidityPriceAccumulator({
    wanted: mints,
    normalizeAddress: (address) => address,
  });

  for (let i = 0; i < mints.length; i += DEXSCREENER_TOKENS_BATCH) {
    const batch = mints.slice(i, i + DEXSCREENER_TOKENS_BATCH);
    try {
      accumulator.addPairs(await readTokensPairs(SOLANA_DEXSCREENER_SLUG, batch.join(",")));
    } catch (err) {
      logger.debug("solana.balances.price_batch_failed", {
        batch: batch.length,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  const prices = accumulator.toPriceMap();
  const stillUnpriced = mints.filter((mint) => !prices.has(mint));
  if (stillUnpriced.length === 0) return prices;

  for (const [mint, price] of await khalaniPriceMap(stillUnpriced, ownerAddress)) {
    prices.set(mint, price);
  }
  return prices;
}

/**
 * Khalani's `extensions.price.usd`, for mints DexScreener did not price.
 *
 * The scan is run for THIS wallet (Khalani has no price-only endpoint), and it
 * is PRICE ONLY. The scan also carries balances, and they are deliberately
 * ignored: the RPC read above is the authority for what this wallet holds, and
 * mixing in a second balance source is how a token the RPC does not see gets
 * written as a holding.
 */
async function khalaniPriceMap(
  mints: readonly string[],
  ownerAddress: string,
): Promise<Map<string, number>> {
  const wanted = new Set(mints);
  const prices = new Map<string, number>();
  try {
    const scan = await getTokenBalancesAcrossChains({
      address: ownerAddress,
      family: "solana",
    });
    for (const token of scan.tokens) {
      if (!wanted.has(token.address)) continue;
      const raw = token.extensions?.price?.usd;
      if (raw === undefined) continue;
      const price = Number(raw);
      if (!Number.isFinite(price) || price < 0) continue;
      prices.set(token.address, price);
    }
  } catch (err) {
    logger.debug("solana.balances.khalani_price_fallback_failed", {
      mints: mints.length,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
  return prices;
}
