/**
 * Trench launch IDENTITY repair — the crash-recovery reconciler for launches
 * whose `create` settled but whose token identity was never written.
 *
 * ── Why the generic sweep cannot do this ───────────────────────────────────
 *
 * `agent-activity-repair.ts` is STATUS-ONLY by owner decree (2026-07-30): it
 * asks the chain one question per pending row — did this tx hash succeed or
 * revert — and writes the status alone. It decodes nothing. That is the right
 * design for a protocol-agnostic sweep, and it is exactly why it cannot finish a
 * launch: a launch's whole point is the ADDRESS of the token that now exists,
 * and that address is only knowable by decoding `TokenCreated` from the receipt.
 * The generic sweep can therefore confirm the `agent_activity` row and still
 * leave `token_launch_intents.token_address` NULL and `launched_tokens` empty.
 *
 * THIS IS NOT THE PRIMARY PATH. The launch handler decodes its own receipt and
 * writes both records inline; that is where a healthy launch is completed. This
 * sweep exists for the window the handler cannot cover — a crash, a kill, or a
 * power loss between the create being mined and the identity being persisted.
 * Without it, "launched tokens are saved" would be a best-effort claim.
 *
 * ── Its guarantees ─────────────────────────────────────────────────────────
 *
 * SAFE TO RE-RUN. `launchedTokens.record` upserts on the case-insensitive
 * identity index (`ON CONFLICT (chain_id, LOWER(token_address)) DO NOTHING`), so
 * running this twice, or racing the handler, converges on exactly one row.
 *
 * NEVER INVENTS AN ADDRESS. If the receipt is missing, unreadable, carries no
 * decodable `TokenCreated`, or the lookup throws, the intent stays
 * `broadcast_pending` and is retried on the next tick. Ambiguity NEVER
 * terminalizes — the same rule the staged-broadcast and activity-repair paths
 * follow, and for the same reason: a launch marked failed is a launch the user
 * may try again, and the first `create` may already have minted their token.
 *
 * NEVER RE-BROADCASTS AND NEVER SIGNS. The dependency surface is exactly ONE
 * read-only receipt lookup. This module holds no signer and imports no
 * send/broadcast/sign capability, by construction.
 *
 * A PROVEN REVERT IS THE ONE TERMINAL ANSWER it may write (`terminal_failure`).
 * That is not a weakening of the rule above: the receipt says the create did not
 * happen, so there is no token to lose. Everything short of that literal status
 * is ambiguity and stays pending.
 *
 * LOOKUP-ONLY AND SESSION-SAFE. The candidate query is global (its rows span
 * arbitrary sessions), but every WRITE goes back through the session-scoped CAS
 * writers in `db/repos/token-launch-intents.ts`, under
 * `withSessionControlLock` keyed by the session id carried on the row it just
 * read — so a launch intent transition made here serializes with the compaction
 * safe-moment gate exactly like one made by the handler.
 */

