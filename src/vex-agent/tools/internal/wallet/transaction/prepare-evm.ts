/**
 * `WalletEvmTransactionPrepare`. Signs nothing, spends nothing, writes ONE
 * durable `wallet_transaction_intents` row.
 *
 * The order of operations is the contract, and each step exists because the
 * next one would otherwise be dishonest:
 *
 *  1. validate shape, and refuse a caller-supplied redirect field BY NAME;
 *  2. resolve the chain and the session's selected wallet ADDRESS (no decrypt);
 *  3. DECODE fail-closed, before anything else - an undecodable proposal has no
 *     preview, so there is nothing a user could approve;
 *  4. simulate with `eth_call` from the selected wallet, surfacing the decoded
 *     revert reason;
 *  5. require the MANDATORY fee bounds; a missing cap refuses BY NAME and
 *     carries the current network estimate as a labelled hint;
 *  6. compute the VERSIONED proposal digest over every sign-relevant field;
 *  7. INSERT the intent under the session control lock (T1).
 *
 * Steps 3 to 6 all run BEFORE step 7, so every refusal above leaves no row
 * behind and nothing to cancel.
 */

import { randomUUID } from "node:crypto";

import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../resolve.js";
import { WALLET_INTENT_TTL_MS } from "../send-types.js";
import { fail, ok } from "../send/results.js";

import { decodeEvmTransaction } from "./decode-evm.js";
import {
  defaultEvmPrepareChainFactory,
  type EvmPrepareChainFactory,
  type EvmSimulationCall,
} from "./chain-seams.js";
import { forbiddenRedirectFieldRefusal, parseEvmFeeBounds } from "./fee-bounds.js";
import { canonicalTransactionPreview } from "./preview.js";
import { computeProposalDigest } from "./proposal-digest.js";
import { refusalToResult, requireHexData, requireString } from "./tool-io.js";
import {
  approvedPerGasCapWei,
  quoteWalletTxVexFee,
  walletTxFeeVenue,
  walletTxVexFeeDisclosure,
} from "./vex-fee.js";

export interface EvmPrepareDeps {
  readonly chainFactory: EvmPrepareChainFactory;
}

const DEFAULT_DEPS: EvmPrepareDeps = { chainFactory: defaultEvmPrepareChainFactory };

