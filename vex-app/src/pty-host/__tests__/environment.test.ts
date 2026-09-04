/**
 * THE ENVIRONMENT A SHELL INHERITS, as a table.
 *
 * This is a security test wearing ordinary clothes. Two of its rows are the
 * whole reason the deny-list exists:
 *
 *  - a leaked `ELECTRON_RUN_AS_NODE` turns any `electron` the user runs from a
 *    Vex terminal into a bare Node process, silently;
 *  - a leaked `VEX_PTY_*` exports Vex's own private configuration into every
 *    command they run and every `env` dump they paste into a bug report.
 *
 * The logging row is the one that keeps credentials out of files users attach
 * to support tickets.
 */

import { describe, expect, it } from "vitest";
import {
  PTY_HOST_CONFIG_KEYS,
  TERMINAL_DETACH_GRACE_MS,
  TERMINAL_SCROLLBACK_ROWS,
  ptyHostEnvironment,
} from "@shared/schemas/terminal.js";
import { readAndClearPtyHostConfig } from "../config.js";
import {
  TERMINAL_ENV_PRESERVE,
  buildTerminalEnvironment,
  sanitizeEnvForLogging,
  scrubEnvironment,
} from "../process-env.js";

describe("scrubEnvironment", () => {
  it.each([
    ["ELECTRON_RUN_AS_NODE", "1"],
    ["ELECTRON_NO_ATTACH_CONSOLE", "1"],
    ["VEX_PTY_SNAPSHOT_DIR", "/home/u/.config/vex/studio/terminal-snapshots"],
    ["VEX_ANYTHING", "x"],
    ["SNAP", "/snap/vex/42"],
    ["SNAP_LIBRARY_PATH", "/snap/vex/42/lib"],
    ["GDK_PIXBUF_MODULE_FILE", "/snap/vex/42/loaders.cache"],
  ])("REMOVES %s", (key, value) => {
    const scrubbed = scrubEnvironment({ [key]: value, PATH: "/usr/bin" });
    expect(scrubbed).not.toHaveProperty(key);
    expect(scrubbed.PATH).toBe("/usr/bin");
  });

  it.each([
    ["PATH", "/usr/bin"],
    ["HOME", "/home/u"],
    ["SHELL", "/bin/zsh"],
    ["ELECTRONIC_THING", "kept"],
    ["VEXATIOUS", "kept"],
    ["SNAPSHOT_TOOL", "kept"],
  ])("KEEPS %s", (key, value) => {
    // The patterns are anchored, so a variable that merely starts with the same
    // letters is not collateral damage.
    expect(scrubEnvironment({ [key]: value })[key]).toBe(value);
  });

  it("honours an explicit preserve entry over the deny-list", () => {
    const scrubbed = scrubEnvironment({ ELECTRON_RUN_AS_NODE: "1" }, [
      "ELECTRON_RUN_AS_NODE",
    ]);
    expect(scrubbed.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("ships with an EMPTY preserve list, as a deliberate decision", () => {
    // Named rather than implicit: adding an exception should be a visible diff
    // with a reason next to it.
    expect(TERMINAL_ENV_PRESERVE).toEqual([]);
  });

  it("never mutates the environment it was given", () => {
    const source = { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" };
    scrubEnvironment(source);
    expect(source.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

describe("buildTerminalEnvironment", () => {
  it("asserts TERM, COLORTERM and TERM_PROGRAM over anything the overlay says", () => {
    const env = buildTerminalEnvironment(
      { PATH: "/usr/bin" },
      { TERM: "dumb", COLORTERM: "" },
    );
    // An overlay that could set TERM=dumb would produce a shell whose escape
    // sequences the renderer cannot interpret.
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.TERM_PROGRAM).toBe("vex-studio");
  });

  it("sets LANG only when it is MISSING", () => {
    expect(buildTerminalEnvironment({}, {}).LANG).toBe("en_US.UTF-8");
    // A user's chosen locale changes how their own tools format numbers and
    // dates; overriding it is not ours to do.
    expect(buildTerminalEnvironment({ LANG: "pl_PL.UTF-8" }, {}).LANG).toBe(
      "pl_PL.UTF-8",
    );
  });

  it("treats null as DELETE and an absent key as LEAVE ALONE", () => {
    const env = buildTerminalEnvironment(
      { KEEP: "yes", DROP: "no" },
      { DROP: null, ADDED: "new" },
    );
    expect(env).not.toHaveProperty("DROP");
    expect(env.KEEP).toBe("yes");
    expect(env.ADDED).toBe("new");
  });
});

/**
 * THE SEAM, composed: `scrubEnvironment` builds the base at host boot
 * (`pty-host/index.ts`), `buildTerminalEnvironment` applies main's per-terminal
 * overlay over it (`terminal-process.ts`), and only the result reaches a shell.
 * Testing the two apart cannot show the property that matters here - that the
 * deny-list strips Vex's own variables from the BASE while the one key main
 * chose to put back survives.
 */
describe("the base and the overlay, composed as the pty host composes them", () => {
  const launcherEnvironment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    ELECTRON_RUN_AS_NODE: "1",
    // What the launcher exported, which is NOT what this app resolved: a
    // shell that inherited it would send its bridge to the wrong Vex.
    VEX_CONFIG_DIR: "/home/u/.config/vex",
    ...ptyHostEnvironment("/home/u/.config/vex/studio/terminal-snapshots"),
  };

  it("strips ELECTRON_*, VEX_* and the pty host's OWN boot keys from the base", () => {
    const base = scrubEnvironment(launcherEnvironment);
    expect(base).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(base).not.toHaveProperty("VEX_CONFIG_DIR");
    for (const key of PTY_HOST_CONFIG_KEYS) {
      expect(base, `${key} survived the deny-list`).not.toHaveProperty(key);
    }
    expect(base["PATH"]).toBe("/usr/bin");
  });

  it("lets main's overlay put VEX_CONFIG_DIR back, with the value it resolved", () => {
    const base = scrubEnvironment(launcherEnvironment);
    const env = buildTerminalEnvironment(base, {
      VEX_CONFIG_DIR: "/tmp/vex-e2e-fixture/config",
    });
    // The overlay is the OWNER of what Vex's own integration needs, exactly as
    // VS Code's workbench adds its keys after sanitizing rather than widening
    // the preserve list.
    expect(env["VEX_CONFIG_DIR"]).toBe("/tmp/vex-e2e-fixture/config");
    // And the deny-list is unchanged by that: nothing else came back.
    expect(env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    for (const key of PTY_HOST_CONFIG_KEYS) {
      expect(env, `${key} reached a shell`).not.toHaveProperty(key);
    }
  });
});

describe("sanitizeEnvForLogging", () => {
  it("replaces every VALUE with its length and keeps every NAME", () => {
    const sanitized = sanitizeEnvForLogging({
      GITHUB_TOKEN: "ghp_averyrealsecret",
      PATH: "/usr/bin",
    });
    expect(sanitized).toEqual({
      GITHUB_TOKEN: "<19 chars>",
      PATH: "<8 chars>",
    });
    expect(JSON.stringify(sanitized)).not.toContain("ghp_");
  });

  it("passes undefined through rather than inventing an empty environment", () => {
    expect(sanitizeEnvForLogging(undefined)).toBeUndefined();
  });
});

describe("boot configuration", () => {
  it("parses every key main sets, and DELETES all of them", () => {
    const env: NodeJS.ProcessEnv = {
      ...ptyHostEnvironment("/tmp/vex-snapshots"),
      PATH: "/usr/bin",
    };

    const config = readAndClearPtyHostConfig(env);

    expect(config).not.toBeNull();
    expect(config?.snapshotDir).toBe("/tmp/vex-snapshots");
    expect(config?.graceMs).toBe(TERMINAL_DETACH_GRACE_MS);
    expect(config?.scrollbackRows).toBe(TERMINAL_SCROLLBACK_ROWS);
    for (const key of PTY_HOST_CONFIG_KEYS) {
      expect(env, `${key} survived into the base environment`).not.toHaveProperty(key);
    }
    expect(env.PATH).toBe("/usr/bin");
  });

  it("DELETES the keys even when it refuses the configuration", () => {
    const env: NodeJS.ProcessEnv = { VEX_PTY_SNAPSHOT_DIR: "relative/path" };

    // A relative directory is refused rather than defaulted: guessing where to
    // write user data is the one failure that puts files nobody looks for.
    expect(readAndClearPtyHostConfig(env)).toBeNull();
    expect(env).not.toHaveProperty("VEX_PTY_SNAPSHOT_DIR");
  });

  it("falls back to the contract constants for a malformed number", () => {
    const env: NodeJS.ProcessEnv = {
      VEX_PTY_SNAPSHOT_DIR: "/tmp/snap",
      VEX_PTY_GRACE_MS: "not-a-number",
      VEX_PTY_SCROLLBACK: "-5",
    };
    const config = readAndClearPtyHostConfig(env);
    expect(config?.graceMs).toBe(TERMINAL_DETACH_GRACE_MS);
    expect(config?.scrollbackRows).toBe(TERMINAL_SCROLLBACK_ROWS);
  });
});
