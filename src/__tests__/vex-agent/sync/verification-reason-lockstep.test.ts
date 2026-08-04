/**
 * Lockstep guard: every reason the sync sweeps write into
 * `agent_activity.last_verification_reason` is a member of the closed
 * `VERIFICATION_REASONS` vocabulary (`db/repos/agent-activity/types.ts`).
 *
 * WHY A SOURCE SCAN AND NOT ONLY A TYPE. The vocabulary claimed to be the closed
 * set for that column while THREE sweeps wrote seven reasons it had never heard
 * of: the bridge family's set was bounded by name, and the EVM and Solana sweeps
 * called `touchLastChecked(id, "…")` with a bare `string` parameter, so nothing —
 * not the compiler, not a test — connected them. The narrowing of
 * `touchLastChecked`'s parameter to the union is the eventual enforcement and is
 * blocked on another workstream's move of that file; until then this scan is
 * what makes a drifting literal fail a run instead of reaching a user-visible
 * column.
 *
 * The column's meaning is deliberately narrow — *why the last verification CHECK
 * could not conclude*. Reasons that describe why a row is PENDING, or what
 * evidence its AMOUNTS have, are different facts in different columns with their
 * own writers, and must not appear here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageRoot } from "@utils/package-assets.js";
import { VERIFICATION_REASONS } from "@vex-agent/db/repos/agent-activity.js";

const SYNC_DIR = join(getPackageRoot(), "src", "vex-agent", "sync");

function readSyncSources(): Array<{ file: string; source: string }> {
  return readdirSync(SYNC_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const file = join(entry.parentPath ?? SYNC_DIR, entry.name);
      return { file, source: readFileSync(file, "utf-8") };
    });
}

/** Every string literal passed as the reason argument of a reason writer. */
function reasonLiterals(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /touchLastChecked\(\s*[^,()]+,\s*"([^"]+)"/g,
    /noteVerificationInconclusive\(\s*[^,()]+,\s*"([^"]+)"/g,
  ]) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

describe("the 065 reason vocabulary has ONE owner and no drifting writers", () => {
  it("every literal written by src/vex-agent/sync/** is a member of the union", () => {
    const offenders: string[] = [];
    for (const { file, source } of readSyncSources()) {
      for (const literal of reasonLiterals(source)) {
        if (!(VERIFICATION_REASONS as readonly string[]).includes(literal)) {
          offenders.push(`${file}: "${literal}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("admits the EVM and Solana sweeps' own reasons by name", () => {
    // These were the seven that existed outside the "closed" set.
    for (const reason of [
      "receipt_not_found",
      "rpc_error",
      "unreadable_signature_status",
      "get_transaction_unavailable",
      "unreadable_transaction_meta",
      "no_blockhash_evidence",
      "block_height_unavailable",
    ]) {
      expect(VERIFICATION_REASONS).toContain(reason);
    }
  });

  it("does NOT admit a pending-state or amount-evidence fact", () => {
    // `in_mempool` / `nonce_superseded` are CONCLUSIVE observations (a pending
    // reason, not a failed check) and `amounts_*` are amount evidence. Each
    // belongs to its own column and its own writer; putting them here is what
    // made two columns collide.
    for (const foreign of ["in_mempool", "nonce_superseded", "amounts_incomplete", "amounts_undecodable"]) {
      expect(VERIFICATION_REASONS).not.toContain(foreign);
    }
  });

  it("keeps `receipt_unavailable` readable for pre-existing rows but produces it nowhere", () => {
    expect(VERIFICATION_REASONS).toContain("receipt_unavailable");
    const producers = readSyncSources().filter(({ source }) =>
      /reason:\s*"receipt_unavailable"/.test(source) || reasonLiterals(source).includes("receipt_unavailable"));
    expect(producers.map((p) => p.file)).toEqual([]);
  });
});
