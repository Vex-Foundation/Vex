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
 * 1. DexScreener, via the shared QUOTE-TIERED selection rule in
 *    `dexscreener/best-liquidity-price.ts` with base58 case treated as
 *    IDENTITY (the provider echoes the canonical mint in `baseToken.address`,
 *    and `proj_balances` compares `token_address` without `LOWER()`). Only a
 *    pool quoted in a stablecoin (tier 0) or in wSOL (tier 1), above the
 *    shared liquidity floor, may price a mint, and the deepest such pool wins
 *    whichever class it is. MEASURED 2026-08-26: the old "deepest liquidity wins regardless of
 *    quote" rule priced JUP at $1136.11 off a JUP/MET pool whose $176M depth
 *    is denominated in a token the provider itself misprices; the tiered rule
 *    answers $0.2170 from JUP/USDC. A mint the representative pool list leaves
 *    unpriced gets ONE extra full-pool-list read per mint, sequentially and
 *    capped (`dexscreener/unpriced-pool-fallback.ts`).
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
 * answers lamports as a JSON number, so a value above 2^53 cannot be trusted;
 * rather than let a lossy or non-numeric value through, the reader validates it
 * (non-negative safe integer) and FAILS the read otherwise.
 *
 * ## Retry and cancellation ownership
 *
 * This module owns NO retry. `Connection`'s own transport already retries HTTP
 * 429 with exponential backoff (`@solana/web3.js@1.98.4`
 * `lib/index.esm.js:5024-5046`), and it is the single retry owner on this path;
 * a second outer retry only doubles the load on the provider and can leave two
 * requests in flight at once. What this module DOES own is the deadline, and
 * the deadline CANCELS: the reader's transport is built with a custom `fetch`
 * that forwards the reader's `AbortSignal` to the HTTP request, so an expired
 * deadline aborts the request instead of abandoning it.
 *
 * A CALLER may also pass its own signal (`options.signal`, an operator Stop
 * threaded from a tool context). It is COMPOSED with the deadline, not
 * substituted for it, and the two outcomes stay distinguishable: a caller abort
 * rethrows the signal's own reason, a deadline breach throws
 * `SolanaRpcDeadlineExceededError`.
 *
 * ## How far the caller's Stop actually reaches
 *
 * A read is not three RPC calls; it is those plus the ENRICHMENT legs, and the
 * enrichment legs are where the time goes (up to 12 SEQUENTIAL pool re-reads).
 * A signal that is only checked BETWEEN legs still waits for the leg in flight,
 * so it is passed INTO every leg that can take it:
 *
 * | Leg                                   | Reach of the Stop                  |
 * |---------------------------------------|------------------------------------|
 * | `getBalance`, both account reads      | into the request (shared transport)|
 * | Jupiter metadata lookup               | into the request                   |
 * | DexScreener price batches             | into each request                  |
 * | DexScreener pool fallback (up to 12)  | into each request, and between them|
 * | Khalani price fallback                | checked BEFORE the call only       |
 *
 * The last row is the one residual: `getTokenBalancesAcrossChains` is a shared
 * multi-chain scan that exposes no signal of its own, so widening it belongs to
 * a change that owns that surface. A Stop arriving mid-scan waits for that one
 * request. Everything before it stops immediately.
 */

import { PublicKey, type Commitment, type FetchFn } from "@solana/web3.js";
import { z } from "zod";

import {
  createBestLiquidityPriceAccumulator,
  summarizeUnpricedReasons,
  type PriceTierCounts,
} from "../../dexscreener/best-liquidity-price.js";
import { readTokensPairs } from "../../dexscreener/price-read.js";
import { addPoolListsForUnpricedAddresses } from "../../dexscreener/unpriced-pool-fallback.js";
import { getTokenBalancesAcrossChains } from "../../khalani/balances.js";
import { getJupiterTokensByMint } from "../jupiter/jupiter-tokens/service.js";
import { jupiterMintInformationToMetadata } from "../jupiter/jupiter-tokens/types.js";
import { solanaPubkey } from "../shared/schemas.js";
import { createSolanaConnection } from "../shared/solana-transaction/connection.js";
import {
  SOL_MINT,
  SOLANA_QUOTE_ASSET_POLICY,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getWellKnownSolanaTokenByMint,
} from "../shared/solana-constants.js";
import { cacheSolanaTokens, getCachedSolanaToken } from "../shared/solana-token-cache.js";
import logger from "../../../utils/logger.js";

