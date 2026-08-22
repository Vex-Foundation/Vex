/**
 * Twitter/X output projection.
 *
 * The Rettiwt client returns verbose `ITweet` / `IUser` / `ISpace` payloads
 * (profile/banner image URLs, entities, pinned tweets, full participant lists)
 * that routinely push tool output past 25 KB while carrying little signal for
 * the agent. This module curates the output string
 * BEFORE `ok()` — the only lever, since the internal-tool `data` is dropped at
 * the batch loop and only the `output` string reaches the model.
 *
 * THIS PROJECTION IS THE ONLY SHAPE (W2B). The `response_format: "detailed"`
 * escape hatch was retired: it existed to dump the verbatim client payload,
 * measured at 26,082 B and 30,321 B on ordinary 20-row searches - and the fields it added beyond this projection are
 * profile images, banners, entities and inflated quoted tweets, none of which
 * serve the tool's two jobs. Retirement is enforced by NAME-REJECTION in the
 * handler, never by silent deletion.
 *
 * NOTHING HERE IS TRUNCATED. `fullText` is 43 % of a concise payload and it
 * still ships whole: hostile text is LABELLED (see `research-provenance.ts`),
 * never cut.
 *
 * The client output originates from an external API, so every field is treated
 * as possibly-missing: arrays/nested objects are narrowed defensively before
 * use rather than trusting the rettiwt-api static types.
 */

import type { TwitterAccountParams } from "@tools/twitter-account/schema.js";
import type { TwitterAccountResult } from "@tools/twitter-account/types.js";
import {
  RESEARCH_EXTERNAL_CONTENT_WARNING,
  collectExternalContentFields,
  collectExternalContentPatterns,
} from "./research-provenance.js";

// ── Concise output shapes ────────────────────────────────────────

/** Shallow projection of a nested quoted/retweeted tweet (avoids re-inflation). */
export interface ConciseNestedTweet {
  id?: string;
  url?: string;
  author?: { userName?: string };
}

/** Lean per-tweet author (subset of IUser). */
export interface ConciseTweetAuthor {
  userName?: string;
  fullName?: string;
  followersCount?: number;
  isVerified?: boolean;
}

/** Concise tweet — drops entities/conversationId/replyTo/bookmarkCount. */
export interface ConciseTweet {
  id?: string;
  url?: string;
  /** The provider's ISO string, preserved. */
  createdAt?: string;
  /** Epoch ms for age arithmetic; null when the provider date cannot be parsed. */
  createdAtMs?: number | null;
  fullText?: string;
  lang?: string;
  likeCount?: number;
  replyCount?: number;
  retweetCount?: number;
  quoteCount?: number;
  viewCount?: number;
  media: string[];
  author?: ConciseTweetAuthor;
  quoted?: ConciseNestedTweet;
  retweetedTweet?: ConciseNestedTweet;
}

/** Concise user (top-level user lists keep `description`). */
export interface ConciseUser {
  id?: string;
  userName?: string;
  fullName?: string;
  followersCount?: number;
  followingsCount?: number;
  isVerified?: boolean;
  description?: string;
}

/** Concise space — participant arrays dropped, only counts kept. */
export interface ConciseSpace {
  id?: string;
  state?: string;
  title?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  creatorId?: string;
  participantCount?: number;
  totalLiveListeners?: number;
  adminsCount?: number;
  speakersCount?: number;
  listenersCount?: number;
}

// ── Defensive accessors (treat external data as untrusted) ───────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Epoch ms for a provider date string, or null when it cannot be read. Never
 * NaN: a NaN in a payload is a number the agent cannot distinguish from a real
 * one until it does arithmetic with it.
 */
