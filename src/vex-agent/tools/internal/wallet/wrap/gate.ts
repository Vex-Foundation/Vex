/**
 * Everything `WalletWrapConfirm` proves BEFORE anything is signed.
 *
 * Its own module because it is a different lifecycle owner from the execution
 * beside it: every path through here ends with the intent still `pending`,
 * nothing claimed, nothing decrypted and nothing broadcast, which is the shape
 * from which preparing again is safe. The execution half owns the opposite
 * property - once it starts, a transaction may exist on chain - and the two
 * change for unrelated reasons: this file changes when the AUTHORITY model
 * does, `confirm.ts` changes when the SIGNING path does.
 *
 * The order is the contract:
 *
 *   1. read the intent, SESSION-SCOPED; a cross-session id misses;
 *   2. revalidate the row: version, status, expiry, and the digest RECOMPUTED
 *      from the row's own bound fields;
 *   3. rebuild the approval binding, which re-renders the card and compares it;
 *   4. resolve the APPROVAL-BOUND digest, fail-closed on an approved resume;
 *   5. THE APPROVAL GATE - a restricted session stops here;
 *   6. prove the session's selected ADDRESS is the approved wallet, without
 *      decrypting anything, and capture the authority anchor;
 *   7. at commit time, re-resolve the chain, re-read the verified contract, and
 *      RE-DERIVE the `{ to, data, value }` triple to compare byte for byte.
 *
 * WHY THE DIGEST IS RECOMPUTED AND NOT READ. `bindingFromDurableWrapIntent`
 * reports the STORED digest, because a binding's job is to say what an approval
 * will be bound to; comparing that against the row it came from would compare a
 * value to itself. The card comparison is not a substitute either: the preimage
 * binds `intentId`, `walletAddress` and `payload.data`, none of which the card
 * renders, so an edit to any of them leaves the card identical.
 */

