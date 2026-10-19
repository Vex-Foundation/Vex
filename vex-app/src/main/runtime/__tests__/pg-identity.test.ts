import { describe, expect, it } from "vitest";
import { describePgError, isDiskFullPgError, isDuplicateDatabaseError } from "../native/pg-identity.js";
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

describe("isDuplicateDatabaseError", () => {
  it("reads duplicate_database as the database being there", () => {
    expect(isDuplicateDatabaseError(serverError("42P04"))).toBe(true);
  });

  it("reads the unique violation a racing CREATE DATABASE gets as the database being there", () => {
    // Measured on a Windows runner: a create the client had given up on
    // committed while the retry's create waited, and the retry got this.
    const raced = Object.assign(serverError("23505"), { constraint: "pg_database_datname_index" });
    expect(isDuplicateDatabaseError(raced)).toBe(true);
  });

  it("does not swallow any other unique violation, a socket error or a disk full", () => {
    expect(isDuplicateDatabaseError(Object.assign(serverError("23505"), { constraint: "pg_authid_rolname_index" }))).toBe(false);
    expect(isDuplicateDatabaseError(serverError("23505"))).toBe(false);
    expect(isDuplicateDatabaseError(Object.assign(new Error("Query read timeout"), { code: "ETIMEDOUT" }))).toBe(false);
    expect(isDuplicateDatabaseError(serverError("53100"))).toBe(false);
  });
});
