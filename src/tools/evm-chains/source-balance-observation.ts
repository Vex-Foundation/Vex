/**
 * The EVM producer of `SourceBalanceObservation`: one narrow chain read of one
 * asset, for one wallet, at one block tag, stamped with when it was taken.
 *
 * WHOSE VOCABULARY THIS IS. The shapes come from
 * `vex-agent/tools/protocols/quote-authority/spendability-contract.ts`, which
 * WP2-S froze as the single vocabulary of spendability; this module is the EVM
 * half of what produces them (`solana-ecosystem` owns the other). The import is
 * TYPE-ONLY on purpose: `src/tools/**` does not depend on `src/vex-agent/**` at
 * runtime (the one-way direction stated in `tools/uniswap/quote.ts:262` and
 * `tools/khalani/validation/_shared.ts`), and a type-only import is erased, so
 * the module graph stays one-way while the vocabulary stays single. A second
 * local copy of these shapes would be the worse trade: two vocabularies that
 * can silently disagree about what a balance statement means.
 *
 * WHAT MAKES `pending` THE AUTHORIZATION TAG. It is the only tag that subtracts
 * the wallet's own in-flight transactions. A swap authorized from `latest` can
 * be authorized against money an unconfirmed transfer has already spent, which
 * is why contract C2.4 makes a failed `pending` read `balance_unavailable`
 * rather than a fallback.
 *
 * MetaMask's own helper falls back from `pending` to `latest` and returns the
 * result as if it were the same fact
 * (`transaction-pay-controller/src/utils/token.ts:381-390`,
 * `requestBalanceWithFallback`). That is the single decision from the wallet
 * references Vex deliberately did not adopt. The `latest` read still HAPPENS
 * here, because a person reading a refusal deserves to know what the chain did
 * say - it travels as `advisoryLatest` inside a read that is NOT ok, where no
 * code path can promote it to a verdict.
 */

import type { Address } from "viem";
import { formatUnits } from "viem";

import type {
  AssetRef,
  SourceBalanceObservation,
  SourceBalanceRead,
} from "@vex-agent/tools/protocols/quote-authority/spendability-contract.js";

import {
  readErc20Balance,
  readNativeBalance,
  type BalanceBlockTag,
  type Erc20ReadClient,
  type NativeReadClient,
} from "./erc20-reads.js";

/** Both halves of one wallet's spendability, from one client. */
export type SourceBalanceClient = Erc20ReadClient & NativeReadClient;

/**
 * Which balance to read. The NATIVE arm reads the ACCOUNT balance and cannot
 * see a token account; the ERC-20 arm reads exactly one contract.
 */
export type EvmBalanceSubject =
  | { readonly kind: "native" }
  | { readonly kind: "erc20"; readonly token: Address };

export interface EvmSourceBalanceRequest {
  readonly chainId: number;
  readonly wallet: Address;
  readonly subject: EvmBalanceSubject;
  /**
   * The asset's identity as THIS lane spells it: the ERC-20 contract address,
   * or the venue's own native sentinel. Echoed into the observation and never
   * normalized here - this module does not own asset identity (contract C4.5).
   */
  readonly assetAddress: string;
  /**
   * The token scale, or `null` when the lane could not establish one. NEVER
   * defaulted to 18: an unknown scale yields a `null` human amount and an exact
   * raw one (contract C1.2).
   */
  readonly decimals: number | null;
  /** The symbol when the lane read one, else `null`. Never invented. */
  readonly symbol: string | null;
  /**
   * The tag to read at. DEFAULTS TO `pending`, the only tag a spend may be
   * authorized from (contract C2.4).
   *
   * A caller may name `latest` instead, and one does: the ERC-20 preflight
   * guard reads the state its twelve production callers have always read, so
   * gaining a structured outcome does not silently move every venue's preflight
   * onto a different block. Such an observation is stamped `latest` and the
   * frozen judge refuses it as `balance_block_tag_not_pending`, which is
   * exactly right - a preflight is not an authorization.
   *
   * The `latest` fallback below runs ONLY for a `pending` request. There is
   * nothing to fall back to when `latest` is what was asked for.
   */
  readonly blockTag?: BalanceBlockTag;
  readonly signal?: AbortSignal;
}

