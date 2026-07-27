/**
 * The read-only guarantee is enforced by the CLOSED Zod action union, and that
 * schema is load-bearing: rettiwt-api 7.1.x ships list mutation, tweet posting,
 * follower removal, DM and media-upload resources. The SDK can do all of it;
 * the tool cannot reach any of it.
 *
 * This pins that claim against the SDK's OWN `ResourceType` enum rather than a
 * hand-copied list, so an SDK upgrade that adds a mutation resource fails here
 * instead of quietly widening the surface (`rules/90`: never let a test
 * re-implement the thing under test).
 *
 * Two independent proofs:
 *   1. no mutation resource name is accepted as an `action`, and none appears
 *      in the agent-facing action enum;
 *   2. driving EVERY action of the schema through the production client touches
 *      only read-only SDK methods — recorded by a proxy, compared to an
 *      allowlist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwitterAccountParamsSchema } from "@tools/twitter-account/schema.js";
import { TWITTER_ACCOUNT_TOOLS } from "@vex-agent/tools/registry/twitter-account.js";

const touched = vi.hoisted(() => new Set<string>());

vi.mock("rettiwt-api", async () => {
  const actual = await vi.importActual<typeof import("rettiwt-api")>("rettiwt-api");

  /** Every SDK call resolves to a shape the production serializers accept. */
  const benign = { list: [], next: "", id: "1" };

  function namespace(name: string): unknown {
    return new Proxy(
      {},
      {
        get(_target, property) {
          const method = String(property);
          return async (..._args: unknown[]) => {
            touched.add(`${name}.${method}`);
            return benign;
          };
        },
      },
    );
  }

  class RecordingRettiwt {
    user = namespace("user");
    tweet = namespace("tweet");
    space = namespace("space");
    list = namespace("list");
    media = namespace("media");
    dm = namespace("dm");
  }

  return { ...actual, Rettiwt: RecordingRettiwt };
});

const { executeTwitterAccountRequest } = await import("@tools/twitter-account/client.js");
const rettiwt = await vi.importActual<typeof import("rettiwt-api")>("rettiwt-api");

/**
 * Resource names whose verb changes state (or reads private messages). Derived
 * from the enum by token so a newly-added mutation resource is covered without
 * editing this list.
 */
const MUTATING_TOKENS = new Set([
  "POST", "UNPOST", "LIKE", "UNLIKE", "RETWEET", "UNRETWEET", "BOOKMARK", "UNBOOKMARK",
  "FOLLOW", "UNFOLLOW", "CREATE", "DELETE", "UPDATE", "MUTE", "UNMUTE", "ADD", "REMOVE",
  "CHANGE", "SCHEDULE", "UNSCHEDULE", "UPLOAD", "INITIALIZE", "APPEND", "FINALIZE", "DM",
]);

function isMutatingResource(resource: string): boolean {
  return resource.split("_").some((token) => MUTATING_TOKENS.has(token));
}

const MUTATION_RESOURCES = Object.values(rettiwt.ResourceType).filter(isMutatingResource);

/** Every action the agent-facing manifest advertises. */
function manifestActions(): string[] {
  const tool = TWITTER_ACCOUNT_TOOLS[0];
  if (!tool) throw new Error("the twitter_account manifest is missing");
  const action = tool.parameters.properties?.action;
  return [...(action?.enum ?? [])];
}

describe("twitter_account — closed read-only action union", () => {
  const originalApiKey = process.env.RETTIWT_API_KEY;

  beforeEach(() => {
    process.env.RETTIWT_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.RETTIWT_API_KEY;
    else process.env.RETTIWT_API_KEY = originalApiKey;
  });

  it("recognises the SDK's concrete mutation resources", () => {
    // Pins the predicate itself: if these four ever stop being classified as
    // mutations, the proof below is vacuous.
    for (const resource of ["LIST_CREATE", "LIST_DELETE", "TWEET_POST", "USER_REMOVE_FOLLOWER"]) {
      expect(MUTATION_RESOURCES).toContain(resource);
    }
    // …and does not over-classify the reads we legitimately use.
    for (const resource of ["TWEET_SEARCH", "TWEET_LIKERS", "USER_FOLLOWERS", "USER_FOLLOWING", "USER_LIKES"]) {
      expect(MUTATION_RESOURCES).not.toContain(resource);
    }
  });

  it("accepts NO mutation resource as an action, in the schema or the manifest", () => {
    const actions = manifestActions();
    for (const resource of MUTATION_RESOURCES) {
      const asAction = resource.toLowerCase();
      expect(actions).not.toContain(asAction);
      expect(TwitterAccountParamsSchema.safeParse({ action: asAction }).success).toBe(false);
      expect(
        TwitterAccountParamsSchema.safeParse({ action: asAction, tweetId: "1", username: "x" }).success,
      ).toBe(false);
    }
  });

  it("touches only read-only SDK methods when every advertised action runs", async () => {
    const invocations: ReadonlyArray<Record<string, unknown>> = [
      { action: "account_status" },
      { action: "tweet_details", tweetId: "1" },
      { action: "tweet_search", query: "$WIF" },
      { action: "tweet_replies", tweetId: "1" },
      { action: "tweet_likers", tweetId: "1" },
      { action: "tweet_retweeters", tweetId: "1" },
      { action: "space_details", spaceId: "s1" },
      { action: "user_details", username: "someone" },
      { action: "user_search", query: "solana" },
      { action: "user_timeline", userId: "1" },
      { action: "user_replies", userId: "1" },
      { action: "user_followers", userId: "1" },
      { action: "user_following", userId: "1" },
    ];
    // Every advertised action is exercised — no action may go unproven.
    expect(invocations.map((i) => i.action).sort()).toEqual([...manifestActions()].sort());

    for (const params of invocations) {
      const parsed = TwitterAccountParamsSchema.safeParse(params);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      await executeTwitterAccountRequest(parsed.data);
    }

    expect([...touched].sort()).toEqual([
      "space.details",
      "tweet.details",
      "tweet.likers",
      "tweet.replies",
      "tweet.retweeters",
      "tweet.search",
      "user.details",
      "user.followers",
      "user.following",
      "user.replies",
      "user.search",
      "user.timeline",
    ]);
  });
});

describe("twitter_account — client credentials", () => {
  const originalApiKey = process.env.RETTIWT_API_KEY;

  beforeEach(() => {
    process.env.RETTIWT_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.RETTIWT_API_KEY;
    else process.env.RETTIWT_API_KEY = originalApiKey;
  });

  it("refuses to build a client without the configured key", async () => {
    delete process.env.RETTIWT_API_KEY;
    await expect(
      executeTwitterAccountRequest({ action: "account_status" }),
    ).rejects.toThrow(/RETTIWT_API_KEY/);
  });
});
