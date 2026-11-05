/**
 * The print art the app no longer ships (`public/art/`). The day and night
 * plateau prints and the grain tile laid over them stood behind K2's print
 * window in the Vex sidebar and the R3 pre-shell stage; Kimm's section draws
 * its own ground, so they retired with K2 (plan rows S8-16 and S8-17). The
 * eagle and the far birds left with the flock before them. A file that came
 * back would ship bytes nothing paints, so its absence is pinned here.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "..", "..", "public");

const fileOf = (url: string) => path.join(PUBLIC, ...url.split("/").filter(Boolean));

describe("the retired print art", () => {
  it.each([
    "/art/plateau.jpg",
    "/art/plateau-night.jpg",
    "/art/grain.svg",
    "/art/eagle.png",
    "/art/birds",
    "/art/vex-k2",
  ])("%s no longer ships", (url) => {
    expect(existsSync(fileOf(url))).toBe(false);
  });
});