export async function handleWalletEvmTransactionPrepare(
  params: Record<string, unknown>,
  context: InternalToolContext,
  deps: EvmPrepareDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  // 1. Forbidden redirect fields are answered FIRST, before any other
  // validation, so a caller who passed `from` learns that rather than learning
  // about an unrelated missing field and re-sending `from` again.
  const forbidden = forbiddenRedirectFieldRefusal(params);
  if (forbidden !== null) return refusalToResult(forbidden);

  const chainInput = requireString(params, "chain");
  if (!chainInput.ok) return refusalToResult(chainInput.refusal);
  const to = requireString(params, "to");
  if (!to.ok) return refusalToResult(to.refusal);
  const data = requireHexData(params, "data");
  if (!data.ok) return refusalToResult(data.refusal);
  const valueWei = requireString(params, "valueWei", "0");
  if (!valueWei.ok) return refusalToResult(valueWei.refusal);
  if (!/^(0|[1-9][0-9]{0,77})$/.test(valueWei.value)) {
    return fail(
      "`valueWei` must be a RAW decimal integer string of wei (never a human decimal such as \"0.1\", "
      + "and never a JSON number).",
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(to.value)) {
    return fail("`to` must be a 20-byte 0x-prefixed EVM address.");
  }

  // 2. Address only. Prepare never reaches key material.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const chain = await deps.chainFactory(chainInput.value);

  // 3. Decode, fail closed. Nothing below runs on undecoded bytes.
  const decoded = await decodeEvmTransaction(
    { to: to.value, data: data.value, valueWei: valueWei.value, chainId: chain.chainId },
    chain,
  );
  if (!decoded.ok) return refusalToResult(decoded.refusal);

  const call: EvmSimulationCall = {
    from: walletAddress,
    to: to.value,
    data: data.value,
    valueWei: valueWei.value,
  };

  // 4. Simulate. A proposal that cannot execute now must not become an intent
  // the user is asked to approve.
  const simulated = await chain.simulate(call);
  if (!simulated.ok) return refusalToResult(simulated.refusal);

  // 5. MANDATORY bounds. The estimate is fetched only to LABEL the refusal.
  const feeBounds = parseEvmFeeBounds(params, await chain.estimateFees(call));
  if (!feeBounds.ok) return refusalToResult(feeBounds.refusal);

  // The Vex fee, from the caps just accepted and the raw value. The card below
  // renders the same decision from the same two facts through the canonical
  // renderer, so the number the caller is told and the number the human reads
  // are one computation.
  const feeVenue = walletTxFeeVenue({
    chainSlug: chain.chainAlias,
    nativeSymbol: chain.nativeSymbol,
    nativeDecimals: chain.nativeDecimals,
  });
  const perGasCapWei = approvedPerGasCapWei(feeBounds.value);
  const feeQuote =
    perGasCapWei === null ? null : quoteWalletTxVexFee(BigInt(valueWei.value), perGasCapWei);
  const vexFee =
    feeQuote === null
      ? null
      : {
          ...walletTxVexFeeDisclosure(feeVenue, feeQuote),
          // The ceiling the fee's OWN transfer is signed under, stated because
          // it is IN ADDITION to the transaction's own network fee.
          maxNetworkFeeWei: feeQuote.maxNetworkFeeWei.toString(),
          ...(feeQuote.charged ? {} : { reason: feeQuote.reason }),
        };

  const intentId = `wtx-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + WALLET_INTENT_TTL_MS).toISOString();
  // THE canonical card, rendered from bound fields only. The digest below
  // renders the identical value from the identical fields, so the stored
  // preview and the digested preview cannot start out disagreeing.
  const preview = canonicalTransactionPreview({
    family: "eip155",
    chainAlias: chain.chainAlias,
    decoded: decoded.value,
    feeBounds: feeBounds.value,
    evmValueWei: valueWei.value,
  });

  // 6. The digest covers the payload AND the authority fields around it.
  const digest = computeProposalDigest({
    intentId,
    family: "eip155",
    walletAddress,
    chainAlias: chain.chainAlias,
    chainId: chain.chainId,
    payload: { to: to.value.toLowerCase(), data: data.value.toLowerCase(), valueWei: valueWei.value },
    decoded: decoded.value,
    feeBounds: feeBounds.value,
    recentBlockhash: null,
    lastValidBlockHeight: null,
    expiresAt,
  });

  // 7. T1. Under the session control lock, DB-only, committed before anything
  // else: creating the row is the moment the session gains live money state.
  await withSessionControlLock(context.sessionId, (client) =>
    intentsRepo.createWith(client, {
      intentId,
      sessionId: context.sessionId,
      walletAddress,
      family: "eip155",
      chainAlias: chain.chainAlias,
      chainId: chain.chainId,
      payload: {
        family: "eip155",
        evm: { to: to.value, data: data.value, valueWei: valueWei.value },
      },
      decoded: decoded.value,
      preview,
      feeBounds: feeBounds.value,
      proposalDigest: digest.digest,
      proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
      recentBlockhash: null,
      lastValidBlockHeight: null,
      expiresAt,
    }),
  );

  return ok({
    intentId,
    walletFamily: "eip155",
    chain: chain.chainAlias,
    chainId: chain.chainId,
    walletAddress,
    status: "prepared",
    expiresAt,
    preview,
    decoded: decoded.value,
    // Echoed so the caller can see exactly which caps the approval will carry
    // and which confirm will enforce.
    approvedFeeBounds: feeBounds.value,
    // THE VEX FEE, stated at prepare because it is part of what the approval
    // covers. Derived from the same bound fields the card renders it from and
    // the confirm path recomputes it from, so these three cannot disagree.
    vexFee,
    nativeCurrency: { symbol: chain.nativeSymbol, decimals: chain.nativeDecimals },
    message:
      "Prepared. Nothing was signed and nothing was spent. Confirm with "
      + "WalletEvmTransactionConfirm to broadcast it.",
  });
}
