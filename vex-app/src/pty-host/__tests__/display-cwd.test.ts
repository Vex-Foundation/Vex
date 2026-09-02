/**
 * The cwd LABEL derivation, as a table over every answer it can give.
 *
 * The property under test is not "the string is pretty". It is that NO INPUT
 * produces an absolute path, which is the promise the module's doc makes and
 * the reason the raw path stops at the host. So the table enumerates the four
 * answers, and a final case drives a set of hostile-shaped inputs through it
 * and asserts the absence of the root string in every result - the assertion
 * that would go red if a future edit added a "just show the path" fallback.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISPLAY_CWD_OUTSIDE_PROJECT,
  DISPLAY_CWD_UNKNOWN,
  deriveDisplayCwd,
} from "../display-cwd.js";

const ROOT = "/home/ada/Vex/projects/vex-core";
const CONTEXT = { projectRoot: ROOT, projectLabel: "vex-core" } as const;

describe("deriveDisplayCwd", () => {
  const table: ReadonlyArray<{
    readonly name: string;
    readonly cwd: string | null;
    readonly expected: string;
  }> = [
    {
      name: "the project root itself is the project's label",
      cwd: ROOT,
      expected: "vex-core",
    },
    {
      name: "a trailing separator on the root is still the root",
      cwd: `${ROOT}/`,
      expected: "vex-core",
    },
    {
      name: "one level inside is a project-relative path",
      cwd: `${ROOT}/src`,
      expected: "src",
    },
    {
      name: "several levels inside keep every segment",
      cwd: `${ROOT}/src/lib/terminal`,
      expected: "src/lib/terminal",
    },
    {
      name: "a sibling project is outside, not a relative path",
      cwd: "/home/ada/Vex/projects/trading-agent",
      expected: DISPLAY_CWD_OUTSIDE_PROJECT,
    },
    {
      name: "the home directory is outside and is never spelled out",
      cwd: "/home/ada",
      expected: DISPLAY_CWD_OUTSIDE_PROJECT,
    },
    {
      name: "a path that merely shares a prefix is not inside",
      cwd: `${ROOT}-backup/src`,
      expected: DISPLAY_CWD_OUTSIDE_PROJECT,
    },
    {
      name: "an unreadable cwd is unknown, which is not the same as outside",
      cwd: null,
      expected: DISPLAY_CWD_UNKNOWN,
    },
    {
      name: "an empty cwd is unknown rather than the project root",
      cwd: "",
      expected: DISPLAY_CWD_UNKNOWN,
    },
    {
      name: "a traversal that resolves back out of the root is outside",
      cwd: `${ROOT}/src/../../trading-agent`,
      expected: DISPLAY_CWD_OUTSIDE_PROJECT,
    },
    {
      name: "a traversal that resolves back to the root is the label",
      cwd: `${ROOT}/src/..`,
      expected: "vex-core",
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(deriveDisplayCwd(CONTEXT, row.cwd)).toBe(row.expected);
    });
  }

  it("never returns anything containing the absolute root or the home path", () => {
    const hostile = [
      ROOT,
      `${ROOT}/src`,
      `${ROOT}/src/lib`,
      "/home/ada",
      "/home/ada/.ssh",
      "/home/ada/Vex/projects/other",
      `${ROOT}/../../..`,
      "/",
      "",
    ];
    for (const cwd of hostile) {
      const label = deriveDisplayCwd(CONTEXT, cwd);
      expect(label).not.toContain("/home/ada");
      expect(label).not.toContain(ROOT);
      expect(path.isAbsolute(label)).toBe(false);
    }
  });

  it("uses the label main supplied, never a path segment of its own choosing", () => {
    expect(
      deriveDisplayCwd({ projectRoot: ROOT, projectLabel: "renamed" }, ROOT),
    ).toBe("renamed");
  });
});
