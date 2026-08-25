/**
 * Indexify stack-creation handler.
 *
 * Creation moves no funds but publishes a PUBLIC stack under the linked
 * account immediately, so it validates everything the venue lets us validate
 * BEFORE the mutating call: allocations are checked locally (count, mint
 * shape, integer weights summing to 100) and the name and description go
 * through the venue's own `check_name` / `check_description`. A refusal on
 * any of these happens by name, with nothing created.
 *
 * The creator fee is PINNED to the venue's live default (fee-params doctrine:
 * a fee-shaped param on a mutating tool is refused structurally, whatever the
 * reasoning — see fee-params-never-from-model.test.ts). The creator can
 * adjust it afterward in the Indexify app.
 *
 * Same commit-point contract as the trade handler: the `create` POST is not
 * abortable, and the follow-up slug read is best-effort.
 */

import { getIndexifyClient } from "@tools/indexify/client.js";
import type { IndexifyCategory } from "@tools/indexify/constants.js";
import {
  INDEXIFY_CATEGORIES,
  INDEXIFY_MAX_STACK_TOKENS,
  INDEXIFY_WEIGHT_SUM,
  indexifyStackUrl,
} from "@tools/indexify/constants.js";
import { ok, fail, num, str } from "../../handler-helpers.js";
import { isRecord } from "@utils/validation-helpers.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { indexifyFailureDetail } from "./failure.js";

const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_DESCRIPTION = 500;

/** Read and fully validate the `allocations` map, or return the refusal text. */
function readAllocations(p: Record<string, unknown>): { ok: true; value: Record<string, number> } | { ok: false; reason: string } {
  const raw = p.allocations;
  if (!isRecord(raw)) {
    return { ok: false, reason: 'Missing or invalid required: allocations (an object mapping mint address to integer percent weight, e.g. {"JUPy...": 60, "jito...": 40}).' };
  }
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > INDEXIFY_MAX_STACK_TOKENS) {
    return { ok: false, reason: `"allocations" must hold 1-${INDEXIFY_MAX_STACK_TOKENS} tokens, received ${entries.length}.` };
  }
  const value: Record<string, number> = {};
  let sum = 0;
  for (const [mint, weight] of entries) {
    if (!SOLANA_MINT.test(mint)) {
      return { ok: false, reason: `"allocations" key "${mint}" is not a Solana mint address — resolve exact mints with indexify__tokens_search.` };
    }
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > 99) {
      return { ok: false, reason: `"allocations" weight for ${mint} must be an INTEGER percent from 1 to 99, received ${String(weight)}.` };
    }
    value[mint] = weight;
    sum += weight;
  }
  if (sum !== INDEXIFY_WEIGHT_SUM) {
    return { ok: false, reason: `"allocations" weights must sum to exactly ${INDEXIFY_WEIGHT_SUM}, received ${sum}. Adjust the weights.` };
  }
  return { ok: true, value };
}

export async function indexifyStackCreateHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const name = str(p, "name").trim();
  if (!name) return fail("Missing required: name (the stack's display name).");
  const description = str(p, "description").trim();
  if (!description) return fail("Missing required: description (the stack's thesis, up to 500 characters).");
  if (description.length > MAX_DESCRIPTION) {
    return fail(`"description" must be at most ${MAX_DESCRIPTION} characters, received ${description.length}.`);
  }
  const categoryRaw = str(p, "category").trim().toLowerCase();
  const category = INDEXIFY_CATEGORIES.find((candidate) => candidate === categoryRaw) as IndexifyCategory | undefined;
  if (category === undefined) {
    return fail(`"category" must be one of: ${INDEXIFY_CATEGORIES.join(", ")}.`);
  }
  const allocations = readAllocations(p);
  if (!allocations.ok) return fail(allocations.reason);

  const client = getIndexifyClient();

  // ── Preflights (abortable; refuse by name, nothing created) ──────
  // The creator fee is NOT a parameter (fee-params doctrine) — it is pinned
  // to whatever the venue itself declares as the default, read live here.
  let creatorFee: number;
  try {
    const [nameCheck, descriptionCheck, bounds] = await Promise.all([
      client.checkStackName(name, { signal: context.abortSignal }),
      client.checkStackDescription(description, { signal: context.abortSignal }),
      client.creatorFeeBounds({ signal: context.abortSignal }),
    ]);
    if (nameCheck !== "OK") {
      const reason = nameCheck === "TAKEN" ? "is already taken" : nameCheck === "BADWORD" ? "was flagged for wording" : "is invalid (avoid symbols)";
      return fail(`Stack name "${name}" ${reason} — pick another name. Nothing was created.`);
    }
    if (descriptionCheck !== "OK") {
      const reason = descriptionCheck === "BADWORD" ? "was flagged for wording" : "is invalid";
      return fail(`The stack description ${reason} — reword it. Nothing was created.`);
    }
    creatorFee = bounds.default;
  } catch (err) {
    return fail(`Indexify create preflight failed — nothing was created (${indexifyFailureDetail("indexify__stack_create", err)})`);
  }

  // ── Commit (deliberately NOT abortable — see module doc) ─────────
  let stackId: number;
  try {
    const result = await client.createStack({
      stackName: name,
      stackTokenInfo: allocations.value,
      creatorFee,
      description,
      category,
      // The venue requires the object; empty strings are its own idle shape.
      socialLinks: { twitter: "", telegram: "", discord: "", linkedin: "" },
    });
    stackId = result.stack_id;
  } catch (err) {
    const detail = indexifyFailureDetail("indexify__stack_create", err);
    const ambiguous = detail.includes("timed out") || detail.includes("Could not reach");
    return fail(
      ambiguous
        ? `Indexify create result UNKNOWN — the stack may or may not exist (${detail}). `
          + `Check with indexify__stacks_search for "${name}" before retrying.`
        : `Indexify refused the creation — nothing was created (${detail})`,
    );
  }

  // Best-effort read-back for the slug and link; its failure never hides the id.
  let slug: string | null = null;
  try {
    const created = await client.fetchStack({ stackId });
    slug = created?.slug ?? null;
  } catch {
    slug = null;
  }

  return ok({
    created: true,
    stackId,
    name,
    category,
    creatorFeePercent: creatorFee,
    allocations: allocations.value,
    ...(slug !== null
      ? { slug, url: indexifyStackUrl(slug) }
      : { note: "Created, but the slug read-back failed — fetch it with indexify__stack_get using the stackId." }),
    visibility: "The stack is PUBLIC on Indexify immediately, under the linked account, open for anyone to invest in.",
  });
}
