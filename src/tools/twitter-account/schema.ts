import { z } from "zod";

const TWENTY_MAX = 20;
const HUNDRED_MAX = 100;

const NonEmptyString = z.string().trim().min(1);
const NumericId = NonEmptyString.regex(/^\d+$/, "must be a numeric Twitter/X id");
const Cursor = NonEmptyString.optional();
const Count20 = z.number().int().min(1).max(TWENTY_MAX).optional();
const Count100 = z.number().int().min(1).max(HUNDRED_MAX).optional();
const StringList = z.array(NonEmptyString).min(1).max(20).optional();
const IsoDate = z.string().datetime().optional();

const Username = NonEmptyString.transform((value) => (
  value.startsWith("@") ? value.slice(1) : value
)).pipe(
  z.string()
    .min(1)
    .max(15)
    .regex(/^[A-Za-z0-9_]+$/, "must be a Twitter/X username"),
);

const UserTarget = z
  .object({
    username: Username.optional(),
    userId: NumericId.optional(),
  })
  .refine((value) => value.username !== undefined || value.userId !== undefined, {
    message: "Provide `username` or `userId`",
  });

/**
 * X's cashtag operator, as it is actually matched: a ticker of letters and
 * digits. The `$` is optional on input and always present on output — the live
 * recon proved `includeWords` reaches X's query verbatim, so `"$WIF"` IS the
 * cashtag search and `"WIF"` is a plain word search over a different corpus.
 */
const CASHTAG_SYNTAX = /^\$?[A-Za-z][A-Za-z0-9]{0,14}$/;
const CashtagList = z
  .array(
    z
      .string()
      .trim()
      .regex(CASHTAG_SYNTAX, "cashtags entries must look like `$WIF` — letters and digits only"),
  )
  .min(1)
  .max(10)
  .optional();

/** 30 days: X's search does not usefully reach further back on a public session. */
const WITHIN_HOURS_MAX = 24 * 30;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * rettiwt gates every numeric operator on TRUTHINESS
 * (`this.minLikes ? …`, `dist/models/args/FetchArgs.js:141-143`), so a `0`
 * floor is dropped from the query rather than applied. A supplied value that is
 * silently discarded is exactly the failure `rules/90` names for fee and limit
 * params: reject it by name instead.
 */
function engagementFloor(name: string): z.ZodOptional<z.ZodNumber> {
  return z
    .number()
    .int()
    .min(
      1,
      `${name} must be at least 1 — X's query builder drops a 0 floor instead of applying it, `
      + `so ${name}: 0 would silently disable the filter. Omit the param to search unfiltered.`,
    )
    .optional();
}

function withDollar(cashtag: string): string {
  return cashtag.startsWith("$") ? cashtag : `$${cashtag}`;
}

function mergeUniqueWords(existing: readonly string[], added: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const word of [...existing, ...added]) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(word);
  }
  return merged;
}

