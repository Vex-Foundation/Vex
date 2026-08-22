/**
 * The retired-input-spelling rewrite, at the EARLIEST runtime boundary.
 *
 * WHY IT IS HERE AND NOT IN `validateProtocolParams`. The validator is not the
 * first reader of a protocol call: the string-array and numeric-string coercers
 * run before it, `isPreviewExecution` reads `dryRun` off the same object before
 * it, and, on the approval branch, the enqueue writes the ORIGINAL
 * `ParsedToolCall.arguments` into `approval_queue.tool_call`
 * (`engine/core/turn-loop-tool-batch.ts`, `.../approval-stop.ts`), which is a
 * different object from anything the validator produced. A rewrite placed
 * inside the validator would therefore leave a retired spelling in the durable
 * approval row and in the capture, and a cold resume would replay the spelling
 * the schema no longer declares. Running first, on the caller's own object,
 * means every one of those readers sees the canonical key.
 *
 * WHY IT MUTATES. Same reason `normalizeChainValueParams` mutates: the handler,
 * the capture row, the fingerprint check and every gate must see ONE spelling.
 * A copy would create the second source of truth this rewrite exists to remove.
 *
 * WHY BOTH SPELLINGS ARE A REFUSAL, not a precedence rule. A call carrying
 * `wallet` and `walletFamily` is ambiguous about what the caller believes it
 * asked for, and silently preferring one would answer a question that was never
 * asked. There is no precedence here on purpose: the caller re-sends one key.
 * This is the same contract `refuseRetiredTokenCheckAddress` already applies on
 * the internal lane (`tools/internal/action-aliases.ts`).
 */

import type { ProtocolToolManifest } from "../types.js";

/** Outcome of the rewrite. `ok` carries no payload: `params` was mutated. */
export type ParamAliasNormalization =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Rewrite every declared retired spelling in `params` to its canonical key,
 * IN PLACE, or refuse by name when both spellings arrived.
 *
 * A manifest that declares no alias does nothing at all here.
 */
export function normalizeParamAliases(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): ParamAliasNormalization {
  for (const param of manifest.params) {
    for (const alias of param.aliases ?? []) {
      // `undefined` is absent under the same rule the rest of the boundary
      // uses: JSON drops it and capture normalises it away.
      if (params[alias.key] === undefined) continue;
      if (params[param.key] !== undefined) {
        return {
          ok: false,
          reason:
            `Parameter "${alias.key}" for ${manifest.toolId} was retired and renamed to `
            + `"${param.key}", and you supplied BOTH. Vex will not guess which one you meant. `
            + `Re-send the call with "${param.key}" only.`,
        };
      }
      params[param.key] = params[alias.key];
      delete params[alias.key];
    }
  }
  return { ok: true };
}
