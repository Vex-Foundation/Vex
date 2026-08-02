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

describe("twitter_account", () => {
  const originalApiKey = process.env.RETTIWT_API_KEY;

  beforeEach(() => {
    mockExecuteTwitterAccountRequest.mockReset();
    if (originalApiKey === undefined) delete process.env.RETTIWT_API_KEY;
    else process.env.RETTIWT_API_KEY = originalApiKey;
  });

  it("rejects missing action", async () => {
    const result = await handleTwitterAccount({}, baseContext);

    expect(result.success).toBe(false);
    expect(result.output).toContain("twitter_account:");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("calls the Rettiwt client for a valid account_status request", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce({
      action: "account_status",
      data: { account: { id: "123", userName: "research" } },
    });

    const result = await handleTwitterAccount({ action: "account_status" }, baseContext);

    expect(result.success).toBe(true);
    expect(result.output).toContain("\"account_status\"");
    expect(mockExecuteTwitterAccountRequest).toHaveBeenCalledWith({ action: "account_status" });
  });

  it("normalizes leading @ in usernames before execution", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce({
      action: "user_details",
      data: { user: { userName: "openai" } },
    });

    const result = await handleTwitterAccount(
      { action: "user_details", username: "@openai" },
      baseContext,
    );

    expect(result.success).toBe(true);
    expect(mockExecuteTwitterAccountRequest).toHaveBeenCalledWith({
      action: "user_details",
      username: "openai",
    });
  });

  // An EMPTY filter object is now read as an absent filter (the model boundary's
  // "empty means absent" rule), so this call is rejected as a search carrying no
  // criterion at all — same refusal, and the message now names both search modes.
  it("rejects tweet_search without a filter field", async () => {
    const result = await handleTwitterAccount(
      { action: "tweet_search", filter: {} },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("tweet_search needs ONE of two things");
    expect(result.output).toContain("filter");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("rejects tweet_search without query or filter", async () => {
    const result = await handleTwitterAccount(
      { action: "tweet_search" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("tweet_search needs ONE of two things");
    expect(result.output).toContain("`query`");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("accepts tweet_search with a query shortcut", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce({
      action: "tweet_search",
      data: { items: [], next: "" },
    });

    const result = await handleTwitterAccount(
      { action: "tweet_search", query: "pump fun", count: 5 },
      baseContext,
    );

    expect(result.success).toBe(true);
    expect(mockExecuteTwitterAccountRequest).toHaveBeenCalledWith({
      action: "tweet_search",
      query: "pump fun",
      count: 5,
    });
  });

  // ── response_format (P0-5 concise default) ────────────────────
  const noisyUserResult = {
    action: "user_details",
    data: {
      user: {
        id: "u1",
        userName: "openai",
        fullName: "OpenAI",
        followersCount: 10,
        followingsCount: 1,
        isVerified: true,
        profileImage: "https://img/avatar.png",
        profileBanner: "https://img/banner.png",
        pinnedTweets: ["t1"],
      },
    },
  };

  it("defaults to concise projection (strips profileImage) when response_format is absent", async () => {
    mockExecuteTwitterAccountRequest.mockResolvedValueOnce(noisyUserResult);

    const result = await handleTwitterAccount(
      { action: "user_details", username: "openai" },
      baseContext,
    );

    expect(result.success).toBe(true);
    expect(result.output).not.toContain("profileImage");
    expect(result.output).not.toContain("profileBanner");
    expect(result.output).toContain("\"userName\":\"openai\"");
  });

  // W2B retired `response_format`. These three flipped from "concise wins" /
  // "detailed passes through" / "an unknown value falls back" to a single rule:
  // the param is rejected BY NAME, whatever its value, and no request is made.
  // Silent deletion was not an option — the union strips unknown keys, so a
  // dropped read would have ACCEPTED `detailed` and quietly returned concise.
  it("response_format='concise' is rejected by name — the projection is the only shape", async () => {
    const result = await handleTwitterAccount(
      { action: "user_details", username: "openai", response_format: "concise" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("response_format");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("response_format='detailed' is rejected by name — the verbatim payload is gone", async () => {
    const result = await handleTwitterAccount(
      { action: "user_details", username: "openai", response_format: "detailed" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("response_format");
    expect(result.output).not.toContain("profileImage");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  it("an unknown response_format value is rejected too — never a silent fallback", async () => {
    const result = await handleTwitterAccount(
      { action: "user_details", username: "openai", response_format: "verbose" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("response_format");
    expect(mockExecuteTwitterAccountRequest).not.toHaveBeenCalled();
  });

  /**
   * This used to assert a DENYLIST: the provider's sentence reached the model
   * with three secret shapes rewritten to `[redacted]`. The contract is now an
   * ALLOWLIST — a Vex-owned code and a static message — so the secrets are gone
   * along with the sentence that carried them, redaction markers included.
   * Adversarial coverage lives in `twitter-account-provider-error.test.ts`.
   */
  it("carries no provider error text at all — not the secrets, not the redaction markers", async () => {
    process.env.RETTIWT_API_KEY = "secret-do-not-leak";
    mockExecuteTwitterAccountRequest.mockRejectedValueOnce(
      new Error("failed secret-do-not-leak auth_token=abc; ct0=def Bearer token.value"),
    );

    const result = await handleTwitterAccount({ action: "account_status" }, baseContext);

    expect(result.success).toBe(false);
    expect(result.output).toContain("twitter_account:");
    expect(result.output).toContain("provider_rejected");
    expect(result.output).not.toContain("secret-do-not-leak");
    expect(result.output).not.toContain("auth_token");
    expect(result.output).not.toContain("Bearer");
    expect(result.output).not.toContain("[redacted]");
  });
});
