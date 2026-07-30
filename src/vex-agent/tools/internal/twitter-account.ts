import { TwitterAccountParamsSchema, type TwitterAccountParams } from "@tools/twitter-account/schema.js";
import { describeReceivedValue } from "@tools/twitter-account/empty-values.js";
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

/**
 * `response_format` is RETIRED, and must be rejected rather than ignored.
 *
 * It was read off the RAW params here because the Zod discriminated union
 * strips unknown keys. That is exactly why deleting the read would be unsafe:
 * `response_format: "detailed"` would then sail through the union, get dropped
 * silently, and the caller would receive the concise projection believing it
 * asked for and got the verbatim payload. Naming the retirement is the only
 * honest option (`rules/90`: a supplied param is never silently discarded).
 */
const RETIRED_RESPONSE_FORMAT_PARAM = "response_format";

export async function handleTwitterAccount(
  params: Record<string, unknown>,
  _context: InternalToolContext,
): Promise<ToolResult> {
  if (RETIRED_RESPONSE_FORMAT_PARAM in params) {
    return fail(
      "twitter_account: `response_format` was retired — there is one response shape now "
      + "(the concise projection), and it never truncates post text. The verbatim client payload "
      + "measured 1.6-1.9x the tool-output cap on an ordinary 20-row search. Remove the parameter.",
    );
  }

  const parsed = TwitterAccountParamsSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`twitter_account: ${formatValidationIssue(issue, params)}`);
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
    return fail(`twitter_account: ${twitterFailureMessage(classifyTwitterFailure(error))}`);
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

/**
 * A rejection the model can act on: WHERE (the path), WHAT WAS EXPECTED (the
 * schema's own message — custom refinements carry the good ones), and HOW THE
 * VALUE ARRIVED, by shape. The shape matters because the commonest failing call
 * is a field the model considers blank rather than supplied: naming
 * "an empty string" and the empty-means-absent rule turns a mystery into an
 * instruction. Values are never echoed — a query is user content.
 */
function formatValidationIssue(
  issue: { path: PropertyKey[]; message: string } | undefined,
  rawParams: unknown,
): string {
  if (!issue) return "invalid arguments";
  const path = issue.path.map(String).join(".");
  const received = describeReceivedValue(rawParams, issue.path);
  const emptyNote = received !== null && received.startsWith("an empty")
    ? ` — it arrived as ${received}, and an empty value means ABSENT at this boundary: `
      + "supply a real value or omit the field entirely"
    : received !== null
      ? ` (received ${received})`
      : "";
  return path ? `${path}: ${issue.message}${emptyNote}` : `${issue.message}${emptyNote}`;
}