/** DexScreener tokens/v1 caps at 30 addresses per request. */
const DEXSCREENER_TOKENS_BATCH = 30;
/**
 * Deadline this reader owns for ONE RPC call, INCLUDING whatever rate-limit
 * backoff the transport performs inside it. There is no outer retry, so this is
 * the whole budget for the call, and reaching it aborts the HTTP request.
 */
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
        /**
         * The SPL Token / Token-2022 Mint account stores `decimals` as a `u8`,
         * so 0..255 is the whole on-chain range. Anything outside it did not
         * come from a mint and is refused.
         */
        decimals: z.number().int().min(0).max(255),
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
 *    on-chain, so it fails closed rather than picking a winner. The decimals
 *    agreement is checked across EVERY validated account of the mint, ZERO
 *    ONES INCLUDED, and before the zero-skip: a zero account that disagrees
 *    with a non-zero account of the same mint still means the response cannot
 *    be trusted, and skipping it first would let that response through with a
 *    holding written at whichever decimals happened to arrive first.
 *
 * The pass over the entries is therefore twofold: pass one validates and
 * records the first decimals seen per mint, pass two folds the accounts that
 * agree with it. A conflicting account is a FAILURE and is never also counted
 * as zero-skipped or frozen - it contributes nothing but the failure.
 */
