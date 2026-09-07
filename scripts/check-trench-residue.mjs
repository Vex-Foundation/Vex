#!/usr/bin/env node
/**
 * Trench Express RESIDUE gate.
 *
 * Migration 108 retired the Trench Express protocol: its ten tools, client,
 * ABI, fee venue, handlers, prompts, dialog lane and IPC domain are deleted.
 * What the deletion cannot prove on its own is that nothing was MISSED - a
 * stale registry row, an orphaned prompt sentence, a UI string that still
 * offers a launchpad the app can no longer reach. This gate scans the source
 * tree and the live docs for `trench` in any casing and fails on every
 * occurrence that is not on the measured allowlist below.
 *
 * REPO-WIDE, NOT DIFF-SCOPED, unlike its siblings `check-no-em-dash.mjs` and
 * `check-test-unsafe-escapes.mjs`. Those police what a branch ADDS; this one
 * asserts a property of the whole tree, and a residue gate that only looked at
 * added lines would pass on the very tree it exists to describe.
 *
 * ── WHY THERE IS AN ALLOWLIST AT ALL ──────────────────────────────────────
 *
 * "No `trench` anywhere" is not achievable and would not be correct. Historical
 * rows must stay readable (owner decree: AgentScan shows them as "Trench
 * Express (legacy)"), and reading them means naming the durable values they
 * carry: the `trench` protocol discriminator, the `trench_fee` / `token_launch`
 * activity roles, the `trench_express` launchpad, the AgentScan wire enum. A
 * gate that forbade those would only be satisfiable by renaming durable data,
 * which is the one thing a retirement must not do.
 *
 * So the allowlist is a MEASUREMENT, and every entry carries the reason its
 * path legitimately still names the retired protocol. Two rules keep it honest:
 *
 *   1. an entry whose path no longer contains the token FAILS as stale, so the
 *      list shrinks as the residue does and cannot quietly outlive it;
 *   2. an entry may not be added to park work. The question it answers is
 *      "why does this file still have to say this?", and "we did not get to it"
 *      is not an answer.
 *
 * ── WHAT IS OUT OF SCOPE, and why each exclusion is not a hole ─────────────
 *
 *   - `db/migrations/`: durable SQL, including 062/063/082 which CREATED the
 *     tables under their original names and 108 which retired them. Rewriting
 *     an applied migration is forbidden.
 *   - `sync/legacy-trench-express/`: the kept historical decoders. Naming the
 *     protocol is their entire purpose.
 *   - `tools/tool-surface-spec/`: dated planning and audit records. They are an
 *     archive of decisions taken at a point in time; editing them would falsify
 *     the record rather than clean the tree.
 *   - generated output (`__toolsnaps__`, `__promptsnaps__`, `__goldens__`) and
 *     captured fixtures: outputs, not sources. A residue there is fixed at the
 *     generator or the capture, which this gate does scan.
 *   - `node_modules`, `dist`, and anything git does not track.
 *   - TEST FILES (`__tests__/` and `*.test.*`). This is the one exclusion that
 *     is a JUDGEMENT rather than a category, so it is argued rather than
 *     asserted. A test's job is to pin the behavior of the code it covers, and
 *     what the surviving code legitimately still names is exactly what the
 *     production entries below already state a reason for: the durable
 *     `trench` / `trench_express` / `trench_fee` values, the historical ledger
 *     mapping, the legacy decoders, the retirement migration itself. Scanning
 *     tests would therefore need roughly seventy allowlist entries restating
 *     reasons already given one layer up, and a list that long stops being read.
 *     The gap it leaves - a test still referencing something deleted - is not
 *     silent: such a test cannot import and the suite goes red, which is how the
 *     one real instance (`integration/agentscan/attest.int.test.ts` importing
 *     `@tools/trench-express/constants.js`) was actually found.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

const TOKEN = /trench/i;

/**
 * The measured allowlist: PATH PREFIX plus the reason that path still names the
 * retired protocol. A prefix rather than an exact file where one reason covers a
 * whole directory with a single responsibility - the image ladder, the launch
 * intent repo - so the list states one fact once instead of repeating it.
 */