import { getWrappedNativeContract } from "@tools/evm-chains/wrapped-native.js";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import * as wrapIntentsRepo from "@vex-agent/db/repos/wallet-wrap-intents.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";
import { WRAP_PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import { readApprovalProposalBinding } from "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js";
import {
  buildDurableApprovalCard,
  durableApprovalCardMatches,
  readEnvelopeToolName,
} from "@vex-agent/engine/core/approval-runtime/durable-approval-card.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "../resolve.js";
import { captureAuthorityAnchor, type AuthorityAnchor } from "../transaction/authority-fence.js";

import {
  deriveWrapTransaction,
  wrapTransactionsEqual,
  type WrapTransaction,
} from "./calldata.js";
import { canonicalPreviewOfWrapIntent, wrapPreviewsEqual } from "./preview.js";
import {
  bindingFromDurableWrapIntent,
  recomputeWrapProposalDigest,
} from "./proposal-digest.js";
import { accept, refuse, type WrapOutcome } from "./refusal.js";
import { requireWrapString, wrapRefusalToResult } from "./tool-io.js";

// ── Steps 1 to 6: the gate ────────────────────────────────────────────

export type WrapGateOutcome =
  | { readonly kind: "return"; readonly result: ToolResult }
  | {
      readonly kind: "proceed";
      readonly intent: WalletWrapIntent;
      readonly anchor: AuthorityAnchor;
      readonly loadSigner: () => WrapSignerLoad;
    };

/** The signer, or the `ToolResult` explaining why nothing will be signed. */
export type WrapSignerLoad =
  | { readonly kind: "return"; readonly result: ToolResult }
  | { readonly kind: "signer"; readonly signer: EvmWallet };

/**
 * Row-level revalidation. Every refusal here leaves the intent `pending`, with
 * nothing signed and nothing claimed, which is the shape from which preparing
 * again is safe.
 */
export function revalidateWrapIntentRow(
  intent: WalletWrapIntent,
  approvalBoundDigest: string | null,
  now: Date = new Date(),
): WrapOutcome<void> {
  if (intent.proposalDigestVersion !== WRAP_PROPOSAL_DIGEST_VERSION) {
    return refuse(
      "invalid_input",
      `Refusing to sign: wrap intent ${intent.intentId} carries proposal digest version `
      + `"${intent.proposalDigestVersion}", and this build computes "${WRAP_PROPOSAL_DIGEST_VERSION}". `
      + "A digest from a different serialization cannot be compared, so this is refused rather than "
      + "reported as proposal drift. Nothing was signed. Prepare the conversion again on this build.",
      { intentId: intent.intentId, storedVersion: intent.proposalDigestVersion },
    );
  }
  if (intent.status !== "pending") {
    return refuse(
      intent.status === "cancelled" ? "cancelled" : "already_consumed",
      `Refusing to sign: wrap intent ${intent.intentId} is ${intent.status}, and only a pending `
      + "intent may be confirmed. Nothing was signed and no funds moved.",
      { intentId: intent.intentId, status: intent.status },
    );
  }
  if (new Date(intent.expiresAt) <= now) {
    return refuse(
      "expired",
      `Refusing to sign: wrap intent ${intent.intentId} expired at ${intent.expiresAt}. Prepare the `
      + "conversion again to review current chain state and fees. Nothing was signed.",
      { intentId: intent.intentId, expiresAt: intent.expiresAt },
    );
  }

  // THE DIGEST, RECOMPUTED from the row's own bound fields. This must run
  // BEFORE the binding: the binding re-renders the CARD and would report an
  // edited amount as a changed description, which sends an operator looking for
  // the wrong thing. A moved bound field is digest drift, and it is named that.
  const recomputed = recomputeWrapProposalDigest(intent);
  if (!recomputed.ok) return recomputed;
  if (recomputed.value !== intent.proposalDigest) {
    return refuse(
      "digest_mismatch",
      `Refusing to sign: the proposal digest recomputed from wrap intent ${intent.intentId}'s own `
      + "stored fields does not match the digest stored beside them, so the row was changed after it "
      + "was prepared. Nothing was signed and no funds moved. Prepare the conversion again.",
      { intentId: intent.intentId },
    );
  }

  const binding = bindingFromDurableWrapIntent(intent);
  if (!binding.ok) return binding;

  if (approvalBoundDigest !== null && approvalBoundDigest !== intent.proposalDigest) {
    return refuse(
      "digest_mismatch",
      "Refusing to sign: the proposal this approval was granted for is not the proposal on this "
      + `intent. The approval is bound to the exact conversion the user read, so wrap intent `
      + `${intent.intentId} cannot be signed under it. Nothing was signed and no funds moved. `
      + "Prepare the conversion again and request a fresh approval.",
      { intentId: intent.intentId },
    );
  }
  return accept(undefined);
}

/**
 * The digest the APPROVAL was bound to, or `null` for a full-permission session
 * signing directly, which has no second digest to compare against.
 */
async function resolveWrapApprovalBoundDigest(
  context: InternalToolContext,
  intent: WalletWrapIntent,
): Promise<WrapOutcome<string | null>> {
  if (!context.approved) return accept<string | null>(null);

  const approvalId = context.approvalId;
  if (approvalId === undefined || approvalId === null || approvalId === "") {
    return refuse(
      "invalid_input",
      "Refusing to sign: this call is marked approved but names no approval, so Vex cannot check that "
      + "the approval was granted for this exact conversion. Nothing was signed and no funds moved. "
      + "Prepare the conversion again and approve it.",
      { intentId: intent.intentId },
    );
  }

  const approval = await approvalsRepo.getByIdForSession(approvalId, context.sessionId);
  if (approval === null) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval this call names does not exist for this session. Nothing was "
      + "signed and no funds moved.",
      { intentId: intent.intentId },
    );
  }

  const bound = readApprovalProposalBinding(approval.toolCall);
  if (bound === null) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval this call names carries no record of WHICH conversion was "
      + "approved, so it cannot authorize this one. Nothing was signed and no funds moved. Prepare "
      + "the conversion again and request a fresh approval.",
      { intentId: intent.intentId },
    );
  }

  const binding = bindingFromDurableWrapIntent(intent);
  if (!binding.ok) return binding;

  if (
    bound.resource.table !== binding.value.resource.table
    || bound.resource.intentId !== intent.intentId
  ) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval this call names was granted for a different prepared action, so "
      + "it does not authorize this intent. Nothing was signed and no funds moved.",
      { intentId: intent.intentId },
    );
  }

  // THE CARD, RE-DERIVED AND COMPARED. The row and the digest are proven above;
  // this proves the SENTENCE the human authorized, in the envelope the digest
  // covers AND in the durable card row they actually read. Two different rows,
  // two different edits, so both are checked.
  const canonical = canonicalPreviewOfWrapIntent(intent);
  if (!canonical.ok) return canonical;
  if (!wrapPreviewsEqual(bound.preview, canonical.value)) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the description recorded on this approval is not the description this "
      + `conversion produces, so wrap intent ${intent.intentId} is not the action the user authorized. `
      + "Nothing was signed and no funds moved. Prepare the conversion again and request a fresh "
      + "approval.",
      { intentId: intent.intentId },
    );
  }

  const card = await approvalIntentsRepo.getByApprovalId(approvalId);
  if (card === null) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval this call names has no recorded card, so what the user was "
      + `shown before approving wrap intent ${intent.intentId} cannot be checked. Nothing was signed `
      + "and no funds moved. Prepare the conversion again and request a fresh approval.",
      { intentId: intent.intentId },
    );
  }
  const toolName = readEnvelopeToolName(approval.toolCall);
  if (toolName === null) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval this call names does not record which tool it would run, so the "
      + `title the user read before approving wrap intent ${intent.intentId} cannot be checked. `
      + "Nothing was signed and no funds moved. Prepare the conversion again and request a fresh "
      + "approval.",
      { intentId: intent.intentId },
    );
  }
  const expected = buildDurableApprovalCard(toolName, {
    preview: canonical.value,
    intentExpiresAt: intent.expiresAt,
    resource: { intentId: intent.intentId },
  });
  if (!durableApprovalCardMatches(expected, card.previewJson)) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval card stored for this decision is not the card this conversion "
      + `produces, so what the user read is not what wrap intent ${intent.intentId} would do. Nothing `
      + "was signed and no funds moved. Prepare the conversion again and request a fresh approval.",
      { intentId: intent.intentId },
    );
  }

  return accept<string | null>(bound.proposalDigest);
}

