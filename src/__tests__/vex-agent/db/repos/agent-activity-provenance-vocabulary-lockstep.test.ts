/**
 * LOCKSTEP for the three vocabularies of migration 067's provenance columns:
 * every literal any writer passes is a member, and every member has a writer.
 *
 * Scoped to the 067 columns ONLY. `VerificationReason` — the vocabulary of the
 * 065 column `last_verification_reason`, written by `touchLastChecked` — has its
 * own owner and its own lockstep suite; asserting about it here would make two
 * workstreams' tests fight over one file.
 *
 * It reads the SOURCE of the writers rather than calling them, for the same
 * reason the kind↔role lockstep beside it does: a literal that never appears in
 * a test's happy path is exactly the one that drifts.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_SOURCES,
  PENDING_REASONS,
  SETTLEMENT_DECLINE_REASONS,
  SETTLEMENT_SOURCES,
} from "@vex-agent/db/repos/agent-activity/provenance-vocabulary.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const REPO_DIR = path.join(REPO_ROOT, "src/vex-agent/db/repos/agent-activity");

function source(relative: string): string {
  return readFileSync(path.join(REPO_DIR, relative), "utf8");
}

const WRITER_SOURCES = [
  source("swap-lifecycle.ts"),
  source("swap-lifecycle/verification-bookkeeping.ts"),
  source("settlement-enrichment.ts"),
  source("launch-lifecycle.ts"),
  source("bridge-lifecycle.ts"),
].join("\n");

/** The SQL literals a CAS writes directly, e.g. `confirmation_source = 'tool_response'`. */
function writesLiteral(value: string): boolean {
  return WRITER_SOURCES.includes(`'${value}'`);
}

describe("migration 067 provenance vocabularies — lockstep with their writers", () => {
  it("every ConfirmationSource has a writer", () => {
    for (const member of CONFIRMATION_SOURCES) {
      // `receipt_status_only_*` are caller-supplied through a closed parameter
      // type, so the literals live at the two sweep call sites rather than in
      // the CAS — the type is the enforcement point there.
      if (member.startsWith("receipt_status_only")) {
        const sweeps = [
          readFileSync(path.join(REPO_ROOT, "src/vex-agent/sync/agent-activity-repair.ts"), "utf8"),
          readFileSync(path.join(REPO_ROOT, "src/vex-agent/sync/solana-activity-repair.ts"), "utf8"),
        ].join("\n");
        expect(sweeps, `no sweep passes '${member}'`).toContain(`"${member}"`);
        continue;
      }
      expect(writesLiteral(member), `no writer sets confirmation_source '${member}'`).toBe(true);
    }
  });

  it("every SettlementSource is either written by a CAS or reachable through the decline writer", () => {
    for (const member of SETTLEMENT_SOURCES) {
      const declinable = (SETTLEMENT_DECLINE_REASONS as readonly string[]).includes(member);
      expect(
        declinable || writesLiteral(member),
        `no writer can produce settlement_source '${member}'`,
      ).toBe(true);
    }
  });

  it("SettlementDeclineReason is a strict subset of SettlementSource", () => {
    // The full union also carries POSITIVE provenance; a decline path must be
    // structurally unable to stamp a success.
    for (const member of SETTLEMENT_DECLINE_REASONS) {
      expect(SETTLEMENT_SOURCES).toContain(member);
    }
    expect(SETTLEMENT_DECLINE_REASONS.length).toBeLessThan(SETTLEMENT_SOURCES.length);
    for (const positive of ["tool_response", "receipt_decoded_late", "provider_verified"] as const) {
      expect(SETTLEMENT_DECLINE_REASONS as readonly string[]).not.toContain(positive);
    }
  });

  it("the feed projection reads every settlement_source arm it promised", () => {
    // The quarantine and the two declines are agent-SILENT unless the feed's
    // CASE actually reads them — a durable state nobody surfaces is a log with
    // extra steps.
    const projection = readFileSync(
      path.join(REPO_ROOT, "src/vex-agent/db/repos/transactions-query-builder.ts"),
      "utf8",
    );
    for (const member of ["conflict_quarantined", "amounts_undecodable", "amounts_incomplete"]) {
      expect(projection, `the feed never reads settlement_source '${member}'`)
        .toContain(`settlement_source = '${member}'`);
    }
    expect(projection).toContain("'amount_evidence_conflict'");
  });

  it("every HANDLER-RETURN PendingReason is actually written by a venue handler", () => {
    // A vocabulary member with no writer is a promise the product never keeps:
    // the fallback would be routing on a reason that can never appear. These
    // seven are R1's — written at tool-return time through
    // `noteHandlerPendingReason`. `in_mempool` and `nonce_superseded` are the
    // pending-fallback lane's CHAIN observations, written by its own sweep and
    // covered by its own suite; asserting them here would make two workstreams'
    // tests fight over one file.
    const handlerFiles = execSync(
      "grep -rl noteHandlerPendingReason src/vex-agent/tools --include=*.ts",
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).split("\n").filter((f) => f.length > 0);
    expect(handlerFiles.length, "no venue handler records a pending reason at all").toBeGreaterThan(0);
    const handlerSources = handlerFiles
      .map((f) => readFileSync(path.join(REPO_ROOT, f), "utf8"))
      .join("\n");
    const laneOwned = new Set(["in_mempool", "nonce_superseded"]);
    for (const member of PENDING_REASONS) {
      if (laneOwned.has(member)) continue;
      expect(handlerSources, `no venue handler ever writes pending_reason '${member}'`)
        .toContain(`"${member}"`);
    }
  });

  it("every PendingReason is a distinct, non-empty snake_case code", () => {
    expect(new Set(PENDING_REASONS).size).toBe(PENDING_REASONS.length);
    for (const member of PENDING_REASONS) {
      expect(member).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    // The distinction the vocabulary exists for: "we never saw the receipt"
    // versus "we saw a SUCCESSFUL receipt and could not read the amounts". They
    // are two different jobs for the fallback and used to be indistinguishable.
    expect(PENDING_REASONS).toContain("broadcast_ambiguous_confirm");
    expect(PENDING_REASONS).toContain("settlement_undecodable");
  });
});
