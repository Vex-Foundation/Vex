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
 * executing against a different contract. The fingerprint covers EVERY field
 * that validation or normalization reads — toolId, `mutating`, `actionKind`,
 * the param schema (key, type, required, unit, enum, acceptsStringArray, and
 * the retired-spelling `aliases` when a param declares any) and
 * the three cross-param group fields (`exclusiveParamGroups`, `atMostOne`,
 * `atLeastOneOf`). A v1 fingerprint omitted the enum / array / group fields, so
 * a manifest could tighten admission under a queued approval and still resume;
 * v1 metadata is therefore REFUSED, not re-verified. DESCRIPTION PROSE IS
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
import { resolveInjectedProtocolTool } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import { resolveToolName } from "@vex-agent/tools/registry/name-resolution.js";

/**
 * Current envelope-metadata version.
 *
 * v2 (2026-08-03) widened the fingerprint to every validation/normalization
 * field. A v1 block cannot be re-verified — its hash never saw those fields —
 * so it fails closed and asks for a fresh approval rather than being trusted.
 */
const ENVELOPE_VERSION = 2;

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
 *
 * ALIAS RESOLUTION HAPPENS HERE, not only at dispatch (approved plan section
 * 5.5). The turn loop passes the ORIGINAL model tool call to the enqueue path,
 * and `command` is DURABLE: a retired spelling written into
 * `approval_queue.tool_call` would be replayed verbatim by a cold resume in a
 * later process, after the deprecation window has closed. What is stored, and
 * what the fingerprint binds to, is therefore the CANONICAL identity.
 *
 * THE STORED `toolId` COMES FROM THE RESOLVED MANIFEST, never from inverting the
 * model-visible name. This module used to invert the name itself, in a private
 * second copy of the mapping; that is unsound under the target public-name
 * grammar, where `kyberswap__swap_quote` inverts to `kyberswap.SwapQuote`
 * rather than the immutable `kyberswap.swap.quote`. The wrong id would then be
 * written into a durable approval row AND hashed into the fingerprint that is
 * supposed to guarantee the human approved this exact contract. Manifest
 * resolution is consequently delegated to the ONE shared catalog resolver
 * (`registry/injected-protocol-tools.ts`), and the id is read off the manifest
 * it returns.
 *
 * `originalToolName` deliberately keeps the RAW name the model emitted: it is
 * audit-only and never dispatched, and recording the spelling the model
 * actually used is the point of the field.
 */
export function buildApprovalToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  binding?: ApprovalProposalBinding,
): Record<string, unknown> {
  const canonicalName = resolveToolName(toolName);
  const manifest = resolveInjectedProtocolTool(canonicalName);
  // The binding is a SIBLING of `vex`, not a member of it: `vex` is the
  // protocol-manifest identity block, whose schema is versioned and whose
  // absence means "historical row". A proposal binding is a different fact
  // about a different lane (an internal tool with no manifest at all), and
  // folding it into that block would make every bound approval look like a
  // manifest envelope to `checkApprovalManifestIdentity`.
  const boundBlock = binding === undefined ? {} : { proposalBinding: proposalBindingBlock(binding) };
  if (!manifest) return { command: canonicalName, args: toolArgs, ...boundBlock };

  return {
    command: "execute_tool",
    args: { toolId: manifest.toolId, params: toolArgs },
    vex: {
      v: ENVELOPE_VERSION,
      originalToolName: toolName,
      manifestFingerprint: computeManifestFingerprint(manifest),
    },
    ...boundBlock,
  };
}

/**
 * What an approval for a PREPARED PROPOSAL is bound to, as it is stored.
 *
 * It is inside the envelope on purpose. `computeRequestDigest` hashes the whole
 * stored envelope, so putting the proposal digest here is what makes the
 * approval identify the exact transaction the human read - rather than
 * `{walletFamily, intentId}`, which names WHICH row and says nothing about what
 * it does. Storing it also makes it READABLE at resume: the confirm handler
 * compares the intent it is about to consume against THIS value, never against
 * whatever digest currently sits beside the row.
 */
