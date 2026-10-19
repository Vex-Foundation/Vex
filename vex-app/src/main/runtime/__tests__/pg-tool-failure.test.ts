import { describe, expect, it } from "vitest";

import { pgToolFailureSummary } from "../migration/pg-tool-failure.js";
import {
  DUMP_MISSING_DATABASE,
  DUMP_PERMISSION_DENIED,
  RESTORE_CONNECTION_REFUSED,
  RESTORE_COPY_CHECK_VIOLATION,
  RESTORE_CREATE_TABLE_EXISTS,
  RESTORE_SERVER_TERMINATED,
  toCrlf,
} from "./pg-client-tool-stderr.js";

describe("pgToolFailureSummary", () => {
  it("names the error and the statement's first line, not the statement's tail", () => {
    const summary = pgToolFailureSummary("pg_restore", { code: 1, stderr: RESTORE_CREATE_TABLE_EXISTS });
    expect(summary).toBe(
      'pg_restore: error: could not execute query: ERROR:  relation "activity" already exists'
        + " | statement: CREATE TABLE public.activity ( [8 more lines]",
    );
    expect(summary).not.toContain("activity_status_check");
  });

  it("reads Windows output (CRLF) the same way and keeps no carriage return", () => {
    const summary = pgToolFailureSummary("pg_restore", { code: 1, stderr: toCrlf(RESTORE_CREATE_TABLE_EXISTS) });
    expect(summary).toBe(pgToolFailureSummary("pg_restore", { code: 1, stderr: RESTORE_CREATE_TABLE_EXISTS }));
    expect(summary).not.toContain("\r");
  });

  it("keeps a failed COPY's cause and leaves out the server lines that quote the row", () => {
    const summary = pgToolFailureSummary("pg_restore", { code: 1, stderr: RESTORE_COPY_CHECK_VIOLATION });
    expect(summary).toBe(
      'pg_restore: error: COPY failed for table "activity": ERROR:  new row for relation "activity" violates check constraint "activity_note_check"',
    );
    expect(summary).not.toContain("synthetic row two");
  });

  it.each([
    [
      "the server died mid-restore",
      RESTORE_SERVER_TERMINATED,
      "pg_restore: error: error returned by PQputCopyData: server closed the connection unexpectedly"
        + " | This probably means the server terminated abnormally | before or while processing the request.",
    ],
    [
      "nothing listens on the port",
      RESTORE_CONNECTION_REFUSED,
      'pg_restore: error: connection to server at "127.0.0.1", port 1 failed: Connection refused'
        + " | Is the server running on that host and accepting TCP/IP connections?",
    ],
  ])("keeps libpq's continuation lines when %s", (_name, stderr, expected) => {
    expect(pgToolFailureSummary("pg_restore", { code: 1, stderr })).toBe(expected);
  });

  it("keeps pg_dump's error and its own detail line", () => {
    expect(pgToolFailureSummary("pg_dump", { code: 1, stderr: DUMP_PERMISSION_DENIED })).toBe(
      "pg_dump: error: query failed: ERROR:  permission denied for table activity"
        + " | pg_dump: detail: Query was: LOCK TABLE public.activity IN ACCESS SHARE MODE",
    );
    expect(pgToolFailureSummary("pg_dump", { code: 1, stderr: DUMP_MISSING_DATABASE })).toBe(DUMP_MISSING_DATABASE.trim());
  });

  it("returns stderr it does not recognize whole", () => {
    expect(pgToolFailureSummary("pg_restore", { code: 1, stderr: "something odd\r\nhappened\r\n" })).toBe("something odd | happened");
  });

  it("says when the tool printed nothing", () => {
    expect(pgToolFailureSummary("pg_restore", { code: 3, stderr: "" })).toBe("pg_restore exited with code 3 and printed nothing");
    expect(pgToolFailureSummary("pg_dump", { code: null, stderr: " \n" })).toBe("pg_dump was stopped before it finished and printed nothing");
  });
});
