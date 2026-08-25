/**
 * `deriveProjectSlug` - the confinement proof for Vex Studio project folders.
 *
 * The slug is the ONLY value that ever becomes a directory name under the
 * projects root, and the renderer never supplies it. So the security property
 * of stage P's filesystem flow reduces to a property of this function: whatever
 * a user types, the output is either `null` or a single path segment drawn from
 * `[a-z0-9-]` that cannot traverse, cannot be read as a flag, and satisfies the
 * same pattern the DB CHECK enforces.
 */

import { describe, expect, it } from "vitest";
import { projectSlugSchema } from "@shared/schemas/projects.js";
import { deriveProjectSlug } from "../project-slug.js";

/** Every non-null derivation must satisfy the shared schema and the DB CHECK. */
function expectValidSlug(slug: string | null): string {
  expect(slug).not.toBeNull();
  const value = slug as string;
  expect(projectSlugSchema.safeParse(value).success).toBe(true);
  return value;
}

describe("deriveProjectSlug", () => {
  it("derives a readable slug from an ordinary name", () => {
    expect(deriveProjectSlug("My Trading Bot")).toBe("my-trading-bot");
    expect(deriveProjectSlug("vex-studio")).toBe("vex-studio");
    expect(deriveProjectSlug("Report 2026")).toBe("report-2026");
  });

  it("strips every traversal attempt to a single safe segment", () => {
    // Each of these is a name a user (or a compromised renderer) could send.
    // None of them may survive as a separator, a dot segment, or a leading
    // hyphen the shell of a later tool could read as a flag.
    const attempts: ReadonlyArray<string> = [
      "../../etc/passwd",
      "..",
      ".",
      "../../../root",
      "foo/../bar",
      "a/b/c",
      "C:\\Windows\\System32",
      "..\\..\\secrets",
      "  ../evil  ",
      "-rf",
      "--force",
      "proj\u0000ect",
      "pro\nject",
      "~/.ssh",
      "$HOME",
      "a:b",
    ];
    for (const name of attempts) {
      const slug = deriveProjectSlug(name);
      if (slug === null) continue;
      expectValidSlug(slug);
      for (const forbidden of ["/", "\\", "..", ":", "\u0000", "\n", "~", "$"]) {
        expect(slug, `"${name}" leaked ${JSON.stringify(forbidden)}`).not.toContain(
          forbidden,
        );
      }
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
    }
  });

  it("returns null when nothing survives the alphabet (never invents a folder name)", () => {
    // A name the user cannot see turned into a folder is worse than a refusal:
    // they would end up with a directory they did not choose.
    expect(deriveProjectSlug("...")).toBeNull();
    expect(deriveProjectSlug("///")).toBeNull();
    expect(deriveProjectSlug("!!! ???")).toBeNull();
    expect(deriveProjectSlug("---")).toBeNull();
    expect(deriveProjectSlug("     ")).toBeNull();
  });

  it("bounds the slug at the schema and DB length while keeping it valid", () => {
    const long = "a".repeat(200);
    const slug = expectValidSlug(deriveProjectSlug(long));
    expect(slug.length).toBe(64);
  });

  it("never ends in a hyphen after bounding", () => {
    // A name whose 64th character lands on a separator would otherwise produce
    // a trailing hyphen, which the schema pattern still allows but which reads
    // as a truncated name in the UI.
    const name = `${"a".repeat(63)} tail`;
    const slug = expectValidSlug(deriveProjectSlug(name));
    expect(slug.endsWith("-")).toBe(false);
  });

  it("is deterministic and collapses collisions rather than disambiguating them", () => {
    // Two names deriving one slug is expected: uniqueness is owned by the
    // `projects` UNIQUE constraint and the exclusive mkdir, not by the slug.
    expect(deriveProjectSlug("My App")).toBe(deriveProjectSlug("my---app"));
    expect(deriveProjectSlug("My App")).toBe(deriveProjectSlug("My App"));
  });
});
