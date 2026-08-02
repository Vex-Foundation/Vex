/**
 * Launch settlement decoding — `TokenCreated`, and `Bought` when a prebuy rode
 * along in the same transaction.
 *
 * THE RULE IS DECLINE, NEVER GUESS. A confirmed create whose `TokenCreated` we
 * cannot decode leaves the intent `broadcast_pending` for the identity repair
 * sweep rather than confirming with an invented address. `confirmWith` requires
 * a token address precisely so that "we know a token exists but not which one"
 * is unrepresentable — a wrong address is worse than a missing one, because the
 * user would act on it.
 *
 * Both events are UNINDEXED (`indexed: false` on every input, verified against
 * the Blockscout-verified facet), so they are decoded from `data` and matched by
 * topic0. Logs are filtered to the Diamond first: another contract in the same
 * transaction could emit a same-signature event, and trusting it would let an
 * unrelated address be recorded as the user's token.
 *
 * `Bought`'s parameter names are opaque (`a`, `b`, `v1`, `v2`, `v3`) in the
 * verified ABI, so this module does NOT claim to know which positional field is
 * which beyond what the funded probe proved. The prebuy's token amount is
 * reported only when the creator and token cross-check holds; otherwise it is
 * `null` and the caller says so rather than asserting a number.
 */

import { decodeEventLog, getAddress, toEventSelector, type Address, type Hex } from "viem";

import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";

export interface SettlementLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

const TOKEN_CREATED_TOPIC = toEventSelector(
  "TokenCreated(address,address,uint8,uint8,bytes,uint256)",
);
const BOUGHT_TOPIC = toEventSelector("Bought(address,address,uint256,uint256,uint256)");

export interface DecodedLaunch {
  readonly tokenAddress: Address;
  readonly creator: Address;
  /**
   * Raw token units the prebuy acquired, when it could be proven; `null` when
   * there was no prebuy OR when the `Bought` event could not be cross-checked.
   * The caller MUST distinguish those two — see {@link decodeLaunchReceipt}.
   */
  readonly prebuyTokensOutRaw: bigint | null;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Decode a confirmed create receipt.
 *
 * `null` means the token identity could not be established — the caller must
 * leave the row pending, NOT confirm and NOT fail.
 */
export function decodeLaunchReceipt(input: {
  readonly logs: readonly SettlementLog[];
  readonly diamond: Address;
  readonly wallet: Address;
  readonly expectPrebuy: boolean;
}): DecodedLaunch | null {
  const fromDiamond = input.logs.filter((log) => sameAddress(log.address, input.diamond));

  const created = decodeTokenCreated(fromDiamond, input.wallet);
  if (created === null) return null;

  return {
    tokenAddress: created.tokenAddress,
    creator: created.creator,
    prebuyTokensOutRaw: input.expectPrebuy
      ? decodeBoughtAmount(fromDiamond, input.wallet, created.tokenAddress)
      : null,
  };
}

function decodeTokenCreated(
  logs: readonly SettlementLog[],
  wallet: Address,
): { tokenAddress: Address; creator: Address } | null {
  for (const log of logs) {
    if (log.topics[0] !== TOKEN_CREATED_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: TRENCH_DIAMOND_ABI,
        eventName: "TokenCreated",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      const args = tokenCreatedArgsOf(decoded.args);
      if (args === null) continue;
      // CROSS-CHECK: the creator must be OUR wallet. A create by someone else in
      // the same block landing in this receipt is not our token, and recording
      // it would put a stranger's address in the user's launch history.
      if (!sameAddress(args.creator, wallet)) continue;
      return { tokenAddress: args.token, creator: args.creator };
    } catch {
      // A same-topic log we cannot decode proves nothing. Keep looking; if
      // nothing decodes, the caller leaves the row pending.
      continue;
    }
  }
  return null;
}

/**
 * The prebuy's acquired token amount, or `null` when it cannot be proven.
 *
 * The verified `Bought` ABI has opaque positional names, so the ONLY safe read
 * is the one the funded probe established: the event names the buyer and the
 * token, and the amounts follow. When either identity field fails to match, the
 * positional mapping is unproven and this declines — the launch still confirms,
 * but the caller reports the prebuy amount as pending rather than asserting one.
 */
function decodeBoughtAmount(
  logs: readonly SettlementLog[],
  wallet: Address,
  token: Address,
): bigint | null {
  for (const log of logs) {
    if (log.topics[0] !== BOUGHT_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: TRENCH_DIAMOND_ABI,
        eventName: "Bought",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      const args = boughtArgsOf(decoded.args);
      if (args === null) continue;
      const identifiesBuyerAndToken =
        (sameAddress(args.a, wallet) && sameAddress(args.b, token))
        || (sameAddress(args.a, token) && sameAddress(args.b, wallet));
      if (!identifiesBuyerAndToken) continue;
      // POSITIONS PROVEN BY THE FUNDED PROBE (pinned in `evm.test.ts`):
      // v1 = ETH in, post-fee; v2 = TOKENS OUT; v3 = price. `v3` is a price,
      // not an amount — returning it would record a number off by orders of
      // magnitude as the user's prebuy. A zero in `v2` is a real answer meaning
      // nothing was acquired, not a decode failure.
      return args.v2;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Boundary guards ─────────────────────────────────────────────────────────
// `decodeEventLog`'s `args` is chain data — an external boundary, validated as
// unknown (rule 03) instead of asserted. `getAddress` checksums and throws on a
// malformed address; both call sites run inside a try/catch whose `continue`
// is exactly the right response to an unprovable log.

/** The `TokenCreated(token, creator)` fields, or `null` when the shape does not hold. */
function tokenCreatedArgsOf(raw: unknown): { token: Address; creator: Address } | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (!("token" in raw) || !("creator" in raw)) return null;
  const { token, creator } = raw;
  if (typeof token !== "string" || typeof creator !== "string") return null;
  return { token: getAddress(token), creator: getAddress(creator) };
}

/** The `Bought(a, b, …, v2, …)` fields this decoder consumes, or `null`. */
function boughtArgsOf(raw: unknown): { a: Address; b: Address; v2: bigint } | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (!("a" in raw) || !("b" in raw) || !("v2" in raw)) return null;
  const { a, b, v2 } = raw;
  if (typeof a !== "string" || typeof b !== "string" || typeof v2 !== "bigint") return null;
  return { a: getAddress(a), b: getAddress(b), v2 };
}