export async function gateWrapConfirm(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<WrapGateOutcome> {
  const intentIdParam = requireWrapString(params, "intentId");
  if (!intentIdParam.ok) {
    return { kind: "return", result: wrapRefusalToResult(intentIdParam.refusal) };
  }
  const intentId = intentIdParam.value;

  const intent = await wrapIntentsRepo.getById(intentId, context.sessionId);
  if (intent === null) {
    return {
      kind: "return",
      result: wrapRefusalToResult({
        code: "invalid_input",
        message:
          `Refusing to sign: no prepared wrap intent ${intentId} exists for this session. An intent id `
          + "is scoped to the session that prepared it. Nothing was signed.",
        details: { intentId },
      }),
    };
  }

  const binding = bindingFromDurableWrapIntent(intent);
  if (!binding.ok) return { kind: "return", result: wrapRefusalToResult(binding.refusal) };

  const boundDigest = await resolveWrapApprovalBoundDigest(context, intent);
  if (!boundDigest.ok) return { kind: "return", result: wrapRefusalToResult(boundDigest.refusal) };

  const row = revalidateWrapIntentRow(intent, boundDigest.value);
  if (!row.ok) return { kind: "return", result: wrapRefusalToResult(row.refusal) };

  if (!context.approved && context.sessionPermission === "restricted") {
    return {
      kind: "return",
      result: {
        success: false,
        output:
          "This conversion needs approval before it can be signed. Nothing was signed and no funds "
          + `moved: wrap intent ${intentId} is still pending and will be consumed only after the user `
          + "confirms the exact proposal shown.",
        pendingApproval: true,
        actionKind: "user_wallet_broadcast",
        preparedApprovalBinding: binding.value,
      },
    };
  }

  // ADDRESS ONLY: this proves the session's selection is the approved wallet
  // WITHOUT decrypting anything. The key is loaded later, immediately before the
  // signature, once the authority fence has been re-asked.
  let signerAddress: string;
  try {
    signerAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return { kind: "return", result: walletScopeErrorToResult(err) };
  }
  if (signerAddress.toLowerCase() !== intent.walletAddress.toLowerCase()) {
    return {
      kind: "return",
      result: wrapRefusalToResult({
        code: "invalid_input",
        message:
          `Refusing to sign: wrap intent ${intentId} was prepared for a different wallet than the one `
          + "this session has selected. Signing from another address is never done quietly, so this "
          + "is refused. Nothing was signed. Select the original wallet and confirm again, or cancel.",
        details: { intentId },
      }),
    };
  }

  const anchored = await captureAuthorityAnchor({
    sessionId: intent.sessionId,
    family: "eip155",
    walletAddress: signerAddress,
    intentId: intent.intentId,
    gatePermission: context.sessionPermission,
  });
  if (!anchored.ok) {
    return {
      kind: "return",
      result: wrapRefusalToResult({
        code: "invalid_input",
        message: anchored.refusal.message,
        details: anchored.refusal.details,
      }),
    };
  }

  const loadSigner = (): WrapSignerLoad => {
    let signer;
    try {
      signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
    } catch (err) {
      return { kind: "return", result: walletScopeErrorToResult(err) };
    }
    if (signer.family !== "eip155" || signer.address.toLowerCase() !== intent.walletAddress.toLowerCase()) {
      return {
        kind: "return",
        result: wrapRefusalToResult({
          code: "invalid_input",
          message:
            `Refusing to sign: the key resolved for signing is not the wallet wrap intent ${intentId} `
            + "was approved for. Nothing was signed and no funds moved.",
          details: { intentId },
        }),
      };
    }
    return { kind: "signer", signer };
  };

  return { kind: "proceed", intent, anchor: anchored.value, loadSigner };
}

// ── Step 7: commit-time revalidation ──────────────────────────────────

/**
 * The chain identity, the CONTRACT identity, and the byte-for-byte
 * re-derivation. `null` means every check passed.
 */
export function revalidateWrapAtCommit(
  intent: WalletWrapIntent,
  chain: { readonly chainId: number; readonly chainAlias: string },
): WrapOutcome<WrapTransaction> {
  if (chain.chainId !== intent.chainId) {
    return refuse(
      "invalid_input",
      `Refusing to sign: the chain alias "${intent.chainAlias}" now resolves to chain id `
      + `${chain.chainId}, and wrap intent ${intent.intentId} was approved on chain id `
      + `${intent.chainId}. A re-registered alias is a different chain. Nothing was signed.`,
      { intentId: intent.intentId, approvedChainId: String(intent.chainId), resolvedChainId: String(chain.chainId) },
    );
  }

  // The registry is re-read at commit. A row whose bound contract is no longer
  // the verified one for its chain cannot be signed: either the registry was
  // corrected between prepare and now, in which case the human approved an
  // address this build no longer vouches for, or the row was edited.
  const verified = getWrappedNativeContract(intent.chainId);
  if (verified === undefined) {
    return refuse(
      "unverified_chain",
      `Refusing to sign: this build has no verified wrapped-native contract for chain id `
      + `${intent.chainId}, so the contract wrap intent ${intent.intentId} is bound to cannot be `
      + "vouched for. Nothing was signed.",
      { intentId: intent.intentId, chainId: String(intent.chainId) },
    );
  }
  if (
    verified.address.toLowerCase() !== intent.contract.address.toLowerCase()
    || verified.decimals !== intent.contract.decimals
  ) {
    return refuse(
      "payload_mismatch",
      `Refusing to sign: wrap intent ${intent.intentId} is bound to wrapped-native contract `
      + `${intent.contract.address}, and the verified contract for chain id ${intent.chainId} is `
      + `${verified.address}. Nothing was signed and no funds moved. Prepare the conversion again.`,
      { intentId: intent.intentId, boundContract: intent.contract.address, verifiedContract: verified.address },
    );
  }

  // THE RE-DERIVATION. Built from the bound direction, contract and amount, and
  // compared against the stored triple in ALL THREE fields.
  const rederived = deriveWrapTransaction({
    direction: intent.direction,
    contract: verified,
    amountRaw: BigInt(intent.amountRaw),
  });
  const stored: WrapTransaction = {
    to: intent.payload.to as `0x${string}`,
    data: intent.payload.data as `0x${string}`,
    valueWei: intent.payload.valueWei,
  };
  if (!wrapTransactionsEqual(rederived, stored)) {
    return refuse(
      "payload_mismatch",
      `Refusing to sign: the transaction re-derived from wrap intent ${intent.intentId}'s own approved `
      + "direction, contract and amount is not the transaction stored beside them, so the row was "
      + "changed after it was prepared. Nothing was signed and no funds moved. Prepare the conversion "
      + "again.",
      {
        intentId: intent.intentId,
        storedTo: stored.to,
        storedValueWei: stored.valueWei,
        derivedTo: rederived.to,
        derivedValueWei: rederived.valueWei,
      },
    );
  }

  return accept(rederived);
}
