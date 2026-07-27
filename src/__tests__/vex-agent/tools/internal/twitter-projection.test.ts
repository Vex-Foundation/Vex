import { describe, it, expect } from "vitest";
import { projectTwitterResult } from "../../../../vex-agent/tools/internal/twitter-projection.js";
import type { TwitterAccountResult } from "@tools/twitter-account/types.js";

// ── Fixtures (verbose payloads mirroring rettiwt ITweet/IUser/ISpace) ──

function fullUser(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "u1",
    userName: "research",
    fullName: "Research Account",
    followersCount: 1234,
    followingsCount: 56,
    isVerified: true,
    description: "bio text",
    // noise that must be dropped:
    profileBanner: "https://img/banner.png",
    profileImage: "https://img/avatar.png",
    statusesCount: 999,
    location: "Earth",
    pinnedTweets: ["t1", "t2"],
    likeCount: 42,
    createdAt: "2020-01-01",
    isFollowed: false,
    isFollowing: true,
    ...over,
  };
}

function fullTweet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t1",
    url: "https://x.com/research/status/t1",
    createdAt: "2026-06-19T00:00:00Z",
    fullText: "hello world",
    lang: "en",
    likeCount: 10,
    replyCount: 2,
    retweetCount: 3,
    quoteCount: 1,
    viewCount: 500,
    media: [{ id: "m1", type: "photo", url: "https://img/m1.jpg" }],
    tweetBy: fullUser(),
    // noise that must be dropped:
    entities: { hashtags: ["x"], mentionedUsers: ["u9"], urls: ["http://x"] },
    conversationId: "conv1",
    replyTo: "t0",
    bookmarkCount: 7,
    ...over,
  };
}

function isProjectedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectedRecord(value: unknown): Record<string, unknown> {
  if (!isProjectedRecord(value)) throw new Error("expected a projected record");
  return value;
}

function expectNoTweetNoise(tweet: Record<string, unknown>): void {
  for (const key of ["entities", "conversationId", "replyTo", "bookmarkCount"]) {
    expect(tweet).not.toHaveProperty(key);
  }
  // author is lean (no profileImage/description leak)
  const author = tweet.author as Record<string, unknown> | undefined;
  expect(author).not.toHaveProperty("profileImage");
  expect(author).not.toHaveProperty("description");
}

function expectNoUserNoise(user: Record<string, unknown>): void {
  for (const key of [
    "profileBanner",
    "profileImage",
    "statusesCount",
    "location",
    "pinnedTweets",
    "likeCount",
    "createdAt",
    "isFollowed",
    "isFollowing",
  ]) {
    expect(user).not.toHaveProperty(key);
  }
}

