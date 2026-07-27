import * as RettiwtApi from "rettiwt-api";
import type { IRettiwtConfig, ITweetFilter } from "rettiwt-api";
import type { TwitterAccountParams } from "./schema.js";
import { TwitterAccountRequestError } from "./failure.js";
import {
  RETTIWT_API_KEY_ENV,
  RETTIWT_DELAY_MS_ENV,
  RETTIWT_MAX_RETRIES_ENV,
  RETTIWT_PROXY_URL_ENV,
  RETTIWT_TIMEOUT_MS_ENV,
  type CursoredJson,
  type TwitterAccountRateLimit,
  type TwitterAccountResult,
} from "./types.js";

type RettiwtInstance = InstanceType<typeof RettiwtApi.Rettiwt>;
type TweetSearchParams = Extract<TwitterAccountParams, { action: "tweet_search" }>;
type TweetSearchFilter = NonNullable<TweetSearchParams["filter"]>;

const REPLY_SORT = {
  LATEST: RettiwtApi.TweetRepliesSortType.LATEST,
  LIKES: RettiwtApi.TweetRepliesSortType.LIKES,
  RELEVANCE: RettiwtApi.TweetRepliesSortType.RELEVANCE,
} as const;

export async function executeTwitterAccountRequest(
  params: TwitterAccountParams,
): Promise<TwitterAccountResult> {
  const rateLimit: TwitterAccountRateLimit = {};
  const client = createRettiwt(rateLimit);
  const data = await executeAction(client, params);
  return Object.keys(rateLimit).length > 0
    ? { action: params.action, data, rateLimit }
    : { action: params.action, data };
}

function createRettiwt(rateLimit: TwitterAccountRateLimit): RettiwtInstance {
  const apiKey = process.env[RETTIWT_API_KEY_ENV]?.trim();
  if (!apiKey) {
    // Typed, so the caller can tell OUR failures from the provider's without
    // trusting message text — everything untyped is bounded by default.
    throw new TwitterAccountRequestError("auth_failed");
  }

  const config: IRettiwtConfig = {
    apiKey,
    logging: false,
    responseMiddleware: (response) => {
      captureRateLimit(rateLimit, response.headers);
    },
  };

  const proxy = process.env[RETTIWT_PROXY_URL_ENV]?.trim();
  if (proxy) config.proxy = proxy;

  const timeout = readPositiveIntEnv(RETTIWT_TIMEOUT_MS_ENV);
  if (timeout !== undefined) config.timeout = timeout;

  const delay = readPositiveIntEnv(RETTIWT_DELAY_MS_ENV);
  if (delay !== undefined) config.delay = delay;

  const maxRetries = readNonNegativeIntEnv(RETTIWT_MAX_RETRIES_ENV);
  if (maxRetries !== undefined) config.maxRetries = maxRetries;

  return new RettiwtApi.Rettiwt(config);
}

async function executeAction(
  client: RettiwtInstance,
  params: TwitterAccountParams,
): Promise<unknown> {
  switch (params.action) {
    case "account_status": {
      const account = await client.user.details();
      if (!account) throw new TwitterAccountRequestError("unreadable_content");
      return { account: serialize(account) };
    }
    case "tweet_details":
      return { tweet: serialize(await client.tweet.details(params.tweetId)) };
    case "tweet_search":
      return serializeCursored(await client.tweet.search(
        toRettiwtFilter(params),
        params.count,
        params.cursor,
      ));
    case "tweet_replies":
      return serializeCursored(await client.tweet.replies(
        params.tweetId,
        params.cursor,
        REPLY_SORT[params.sortBy ?? "LATEST"],
      ));
    case "tweet_likers":
      return serializeCursored(await client.tweet.likers(params.tweetId, params.count, params.cursor));
    case "tweet_retweeters":
      return serializeCursored(await client.tweet.retweeters(params.tweetId, params.count, params.cursor));
    case "space_details":
      return { space: serialize(await client.space.details(params.spaceId, {
        withReplays: params.withReplays,
        withListeners: params.withListeners,
      })) };
    case "user_details": {
      const target = params.userId ?? params.username;
      // Defense-in-depth: the schema already refines `username || userId`.
      if (!target) throw new TwitterAccountRequestError("user_not_found");
      return { user: serialize(await client.user.details(target)) };
    }
    case "user_search":
      return serializeCursored(await client.user.search(params.query, params.count, params.cursor));
    case "user_timeline": {
      const userId = await resolveUserId(client, params);
      return serializeCursored(await client.user.timeline(userId, params.count, params.cursor));
    }
    case "user_replies": {
      const userId = await resolveUserId(client, params);
      return serializeCursored(await client.user.replies(userId, params.count, params.cursor));
    }
    case "user_followers": {
      const userId = await resolveUserId(client, params);
      return serializeCursored(await client.user.followers(userId, params.count, params.cursor));
    }
    case "user_following": {
      const userId = await resolveUserId(client, params);
      return serializeCursored(await client.user.following(userId, params.count, params.cursor));
    }
  }
  return assertNever(params);
}