import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import { stampLaunchOutputIdentityByTxHash } from "@vex-agent/db/repos/agent-activity.js";
import {
  claimBroadcastPendingForSweep,
  confirmWith,
  failWith,
  type TokenLaunchIntent,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/**
 * Bounded batch per sweep run, mirroring `REPAIR_BATCH_LIMIT`: the sweep does
 * serial RPC reads inside the shared sync worker, and an unbounded backlog would
 * starve the balance and activity sync sharing the same drain. The remainder is
 * picked up next tick — `claimBroadcastPendingForSweep` serves the
 * least-recently-checked first and stamps every row it hands out, so an
 * ambiguous row moves to the back of the queue and the window always advances
 * rather than re-serving the same 25 rows forever.
 */
export const LAUNCH_REPAIR_BATCH_LIMIT = 25;

export interface LaunchReceiptLookupInput {
  readonly chainId: number;
  readonly txHash: string;
  /** The creator to cross-check `TokenCreated` against — never a stranger's create in the same receipt. */
  readonly walletAddress: string;
}

/** Native ETH, the unit the prebuy was SPENT in. */
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * What a confirmed launch receipt proves.
 *
 * `tokenAddress` is the address decoded from `TokenCreated`. A lookup that CAN
 * read the receipt but CANNOT decode the event must return `null` for the whole
 * result rather than a result with an empty address — "the transaction settled"
 * without "and here is the token" is not enough to complete a launch identity,
 * and a half-answer here would be written to the durable index.
 */
export interface LaunchReceiptIdentity {
  readonly tokenAddress: string;
}

/**
 * The THREE answers the chain can give about a staged create, and the reason
 * this is a union rather than a nullable identity.
 *
 * A create that is later proven to have REVERTED emits no `TokenCreated`, so an
 * identity-or-nothing lookup reported it exactly like "not mined yet" — and the
 * intent stayed `broadcast_pending` forever, with the user's launch stuck in a
 * limbo the UI cannot explain. A PROVEN revert is terminal. Everything else
 * (`null`) is ambiguity, and ambiguity is never terminal.
 */
export type LaunchReceiptOutcome =
  | { readonly kind: "created"; readonly identity: LaunchReceiptIdentity }
  | { readonly kind: "reverted" };

export interface LaunchIdentityRepairDeps {
  /**
   * The ONLY dependency this sweep may have. Read-only: a receipt lookup that
   * reports the mined status and, on success, decodes `TokenCreated`. Never a
   * send/broadcast/sign capability.
   *
   * `null` means "no answer yet" — not yet mined, a transient RPC error, an
   * unreadable receipt, or a SUCCESSFUL receipt with no decodable
   * `TokenCreated`. All of those leave the intent `broadcast_pending`.
   */
  readonly resolveLaunchOutcome: (
    input: LaunchReceiptLookupInput,
  ) => Promise<LaunchReceiptOutcome | null>;
}

export interface LaunchIdentityRepairResult {
  readonly checked: number;
  /** Intents moved `broadcast_pending → confirmed` by THIS run. */
  readonly repaired: number;
  /** Rows inserted into `launched_tokens` by THIS run (0 when the handler already wrote them). */
  readonly indexed: number;
  /** Intents moved `broadcast_pending → terminal_failure` by a PROVEN on-chain revert. */
  readonly failed: number;
  readonly stillPending: number;
}

export async function repairLaunchIdentities(
  deps: LaunchIdentityRepairDeps,
): Promise<LaunchIdentityRepairResult> {
  const candidates = await claimBroadcastPendingForSweep(LAUNCH_REPAIR_BATCH_LIMIT);
  let repaired = 0;
  let indexed = 0;
  let failed = 0;
  let stillPending = 0;

  for (const intent of candidates) {
    const outcome = await lookupOutcome(deps, intent);
    if (outcome === null) {
      stillPending++;
      continue;
    }

    if (outcome.kind === "reverted") {
      // PROVEN not to have happened. No identity row and no confirm: a reverted
      // create minted nothing, so writing either would put a token that does
      // not exist into the user's launch history.
      const terminalized = await withSessionControlLock(intent.sessionId, (client) =>
        failWith(client, intent.intentId, intent.sessionId, "MinedRevert:create"));
      if (terminalized) failed++;
      else logger.info("trench.launch_identity_repair.revert_cas_miss", { intentId: intent.intentId });
      continue;
    }

    const identity = outcome.identity;

    // ORDER MATTERS. The durable identity index is written FIRST, because it is
    // idempotent and because it is the record the user's launch history is
    // built from. Confirming the intent first and then crashing would leave a
    // `confirmed` launch with no row in `launched_tokens` and NOTHING to bring
    // it back: the candidate query only sees `broadcast_pending`. Writing the
    // index first and then crashing merely leaves this intent for the next tick,
    // where the upsert makes the retry free.
    const indexWrite = await launchedTokens.record({
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      tokenAddress: identity.tokenAddress,
      name: intent.name,
      symbol: intent.symbol,
      imageRef: intent.imageId,
      createTxHash: requireTxHash(intent),
      // The AUTHORIZED NATIVE prebuy — wei, 18 decimals, denominated in what
      // was SPENT. It is known from the intent itself and needs no receipt
      // decode, which is exactly why the sweep can complete a launch identity
      // without ever reading an amount off the chain.
      ...nativePrebuyColumns(intent),
      sessionId: intent.sessionId,
    });
    if (indexWrite.inserted) indexed++;

    // The launch's `agent_activity` row learns the token it created. Without
    // this the row keeps `token_out_address` NULL and the app's token history —
    // which matches on exactly that column — never shows the launch in the
    // history of its own token. Identity only: this sweep proves no amount, so
    // it never touches status or the executed legs.
    await stampLaunchOutputIdentityByTxHash(requireTxHash(intent), identity.tokenAddress);

    const confirmed = await withSessionControlLock(intent.sessionId, (client) =>
      confirmWith(client, intent.intentId, intent.sessionId, identity.tokenAddress));
    if (confirmed) {
      repaired++;
    } else {
      // A CAS miss is not a failure: the handler's own late finalize, or a
      // concurrent sweep run, already confirmed this intent. The index write
      // above was idempotent, so nothing was double-counted.
      logger.info("trench.launch_identity_repair.duplicate_cas_miss", {
        intentId: intent.intentId,
      });
    }
  }

  return { checked: candidates.length, repaired, indexed, failed, stillPending };
}

/**
 * The `initial_buy_*` triple, in ONE convention shared with the launch handler:
 * no prebuy → all three NULL.
 *
 * A ZERO prebuy is "no prebuy", so writing `"0"` with decimals and a token
 * address (as this sweep used to) made the same launch look different depending
 * on WHICH writer got there first — the handler's row said "none", the sweep's
 * said "zero ETH of native". `my-launches` renders whatever it finds, so that
 * divergence was user-visible.
 */
function nativePrebuyColumns(intent: TokenLaunchIntent): {
  initialBuyRaw: string | null;
  initialBuyDecimals: number | null;
  initialBuyTokenAddress: string | null;
} {
  const raw = intent.prebuyRaw;
  const hasPrebuy = raw !== null && raw !== "" && BigInt(raw) > 0n;
  if (!hasPrebuy) {
    return { initialBuyRaw: null, initialBuyDecimals: null, initialBuyTokenAddress: null };
  }
  return {
    initialBuyRaw: raw,
    initialBuyDecimals: intent.prebuyDecimals,
    initialBuyTokenAddress: NATIVE_ADDRESS,
  };
}

/**
 * `null` on every ambiguity, and a thrown lookup is one of them — the sweep must
 * never let a transient RPC failure terminalize a launch or crash the shared
 * sync worker.
 */
async function lookupOutcome(
  deps: LaunchIdentityRepairDeps,
  intent: TokenLaunchIntent,
): Promise<LaunchReceiptOutcome | null> {
  const txHash = intent.txHash;
  if (!txHash) {
    // The DB CHECK makes this unreachable for `broadcast_pending`, and the
    // candidate query filters it too. Belt and braces: never look up "null".
    return null;
  }
  try {
    const outcome = await deps.resolveLaunchOutcome({
      chainId: intent.chainId,
      txHash,
      walletAddress: intent.walletAddress,
    });
    if (outcome === null) return null;
    if (outcome.kind === "reverted") return outcome;
    return outcome.identity.tokenAddress.length > 0 ? outcome : null;
  } catch (err) {
    logger.warn("trench.launch_identity_repair.lookup_failed", {
      intentId: intent.intentId,
      chainId: intent.chainId,
      // `summarizeProtocolError` is the canonical scrub boundary — a bare
      // `redact()` detects secret SHAPES only, and an RPC error can carry URLs,
      // request/response bodies and auth headers.
      error: summarizeProtocolError(err).message,
    });
    return null;
  }
}

/**
 * The production wiring: a read-only receipt lookup on the launch venue's chain.
 *
 * READ-ONLY BY CONSTRUCTION. The only chain capability reached here is
 * `getTransactionReceipt`; no signer, no wallet client, no send. The decode is
 * the SAME `decodeLaunchReceipt` the handler's primary path uses, so the sweep
 * cannot disagree with the handler about which token a receipt proves.
 *
 * `reverted` is reported ONLY for the literal `"reverted"` status. viem's
 * formatter yields `null` for a status it does not recognise, and mapping
 * "not success" to "reverted" would turn an unreadable receipt into an
 * irreversible terminal failure.
 */
export function buildProductionLaunchRepairDeps(): LaunchIdentityRepairDeps {
  return {
    resolveLaunchOutcome: async ({ chainId, txHash, walletAddress }) => {
      const { getLocalChain } = await import("@tools/evm-chains/registry.js");
      const chain = getLocalChain(chainId);
      if (!chain) return null;
      const { getLocalPublicClient } = await import("@tools/evm-chains/evm-client.js");
      const { decodeLaunchReceipt } = await import(
        "@vex-agent/tools/protocols/trench/handlers/launch/settlement.js"
      );
      const { TRENCH_DIAMOND_ADDRESS } = await import("@tools/trench-express/constants.js");

      const receipt = await getLocalPublicClient(chain).getTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
      const status: unknown = receipt.status;
      if (status === "reverted") return { kind: "reverted" };
      if (status !== "success") return null;

      const decoded = decodeLaunchReceipt({
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as string[],
          data: log.data,
        })),
        diamond: TRENCH_DIAMOND_ADDRESS as `0x${string}`,
        wallet: walletAddress as `0x${string}`,
        // The sweep never reads an AMOUNT off the chain — the authorized native
        // prebuy comes from the intent. Only the identity is decoded here.
        expectPrebuy: false,
      });
      return decoded === null ? null : { kind: "created", identity: { tokenAddress: decoded.tokenAddress } };
    },
  };
}

function requireTxHash(intent: TokenLaunchIntent): string {
  if (!intent.txHash) {
    throw new Error(
      `trench.launch_identity_repair: intent ${intent.intentId} is broadcast_pending with no tx hash`,
    );
  }
  return intent.txHash;
}
