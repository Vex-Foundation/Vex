/**
 * W2B contract pins for `twitter_account` output.
 *
 *  - `externalContentWarning` is the FIRST key of EVERY action's output shape
 *    (owner directive). Post text is the tool's hostile surface: the live recon
 *    found row #1 of an unfiltered `$WIF` sweep pasting a contract address, so
 *    the label leads the payload rather than trailing it.
 *  - `response_format` is retired BY NAME-REJECTION, not by silent deletion:
 *    the handler used to read it off the RAW params before the Zod union
 *    (which strips unknown keys), so dropping the read would have silently
 *    ACCEPTED `response_format:"detailed"` and returned concise anyway.
 *  - `createdAt` (ISO) is preserved and `createdAtMs` added alongside,
 *    finite-or-null, never NaN.
 *  - `fullText` is never truncated.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestContext } from "../_test-context.js";

const mockExecuteTwitterAccountRequest = vi.hoisted(() => vi.fn());

vi.mock("@tools/twitter-account/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/twitter-account/client.js")>();
  return {
    ...actual,
    executeTwitterAccountRequest: mockExecuteTwitterAccountRequest,
  };
});

const { handleTwitterAccount } = await import(
  "../../../../vex-agent/tools/internal/twitter-account.js"
);
const { RESEARCH_EXTERNAL_CONTENT_WARNING } = await import(
  "../../../../vex-agent/tools/internal/research-provenance.js"
);

const ctx = makeTestContext();

function tweetPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    url: "https://x.com/someone/1",
    createdAt: "2026-07-27T10:15:30.000Z",
    fullText: "a".repeat(1500),
    lang: "en",
    likeCount: 42,
    replyCount: 3,
    retweetCount: 7,
    quoteCount: 1,
    viewCount: 900,
    tweetBy: { userName: "someone", fullName: "Some One", followersCount: 1200, isVerified: false },
    ...overrides,
  };
}

function firstKey(output: string): string {
  const [first] = Object.keys(JSON.parse(output) as Record<string, unknown>);
  if (first === undefined) throw new Error("expected a non-empty payload");
  return first;
}

describe("twitter_account — W2B output contract", () => {
  const originalApiKey = process.env.RETTIWT_API_KEY;

  beforeEach(() => {
    mockExecuteTwitterAccountRequest.mockReset();
    process.env.RETTIWT_API_KEY = "test-key";
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.RETTIWT_API_KEY;
    else process.env.RETTIWT_API_KEY = originalApiKey;
  });

  // ── Warning placement, every action ───────────────────────────

  const shapes: ReadonlyArray<{
    label: string;
    params: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [
    {
      label: "tweet_search",
      params: { action: "tweet_search", query: "$WIF" },
      result: { action: "tweet_search", data: { items: [tweetPayload()], next: "c1" } },
    },
    {
      label: "tweet_details",
      params: { action: "tweet_details", tweetId: "1" },
      result: { action: "tweet_details", data: { tweet: tweetPayload() } },
    },
    {
      label: "user_timeline",
      params: { action: "user_timeline", username: "someone" },
      result: { action: "user_timeline", data: { items: [tweetPayload()], next: "" } },
    },
    {
      label: "tweet_likers (user list)",
      params: { action: "tweet_likers", tweetId: "1" },
      result: {
        action: "tweet_likers",
        data: { items: [{ id: "u1", userName: "liker", fullName: "Liker", description: "bio" }], next: "" },
      },
    },
    {
      label: "user_details",
      params: { action: "user_details", username: "someone" },
      result: { action: "user_details", data: { user: { id: "u1", userName: "someone" } } },
    },
    {
      label: "account_status",
      params: { action: "account_status" },
      result: { action: "account_status", data: { account: { id: "u0", userName: "research" } } },
    },
    {
      label: "space_details",
      params: { action: "space_details", spaceId: "s1" },
      result: { action: "space_details", data: { space: { id: "s1", title: "Space" } } },
    },
  ];

  for (const shape of shapes) {
    it(`puts externalContentWarning FIRST for ${shape.label}`, async () => {
      mockExecuteTwitterAccountRequest.mockResolvedValueOnce(shape.result);

      const result = await handleTwitterAccount(shape.params, ctx);
      expect(result.success).toBe(true);
      expect(firstKey(result.output)).toBe("externalContentWarning");
      const payload = JSON.parse(result.output) as Record<string, unknown>;
      expect(payload.externalContentWarning).toBe(RESEARCH_EXTERNAL_CONTENT_WARNING);
      expect(Object.keys(payload)[1]).toBe("externalContentFields");
      expect(payload.action).toBe(shape.result.action);
    });
  }

  it("names the dot paths that actually carry post text", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce({
      action: "tweet_search",
      data: { items: [tweetPayload()], next: "" },
    });

    const result = await handleTwitterAccount({ action: "tweet_search", query: "$WIF" }, ctx);
    const payload = JSON.parse(result.output) as { externalContentFields: string[] };
    expect(payload.externalContentFields).toContain("tweets[].fullText");
    expect(payload.externalContentFields).toContain("tweets[].author.userName");
    // Identity is never flagged as suspect prose (same rule as tokenAddress).
    expect(payload.externalContentFields).not.toContain("tweets[].id");
  });

  // ── response_format retirement ────────────────────────────────

  it("REJECTS response_format by name, naming the replacement", async () => {
    const result = await handleTwitterAccount(
      { action: "account_status", response_format: "detailed" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("response_format");
    expect(result.output).toContain("concise");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("rejects response_format even when its value is the old default", async () => {
    const result = await handleTwitterAccount(
      { action: "account_status", response_format: "concise" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  // ── Row fields ────────────────────────────────────────────────

  it("preserves createdAt and adds a finite createdAtMs", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce({
      action: "tweet_details",
      data: { tweet: tweetPayload() },
    });

    const result = await handleTwitterAccount({ action: "tweet_details", tweetId: "1" }, ctx);
    const payload = JSON.parse(result.output) as { tweet: Record<string, unknown> };
    expect(payload.tweet.createdAt).toBe("2026-07-27T10:15:30.000Z");
    expect(payload.tweet.createdAtMs).toBe(Date.parse("2026-07-27T10:15:30.000Z"));
  });

  it("a malformed provider date yields createdAtMs null — never NaN", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce({
      action: "tweet_details",
      data: { tweet: tweetPayload({ createdAt: "whenever" }) },
    });

    const result = await handleTwitterAccount({ action: "tweet_details", tweetId: "1" }, ctx);
    const payload = JSON.parse(result.output) as { tweet: Record<string, unknown> };
    expect(payload.tweet.createdAt).toBe("whenever");
    expect(payload.tweet.createdAtMs).toBeNull();
    expect(result.output).not.toContain("NaN");
  });

  it("never truncates fullText", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce({
      action: "tweet_details",
      data: { tweet: tweetPayload() },
    });

    const result = await handleTwitterAccount({ action: "tweet_details", tweetId: "1" }, ctx);
    const payload = JSON.parse(result.output) as { tweet: { fullText: string } };
    expect(payload.tweet.fullText).toHaveLength(1500);
  });

  it("echoes the resolved search window in filtersApplied", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce({
      action: "tweet_search",
      data: { items: [], next: "" },
    });

    const result = await handleTwitterAccount(
      { action: "tweet_search", query: "$WIF", filter: { minLikes: 10, language: "en" } },
      ctx,
    );
    const payload = JSON.parse(result.output) as { filtersApplied: Record<string, unknown> };
    expect(payload.filtersApplied.minLikes).toBe(10);
    expect(payload.filtersApplied.language).toBe("en");
  });
});