/** An ERC-20 observation request: the subject is the token contract itself. */
export type EvmErc20BalanceRequest =
  Omit<EvmSourceBalanceRequest, "subject"> & { readonly token: Address };

/** A native observation request: the subject is the account balance. */
export type EvmNativeBalanceRequest = Omit<EvmSourceBalanceRequest, "subject">;

/**
 * The closed cause vocabulary of a failed EVM balance read.
 *
 * Structural classes only, never provider text: the caller's decision is the
 * same whatever the node said, and an RPC message is uncontrolled payload that
 * would end up on an agent-visible card (rule 04 error layers, rule 90).
 */
export const EVM_BALANCE_READ_CAUSES = {
  /** `pending` failed; a `latest` value was obtained and travels as advisory. */
  pendingUnavailable: "evm_pending_balance_read_failed",
  /** Neither tag could be read. Nothing at all is known about this balance. */
  balanceUnreadable: "evm_balance_read_failed",
} as const;

export type EvmBalanceReadCause =
  (typeof EVM_BALANCE_READ_CAUSES)[keyof typeof EVM_BALANCE_READ_CAUSES];

/** Strict token scale, matching the frozen C1.2 guard: `0` is legal, `Infinity` is not. */
function usableDecimals(decimals: number | null): number | null {
  return typeof decimals === "number"
    && Number.isInteger(decimals)
    && decimals >= 0
    && decimals <= 36
    ? decimals
    : null;
}

/**
 * The human amount, or `null`.
 *
 * `formatUnits` is viem's exact base-10 scaling with no rounding, which is the
 * same primitive the display owner `amount-display.ts` wraps (contract C1.1);
 * this is that conversion, not a second one. It is called DIRECTLY because the
 * wrapper lives in `src/vex-agent` and this layer does not import upward, which
 * is what every other `src/tools` display site does too
 * (`tools/wallet/native-balances.ts:58`, `tools/uniswap/fee/disclosure.ts:81`).
 */
function humanAmount(raw: bigint, decimals: number | null): string | null {
  return decimals === null ? null : formatUnits(raw, decimals);
}

function assetRef(request: EvmSourceBalanceRequest): AssetRef {
  return { chainId: request.chainId, address: request.assetAddress, symbol: request.symbol };
}

function observationOf(
  request: EvmSourceBalanceRequest,
  blockTag: BalanceBlockTag,
  balance: bigint,
  observedAt: string,
): SourceBalanceObservation {
  const decimals = usableDecimals(request.decimals);
  return {
    wallet: request.wallet,
    asset: assetRef(request),
    blockTag,
    balanceRaw: balance.toString(10),
    decimals,
    balance: humanAmount(balance, decimals),
    observedAt,
  };
}

/**
 * One balance read at one tag, as a closure.
 *
 * The producer is written against THIS and not against a client, so an ERC-20
 * observation requires only `readContract` and a native one only `getBalance`.
 * A caller holding just the ERC-20 capability then needs no cast to reach the
 * producer, and a cast on a money path is a hole in exactly the place rule 04
 * says not to put one.
 */
type BalanceReadAt = (blockTag: BalanceBlockTag) => Promise<bigint>;

/**
 * Observe one EVM balance for spendability.
 *
 * NEVER THROWS for a provider failure. A read that cannot be taken is a
 * first-class outcome (`ok: false`), because the alternative - an exception
 * crossing into a quote path - is where "unavailable" gets caught somewhere
 * generic and rendered as "insufficient", which is precisely the collapse
 * rule 04 and contract C2.3 forbid. A cancellation is NOT swallowed into a
 * verdict: an aborted signal rethrows, because the caller that cancelled is
 * not asking for an answer.
 *
 * `now` is injectable so a test can pin `observedAt`; production passes
 * nothing and the observation is stamped at the instant the read returned.
 */
export async function observeEvmSourceBalance(
  client: SourceBalanceClient,
  request: EvmSourceBalanceRequest,
  now: () => Date = () => new Date(),
): Promise<SourceBalanceRead> {
  return await observeBalance(readerFor(client, request), request, now);
}

