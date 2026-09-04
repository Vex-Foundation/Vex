/**
 * `deriveProjectSlug` - the confinement proof for Vex Studio project folders.
 *
 * The slug is the ONLY value that ever becomes a directory name under the
 * projects root, and the renderer never supplies it. So the security property
 * of stage P's filesystem flow reduces to a property of this function: whatever
 * a user types, the output is either a NAMED refusal or a single path segment
 * drawn from `[a-z0-9-]` that cannot traverse, cannot be read as a flag, and
 * satisfies the same pattern the DB CHECK enforces.
 *
 * B3 adds the cross-platform half: a segment that is legal on the machine the
 * project is created on may still be a name the Win32 path namespace reserves
 * for a device, and that folder cannot be opened on Windows at all. The
 * reserved-name table below runs on EVERY platform for exactly that reason.
 */

import { describe, expect, it } from "vitest";
import { projectSlugSchema } from "@shared/schemas/projects.js";
import { deriveProjectSlug, type ProjectSlugDerivation } from "../project-slug.js";

/** Every accepted derivation must satisfy the shared schema and the DB CHECK. */
function expectValidSlug(derived: ProjectSlugDerivation): string {
  expect(derived.kind, JSON.stringify(derived)).toBe("slug");
  if (derived.kind !== "slug") throw new Error("unreachable");
  expect(projectSlugSchema.safeParse(derived.slug).success).toBe(true);
  return derived.slug;
}

/** The slug text, or `null` for either refusal. Keeps the old assertions terse. */
function slugOf(name: string): string | null {
  const derived = deriveProjectSlug(name);
  return derived.kind === "slug" ? derived.slug : null;
}

describe("deriveProjectSlug", () => {
  it("derives a readable slug from an ordinary name", () => {
    expect(slugOf("My Trading Bot")).toBe("my-trading-bot");
    expect(slugOf("vex-studio")).toBe("vex-studio");
    expect(slugOf("Report 2026")).toBe("report-2026");
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
      const slug = slugOf(name);
      if (slug === null) continue;
      expectValidSlug({ kind: "slug", slug });
      for (const forbidden of ["/", "\\", "..", ":", "\u0000", "\n", "~", "$"]) {
        expect(slug, `"${name}" leaked ${JSON.stringify(forbidden)}`).not.toContain(
          forbidden,
        );
      }
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
    }
  });

  it("refuses by name when nothing survives the alphabet (never invents a folder name)", () => {
    // A name the user cannot see turned into a folder is worse than a refusal:
    // they would end up with a directory they did not choose.
    for (const name of ["...", "///", "!!! ???", "---", "     "]) {
      expect(deriveProjectSlug(name), name).toEqual({
        kind: "refused",
        reason: "no_usable_characters",
      });
    }
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

  /**
   * ONE ROW PER RESERVED NAME, and the row is the point: a set membership bug
   * that drops a single member is invisible to a spot check and produces a
   * project folder that cannot be opened on Windows.
   *
   * MEASURED vs ASSERTED: that Windows itself refuses these names is NOT
   * measured here (no test creates a `con` directory on a Windows runner). What
   * is asserted is our own refusal, on every platform, which is the property
   * that keeps a Linux-created project openable after the user moves it. The
   * Windows-side fact is documented from Microsoft's filesystem-naming
   * reference and from VS Code's `isValidBasename`.
   */
  const RESERVED = [
    "con",
    "prn",
    "aux",
    "nul",
    "com0", "com1", "com2", "com3", "com4",
    "com5", "com6", "com7", "com8", "com9",
    "lpt0", "lpt1", "lpt2", "lpt3", "lpt4",
    "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
  ] as const;

  it.each(RESERVED)("refuses the Windows device name %s on every platform", (name) => {
    expect(deriveProjectSlug(name)).toEqual({
      kind: "refused",
      reason: "reserved_device_name",
    });
  });

  it("refuses a reserved name however the user spelled or padded it", () => {
    // Each of these DERIVES a bare reserved segment, which is the only form the
    // alphabet can produce.
    // `COM¹` is here because NFKD folds the superscript to `1`: a name that
    // does not read as a device name still derives one.
    for (const name of ["CON", "Con", "  aux  ", "**nul**", "(com1)", "COM¹", "-lpt9-"]) {
      expect(deriveProjectSlug(name), name).toEqual({
        kind: "refused",
        reason: "reserved_device_name",
      });
    }
  });

  it("accepts names that only LOOK reserved, so the guard is not a superstition", () => {
    // `nul.txt` derives `nul-txt`: a dot cannot survive the alphabet, so the
    // dot-suffixed device form is unreachable and its slug is an ordinary name.
    expect(slugOf("nul.txt")).toBe("nul-txt");
    expect(slugOf("aux1")).toBe("aux1");
    expect(slugOf("com10")).toBe("com10");
    expect(slugOf("console")).toBe("console");
    // `CLOCK$` and `CONIN$` lose their `$`, and `clock` / `conin` are not
    // reserved names. Refusing them would refuse a project called "Clock".
    expect(slugOf("CLOCK$")).toBe("clock");
    expect(slugOf("CONIN$")).toBe("conin");
  });

  it("checks the BOUNDED slug, not the raw name", () => {
    // A name whose first 64 characters are the whole slug is the only way a
    // reserved segment can appear after bounding; the check must therefore run
    // after the bound. This name derives exactly "con".
    expect(deriveProjectSlug("!!con!!")).toEqual({
      kind: "refused",
      reason: "reserved_device_name",
    });
  });

  it("is deterministic and collapses collisions rather than disambiguating them", () => {
    // Two names deriving one slug is expected: uniqueness is owned by the
    // `projects` UNIQUE constraint and the exclusive mkdir, not by the slug.
    expect(slugOf("My App")).toBe(slugOf("my---app"));
    expect(slugOf("My App")).toBe(slugOf("My App"));
  });
});
