/**
 * THE PRODUCTION WIRING of the launch identity sweep: how it asks the chain, and
 * WHICH decoder it dispatches per launchpad.
 *
 * One reason to change - the sweep's dependency on the outside world. The sweep
 * itself (`../launch-identity-repair.ts`) owns the transitions and never learns
 * what an RPC is.
 *
 * READ-ONLY BY CONSTRUCTION: the only chain capability reached here is
 * `getTransactionReceipt`. No signer, no wallet client, no send.
 */

import { getAddress } from "viem";

import { virtualsCurveDeploymentByChainId } from "@tools/virtuals/curve/index.js";
import { decodePreLaunched } from "@tools/virtuals/launch/index.js";
import logger from "@utils/logger.js";
import type { TokenLaunchIntent } from "@vex-agent/db/repos/token-launch-intents.js";
import { isReceiptNotFound } from "./receipt-errors.js";
import type {
  AuthorizedPoolsLaunchPlan,
  LaunchIdentityRepairDeps,
  LaunchReceiptOutcome,
} from "./types.js";

/**
 * The receipt lookup itself, dispatched per launchpad.
 *
 * Each decode is the SAME one the corresponding handler's primary path uses, so
 * the sweep cannot disagree with the handler about which token a receipt proves.
 *
 * `reverted` is reported ONLY for the literal `"reverted"` status. viem's
 * formatter yields `null` for a status it does not recognise, and mapping
 * "not success" to "reverted" would turn an unreadable receipt into an
 * irreversible terminal failure.
 */
export function buildProductionLaunchRepairDeps(): LaunchIdentityRepairDeps {
  return {
    resolveLaunchOutcome: async ({ chainId, txHash, walletAddress, protocol, poolsPlan }) => {
      const { getLocalChain } = await import("@tools/evm-chains/registry.js");
      const chain = getLocalChain(chainId);
      if (!chain) return null;
      const { getLocalPublicClient } = await import("@tools/evm-chains/evm-client.js");
      // The retired Trench Express launchpad. Its decoder is history-only
      // (`sync/legacy-trench-express/`): no new intent can carry
      // `protocol='trench'` since migration 108, but a `broadcast_pending` row
      // mined before it must still be reconciled to a token identity.
      const { decodeLaunchReceipt } = await import(
        "../legacy-trench-express/launch-settlement.js"
      );
      const { LEGACY_TRENCH_DIAMOND_ADDRESS } = await import(
        "../legacy-trench-express/constants.js"
      );

      const client = getLocalPublicClient(chain);

      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      } catch (err) {
        // NO RECEIPT. Before this, every such answer was the same quiet `null` —
        // "not mined yet" — which is why the owner's launch was re-checked for a
        // day without anyone learning that its nonce had already been consumed.
        // Ask the SECOND question exactly when the first one misses.
        if (!isReceiptNotFound(err)) throw err;
        return await classifyMissingLaunchReceipt(client, txHash);
      }

      const status: unknown = receipt.status;
      if (status === "reverted") return { kind: "reverted" };
      if (status !== "success") return null;

      if (protocol === "pools_fun") {
        return await decodePoolsLaunchForSweep(
          receipt.logs.map((log) => ({
            address: log.address,
            topics: log.topics as string[],
            data: log.data,
          })),
          walletAddress,
          poolsPlan,
        );
      }

      // THE VIRTUALS ARM. Without it a Virtuals `preLaunch` fell through to the
      // retired Trench decoder below, decoded to nothing, and was re-checked as
      // ambiguity forever - so the intent never reached `awaiting_keeper` and
      // the keeper sweep, which claims only that status, never saw it. The
      // user's agent existed on chain and nothing in Vex would ever finish it.
      if (protocol === "virtuals") {
        return decodeVirtualsPreLaunchForSweep({
          chainId,
          blockNumber: receipt.blockNumber,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: log.topics as string[],
            data: log.data,
          })),
        });
      }

      const decoded = decodeLaunchReceipt({
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as string[],
          data: log.data,
        })),
        diamond: LEGACY_TRENCH_DIAMOND_ADDRESS as `0x${string}`,
        wallet: walletAddress as `0x${string}`,
        // The sweep never reads an AMOUNT off the chain — the authorized native
        // prebuy comes from the intent. Only the identity is decoded here.
        expectPrebuy: false,
      });
      return decoded === null ? null : { kind: "created", identity: { tokenAddress: decoded.tokenAddress } };
    },
  };
}

