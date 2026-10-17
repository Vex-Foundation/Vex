import { describe, expect, it } from "vitest";
import { describePgError } from "../native/pg-identity.js";

/** What node-postgres throws for an error the server sent. */
function serverError(code: string): Error {
  return Object.assign(new Error(`server said ${code}`), { code, severity: "FATAL" });
}

describe("describePgError", () => {
  it("a server with no vex database is not ours", () => {
    expect(describePgError(serverError("3D000")).kind).toBe("foreign_listener");
  });

  it("a rejected password is auth_rejected, not an accusation", () => {
    expect(describePgError(serverError("28P01")).kind).toBe("auth_rejected");
    expect(describePgError(serverError("28000")).kind).toBe("auth_rejected");
  });

  it("a socket errno is never read as a SQLSTATE, even one shaped like it", () => {
    // `EPIPE` fits the five-character class; only `severity` marks a server error.
    expect(describePgError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toEqual({
      kind: "unreachable",
      detail: "write EPIPE",
    });
    expect(describePgError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })).kind).toBe("unreachable");
  });

  it("any other server error (starting up, too many clients) is retryable", () => {
    expect(describePgError(serverError("57P03"))).toMatchObject({ kind: "unreachable", detail: expect.stringMatching(/57P03/) });
  });
});