function optEpochMs(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ── Field projectors ─────────────────────────────────────────────

/** Lean per-tweet author projection. */
export function projAuthor(u: unknown): ConciseTweetAuthor | undefined {
  if (!isRecord(u)) return undefined;
  return {
    userName: optString(u.userName),
    fullName: optString(u.fullName),
    followersCount: optNumber(u.followersCount),
    isVerified: optBoolean(u.isVerified),
  };
}

/** Shallow projection of a nested quoted/retweeted tweet — no recursion. */
function projNestedTweet(t: unknown): ConciseNestedTweet | undefined {
  if (!isRecord(t)) return undefined;
  const author = isRecord(t.tweetBy) ? { userName: optString(t.tweetBy.userName) } : undefined;
  return {
    id: optString(t.id),
    url: optString(t.url),
    author,
  };
}

/** Concise tweet projection; nested quoted/retweet shallow-projected. */
export function projTweet(t: unknown): ConciseTweet {
  if (!isRecord(t)) {
    return { media: [] };
  }
  const media = optArray(t.media)
    .map((m) => (isRecord(m) ? optString(m.type) : undefined))
    .filter((type): type is string => type !== undefined);

  const createdAt = optString(t.createdAt);
  const projected: ConciseTweet = {
    id: optString(t.id),
    url: optString(t.url),
    createdAt,
    createdAtMs: optEpochMs(createdAt),
    fullText: optString(t.fullText),
    lang: optString(t.lang),
    likeCount: optNumber(t.likeCount),
    replyCount: optNumber(t.replyCount),
    retweetCount: optNumber(t.retweetCount),
    quoteCount: optNumber(t.quoteCount),
    viewCount: optNumber(t.viewCount),
    media,
    author: projAuthor(t.tweetBy),
  };

  const quoted = projNestedTweet(t.quoted);
  if (quoted) projected.quoted = quoted;
  const retweeted = projNestedTweet(t.retweetedTweet);
  if (retweeted) projected.retweetedTweet = retweeted;

  return projected;
}

/** Concise user projection — keeps `description` for top-level user lists. */
export function projUser(u: unknown): ConciseUser {
  if (!isRecord(u)) return {};
  const projected: ConciseUser = {
    id: optString(u.id),
    userName: optString(u.userName),
    fullName: optString(u.fullName),
    followersCount: optNumber(u.followersCount),
    followingsCount: optNumber(u.followingsCount),
    isVerified: optBoolean(u.isVerified),
  };
  const description = optString(u.description);
  if (description !== undefined) projected.description = description;
  return projected;
}

/** Concise space projection — participant arrays dropped, only counts kept. */
export function projSpace(s: unknown): ConciseSpace {
  if (!isRecord(s)) return {};
  const projected: ConciseSpace = {
    id: optString(s.id),
    state: optString(s.state),
    title: optString(s.title),
    createdAt: optString(s.createdAt),
    startedAt: optString(s.startedAt),
    endedAt: optString(s.endedAt),
    creatorId: optString(s.creatorId),
    participantCount: optNumber(s.participantCount),
    totalLiveListeners: optNumber(s.totalLiveListeners),
  };

  if (isRecord(s.participants)) {
    const p = s.participants;
    if (Array.isArray(p.admins)) projected.adminsCount = p.admins.length;
    if (Array.isArray(p.speakers)) projected.speakersCount = p.speakers.length;
    if (Array.isArray(p.listeners)) projected.listenersCount = p.listeners.length;
  }

  return projected;
}

// ── Result-level projection ──────────────────────────────────────

type TweetSearchParams = Extract<TwitterAccountParams, { action: "tweet_search" }>;

/**
 * What the search actually asked X for, AFTER normalization — the derived
 * `startDate` behind `withinHours` and the `includeWords` behind `cashtags`.
 * Echoing the resolved values is what makes "no results" diagnosable: an agent
 * can see whether its own floor or window emptied the payload.
 */
export type TweetSearchFiltersApplied =
  Partial<NonNullable<TweetSearchParams["filter"]>> & { query?: string; count?: number };

interface ConciseBase {
  externalContentWarning: string;
  externalContentFields: string[];
  action: string;
  filtersApplied?: TweetSearchFiltersApplied;
  rateLimit?: TwitterAccountResult["rateLimit"];
  /** Present only when an empty list cannot honestly be read as "zero". */
  emptyResultNote?: string;
}

type ConciseTwitterResult =
  | (ConciseBase & { account: ConciseUser })
  | (ConciseBase & { user: ConciseUser })
  | (ConciseBase & { tweet: ConciseTweet })
  | (ConciseBase & { space: ConciseSpace })
  | (ConciseBase & { tweets: ConciseTweet[]; next: string })
  | (ConciseBase & { users: ConciseUser[]; next: string })
  // Fallback for an unexpected action: surface the raw data rather than drop it.
  | (ConciseBase & { data: unknown });

/**
 * Dot paths carrying text a stranger wrote. Identity (`id`, `authorId`, `url`)
 * is deliberately absent for the same reason `tokenAddress` is not flagged on a
 * DexScreener row: training the agent to distrust identity would poison the one
 * value on the row it is supposed to act on.
 */
const TWEET_EXTERNAL_PATHS = ["fullText", "author.userName", "author.fullName"] as const;
const USER_EXTERNAL_PATHS = ["userName", "fullName", "description"] as const;
const SPACE_EXTERNAL_PATHS = ["title"] as const;

/** Actions whose cursored `items[]` are tweets. */
const TWEET_LIST_ACTIONS: ReadonlySet<string> = new Set([
  "tweet_search",
  "tweet_replies",
  "user_timeline",
  "user_replies",
]);

/** Actions whose cursored `items[]` are users. */
const USER_LIST_ACTIONS: ReadonlySet<string> = new Set([
  "tweet_likers",
  "tweet_retweeters",
  "user_search",
  "user_followers",
  "user_following",
]);

function nextCursor(data: Record<string, unknown>): string {
  return optString(data.next) ?? "";
}

/**
 * Actions whose EMPTY list is unknown rather than zero. X's private API
 * routinely auth-walls liker and reply lists, and an auth-walled list arrives
 * at this seam byte-identical to a genuinely empty one — we cannot tell them
 * apart here, so the note is unconditional on empty rather than guessed at.
 */
const UNKNOWN_WHEN_EMPTY_ACTIONS: ReadonlySet<string> = new Set([
  "tweet_likers",
  "tweet_replies",
]);

/** Vex-authored and STATIC — never interpolates provider text. */
const EMPTY_LIST_UNKNOWN_NOTE =
  "0 rows here means UNKNOWN, not zero: X frequently auth-walls liker and reply "
  + "lists, and that is indistinguishable from a genuinely empty list at this seam. "
  + "Do not report 'no likes' or 'no replies' from this payload — cross-check "
  + "likeCount / replyCount via tweet_details before saying anything about the count.";

function emptyListNote(action: string, rowCount: number): { emptyResultNote?: string } {
  return rowCount === 0 && UNKNOWN_WHEN_EMPTY_ACTIONS.has(action)
    ? { emptyResultNote: EMPTY_LIST_UNKNOWN_NOTE }
    : {};
}

export interface ProjectTwitterOptions {
  /** Present only for `tweet_search`, where the caller resolved a filter. */
  readonly filtersApplied?: TweetSearchFiltersApplied;
}

/**
 * Build the envelope in ONE literal so key order is deterministic:
 * `externalContentWarning` FIRST (owner directive), then the dot paths, then
 * the action, then the payload. `JSON.stringify` preserves insertion order, so
 * this order is the wire contract and is pinned by test.
 */
function envelope<T extends object>(
  result: TwitterAccountResult,
  externalContentFields: string[],
  options: ProjectTwitterOptions,
  payload: T,
): ConciseBase & T {
  return {
    externalContentWarning: RESEARCH_EXTERNAL_CONTENT_WARNING,
    externalContentFields,
    action: result.action,
    ...(options.filtersApplied !== undefined ? { filtersApplied: options.filtersApplied } : {}),
    ...(result.rateLimit ? { rateLimit: result.rateLimit } : {}),
    ...payload,
  };
}

/**
 * Project a Twitter/X client result into the shape the agent reads. `action`
 * drives the payload; `rateLimit` and the cursor `next` are preserved. `data`
 * is narrowed defensively — the client output originates from an external API.
 */
export function projectTwitterResult(
  result: TwitterAccountResult,
  options: ProjectTwitterOptions = {},
): ConciseTwitterResult {
  const data = isRecord(result.data) ? result.data : {};

  if (result.action === "account_status") {
    const account = projUser(data.account);
    return envelope(result, collectExternalContentFields(account, USER_EXTERNAL_PATHS, "account"), options, { account });
  }
  if (result.action === "user_details") {
    const user = projUser(data.user);
    return envelope(result, collectExternalContentFields(user, USER_EXTERNAL_PATHS, "user"), options, { user });
  }
  if (result.action === "tweet_details") {
    const tweet = projTweet(data.tweet);
    return envelope(result, collectExternalContentFields(tweet, TWEET_EXTERNAL_PATHS, "tweet"), options, { tweet });
  }
  if (result.action === "space_details") {
    const space = projSpace(data.space);
    return envelope(result, collectExternalContentFields(space, SPACE_EXTERNAL_PATHS, "space"), options, { space });
  }
  if (TWEET_LIST_ACTIONS.has(result.action)) {
    const tweets = optArray(data.items).map(projTweet);
    return envelope(result, collectExternalContentPatterns(tweets, "tweets", TWEET_EXTERNAL_PATHS), options, {
      tweets,
      next: nextCursor(data),
      ...emptyListNote(result.action, tweets.length),
    });
  }
  if (USER_LIST_ACTIONS.has(result.action)) {
    const users = optArray(data.items).map(projUser);
    return envelope(result, collectExternalContentPatterns(users, "users", USER_EXTERNAL_PATHS), options, {
      users,
      next: nextCursor(data),
      ...emptyListNote(result.action, users.length),
    });
  }

  // Unknown action — preserve the raw payload instead of silently dropping it.
  // Its shape is unknown, so no path can be named honestly; the warning still
  // leads the payload.
  return envelope(result, [], options, { data: result.data });
}