const ALLOWLIST = [
  // ── Durable data: values written to disk that must keep reading back ─────
  {
    prefix: "src/vex-agent/db/repos/token-launch-intents",
    reason:
      "the `protocol` discriminator's own vocabulary (migration 082): `'trench' | 'pools_fun'` is the type every historical intent row reads back as",
  },
  {
    prefix: "src/vex-agent/db/repos/launched-tokens.ts",
    reason:
      "`launchpad = 'trench_express'` is the durable venue value on every historical launch, and the AgentScan attestation sweep still claims those rows",
  },
  {
    prefix: "src/vex-agent/db/repos/launch-images.ts",
    reason:
      "`launch_images.onchain_*` (migration 083) is named for the ladder that sized the derivative; the columns are durable and renaming them is out of the retirement's scope",
  },
  {
    prefix: "src/vex-agent/db/repos/agent-activity/",
    reason:
      "the `trench_fee` and `token_launch` event roles and the `trench_trade` / `trench_launch` settlement decoders are durable `agent_activity` vocabulary (migrations 062, 063)",
  },
  {
    prefix: "src/vex-agent/db/repos/transactions-query-builder.ts",
    reason: "selects the durable `trench_fee` event role out of historical rows",
  },
  {
    prefix: "src/vex-agent/db/repos/transactions-mappers.ts",
    reason: "maps the durable `trench_fee` event role for historical rows",
  },
  {
    prefix: "src/vex-agent/db/repos/agentscan-reporting.ts",
    reason: "reports the durable `trench_fee` event role for historical rows",
  },
  {
    prefix: "src/vex-agent/agentscan/attest-client.ts",
    reason:
      "`AGENTSCAN_LAUNCHPADS` is the SERVER's wire enum; `trench` is a value that server accepts and we do not own it",
  },
  {
    prefix: "vex-app/src/shared/agent-activity-vocabulary.ts",
    reason: "the renderer's mirror of the same durable activity vocabulary",
  },
  {
    prefix: "vex-app/src/main/database/agent-scan-db-",
    reason: "reads the durable `trench_fee` event role out of historical rows",
  },
  {
    prefix: "vex-app/src/renderer/features/appShell/ActivityBadge.tsx",
    reason: "labels the durable `trench_fee` role on a historical activity row",
  },
  {
    prefix: "vex-app/src/main/images/byte-store.ts",
    reason:
      "`CONFIG_DIR/trench-images` is an EXISTING USER'S directory on disk; renaming it would orphan every image they already staged",
  },

  // ── History that must stay readable, and says so ─────────────────────────
  {
    prefix: "vex-app/src/renderer/lib/protocol-marks.ts",
    reason:
      "the retired venue keeps an honest label, `Trench Express (legacy)`, so a historical activity row renders as what it is (owner decree)",
  },
  {
    prefix: "vex-app/src/main/agent/tool-name-canonical.ts",
    reason:
      "the frozen public-name table that keeps historical `trench__*` tool calls resolving to their dotted ids, so an old transcript still renders its acts",
  },
  {
    prefix: "vex-app/src/renderer/features/appShell/ToolLedger/",
    reason:
      "the presentation mapping for historical `trench__*` tool names, so an old transcript still renders its acts instead of raw ids",
  },
  {
    prefix: "vex-app/src/renderer/features/appShell/screens/agent-scan/agent-scan-protocols.ts",
    reason:
      "`trench` stays a SELECTABLE feed filter so historical launches and trades remain findable (plan v3 T1)",
  },
  {
    prefix: "src/vex-agent/sync/executed-amount-fallback",
    reason:
      "dispatches the kept legacy curve decoder for `protocol='trench'` rows that confirmed without amounts",
  },
  {
    prefix: "src/vex-agent/sync/launch-identity-repair",
    reason:
      "reconciles a `broadcast_pending` Trench intent through the kept legacy receipt decoder; migration 108 preserves exactly those rows",
  },
  {
    prefix: "src/vex-agent/sync/agentscan-attest.ts",
    reason:
      "the AgentScan attestation sweep still delivers the creation proofs stored for historical trench.express launches",
  },
  {
    prefix: "src/vex-agent/sync/launch-form-expiry.ts",
    reason:
      "reads back the cancellation reason migration 108 wrote, so a parked agent turn learns the protocol was retired rather than that its form expired",
  },
  {
    prefix: "vex-app/src/renderer/stores/uiStore/persistence.ts",
    reason:
      "the v19 preference migration renames the stored `trench` BOOK section id; it must name the old value to find it",
  },

  // ── The retirement's own record: files that explain what went and why ────
  {
    prefix: "src/lib/token-metadata-limits.ts",
    reason:
      "records the provenance of the surviving caps and which of them the retirement deleted",
  },
  {
    prefix: "vex-app/src/renderer/features/appShell/TokenLaunchDialog",
    reason:
      "the launch dialog states why it now has ONE lane, so the next reader does not reintroduce a selector",
  },
  {
    prefix: "vex-app/src/renderer/features/appShell/token-launch/launch-display.ts",
    reason:
      "records which display helpers went with the retired lane's renderer-side pricing",
  },
  {
    prefix: "vex-app/src/renderer/features/appShell/book/ImageLockerCard.tsx",
    reason:
      "records that the image derivative stopped being gas, so the old cost sentence is not restored",
  },
  {
    prefix: "vex-app/src/renderer/features/appShell/book/image-locker/ImageThumb.tsx",
    reason: "records why the tile's badge stopped saying POOLS ONLY",
  },
  {
    prefix: "vex-app/src/renderer/lib/api/queryKeys.ts",
    reason: "records why there is one launch query key rather than four",
  },
  {
    prefix: "vex-app/src/main/images/byte-resolver.ts",
    reason: "records that the on-chain resolver lane went with the protocol that signed over image bytes",
  },
  {
    prefix: "scripts/deleted-test-allowlist.mjs",
    reason: "names every test whose subject this retirement deleted",
  },
  {
    prefix: "scripts/check-trench-residue.mjs",
    reason: "this gate",
  },

  // ── Prose still naming the retired ladder, scheduled not guessed ─────────
  {
    prefix: "vex-app/src/main/images/",
    reason:
      "the image ladder's modules are named and documented for the on-chain budget that produced the derivative; the derivative survives as the locker thumbnail and RENAMING the seam is a separate change with its own durable column rename (see the report's follow-ups)",
  },
  {
    prefix: "vex-app/src/shared/schemas/images.ts",
    reason: "same seam, renderer side: `onchainByteLength` is the durable DTO field name",
  },
  {
    prefix: "vex-app/src/shared/types/bridge/agent/images.ts",
    reason: "same seam: the bridge type documents where the locker's agent read came from",
  },
  {
    prefix: "vex-app/src/shared/ipc/channels/requests.ts",
    reason: "same seam: the images channel doc names the locker's origin",
  },
  {
    prefix: "vex-app/src/shared/ipc/result/types.ts",
    reason: "same seam: the `images` domain doc names the locker's origin",
  },
  {
    prefix: "vex-app/src/main/agent/index.ts",
    reason: "same seam: the bootstrap comments name the lanes the resolver and the form bus were built for",
  },
  {
    prefix: "src/tools/pools-fun/",
    reason:
      "the pools.fun docs contrast their design against the launchpad they were written beside; a dated design record, not a live instruction",
  },
  {
    prefix: "src/vex-agent/sync/pools-attribution.ts",
    reason: "names the lane its architecture was cloned from",
  },
  {
    prefix: "src/vex-agent/tools/OPEN-DECISIONS.md",
    reason:
      "an open-decisions ledger whose rows were written against the surface of the day; rewriting them would falsify the record",
  },
  {
    prefix: "src/vex-agent/tools/registry/twitter-account.ts",
    reason: "\"HUNT THE TRENCHES\" is the English word, not the protocol",
  },
];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Source and live docs. Mirrors `check-no-em-dash.mjs`'s authored-content set. */
function isScanned(file) {
  if (file.includes("node_modules/")) return false;
  if (file.includes("/dist/")) return false;
  if (file.startsWith("src/vex-agent/db/migrations/")) return false;
  if (file.startsWith("src/vex-agent/sync/legacy-trench-express/")) return false;
  if (file.startsWith("src/vex-agent/tools/tool-surface-spec/")) return false;
  if (file.includes("__toolsnaps__/")) return false;
  if (file.includes("__promptsnaps__/")) return false;
  if (file.includes("__goldens__/")) return false;
  if (file.includes("/fixtures/")) return false;
  if (file.includes("/live-captures/")) return false;
  if (file.includes("__tests__/")) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
  return (
    file.startsWith("src/")
    || file.startsWith("vex-app/src/")
    || file.startsWith("bridge/")
    || file.startsWith("docs/")
    || file.startsWith("scripts/")
    || file.endsWith(".md")
  );
}