/**
 * A launch hash with NO receipt: is it waiting, or has its nonce already been
 * consumed by something else?
 *
 * The nonce is NOT on `token_launch_intents` (migration 062 stores only
 * `tx_hash`, `wallet_address`, `chain_id`), so it is read from the sibling
 * `agent_activity` row that `markActivityBroadcast` staged. That is a lookup, not
 * an inference, and a missing sender or nonce yields `null` — "still waiting" —
 * because supersession is never guessed.
 *
 * The whole check runs under the SAME whole-observation deadline the pending
 * lane uses, through the EIP-1193 `request` that actually honours a signal.
 */
async function classifyMissingLaunchReceipt(
  client: unknown,
  txHash: string,
): Promise<LaunchReceiptOutcome | null> {
  const { asJsonRpcClient, observeEvmTransaction } = await import(
    "../agent-activity-repair/observation.js"
  );
  const { findBroadcastSenderByTxHash } = await import("@vex-agent/db/repos/agent-activity.js");

  const jsonRpc = asJsonRpcClient(client);
  if (!jsonRpc) return null;
  const sender = await findBroadcastSenderByTxHash(txHash);

  const observation = await observeEvmTransaction(jsonRpc, {
    chainId: 0, // unused by the observation; the client is already chain-bound
    txHash,
    fromAddress: sender?.fromAddress ?? null,
    nonce: sender?.nonce ?? null,
  });

  // ONLY a proven supersession is reported. `in_mempool`, `unknown_to_node` and
  // `rpc_error` all stay the quiet `null` this sweep's contract has always
  // promised for "no answer yet" — none of them establishes anything about the
  // launch, and this sweep must never terminalize on ambiguity.
  return observation.kind === "nonce_superseded" ? { kind: "superseded" } : null;
}

/**
 * The AUTHORIZED pools.fun plan for one intent, or `null` when it is not
 * complete enough to prove a receipt with.
 *
 * TWO SOURCES, AND ONE OF THEM IS UNTRUSTED. The pair, the recipient, the
 * predicted token and the gateway are COLUMNS (migration 082). The SALT is not:
 * it lives inside the C0 `authorization_json` blob, which is storage and is read
 * here exactly the way the user-submit path reads it - as untrusted input,
 * shape-checked before any value is used. A blob of the wrong shape yields
 * `null`, and the sweep then declines instead of proving a receipt against a
 * salt it invented.
 *
 * This is not the blob becoming a gate: nothing here decides that a launch
 * happened. The chain does. The plan only says WHICH launch the receipt would
 * have to be, and the decoder still refuses unless the receipt's own events
 * agree with every field.
 */
export function readAuthorizedPoolsPlan(intent: TokenLaunchIntent): AuthorizedPoolsLaunchPlan | null {
  if (intent.protocol !== "pools_fun") return null;
  const pools = intent.pools;
  if (pools === null) return null;

  const feeRecipient = pools.feeRecipientAddress ?? null;
  const pairedAsset = pools.pairedAssetAddress ?? null;
  const predictedTokenAddress = pools.predictedTokenAddress ?? null;
  const userSalt = readAuthorizedSalt(intent.authorizationJson);

  if (feeRecipient === null || pairedAsset === null || predictedTokenAddress === null || userSalt === null) {
    logger.info("pools.launch_identity_repair.plan_incomplete", {
      intentId: intent.intentId,
      hint: "the intent does not carry the full authorized plan (paired asset, fee recipient, predicted "
        + "token and salt), so a receipt cannot be proven to be THIS launch. Left pending, never guessed.",
    });
    return null;
  }
  return {
    feeRecipient,
    pairedAsset,
    userSalt,
    predictedTokenAddress,
    gateway: pools.gatewayAddress ?? null,
    // COLUMNS, not the blob (migration 109). Without this the sweep would hold a
    // holders launch's receipt to the SENTINEL that was signed, which the
    // gateway resolved away before emitting - and this sweep is the only thing
    // that settles a launch whose broadcast came back ambiguous.
    holderRewards:
      pools.holderRewards == null
        ? null
        : { mode: pools.holderRewards.mode, sentinel: pools.holderRewards.sentinel },
  };
}

/** The 32-byte salt inside the C0 blob, or `null` for anything else. */
function readAuthorizedSalt(authorizationJson: unknown): string | null {
  if (authorizationJson === null || typeof authorizationJson !== "object") return null;
  const binding = (authorizationJson as { binding?: unknown }).binding;
  if (binding === null || typeof binding !== "object") return null;
  const salt = (binding as { userSalt?: unknown }).userSalt;
  return typeof salt === "string" && /^0x[0-9a-fA-F]{64}$/.test(salt) ? salt : null;
}

/**
 * The pools.fun half of the sweep's decode.
 *
 * It proves the receipt against the same authorized plan the handler's primary
 * path proves it against, so the two cannot disagree about which token a receipt
 * establishes. Every refusal is the DECODER's own reason, logged once: "not our
 * launch" and "a receipt shape we cannot read" are different facts, and a later
 * reader needs to know which one happened.
 */