/** The ERC-20 arm, for a caller that holds only the contract-read capability. */
export async function observeErc20SourceBalance(
  client: Erc20ReadClient,
  request: EvmErc20BalanceRequest,
  now: () => Date = () => new Date(),
): Promise<SourceBalanceRead> {
  const full: EvmSourceBalanceRequest = { ...request, subject: { kind: "erc20", token: request.token } };
  return await observeBalance(erc20Reader(client, request.token, request), full, now);
}

/** The NATIVE arm, for a caller that holds only the account-balance capability. */
export async function observeNativeSourceBalance(
  client: NativeReadClient,
  request: EvmNativeBalanceRequest,
  now: () => Date = () => new Date(),
): Promise<SourceBalanceRead> {
  const full: EvmSourceBalanceRequest = { ...request, subject: { kind: "native" } };
  return await observeBalance(nativeReader(client, request), full, now);
}

function erc20Reader(
  client: Erc20ReadClient,
  token: Address,
  request: Omit<EvmSourceBalanceRequest, "subject">,
): BalanceReadAt {
  return async (blockTag) =>
    await readErc20Balance(client, token, request.wallet, {
      blockTag,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
}

function nativeReader(
  client: NativeReadClient,
  request: Omit<EvmSourceBalanceRequest, "subject">,
): BalanceReadAt {
  return async (blockTag) => await readNativeBalance(client, request.wallet, { blockTag });
}

function readerFor(client: SourceBalanceClient, request: EvmSourceBalanceRequest): BalanceReadAt {
  return request.subject.kind === "native"
    ? nativeReader(client, request)
    : erc20Reader(client, request.subject.token, request);
}

async function observeBalance(
  readAt: BalanceReadAt,
  request: EvmSourceBalanceRequest,
  now: () => Date,
): Promise<SourceBalanceRead> {
  const tag = request.blockTag ?? "pending";
  try {
    const balance = await readAt(tag);
    return { ok: true, observation: observationOf(request, tag, balance, now().toISOString()) };
  } catch (readFailure) {
    if (request.signal?.aborted) throw readFailure;
    if (tag !== "pending") {
      return {
        ok: false,
        asset: assetRef(request),
        cause: EVM_BALANCE_READ_CAUSES.balanceUnreadable,
      };
    }

    try {
      const latest = await readAt("latest");
      return {
        ok: false,
        asset: assetRef(request),
        cause: EVM_BALANCE_READ_CAUSES.pendingUnavailable,
        advisoryLatest: observationOf(request, "latest", latest, now().toISOString()),
      };
    } catch (latestFailure) {
      if (request.signal?.aborted) throw latestFailure;
      return {
        ok: false,
        asset: assetRef(request),
        cause: EVM_BALANCE_READ_CAUSES.balanceUnreadable,
      };
    }
  }
}

/**
 * Both legs of one EVM swap's spendability, read at the SAME tag from the same
 * client.
 *
 * Sequential rather than concurrent on purpose: two reads issued in parallel to
 * the same node can land on different pending states, and a native leg judged
 * against a later block than the source leg is two statements about two
 * moments. Politeness is a side benefit; consistency is the reason.
 *
 * The native leg exists even when the source asset is an ERC-20, because every
 * EVM swap debits native gas (contract C2.5). When the source asset IS the
 * native asset, the caller passes the same subject twice and gets two
 * observations of one balance - which is correct, and its `requiredRaw` on the
 * native side is the one that must then include the principal.
 */
export async function observeEvmSwapBalances(
  client: SourceBalanceClient,
  request: {
    readonly source: EvmSourceBalanceRequest;
    readonly native: EvmSourceBalanceRequest;
  },
  now: () => Date = () => new Date(),
): Promise<{ readonly source: SourceBalanceRead; readonly native: SourceBalanceRead }> {
  const source = await observeEvmSourceBalance(client, request.source, now);
  const native = await observeEvmSourceBalance(client, request.native, now);
  return { source, native };
}