export interface ApprovalProposalBinding {
  /**
   * The CANONICAL card the human was shown, carried whole.
   *
   * It is stored because the card the user read is part of what the approval
   * authorizes, and the durable card row (`approval_intents.preview_json`) is
   * rendered FROM this value: keeping the canonical form here lets a resume
   * re-derive it from the intent and compare both, so an edit to either the
   * envelope or the card is caught before anything is signed. It also rides
   * into `computeRequestDigest` for free, which is what binds the sentence to
   * the Studio dispatch check rather than only to the confirm handler.
   */
  readonly preview: {
    readonly label: string;
    readonly criticalArgs: Record<string, string | number | boolean | null>;
  };
  readonly proposalDigest: string;
  readonly proposalDigestVersion: string;
  readonly resource: { readonly table: string; readonly intentId: string };
}

const proposalBindingSchema = z.object({
  preview: z.object({
    label: z.string().min(1),
    criticalArgs: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
  }),
  proposalDigest: z.string().min(1),
  proposalDigestVersion: z.string().min(1),
  resource: z.object({ table: z.string().min(1), intentId: z.string().min(1) }),
});

function proposalBindingBlock(binding: ApprovalProposalBinding): Record<string, unknown> {
  return {
    preview: {
      label: binding.preview.label,
      criticalArgs: { ...binding.preview.criticalArgs },
    },
    proposalDigest: binding.proposalDigest,
    proposalDigestVersion: binding.proposalDigestVersion,
    resource: { table: binding.resource.table, intentId: binding.resource.intentId },
  };
}

/**
 * The binding recorded on a stored approval, or `null` when the row carries
 * none (every lane but the generic signing confirm, and every historical row).
 *
 * A MALFORMED block reads as `null` rather than throwing: the caller's own
 * contract decides what an absent binding means, and on the money path that
 * decision is "refuse", which is strictly safer than an exception escaping a
 * read.
 */
