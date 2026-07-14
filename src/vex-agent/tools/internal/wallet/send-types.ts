/**
 * Wallet send — shared types + helpers for prepare/confirm.
 *
 * `ExecuteOutcome` discriminated union (Codex puzzle-5 phase-4 review v3
 * GREEN LIGHT): post-broadcast tx hash is transported structurally; the
 * confirm path never extracts it heuristically from an opaque throw.
 */

import { createHash } from "node:crypto";
import type { WalletIntentPreview } from "@vex-agent/db/repos/wallet-intents.js";

export const WALLET_INTENT_TTL_MS = 10 * 60 * 1000;

export type ExecuteOutcome =
  | {
      readonly kind: "confirmed";
      readonly txHash: string;
      readonly data: Record<string, unknown>;
    }
  | {
      readonly kind: "chain_failed";
      readonly txHash: string;
      /**
       * The SAME chain identity the confirmed path's `_tradeCapture.chain`
       * carries (EVM: the resolved network name; Solana: "solana"). Lets the
       * failure `ToolResult` attach a linkable `_explorerRefs` entry for a
       * broadcast-but-reverted tx.
       */
      readonly chain: string;
      readonly errorKind: string;
      readonly errorHash: string;
    }
  | {
      readonly kind: "confirmation_unknown";
      readonly txHash: string;
      /** Same chain identity as `chain_failed` — a broadcast tx still links. */
      readonly chain: string;
      readonly errorKind: string;
      readonly errorHash: string;
    }
  | {
      readonly kind: "pre_broadcast_failed";
      readonly errorKind: string;
      readonly errorHash: string;
    };

/**
 * Structural error fingerprint — `${ErrorKind}` + `${shortSha256(message)}`.
 * Mirrors the approval-runtime helpers.ts pattern (Codex puzzle-5 phase-3
 * review point 6: logs/transcript MUST never carry raw cause text).
 */
export function summarizeWalletError(cause: unknown): {
  errorKind: string;
  errorHash: string;
} {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    errorKind:
      cause instanceof Error ? cause.constructor.name : typeof cause,
    errorHash: createHash("sha256").update(message).digest("hex").slice(0, 16),
  };
}

export function preBroadcastFailed(cause: unknown): ExecuteOutcome {
  const sum = summarizeWalletError(cause);
  return {
    kind: "pre_broadcast_failed",
    errorKind: sum.errorKind,
    errorHash: sum.errorHash,
  };
}

export function buildWalletIntentPreview(args: {
  network: string;
  chain: string | null;
  to: string;
  amount: string;
  token: string | null;
}): WalletIntentPreview {
  const tokenLabel = args.token === null ? "native" : args.token;
  const chainSuffix = args.chain ? ` on ${args.chain}` : "";
  const truncatedTo =
    args.to.length > 20
      ? `${args.to.slice(0, 10)}…${args.to.slice(-6)}`
      : args.to;
  return {
    label: `Send ${args.amount} ${tokenLabel} to ${truncatedTo}${chainSuffix}`,
    criticalArgs: {
      network: args.network,
      chain: args.chain,
      to: args.to,
      amount: args.amount,
      token: args.token,
    },
  };
}
