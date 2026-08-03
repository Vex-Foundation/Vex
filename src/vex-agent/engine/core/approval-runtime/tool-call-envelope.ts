/**
 * The `approval_queue.tool_call` JSONB contract — written at enqueue, read at
 * cold resume.
 *
 * WHY THIS MODULE EXISTS. A discovered protocol tool is offered to the model as
 * a real function whose name is the dotted toolId with `.` → `__`
 * (`registry/injected-protocol-tools.ts`). That lane is gated on the
 * SESSION-SCOPED, PROCESS-LOCAL discovered set (`registry/discovered-tools.ts`)
 * — deliberately not persisted. So storing `kyberswap__swap__execute` as the
 * approval's tool name made the approval only as durable as the process: after
 * a restart the discovered set is empty, the injected lane refuses the name as
 * "not discovered in this session", and the human's click on Approve failed a
 * money-path action that had already passed every gate.
 *
 * THE FIX, and its deliberate limits. At enqueue an injected direct call is
 * CANONICALIZED into the internal `execute_tool {toolId, params}` envelope
 * inside the SAME JSONB field. Cold resume then flows down the already-working
 * `execute_tool` route, which resolves the manifest from the catalog (durable,
 * process-independent) rather than from a session set. There is no new column,
 * no rewrite of stored rows, and no new provenance lane: the resume path was
 * already non-model-originated (`post-tx/dispatch-approved/resumed-tool-context.ts`).
 * `execute_tool` stays closed to the model — the dispatcher rejects a
 * MODEL-ORIGINATED call to it by name.
 *
 * MANIFEST IDENTITY FAILS CLOSED. The envelope also carries a fingerprint of
 * the manifest the human actually approved. If the contract behind the toolId
 * changed while the approval sat in the queue, the resume REFUSES instead of
 * executing against a different contract. The fingerprint deliberately covers
 * only what changes the action — toolId, `mutating`, `actionKind`, and the
 * structural param schema (key, type, required, unit). DESCRIPTION PROSE IS
 * EXCLUDED: description churn is constant in this repo and must never strand a
 * queued approval.
 *
 * HISTORICAL ROWS ARE UNTOUCHED. A row without the `vex` block is replayed
 * exactly as before — no fingerprint, no identity check, same dispatch.
 */

import { z } from "zod";
import { createHash } from "node:crypto";

import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import {
  fromInjectedToolName,
  isInjectedToolNameShape,
} from "@vex-agent/tools/registry/injected-protocol-tools.js";

/** Current envelope-metadata version. Bump only with a reader for the old value. */
const ENVELOPE_VERSION = 1;

const envelopeMetadataSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  /** The function name the model actually called — audit only, never dispatched. */
  originalToolName: z.string().min(1),
  manifestFingerprint: z.string().min(1),
});

/**
 * Build the `tool_call` JSONB payload for an approval enqueue.
 *
 * An injected direct call becomes the `execute_tool` envelope plus the identity
 * metadata; every other call keeps today's `{command, args}` shape byte for
 * byte, so the internal, alias and legacy lanes are unchanged.
 */
export function buildApprovalToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Record<string, unknown> {
  const manifest = resolveInjectedManifest(toolName);
  if (!manifest) return { command: toolName, args: toolArgs };

  return {
    command: "execute_tool",
    args: { toolId: manifest.toolId, params: toolArgs },
    vex: {
      v: ENVELOPE_VERSION,
      originalToolName: toolName,
      manifestFingerprint: computeManifestFingerprint(manifest),
    },
  };
}

export type ApprovalManifestIdentity =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly refusal: string };

/**
 * Verify at resume that the manifest behind the stored toolId is still the one
 * the human approved. `ok` for any row without the metadata block (historical
 * rows and every non-canonicalized lane).
 */
export function checkApprovalManifestIdentity(
  rawToolCall: Record<string, unknown>,
): ApprovalManifestIdentity {
  const parsed = envelopeMetadataSchema.safeParse(rawToolCall.vex);
  if (!parsed.success) {
    if (rawToolCall.vex === undefined) return { ok: true };
    return {
      ok: false,
      reason: "envelope_metadata_unreadable",
      refusal: buildIdentityRefusal(
        "this approval's stored tool contract could not be read",
      ),
    };
  }

  const args = (rawToolCall.args ?? {}) as Record<string, unknown>;
  const toolId = typeof args.toolId === "string" ? args.toolId : "";
  const manifest = toolId ? getProtocolManifest(toolId) : undefined;
  if (!manifest) {
    return {
      ok: false,
      reason: "manifest_missing",
      refusal: buildIdentityRefusal(
        `the tool "${toolId || parsed.data.originalToolName}" is no longer available`,
      ),
    };
  }

  if (computeManifestFingerprint(manifest) !== parsed.data.manifestFingerprint) {
    return {
      ok: false,
      reason: "manifest_fingerprint_mismatch",
      refusal: buildIdentityRefusal(
        `the tool contract for "${manifest.toolId}" changed after this approval was requested`,
      ),
    };
  }

  return { ok: true };
}

/**
 * Structural identity of a manifest: what it does and what it takes.
 *
 * Params are sorted by key so a manifest reordering — which changes nothing a
 * caller can observe — does not invalidate a queued approval, while an added,
 * removed, retyped, newly required or re-united param does.
 */
export function computeManifestFingerprint(manifest: ProtocolToolManifest): string {
  const params = manifest.params
    .map((param) => ({
      key: param.key,
      type: param.type,
      required: param.required === true,
      unit: param.unit ?? null,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return createHash("sha256")
    .update(
      JSON.stringify({
        toolId: manifest.toolId,
        mutating: manifest.mutating === true,
        actionKind: manifest.actionKind,
        params,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

function resolveInjectedManifest(toolName: string): ProtocolToolManifest | undefined {
  if (!isInjectedToolNameShape(toolName)) return undefined;
  return getProtocolManifest(fromInjectedToolName(toolName));
}

/**
 * Agent- and user-facing refusal. States what actually happened, that NOTHING
 * ran, and the one way forward (rule 04: a failed money-path action names its
 * real cause). No provider text, no ids beyond the toolId itself.
 */
function buildIdentityRefusal(cause: string): string {
  return (
    `Approved action refused: ${cause}. Nothing was executed and no funds moved. ` +
    `Call the tool again with the parameters you want and request a fresh approval.`
  );
}