export function readApprovalProposalBinding(
  rawToolCall: Record<string, unknown>,
): ApprovalProposalBinding | null {
  const parsed = proposalBindingSchema.safeParse(rawToolCall.proposalBinding);
  return parsed.success ? parsed.data : null;
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
    if (isSupersededEnvelopeVersion(rawToolCall.vex)) {
      return {
        ok: false,
        reason: "envelope_version_superseded",
        refusal: buildIdentityRefusal(
          "this approval was recorded under an older tool-contract format that "
          + "cannot verify the tool's current validation rules",
        ),
      };
    }
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
 * Structural identity of a manifest: what it does, what it takes, and every
 * rule that decides whether a given call is admitted.
 *
 * Ordering is canonicalized only where it is genuinely UNOBSERVABLE — params by
 * key, group members, and the groups themselves — so a cosmetic reshuffle does
 * not invalidate a queued approval, while an added, removed, retyped, newly
 * required, re-united, re-enumerated, newly array-accepting or newly grouped
 * param does.
 *
 * ENUM MEMBERS ARE THE EXCEPTION: their DECLARATION ORDER is hashed as declared,
 * because it is behaviourally meaningful. `runtime/params.ts` normalizes a
 * chain-valued enum by returning the FIRST case-insensitive match, so
 * `["base","BASE"]` and `["BASE","base"]` hand the handler different strings for
 * the identical user input. Sorting them would have made those two contracts
 * indistinguishable — a silent substitution under an approval a human already
 * granted. (An enum that is ambiguous in the first place is a manifest defect;
 * `_manifest-lint`'s `enum-case-uniqueness` rule refuses it at the source.)
 *
 * NOT hashed, deliberately: `namespace` and `requiresEnv`. Runtime admission
 * does read both, but they describe the tool's IDENTITY and AVAILABILITY, not
 * the SHAPE of the call the human approved — the same call, with the same
 * params, means the same thing under either. Their failure mode is also the safe
 * one: a tool moved to another namespace or newly gated on a missing env var
 * fails admission outright and nothing executes, whereas a changed call shape
 * would execute silently against a different contract. That asymmetry is why the
 * v2 field list covers call shape only.
 */
export function computeManifestFingerprint(manifest: ProtocolToolManifest): string {
  const params = manifest.params
    .map((param) => ({
      key: param.key,
      type: param.type,
      required: param.required === true,
      unit: param.unit ?? null,
      // AS DECLARED — see the enum note above; sorting here erased a real
      // difference in what the handler receives.
      enum: param.enum ? [...param.enum] : null,
      acceptsStringArray: param.acceptsStringArray === true,
      // ONLY when declared, so every alias-free manifest keeps the exact hash it
      // had before this field existed and no queued approval is stranded by the
      // mechanism's arrival. The alias KEYS alone, SORTED: an alias widens what
      // the boundary ADMITS under a queued approval, which is call shape;
      // declaration order and the `removeAfter` prose are not.
      ...(param.aliases && param.aliases.length > 0
        ? { aliases: param.aliases.map((alias) => alias.key).sort(compareStrings) }
        : {}),
    }))
    .sort((a, b) => compareStrings(a.key, b.key));

  return createHash("sha256")
    .update(
      JSON.stringify({
        toolId: manifest.toolId,
        mutating: manifest.mutating === true,
        actionKind: manifest.actionKind,
        params,
        exclusiveParamGroups: canonicalizeGroups(manifest.exclusiveParamGroups),
        atMostOne: canonicalizeGroups(manifest.atMostOne),
        atLeastOneOf: canonicalizeGroups(manifest.atLeastOneOf),
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort(compareStrings);
}

/** Group members and groups both sorted: only membership changes the contract. */
function canonicalizeGroups(
  groups: readonly (readonly string[])[] | undefined,
): string[][] {
  if (!groups) return [];
  return groups
    .map(sortStrings)
    .sort((a, b) => compareStrings(a.join("\u0000"), b.join("\u0000")));
}

/** A readable metadata block from an older envelope version. */
function isSupersededEnvelopeVersion(vex: unknown): boolean {
  if (typeof vex !== "object" || vex === null) return false;
  const version = (vex as { v?: unknown }).v;
  return typeof version === "number" && version < ENVELOPE_VERSION;
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

/**
 * The REQUEST DIGEST - sha256 over the canonical JSON of the envelope
 * `buildApprovalToolCall` produced.
 *
 * ONE OWNER, ON PURPOSE. The digest exists so a Studio dispatch can prove at
 * commit time that it is about to execute the exact envelope the human saw on
 * the approval card. If the digest were computed over the CALL (tool name plus
 * raw arguments) it would canonicalize the same value twice, in two places,
 * with two chances to disagree - and the half that dispatches is the half that
 * matters. So the input is the stored envelope itself: the digest is taken at
 * enqueue over the value written to `approval_queue.tool_call`, and recomputed
 * at commit over the value read back from that column.
 *
 * Key order is canonicalized recursively because JSONB does not preserve it;
 * ARRAY order is preserved because it is meaningful in tool arguments. Values
 * `undefined` cannot survive a JSONB round trip and are dropped on both sides,
 * so dropping them here keeps enqueue and commit in agreement.
 */
export function computeRequestDigest(envelope: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJsonValue(envelope)))
    .digest("hex");
}

/**
 * Recursive key-sorted projection. Objects become key-sorted objects, arrays
 * keep their order, scalars pass through. Anything JSON cannot represent
 * (`undefined`, a function) is omitted exactly as `JSON.stringify` would omit
 * it, so the digest describes what is actually stored.
 */
function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareStrings)) {
    const projected = canonicalizeJsonValue(source[key]);
    if (projected === undefined) continue;
    out[key] = projected;
  }
  return out;
}