export function projectTokenAccounts(
  entries: readonly RawTokenAccountEntry[],
): TokenAccountProjection {
  const failures: SolanaTokenAccountFailure[] = [];

  interface ValidatedAccount {
    pubkey: string;
    mint: string;
    amountRaw: string;
    decimals: number;
    frozen: boolean;
  }

  // Pass 1: validate, and record the first decimals spelling seen per mint.
  const validated: ValidatedAccount[] = [];
  const decimalsByMint = new Map<string, number>();
  for (const entry of entries) {
    const parsed = parsedTokenAccountSchema.safeParse(entry.data);
    if (!parsed.success) {
      failures.push({ pubkey: entry.pubkey, reason: "schema-parse-failed" });
      continue;
    }
    const info = parsed.data.parsed.info;
    const account: ValidatedAccount = {
      pubkey: entry.pubkey,
      mint: info.mint,
      amountRaw: info.tokenAmount.amount,
      decimals: info.tokenAmount.decimals,
      frozen: info.state === "frozen",
    };
    validated.push(account);
    if (!decimalsByMint.has(account.mint)) decimalsByMint.set(account.mint, account.decimals);
  }

  // Pass 2: fold the accounts whose decimals agree with their mint's.
  const byMint = new Map<string, SolanaMintHolding & { amount: bigint }>();
  let zeroSkipped = 0;
  let frozenAccounts = 0;
  for (const account of validated) {
    if (decimalsByMint.get(account.mint) !== account.decimals) {
      failures.push({ pubkey: account.pubkey, reason: "mint-decimals-conflict" });
      continue;
    }
    if (account.frozen) frozenAccounts += 1;
    const amount = BigInt(account.amountRaw);
    if (amount === 0n) {
      zeroSkipped += 1;
      continue;
    }

    const existing = byMint.get(account.mint);
    if (!existing) {
      byMint.set(account.mint, {
        mint: account.mint,
        amount,
        amountRaw: account.amountRaw,
        decimals: account.decimals,
        frozen: account.frozen,
        accountCount: 1,
      });
      continue;
    }
    existing.amount += amount;
    existing.amountRaw = existing.amount.toString();
    existing.frozen = existing.frozen || account.frozen;
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
  /**
   * Non-empty means the read was INCOMPLETE: some token accounts could not be
   * projected, so the holdings behind them are ABSENT from `tokens`. What COULD
   * be read is still present and enriched - a partial read is never emptied.
   *
   * A consumer that REPLACES durable state (the balance sync) must refuse to
   * write on a non-empty list, because a missing row would delete a real
   * balance. A live consumer surfaces the rows plus these failures.
   */
  accountFailures: SolanaTokenAccountFailure[];
  stats: {
    accountsScanned: number;
    zeroSkipped: number;
    frozenAccounts: number;
    metadataMissing: number;
    unpriced: number;
    /**
     * Which quote tier priced each mint in the pricing set, and how many
     * stayed unpriced. Public prices only - never a secret - and the sync logs
     * it so a wrong portfolio number can be traced to the rule behind it.
     */
    priceTiers: PriceTierCounts;
  };
}

export interface ReadSolanaWalletBalancesOptions {
  /**
   * Injected RPC seam. Defaults to a reader-owned, deadline-cancelling
   * transport (`createDeadlineBoundSolanaRpc`), never the shared singleton.
   */
  readonly rpc?: SolanaBalanceRpc;
  /**
   * The CALLER's cancellation (an operator Stop, threaded from
   * `InternalToolContext.abortSignal` / `ProtocolExecutionContext.abortSignal`).
   *
   * It is COMPOSED with the reader's own per-call deadline, never substituted
   * for it: the deadline still bounds a hung provider when the caller has no
   * signal, and an aborted caller still cancels a request that has not yet hit
   * the deadline. The two outcomes stay DISTINGUISHABLE - a caller abort
   * rethrows the signal's own reason (an `AbortError`), a deadline breach
   * throws `SolanaRpcDeadlineExceededError` - because "the operator stopped"
   * and "the provider hung" are different answers.
   *
   * Absent means "no cancellation", never "cancelled".
   */
  readonly signal?: AbortSignal;
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
  const signal = options.signal;
  const rpc = options.rpc ?? createDeadlineBoundSolanaRpc({ signal });

  // Checked between every leg, so a Stop lands at the next boundary even when
  // the RPC seam is an injected one that cannot observe the signal itself.
  signal?.throwIfAborted();
  // Lamports are validated before anything derives from them: the sync owner
  // WRITES this value, so a NaN or a lossy number must fail the read, not the row.
  const rawLamports = await rpc.getBalance(owner);
  const parsedLamports = lamportsSchema.safeParse(rawLamports);
  if (!parsedLamports.success) {
    throw new SolanaRpcResponseInvalidError(
      "getBalance",
      parsedLamports.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const lamports = parsedLamports.data;

  signal?.throwIfAborted();
  const splAccounts = await rpc.getParsedTokenAccountsByOwner(owner, {
    programId: new PublicKey(SPL_TOKEN_PROGRAM_ID),
  });
  signal?.throwIfAborted();
  const token2022Accounts = await rpc.getParsedTokenAccountsByOwner(owner, {
    programId: new PublicKey(TOKEN_2022_PROGRAM_ID),
  });

  const entries: RawTokenAccountEntry[] = [...splAccounts.value, ...token2022Accounts.value].map(
    (account) => ({ pubkey: account.pubkey.toBase58(), data: account.account.data }),
  );
  const projection = projectTokenAccounts(entries);

  // A PARTIAL read keeps everything it could read. There is exactly ONE path
  // here on purpose: an account this reader could not project is reported in
  // `accountFailures`, and the holdings it COULD project are still enriched and
  // returned beside it. Discarding them would hand every consumer an empty
  // `tokens` list carrying no hint that a holding existed - the same "$0 for a
  // funded wallet" answer this module exists to remove, merely relocated from
  // Khalani to a defensive branch.
  //
  // The FAILURE POLICY stays with the consumers, which is where it differs:
  // `vex-agent/sync/solana-balance-sync.ts` refuses to write a partial read
  // (it REPLACES the whole chain, so a missing row would delete a real
  // balance), while a live tool has nothing to destroy and surfaces the rows
  // plus the account errors. The sync therefore pays for enrichment it then
  // discards on this rare path; correctness of the shared contract is worth
  // more than that saved call.

  const mints = projection.holdings.map((holding) => holding.mint);
  const metadata = await loadMintMetadata(mints, signal);
  // Enrichment legs are network calls of their own. The caller's Stop is
  // checked around them so an abort during metadata or pricing cannot finish
  // as a successful read.
  signal?.throwIfAborted();
  // wSOL prices native SOL, so it joins the pricing set even when the wallet
  // holds no wSOL token account.
  const pricing = await priceMints(
    [SOL_MINT, ...mints.filter((mint) => mint !== SOL_MINT)],
    ownerAddress,
    signal,
  );
  signal?.throwIfAborted();
  const priceByMint = pricing.priceByMint;

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
    // Non-empty means the read was INCOMPLETE: `tokens` holds what could be
    // projected, and the holdings behind these accounts are absent from it.
    accountFailures: projection.failures,
    stats: {
      accountsScanned: entries.length,
      zeroSkipped: projection.zeroSkipped,
      frozenAccounts: projection.frozenAccounts,
      metadataMissing,
      unpriced,
      priceTiers: pricing.tiers,
    },
  };
}

// ── RPC plumbing ────────────────────────────────────────────────────

/**
 * A provider response this reader refuses to project. Fail-closed: the sync
 * owner treats a throw as "read skipped", which keeps the last-good rows,
 * whereas a NaN or a lossy lamports value would be WRITTEN as a balance.
 */
export class SolanaRpcResponseInvalidError extends Error {
  override readonly name = "SolanaRpcResponseInvalidError";
  constructor(
    /** Which call produced it. Never carries the response body or the RPC URL. */
    readonly call: string,
    detail: string,
  ) {
    super(`invalid ${call} response: ${detail}`);
  }
}

/** The deadline this reader owns fired and the HTTP request was aborted. */
export class SolanaRpcDeadlineExceededError extends Error {
  override readonly name = "SolanaRpcDeadlineExceeded";
  constructor(readonly call: string) {
    super(`${call} exceeded the ${RPC_DEADLINE_MS}ms reader deadline`);
  }
}

/**
 * `getBalance` answers lamports as a JSON number. A u64 above 2^53 cannot
 * survive that encoding, and a malformed body could deliver NaN, a float or a
 * negative. Only a non-negative safe integer is a balance.
 */
const lamportsSchema = z
  .number()
  .int("lamports must be an integer")
  .min(0, "lamports must not be negative")
  .max(Number.MAX_SAFE_INTEGER, "lamports exceeds the safe-integer range");

export interface DeadlineBoundRpcOptions {
  /** Overrides `config.solana.rpcUrl`. */
  readonly rpcUrl?: string;
  /** Overrides `config.solana.commitment`. */
  readonly commitment?: Commitment;
  /** Underlying transport. Defaults to `globalThis.fetch`, which is web3.js's own default. */
  readonly fetch?: FetchFn;
  /**
   * The CALLER's cancellation, composed with (never replacing) the per-call
   * deadline. See `ReadSolanaWalletBalancesOptions.signal` for the contract and
   * for why the two outcomes must stay distinguishable.
   */
  readonly signal?: AbortSignal;
}

/**
 * The reader's own transport: a `Connection` whose `fetch` forwards THIS
 * reader's per-call `AbortSignal` to the HTTP request, so an expired deadline
 * CANCELS the request rather than abandoning it while the socket stays open.
 *
 * OWNERSHIP AND CONCURRENCY: the returned object serves ONE call at a time,
 * because the in-flight signal is per-transport state. The reader is strictly
 * sequential, and a reentrant call is rejected rather than silently sharing
 * another call's deadline. Do not share one of these between wallets.
 *
 * It is deliberately NOT the shared `getSolanaConnection()` singleton: binding
 * a mutable abort signal into the process-wide connection would let one
 * caller's deadline cancel another caller's request.
 */
export function createDeadlineBoundSolanaRpc(
  options: DeadlineBoundRpcOptions = {},
): SolanaBalanceRpc {
  const baseFetch: FetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let inFlight: AbortController | null = null;

  const connection = createSolanaConnection({
    rpcUrl: options.rpcUrl,
    commitment: options.commitment,
    fetch: (input, init) => baseFetch(input, { ...init, signal: inFlight?.signal }),
  });

  const callerSignal = options.signal;

  async function callRpc<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (inFlight !== null) {
      throw new Error(`solana balance rpc is sequential; ${label} overlapped another call`);
    }
    callerSignal?.throwIfAborted();
    const controller = new AbortController();
    inFlight = controller;
    const timer = setTimeout(() => controller.abort(), RPC_DEADLINE_MS);
    // The caller's abort cancels the HTTP request through the SAME controller
    // the deadline uses, so a Stop aborts the socket instead of abandoning it.
    const forwardCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
    try {
      return await operation();
    } catch (err) {
      // ORDER MATTERS. Both aborts trip the same controller, so the caller is
      // asked FIRST: an operator Stop must surface as the signal's own reason
      // (an `AbortError`), never be relabelled as the provider hanging.
      if (callerSignal?.aborted === true) throw callerSignal.reason;
      if (controller.signal.aborted) throw new SolanaRpcDeadlineExceededError(label);
      throw err;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forwardCallerAbort);
      inFlight = null;
    }
  }

  return {
    getBalance: (publicKey) => callRpc("getBalance", () => connection.getBalance(publicKey)),
    getParsedTokenAccountsByOwner: (owner, filter) =>
      callRpc(`getTokenAccountsByOwner:${filter.programId.toBase58()}`, () =>
        connection.getParsedTokenAccountsByOwner(owner, filter),
      ),
  };
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
async function loadMintMetadata(
  mints: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, MintLabel>> {
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

  signal?.throwIfAborted();
  try {
    const resolved = await getJupiterTokensByMint(missing, signal);
    const metadata = resolved.map(jupiterMintInformationToMetadata);
    for (const meta of metadata) {
      labels.set(meta.address, { symbol: meta.symbol, name: meta.name });
    }
    if (metadata.length > 0) cacheSolanaTokens(metadata);
  } catch (err) {
    // A Stop is the caller's outcome, not a metadata miss to be shrugged off:
    // swallowing it here would return null labels and let the read continue.
    if (signal?.aborted === true) throw signal.reason;
    logger.debug("solana.balances.metadata_lookup_failed", {
      mints: missing.length,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
  return labels;
}

// ── Pricing ─────────────────────────────────────────────────────────

/** One pricing pass: the map plus the tier census that explains it. */
interface SolanaPricing {
  readonly priceByMint: Map<string, number>;
  readonly tiers: PriceTierCounts;
}

/**
 * Mint -> USD price. DexScreener first (our own read, quote-tiered), Khalani's
 * price map as the fallback for whatever it could not price, null last. Every
 * leg is fail-soft: an unpriced mint keeps its row with a null USD value.
 *
 * The tier census counts the DEXSCREENER decision only. A mint the Khalani
 * fallback rescues still counts as `unpriced` there, which is what the log is
 * for: it says how well OUR rule did, not how many rows ended up with a number.
 *
 * Base58 case is IDENTITY here. The provider echoes the canonical mint back in
 * `baseToken.address` even when the request lowercased it (probed 2026-08-26),
 * and `proj_balances` compares `token_address` with no `LOWER()`, so
 * lowercasing the key would write a mint no reader can match.
 */
async function priceMints(
  mints: readonly string[],
  ownerAddress: string,
  signal?: AbortSignal,
): Promise<SolanaPricing> {
  const accumulator = createBestLiquidityPriceAccumulator({
    wanted: mints,
    normalizeAddress: (address) => address,
    quotePolicy: SOLANA_QUOTE_ASSET_POLICY,
  });
  if (mints.length === 0) {
    return { priceByMint: new Map<string, number>(), tiers: accumulator.countTiers() };
  }

  for (let i = 0; i < mints.length; i += DEXSCREENER_TOKENS_BATCH) {
    const batch = mints.slice(i, i + DEXSCREENER_TOKENS_BATCH);
    signal?.throwIfAborted();
    try {
      accumulator.addPairs(
        await readTokensPairs(SOLANA_DEXSCREENER_SLUG, batch.join(","), { signal }),
      );
    } catch (err) {
      // A Stop ends the pricing pass; it is not one more unpriced batch.
      if (signal?.aborted === true) throw signal.reason;
      logger.debug("solana.balances.price_batch_failed", {
        batch: batch.length,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  // Second, bounded pass. `/tokens/v1` answers the pool the PROVIDER considers
  // representative, and it picks by a depth denominated in the quote asset - so
  // for a mint whose quote asset the provider misprices, the representative
  // pool is exactly the tier-2 pool the rule refuses. JUP is that mint.
  const fallback = await addPoolListsForUnpricedAddresses(
    { accumulator, chainSlug: SOLANA_DEXSCREENER_SLUG, addresses: mints, signal },
    (address) => address,
    (mint, err) => {
      logger.debug("solana.balances.pool_fallback_failed", {
        mint,
        error: err instanceof Error ? err.name : "unknown",
      });
    },
  );
  if (fallback.attempted > 0 || fallback.skipped > 0) {
    logger.debug("solana.balances.pool_fallback", fallback);
  }

  const prices = accumulator.toPriceMap();
  const tiers = accumulator.countTiers();
  if (tiers.unpriced > 0) {
    logger.debug("solana.balances.unpriced_reasons", summarizeUnpricedReasons(accumulator));
  }
  const stillUnpriced = mints.filter((mint) => !prices.has(mint));
  if (stillUnpriced.length === 0) return { priceByMint: prices, tiers };

  // `getTokenBalancesAcrossChains` takes no signal of its own (it is a shared
  // multi-chain scan with many callers), so the Stop is enforced BEFORE the
  // call rather than inside it. A stop arriving mid-scan still waits for this
  // one request; see the module header for the residual.
  signal?.throwIfAborted();

  for (const [mint, price] of await khalaniPriceMap(stillUnpriced, ownerAddress)) {
    prices.set(mint, price);
  }
  return { priceByMint: prices, tiers };
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