async function decodePoolsLaunchForSweep(
  logs: readonly { address: string; topics: string[]; data: string }[],
  walletAddress: string,
  plan: AuthorizedPoolsLaunchPlan | null,
): Promise<LaunchReceiptOutcome | null> {
  if (plan === null) return null;

  const { decodePoolsLaunchSettlement } = await import("../pools-settlement-decoder.js");
  const decoded = decodePoolsLaunchSettlement(
    logs,
    {
      launcher: walletAddress as `0x${string}`,
      feeRecipient: plan.feeRecipient as `0x${string}`,
      pairedAsset: plan.pairedAsset as `0x${string}`,
      userSalt: plan.userSalt as `0x${string}`,
      predictedTokenAddress: plan.predictedTokenAddress as `0x${string}`,
      holderRewards:
        plan.holderRewards === null
          ? null
          : {
            mode: plan.holderRewards.mode,
            sentinel: plan.holderRewards.sentinel as `0x${string}`,
          },
    },
    // The gateway the plan recorded SELECTS THE SUITE, and its factory comes
    // with it. A row from before migration 082 carries none; the decoder then
    // discovers the suite from the receipt itself and requires exactly one to
    // have emitted both events, which is stricter than the pinned-V1 default it
    // replaces - that default declined every V2 and V3 launch by construction.
    plan.gateway === null ? {} : { gateway: plan.gateway },
  );

  if (!decoded.ok) {
    // AMBIGUITY IS NEVER TERMINAL - and never silent either.
    logger.info("pools.launch_identity_repair.undecoded", { reason: decoded.reason });
    return null;
  }
  return { kind: "created", identity: { tokenAddress: decoded.value.tokenAddress } };
}

/**
 * The Virtuals half of the sweep's decode: the `PreLaunched` event of OUR
 * pre-launch, read from its own receipt.
 *
 * It uses the SAME decoder the handler's primary path uses
 * (`tools/virtuals/launch/receipt-decoder.ts`), so the two cannot disagree
 * about which agent a receipt establishes, and that decoder requires the log to
 * come from the PINNED BondingV5 - any contract can emit a log whose topic0
 * matches, and a decoder that accepted one would let a stranger name the token
 * a launch is recorded against.
 *
 * There is no creator cross-check here and none is available: `PreLaunched`
 * carries no creator field. The binding is the RECEIPT - the sweep looked this
 * up by the intent's own signed transaction hash - which is strictly stronger
 * than an address comparison inside a receipt that could hold several launches.
 *
 * `null` on anything it cannot read, which the sweep treats as ambiguity and
 * re-checks. Recovery is where a wrong answer is least likely to be noticed, so
 * it declines rather than decoding loosely.
 */
function decodeVirtualsPreLaunchForSweep(input: {
  readonly chainId: number;
  readonly blockNumber: bigint | null | undefined;
  readonly logs: readonly { address: string; topics: string[]; data: string }[];
}): LaunchReceiptOutcome | null {
  const deployment = virtualsCurveDeploymentByChainId(input.chainId);
  if (deployment === undefined) {
    logger.info("virtuals.launch_identity_repair.no_deployment", { chainId: input.chainId });
    return null;
  }
  const blockNumber = input.blockNumber;
  if (typeof blockNumber !== "bigint") {
    // The keeper sweep scans FROM this block. Without it the recovered row
    // would either be unusable to that sweep or force a scan from genesis on
    // every tick, so the launch stays pending until a receipt that carries one.
    logger.info("virtuals.launch_identity_repair.receipt_block_missing", { chainId: input.chainId });
    return null;
  }

  const preLaunched = decodePreLaunched({
    logs: input.logs,
    bondingV5: getAddress(deployment.bondingV5),
  });
  if (preLaunched === null) {
    logger.info("virtuals.launch_identity_repair.prelaunch_undecoded", { chainId: input.chainId });
    return null;
  }

  return {
    kind: "pre_launched",
    virtuals: {
      tokenAddress: preLaunched.token,
      pairAddress: preLaunched.pair,
      virtualId: preLaunched.virtualId.toString(),
      initialPurchaseRaw: preLaunched.initialPurchaseRaw.toString(),
      // The deployment's PINNED decimals, the same ones the launch handler
      // parsed the committed amount with. An amount without its scale is not a
      // number a person can read.
      initialPurchaseDecimals: deployment.virtualDecimals,
      virtualAddress: getAddress(deployment.virtual),
      preLaunchBlock: blockNumber.toString(),
    },
  };
}
