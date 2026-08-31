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
import { formatSpawnTrace } from "../node-pty-spawner.js";

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
