/**
 * THE SPAWN TRACE, and the one property that makes it safe to ship.
 *
 * A spawn trace is the diagnostic a user attaches to a bug report, and the
 * environment it describes is the one the user exported before launching Vex -
 * `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `npm_config__auth`. Logging it raw
 * would put live credentials in a file that travels. So the assertion here is
 * not "the trace mentions the executable"; it is that NO VALUE from the
 * environment survives into the line, while the keys and the diagnosable facts
 * do.
 *
 * The formatter is tested directly rather than through a spawn: proving a
 * string is redacted should not require a real shell, and `real-pty.test.ts`
 * covers the sink actually being called.
 */

import { describe, expect, it } from "vitest";
import { formatSpawnTrace, isFatalPtyError } from "../node-pty-spawner.js";

const SECRET = "ghp_liveTokenThatMustNotAppearAnywhere";

const ENV = {
  PATH: "/usr/bin:/bin",
  GITHUB_TOKEN: SECRET,
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  EMPTY_ONE: "",
};

describe("the spawn trace", () => {
  it("carries the executable, args and cwd, which are what a launch bug needs", () => {
    const line = formatSpawnTrace("/bin/bash", ["-l"], "/home/user/project", ENV);

    expect(line).toContain("/bin/bash");
    expect(line).toContain("-l");
    expect(line).toContain("/home/user/project");
    expect(line.startsWith("[pty-host] spawn ")).toBe(true);
  });

  it("REDACTS every environment value while keeping every key", () => {
    const line = formatSpawnTrace("/bin/bash", [], "/tmp", ENV);

    // The whole point. A substring check is the right assertion: it fails for
    // any encoding of the secret the formatter might produce.
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("wJalrXUtnFEMI");
    expect(line).not.toContain("/usr/bin:/bin");

    // Keys survive, because "not set at all" and "set but empty" are different
    // bugs and the trace has to tell them apart.
    expect(line).toContain("GITHUB_TOKEN");
    expect(line).toContain("AWS_SECRET_ACCESS_KEY");
    expect(line).toContain("EMPTY_ONE");
    expect(line).toContain("<0 chars>");
    expect(line).toContain(`<${String(SECRET.length)} chars>`);
  });

  it("is a single line, so one spawn is one record in the host's stream", () => {
    const line = formatSpawnTrace("/bin/sh", ["-c", "echo hi\nand more"], "/tmp", ENV);
    // JSON.stringify escapes the newline inside the argument rather than
    // breaking the record in two.
    expect(line.includes("\n")).toBe(false);
  });

  it("survives an environment with no variables at all", () => {
    expect(() => formatSpawnTrace("/bin/sh", [], "/tmp", {})).not.toThrow();
  });
});

/**
 * WHICH SOCKET ERRORS ARE THE TERMINAL'S DEATH, as node-pty itself decides it.
 *
 * node-pty's socket handler returns early for `EAGAIN` and for `EIO`/`errno 5`
 * and THROWS everything else (`unixTerminal.js:102-124`,
 * `windowsTerminal.js:92-101`). The seam forwards exactly the throwing set, so
 * this table is that source read back: get it wrong in one direction and a clean
 * shell exit is reported as a terminal failure, get it wrong in the other and
 * the failure the seam exists for is swallowed.
 */
describe("the fatal-error classification", () => {
  function withCode(message: string, code?: string): Error {
    const error = new Error(message);
    if (code !== undefined) Object.assign(error, { code });
    return error;
  }

  it.each([
    // Startup noise from a tty.ReadStream, twice, on every Unix spawn.
    ["EAGAIN", "read EAGAIN", "EAGAIN", false],
    // The last process in the terminal closed it. The exit event carries this.
    ["EIO", "read EIO", "EIO", false],
    ["errno 5", "read errno 5", "errno 5", false],
    ["ECONNRESET", "read ECONNRESET", "ECONNRESET", true],
    ["EPIPE", "write EPIPE", "EPIPE", true],
    ["EBADF", "read EBADF", "EBADF", true],
  ])("treats %s as fatal=%j", (_label, message, code, fatal) => {
    expect(isFatalPtyError(withCode(message, code))).toBe(fatal);
  });

  it("treats an error with NO code as fatal, because node-pty throws it", () => {
    // node-pty only inspects `err.code`; an error without one falls straight
    // through to the rethrow, so the seam must forward it or it becomes an
    // uncaught exception in the host.
    expect(isFatalPtyError(withCode("something went wrong"))).toBe(true);
  });

  it("does not match a code merely because the MESSAGE mentions one", () => {
    // The classification reads `err.code`, exactly as node-pty does. A message
    // that happens to contain "EIO" is not an EIO.
    expect(isFatalPtyError(withCode("EIO appears in this message", "ECONNRESET"))).toBe(true);
  });
});