function isAllowed(file) {
  return ALLOWLIST.some((entry) => file.startsWith(entry.prefix));
}

function containsToken(file) {
  const absolute = path.join(repositoryRoot, file);
  if (!existsSync(absolute)) return false;
  return TOKEN.test(readFileSync(absolute, "utf8"));
}

const tracked = runGit(["ls-files"]).split(/\r?\n/).filter(Boolean);
const untracked = runGit(["ls-files", "--others", "--exclude-standard"])
  .split(/\r?\n/)
  .filter(Boolean);
const files = [...new Set([...tracked, ...untracked])].filter(isScanned);

const offenders = [];
for (const file of files) {
  if (isAllowed(file)) continue;
  const absolute = path.join(repositoryRoot, file);
  if (!existsSync(absolute)) continue;
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (TOKEN.test(line)) offenders.push(`${file}:${index + 1} ${line.trim()}`);
  });
}

// A stale entry is a defect in its own right: it claims a reason for something
// that is no longer there, and the next reader trusts it.
const stale = ALLOWLIST.filter(
  (entry) => !files.some((file) => file.startsWith(entry.prefix) && containsToken(file)),
);

if (stale.length > 0) {
  for (const entry of stale) {
    console.error(`✗ stale allowlist entry: ${entry.prefix} no longer contains the retired name`);
  }
  fail(`${stale.length} stale allowlist entr(y|ies) in scripts/check-trench-residue.mjs - delete them`);
}

if (offenders.length > 0) {
  console.error("✗ Trench Express residue outside the measured allowlist:");
  for (const line of offenders) console.error(`  ${line}`);
  fail(
    `${offenders.length} occurrence(s). Remove them, or - if the path legitimately must keep the `
      + `name - add it to ALLOWLIST in scripts/check-trench-residue.mjs with the reason it must.`,
  );
}

console.log(
  `✓ no Trench Express residue outside the ${ALLOWLIST.length} measured allowlist entries `
    + `(${files.length} files scanned).`,
);