const TweetFilter = z
  .object({
    fromUsers: StringList,
    toUsers: StringList,
    mentions: StringList,
    hashtags: StringList,
    cashtags: CashtagList,
    includeWords: StringList,
    optionalWords: StringList,
    excludeWords: StringList,
    includePhrase: NonEmptyString.optional(),
    language: z.string().trim().min(2).max(12).optional(),
    list: NonEmptyString.optional(),
    maxId: NumericId.optional(),
    sinceId: NumericId.optional(),
    quoted: NumericId.optional(),
    startDate: IsoDate,
    endDate: IsoDate,
    withinHours: z.number().int().min(1).max(WITHIN_HOURS_MAX).optional(),
    minLikes: engagementFloor("minLikes"),
    minReplies: engagementFloor("minReplies"),
    minRetweets: engagementFloor("minRetweets"),
    onlyLinks: z.boolean().optional(),
    onlyOriginal: z.boolean().optional(),
    onlyReplies: z.boolean().optional(),
    onlyText: z.boolean().optional(),
    top: z.boolean().optional(),
  })
  .strict()
  .refine((filter) => Object.keys(filter).length > 0, {
    message: "Provide at least one tweet search filter field",
  })
  // Normalization happens HERE, once, so the value sent to X and the value
  // echoed back to the agent are the same value. `cashtags` and `withinHours`
  // are input-only ergonomics: they leave as `includeWords` and `startDate`.
  .transform((filter, ctx) => {
    const { cashtags, withinHours, ...rest } = filter;

    if (withinHours !== undefined && rest.startDate !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["withinHours"],
        message:
          "`withinHours` and `startDate` both set the start of the window — pass one. "
          + "`withinHours` is relative to now; `startDate` is an absolute ISO instant.",
      });
      return z.NEVER;
    }

    const startDate = withinHours !== undefined
      ? new Date(Date.now() - withinHours * MS_PER_HOUR).toISOString()
      : rest.startDate;

    if (startDate !== undefined && rest.endDate !== undefined
      && Date.parse(rest.endDate) < Date.parse(startDate)) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message:
          `\`endDate\` (${rest.endDate}) is earlier than the start of the window (${startDate}), `
          + "so the range is empty and X would match nothing.",
      });
      return z.NEVER;
    }

    const includeWords = cashtags === undefined
      ? rest.includeWords
      : mergeUniqueWords(rest.includeWords ?? [], cashtags.map(withDollar));

    return {
      ...rest,
      ...(includeWords !== undefined ? { includeWords } : {}),
      ...(startDate !== undefined ? { startDate } : {}),
    };
  });

const WithCursor20 = z.object({ count: Count20, cursor: Cursor });
const WithCursor100 = z.object({ count: Count100, cursor: Cursor });

const TwitterAccountParamsBaseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("account_status") }),
  z.object({ action: z.literal("tweet_details"), tweetId: NumericId }),
  z.object({
    action: z.literal("tweet_search"),
    query: NonEmptyString.optional(),
    filter: TweetFilter.optional(),
    count: Count20,
    cursor: Cursor,
  }),
  z.object({
    action: z.literal("tweet_replies"),
    tweetId: NumericId,
    cursor: Cursor,
    sortBy: z.enum(["LATEST", "LIKES", "RELEVANCE"]).optional(),
  }),
  z.object({ action: z.literal("tweet_likers"), tweetId: NumericId }).merge(WithCursor100),
  z.object({ action: z.literal("tweet_retweeters"), tweetId: NumericId }).merge(WithCursor100),
  z.object({
    action: z.literal("space_details"),
    spaceId: NonEmptyString,
    withReplays: z.boolean().optional(),
    withListeners: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("user_details"),
  }).merge(UserTarget),
  z.object({ action: z.literal("user_search"), query: NonEmptyString }).merge(WithCursor20),
  z.object({ action: z.literal("user_timeline") }).merge(UserTarget).merge(WithCursor20),
  z.object({ action: z.literal("user_replies") }).merge(UserTarget).merge(WithCursor20),
  z.object({ action: z.literal("user_followers") }).merge(UserTarget).merge(WithCursor100),
  z.object({ action: z.literal("user_following") }).merge(UserTarget).merge(WithCursor100),
]);

export const TwitterAccountParamsSchema = TwitterAccountParamsBaseSchema.superRefine((params, ctx) => {
  if (params.action !== "tweet_search") return;
  if (params.query !== undefined || params.filter !== undefined) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "tweet_search requires query or filter",
    path: ["query"],
  });
});

export type TwitterAccountParams = z.infer<typeof TwitterAccountParamsSchema>;

/**
 * The closed set of read-only operations. This union is what keeps the SDK's
 * list-mutation, posting, follower-removal, DM and media-upload resources
 * unreachable — see `src/__tests__/tools/twitter-read-only-closure.test.ts`.
 */
export type TwitterAccountAction = TwitterAccountParams["action"];
