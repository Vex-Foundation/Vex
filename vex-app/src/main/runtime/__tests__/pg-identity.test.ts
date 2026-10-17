import { describe, expect, it } from "vitest";
import { describePgError, isDiskFullPgError } from "../native/pg-identity.js";
import { CLIENT_DISK_FULL_ERROR } from "./pg-disk-full-logs.js";

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

describe("isDiskFullPgError", () => {
  it("the client's view of an INSERT on a full volume (PG 18.6, verbatim) is a full disk", () => {
    expect(isDiskFullPgError(Object.assign(new Error(CLIENT_DISK_FULL_ERROR.message), CLIENT_DISK_FULL_ERROR))).toBe(true);
  });

  it("SQLSTATE 53100 from the server is a full disk, whatever the text", () => {
    expect(isDiskFullPgError(serverError("53100"))).toBe(true);
  });

  it("other server errors, and a socket error shaped like the SQLSTATE, are not", () => {
    expect(isDiskFullPgError(serverError("57P03"))).toBe(false);
    expect(isDiskFullPgError(Object.assign(new Error("refused"), { code: "53100" }))).toBe(false);
    expect(isDiskFullPgError(new Error("write EPIPE"))).toBe(false);
  });
});