describe("projectTwitterResult — concise shape per action", () => {
  it("account_status → { action, account: projUser }", () => {
    const result: TwitterAccountResult = {
      action: "account_status",
      data: { account: fullUser() },
    };
    const out = projectedRecord(projectTwitterResult(result));
    expect(out.action).toBe("account_status");
    const account = out.account as Record<string, unknown>;
    expect(account.userName).toBe("research");
    expect(account.description).toBe("bio text");
    expectNoUserNoise(account);
  });

  it("user_details → { action, user: projUser }", () => {
    const result: TwitterAccountResult = {
      action: "user_details",
      data: { user: fullUser({ userName: "openai" }) },
    };
    const out = projectedRecord(projectTwitterResult(result));
    const user = out.user as Record<string, unknown>;
    expect(user.userName).toBe("openai");
    expectNoUserNoise(user);
  });

  it("tweet_details → { action, tweet: projTweet } with media as types[]", () => {
    const result: TwitterAccountResult = {
      action: "tweet_details",
      data: { tweet: fullTweet() },
    };
    const out = projectedRecord(projectTwitterResult(result));
    const tweet = out.tweet as Record<string, unknown>;
    expect(tweet.fullText).toBe("hello world");
    expect(tweet.media).toEqual(["photo"]);
    expectNoTweetNoise(tweet);
  });

  it("space_details → counts only, participant arrays dropped", () => {
    const result: TwitterAccountResult = {
      action: "space_details",
      data: {
        space: {
          id: "s1",
          state: "Ended",
          title: "AMA",
          createdAt: "2026-06-18",
          startedAt: "2026-06-18T01:00:00Z",
          endedAt: "2026-06-18T02:00:00Z",
          creatorId: "u1",
          participantCount: 120,
          totalLiveListeners: 80,
          participants: {
            total: 120,
            admins: [{ id: "a1" }, { id: "a2" }],
            speakers: [{ id: "sp1" }],
            listeners: [{ id: "l1" }, { id: "l2" }, { id: "l3" }],
          },
        },
      },
    };
    const out = projectedRecord(projectTwitterResult(result));
    const space = out.space as Record<string, unknown>;
    expect(space).not.toHaveProperty("participants");
    expect(space.participantCount).toBe(120);
    expect(space.totalLiveListeners).toBe(80);
    expect(space.adminsCount).toBe(2);
    expect(space.speakersCount).toBe(1);
    expect(space.listenersCount).toBe(3);
  });

  const TWEET_LIST_ACTIONS = [
    "tweet_search",
    "tweet_replies",
    "user_timeline",
    "user_replies",
  ] as const;

  it.each(TWEET_LIST_ACTIONS)("%s → { tweets: projTweet[], next }", (action) => {
    const result: TwitterAccountResult = {
      action,
      data: { items: [fullTweet(), fullTweet({ id: "t2" })], next: "CURSOR123" },
    };
    const out = projectedRecord(projectTwitterResult(result));
    expect(out.action).toBe(action);
    expect(out.next).toBe("CURSOR123");
    const tweets = out.tweets as Array<Record<string, unknown>>;
    expect(tweets).toHaveLength(2);
    tweets.forEach(expectNoTweetNoise);
  });

  const USER_LIST_ACTIONS = [
    "tweet_likers",
    "tweet_retweeters",
    "user_search",
    "user_followers",
    "user_following",
  ] as const;

  it.each(USER_LIST_ACTIONS)("%s → { users: projUser[], next }", (action) => {
    const result: TwitterAccountResult = {
      action,
      data: { items: [fullUser(), fullUser({ id: "u2" })], next: "" },
    };
    const out = projectedRecord(projectTwitterResult(result));
    expect(out.action).toBe(action);
    expect(out.next).toBe("");
    const users = out.users as Array<Record<string, unknown>>;
    expect(users).toHaveLength(2);
    users.forEach(expectNoUserNoise);
  });
});

describe("projectTwitterResult — nested + meta preservation", () => {
  it("shallow-projects quoted/retweeted tweets to { id, url, author:{userName} }", () => {
    const tweet = fullTweet({
      quoted: fullTweet({ id: "q1", url: "https://x.com/q1" }),
      retweetedTweet: fullTweet({ id: "r1", url: "https://x.com/r1" }),
    });
    const result: TwitterAccountResult = {
      action: "tweet_details",
      data: { tweet },
    };
    const out = projectedRecord(projectTwitterResult(result));
    const projected = projectedRecord(out.tweet);

    const quoted = projected.quoted as Record<string, unknown>;
    expect(Object.keys(quoted).sort()).toEqual(["author", "id", "url"]);
    expect(quoted.id).toBe("q1");
    expect((quoted.author as Record<string, unknown>).userName).toBe("research");
    // shallow: nested noise must NOT survive
    expect(quoted).not.toHaveProperty("fullText");
    expect(quoted).not.toHaveProperty("entities");

    const rt = projected.retweetedTweet as Record<string, unknown>;
    expect(rt.id).toBe("r1");
    expect(rt).not.toHaveProperty("fullText");
  });

  it("preserves rateLimit when present, omits it when absent", () => {
    const withRl: TwitterAccountResult = {
      action: "account_status",
      data: { account: fullUser() },
      rateLimit: { limit: "100", remaining: "99", reset: "1700000000" },
    };
    const a = projectedRecord(projectTwitterResult(withRl));
    expect(a.rateLimit).toEqual({ limit: "100", remaining: "99", reset: "1700000000" });

    const withoutRl: TwitterAccountResult = {
      action: "account_status",
      data: { account: fullUser() },
    };
    const b = projectedRecord(projectTwitterResult(withoutRl));
    expect(b).not.toHaveProperty("rateLimit");
  });

  it("defensively tolerates missing/invalid data without throwing", () => {
    const broken: TwitterAccountResult = { action: "tweet_search", data: null };
    const out = projectedRecord(projectTwitterResult(broken));
    expect(out.tweets).toEqual([]);
    expect(out.next).toBe("");
  });
});