async function resolveUserId(
  client: RettiwtInstance,
  target: { userId?: string; username?: string },
): Promise<string> {
  if (target.userId) return target.userId;
  // Defense-in-depth: the schema already refines `username || userId`.
  if (!target.username) throw new TwitterAccountRequestError("user_not_found");

  const user = serialize(await client.user.details(target.username));
  const id = getStringField(user, "id");
  // The handle the agent asked for is already in its own tool call, so the
  // static message loses nothing by not repeating it.
  if (!id) throw new TwitterAccountRequestError("user_not_found");
  return id;
}

function toRettiwtFilter(params: TweetSearchParams): ITweetFilter {
  const filter: TweetSearchFilter = params.filter ?? {};
  const includeWords = uniqueStrings([
    ...queryWords(params.query),
    ...(filter.includeWords ?? []),
  ]);

  return {
    ...filter,
    includeWords: includeWords.length > 0 ? includeWords : undefined,
    fromUsers: stripPrefixes(filter.fromUsers, "@"),
    toUsers: stripPrefixes(filter.toUsers, "@"),
    mentions: stripPrefixes(filter.mentions, "@"),
    hashtags: stripPrefixes(filter.hashtags, "#"),
    startDate: filter.startDate ? new Date(filter.startDate) : undefined,
    endDate: filter.endDate ? new Date(filter.endDate) : undefined,
  };
}

function queryWords(query: string | undefined): string[] {
  return query?.split(/\s+/).map((word) => word.trim()).filter(Boolean) ?? [];
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function serializeCursored(value: unknown): CursoredJson {
  const serialized = serialize(value);
  if (!isRecord(serialized) || !Array.isArray(serialized.list)) {
    throw new TwitterAccountRequestError("unreadable_content");
  }
  return {
    items: serialized.list,
    next: typeof serialized.next === "string" ? serialized.next : "",
  };
}

function serialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serialize);
  if (hasToJson(value)) return value.toJSON();
  return value;
}

/**
 * DENYLIST redaction — it removes the three secret shapes it knows about and
 * passes every other provider word through. That is why it is NO LONGER on the
 * agent-facing path: `twitter_account` now answers with a bounded code from
 * `failure.ts`, which is an allowlist and cannot be outflanked by prose nobody
 * anticipated.
 *
 * Its one remaining caller is the regime worker, which sanitizes before
 * re-throwing and whose catch then discards the message entirely (only
 * `errorCode` is logged). Do not reintroduce it into anything the model reads.
 */
export function sanitizeTwitterAccountError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  let message = rawMessage || "Twitter/X request failed";
  const apiKey = process.env[RETTIWT_API_KEY_ENV]?.trim();
  if (apiKey) message = message.split(apiKey).join("[redacted]");
  return message
    .replace(/(auth_token|ct0|kdt|twid)=([^;\s]+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function captureRateLimit(
  target: TwitterAccountRateLimit,
  headers: unknown,
): void {
  if (!isRecord(headers)) return;
  target.limit = headerString(headers["x-rate-limit-limit"]) ?? target.limit;
  target.remaining = headerString(headers["x-rate-limit-remaining"]) ?? target.remaining;
  target.reset = headerString(headers["x-rate-limit-reset"]) ?? target.reset;
}

function readPositiveIntEnv(key: string): number | undefined {
  const value = readNonNegativeIntEnv(key);
  return value !== undefined && value > 0 ? value : undefined;
}

function readNonNegativeIntEnv(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stripPrefixes(values: string[] | undefined, prefix: string): string[] | undefined {
  return values?.map((value) => value.startsWith(prefix) ? value.slice(1) : value);
}

function headerString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function hasToJson(value: unknown): value is { toJSON: () => unknown } {
  return typeof value === "object"
    && value !== null
    && "toJSON" in value
    && typeof value.toJSON === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported twitter_account action: ${JSON.stringify(value)}`);
}
