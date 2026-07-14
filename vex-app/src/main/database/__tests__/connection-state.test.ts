import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDbConnection,
  setDbConnection,
  subscribeDbConnection,
} from "../connection-state.js";

afterEach(() => {
  setDbConnection(null);
});

describe("main database connection state", () => {
  it("notifies subscribers of the previous and next main-only connection values", () => {
    const listener = vi.fn();
    const off = subscribeDbConnection(listener);
    const connection = { pgPort: 5432, pgPasswordPath: "/tmp/password" };

    setDbConnection(connection);

    expect(getDbConnection()).toEqual(connection);
    expect(listener).toHaveBeenCalledWith(connection, null);
    off();
  });
});
