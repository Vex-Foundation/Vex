/**
 * `twitter_account` — "empty means absent" at the model boundary.
 *
 * THE DEFECT THIS CLOSES, measured in a live session (2026-07-30)
 *
 * A strong model failed `tweet_search` 5 calls out of 5. Both live shapes are
 * the same standard LLM habit: fill EVERY field the schema advertises, using an
 * empty value for the ones you have nothing to say about.
 *
 *   1. every field filled empty, with the one real criterion in `cashtags`;
 *   2. a real `query`, and every unused filter array sent as `[]`.
 *
 * Zod answered `query: Invalid input` / `filter.fromUsers: Invalid input` — a
 * path and no expectation, on a field the model considered blank rather than
 * supplied. Nothing in that message says "omit it".
 *
 * The contract this pins: for an OPTIONAL field, `""` / `[]` / an object that
 * reduced to nothing MEANS ABSENT. No filter is invented, no criterion is
 * dropped: an empty value carried no information in the first place.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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

const baseContext = makeTestContext();

const EMPTY_SEARCH_RESULT = {
  action: "tweet_search" as const,
  data: { tweets: [], next: undefined },
};

describe("twitter_account — the two live tweet_search failures", () => {
  beforeEach(() => {
    mockExecuteTwitterAccountRequest.mockReset();
    mockExecuteTwitterAccountRequest.mockResolvedValue(EMPTY_SEARCH_RESULT);
  });

  it("accepts the all-fields-filled-empty call whose only real criterion is cashtags", async () => {
    const result = await handleTwitterAccount(
      {
        action: "tweet_search",
        query: "",
        cursor: "",
        filter: {
          fromUsers: [],
          toUsers: [],
          mentions: [],
          hashtags: [],
          cashtags: ["$WIF"],
          includeWords: [],
          optionalWords: [],
          excludeWords: [],
          includePhrase: "",
          language: "",
          list: "",
        },
      },
      baseContext,
    );

    expect(result.success, result.output).toBe(true);
    const sent = mockExecuteTwitterAccountRequest.mock.calls[0]?.[0];
    // The one real criterion survives, normalized as it always was.
    expect(sent.filter.includeWords).toEqual(["$WIF"]);
    // Nothing empty was forwarded as a filter.
    expect(sent.filter).not.toHaveProperty("fromUsers");
    expect(sent.filter).not.toHaveProperty("language");
    expect(sent).not.toHaveProperty("cursor");
    expect(sent).not.toHaveProperty("query");
  });

  it("accepts a real query beside the empty filter arrays, and drops the empty filter", async () => {
    const result = await handleTwitterAccount(
      {
        action: "tweet_search",
        query: "$WIF momentum",
        filter: { fromUsers: [], toUsers: [], mentions: [], hashtags: [] },
      },
      baseContext,
    );

    expect(result.success, result.output).toBe(true);
    const sent = mockExecuteTwitterAccountRequest.mock.calls[0]?.[0];
    expect(sent.query).toBe("$WIF momentum");
    expect(sent).not.toHaveProperty("filter");
  });

  it("still refuses a search that carries NO criterion at all, naming both modes", async () => {
    const result = await handleTwitterAccount(
      { action: "tweet_search", query: "", filter: { fromUsers: [] } },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("query");
    expect(result.output).toContain("filter");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("keeps a REQUIRED empty value a failure, with the expectation stated", async () => {
    const result = await handleTwitterAccount({ action: "tweet_details", tweetId: "" }, baseContext);

    expect(result.success).toBe(false);
    expect(result.output).toContain("tweetId");
    expect(result.output).not.toMatch(/Invalid input$/);
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("does not invent a filter — a genuinely wrong value is still rejected by path", async () => {
    const result = await handleTwitterAccount(
      { action: "tweet_search", query: "wif", filter: { minLikes: 0 } },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("minLikes");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("never drops the discriminator, whatever it holds", async () => {
    const result = await handleTwitterAccount({ action: "" }, baseContext);

    expect(result.success).toBe(false);
    expect(result.output).toContain("action");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });
});
