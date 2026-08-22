import { TwitterAccountParamsSchema, type TwitterAccountParams } from "@tools/twitter-account/schema.js";
import { formatZodIssueForModel } from "./arg-validation.js";
import { executeTwitterAccountRequest } from "@tools/twitter-account/client.js";
import {
  classifyTwitterFailure,
  twitterFailureMessage,
} from "@tools/twitter-account/failure.js";
import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { fail, ok } from "./types.js";
import {
  projectTwitterResult,
  type TweetSearchFiltersApplied,
} from "./twitter-projection.js";
import { rejectRetiredResponseFormat } from "@vex-agent/response-format.js";

/**
 * `response_format` is RETIRED, and must be rejected rather than ignored:
 * state 4 of the shared vocabulary (`@vex-agent/response-format.js`, D17).
 *
 * It is read off the RAW params here because the Zod discriminated union
 * strips unknown keys. That is exactly why deleting the read would be unsafe:
 * `response_format: "detailed"` would then sail through the union, get dropped
 * silently, and the caller would receive the concise projection believing it
 * asked for and got the verbatim payload. Naming the retirement is the only
 * honest option (`rules/90`: a supplied param is never silently discarded).
 *
 * The measured evidence for the retirement is this tool's own, so it stays
 * here; only the detect-and-refuse mechanism is shared.
 */
const RETIRED_RESPONSE_FORMAT_REASON =
  "There is one response shape now (the concise projection), and it never truncates "
  + "post text. The verbatim client payload measured 26,082 B and 30,321 B on ordinary "
  + "20-row searches, against a far smaller projected payload for the same rows.";

export async function handleTwitterAccount(
  params: Record<string, unknown>,
  _context: InternalToolContext,
): Promise<ToolResult> {
  // BEFORE the schema parse, deliberately: an unrelated validation error must
  // not pre-empt the retirement message the caller actually needs.
  const retired = rejectRetiredResponseFormat(params, {
    tool: "TwitterAccount",
    reason: RETIRED_RESPONSE_FORMAT_REASON,
  });
  if (retired !== undefined) return fail(retired);

  const parsed = TwitterAccountParamsSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`TwitterAccount: ${formatZodIssueForModel(issue, params)}`);
  }

  try {
    const result = await executeTwitterAccountRequest(parsed.data);
    const filtersApplied = resolvedSearchFilters(parsed.data);
    return ok(
      projectTwitterResult(
        result,
        filtersApplied !== undefined ? { filtersApplied } : {},
      ),
    );
  } catch (error) {
    // Provider error text is untrusted content, not diagnostics: it selects a
    // Vex-owned code and is then discarded. The vocabulary — including the
    // auth/rate-limit distinction the agent acts on — lives in
    // `@tools/twitter-account/failure.ts`.
    return fail(`TwitterAccount: ${twitterFailureMessage(classifyTwitterFailure(error))}`);
  }
}

/**
 * The search request as it was RESOLVED — `withinHours` already turned into a
 * UTC `startDate`, `cashtags` already folded into `includeWords`. The agent
 * asked in one vocabulary and X was asked in another; echoing the second is
 * what lets an empty result be diagnosed instead of read as "nobody is talking
 * about this token".
 */
function resolvedSearchFilters(
  params: TwitterAccountParams,
): TweetSearchFiltersApplied | undefined {
  if (params.action !== "tweet_search") return undefined;
  return {
    ...(params.query !== undefined ? { query: params.query } : {}),
    ...(params.count !== undefined ? { count: params.count } : {}),
    ...(params.filter ?? {}),
  };
}

