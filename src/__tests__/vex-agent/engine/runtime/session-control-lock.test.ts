import { beforeEach, describe, expect, it, vi } from "vitest";

import { testPoolClient } from "../../../helpers/db-client.js";

const mocks = vi.hoisted(() => ({
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

/**
 * The lock helpers only hand this client to the mocked `executeWith` and
 * `withTransaction`, so its IDENTITY is the whole contract under test. It is a
 * real client whose query and connect are replaced, so no test can reach a
 * database through it.
 */
const CLIENT = testPoolClient();

vi.mock("@vex-agent/db/client.js", () => ({
  executeWith: mocks.executeWith,
  withTransaction: mocks.withTransaction,
}));

const {
  acquireSessionControlLocks,
  sessionControlLockKey,
  withSessionControlLocks,
} = await import(
  "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeWith.mockResolvedValue(1);
  mocks.withTransaction.mockImplementation(async (fn) => fn(CLIENT));
});

describe("multi-session control locks", () => {
  it("sorts and de-duplicates session ids before taking advisory locks", async () => {
    await acquireSessionControlLocks(CLIENT, [
      "session-z",
      "session-a",
      "session-z",
    ]);

    expect(mocks.executeWith.mock.calls.map((call) => call[2])).toEqual([
      [sessionControlLockKey("session-a")],
      [sessionControlLockKey("session-z")],
    ]);
  });

  it("holds all session locks in the transaction that runs the callback", async () => {
    const result = await withSessionControlLocks(
      ["session-previous", "session-current"],
      async (client) => ({ client, calls: mocks.executeWith.mock.calls.length }),
    );

    expect(result).toEqual({ client: CLIENT, calls: 2 });
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty lock set", async () => {
    await expect(acquireSessionControlLocks(CLIENT, [])).rejects.toThrow(
      "At least one session control lock is required",
    );
    expect(mocks.executeWith).not.toHaveBeenCalled();
  });
});
