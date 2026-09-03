/**
 * The bridge-readiness guidance TABLE, checked as a table.
 *
 * Two things this pins that the panel test cannot:
 *
 *  - the sentences are COMPLETE WITHOUT their links. That is what makes the
 *    restructuring honest: if a `text` still reads "download it from" and the
 *    address only exists in the anchor, a reader who does not follow the link
 *    is left mid-sentence.
 *  - every `href` sits under a path prefix that main's `shell.openExternal`
 *    allowlist actually permits. A link this table invents outside the
 *    allowlist opens NOTHING and reports nothing, so the failure is invisible
 *    at every layer above it. The allowlist lives in main, which the renderer
 *    cannot import across the process boundary, so the prefixes are mirrored
 *    here the same way the studio host-status codes are mirrored: a literal
 *    list, reconciled by review, with the source named.
 *
 *    Mirror of `main/windows/main-window.ts` `ALLOWED_EXTERNAL`:
 *      { host: "go.dev", pathPrefix: "/dl" }
 *      { host: "go.dev", pathPrefix: "/doc/install" }
 */

import { describe, expect, it } from "vitest";
import type { StudioBridgeHostPlatform } from "@shared/schemas/studio-bridge-readiness.js";
import {
  studioGoInstallGuidance,
  type GuidanceLink,
} from "../bridge-readiness-copy.js";

const PIN = "go1.27.0";

const PLATFORMS: readonly StudioBridgeHostPlatform[] = [
  "win32",
  "darwin",
  "linux",
  "other",
];

/** The go.dev entries of main's openExternal allowlist, mirrored. */
const ALLOWED_PREFIXES: readonly string[] = [
  "https://go.dev/dl",
  "https://go.dev/doc/install",
];

function isAllowed(link: GuidanceLink): boolean {
  return ALLOWED_PREFIXES.some(
    (prefix) => link.href === prefix || link.href.startsWith(`${prefix}/`),
  );
}

describe("go install guidance", () => {
  it("reads as a complete sentence with no address in it, on every platform", () => {
    for (const platform of PLATFORMS) {
      const { pinned } = studioGoInstallGuidance(platform, PIN);
      expect({
        platform,
        // Complete: it ends in a full stop and never trails off into a link.
        complete: pinned.text.trim().endsWith("."),
        // And it carries no raw address, which is the whole restructuring.
        noAddress: !pinned.text.includes("go.dev") && !pinned.text.includes("http"),
        // The pin is always named, because the exact version IS the remedy.
        namesPin: pinned.text.includes(PIN),
        hasLink: pinned.links.length > 0,
      }).toEqual({
        platform,
        complete: true,
        noAddress: true,
        namesPin: true,
        hasLink: true,
      });
    }
  });

  it("only ever links inside main's openExternal allowlist", () => {
    for (const platform of PLATFORMS) {
      const { pinned } = studioGoInstallGuidance(platform, PIN);
      for (const link of pinned.links) {
        expect({ platform, href: link.href, allowed: isAllowed(link) }).toEqual({
          platform,
          href: link.href,
          allowed: true,
        });
        // A label that is just the address is the defect this replaced.
        expect(link.label.includes("go.dev")).toBe(false);
      }
    }
  });

  it("names the package-manager route with its caveat, or not at all", () => {
    for (const platform of PLATFORMS) {
      const { packaged } = studioGoInstallGuidance(platform, PIN);
      if (packaged === null) {
        // `other` has no package manager Vex can name honestly.
        expect(platform).toBe("other");
        continue;
      }
      // Never an unqualified recommendation: the pin is exact and a package
      // manager tracks its own latest, which lands the user back here.
      expect(packaged).toContain("may not");
      expect(packaged).toContain("pinned version");
    }
  });

  it("sends the Linux tarball route to Go's install guide as well as the index", () => {
    const { pinned } = studioGoInstallGuidance("linux", PIN);
    expect(pinned.links.map((link) => link.href)).toEqual([
      "https://go.dev/dl/",
      "https://go.dev/doc/install",
    ]);
  });
});
