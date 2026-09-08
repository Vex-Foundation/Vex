import { requireValue } from "../helpers/require-value.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FEE_LAUNCH = fileURLToPath(
  new URL("../../tools/lighter/FEE_LAUNCH.md", import.meta.url),
);

const STATUS = /^(pending|observed on \d{4}-\d{2}-\d{2})$/;

function evidenceRows(): { readonly id: string; readonly status: string }[] {
  const text = readFileSync(FEE_LAUNCH, "utf8");
  return text
    .split("\n")
    .filter((line) => /^\| E\d+ \|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return { id: requireValue(cells[1]), status: requireValue(cells[cells.length - 2]) };
    });
}

describe("Lighter fee launch evidence", () => {
  it("keeps one evidence row per required live check on both deployments", () => {
    const rows = evidenceRows();
    expect(rows.map((row) => row.id)).toEqual([
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "E7",
      "E8",
    ]);
  });

  it("accepts only pending or an observation date in every status cell", () => {
    for (const row of evidenceRows()) {
      expect(row.status, `${row.id} status`).toMatch(STATUS);
    }
  });

  it("records the owner attestation of the collector identity", () => {
    const text = readFileSync(FEE_LAUNCH, "utf8");
    expect(text).toContain("2026-09-07");
    expect(text).toContain("0x10Ce97Cf3142BE2a1a28aC83A55b21fDCE493C03");
    expect(text).toContain("743799");
    expect(text).toContain("22869");
  });

  it("never uses an em dash", () => {
    // Escaped so this guard does not itself trip the repository em-dash gate.
    expect(readFileSync(FEE_LAUNCH, "utf8")).not.toContain("\u2014");
  });
});
