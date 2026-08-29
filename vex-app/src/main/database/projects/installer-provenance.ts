/**
 * The Studio installer's DURABLE PROVENANCE: what Vex wrote, where, and when.
 *
 * This repository owns three durable facts and nothing else:
 *
 *   1. PER-ARTIFACT PROVENANCE (`project_file_provenance`). For each artifact,
 *      the repo-relative path Vex wrote, the digest of the Vex-owned REGION
 *      inside it, and the digest of the WHOLE file as Vex left it. The region
 *      digest is what proves "this entry is ours to rewrite"; the file digest
 *      is what detects that something moved underneath us.
 *   2. THE COMPLETION MARKER on `projects`. `last_rendered_scope_version` and
 *      `generator_version` (the generator fingerprint) advance ONLY after a run
 *      that reconciled every artifact of the scope it reloaded.
 *   3. THE CHANGE-NOTE LOG (`project_change_notes`), bounded to
 *      `STUDIO_CHANGE_NOTE_LIMIT` entries and rendered into the `AGENTS.md`
 *      managed block.
 *
 * WHY EACH ARTIFACT COMMITS ON ITS OWN. A reconciliation writes several files,
 * and a file write is not transactional with a database row. Wrapping the whole
 * run in one transaction would mean a crash after three successful file
 * replacements left ZERO provenance - and the next run would then see three
 * files it wrote itself, fail to prove ownership, and refuse them all as
 * collisions. Committing immediately after each successful replacement is what
 * makes the fault-injection case recoverable: whatever was written is proven,
 * and Repair finishes the rest. The completion marker is the separate, later
 * statement that says the WHOLE scope is done.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  STUDIO_CHANGE_NOTE_LIMIT,
  type StudioChangeNote,
} from "@vex-agent/studio/installer/render/index.js";
import { dbError, withClient } from "../sessions/connection.js";

/**
 * HOW Vex came to own an artifact's bytes.
 *
 *   - `written`  Vex rendered and REPLACED them. They are Vex's own output.
 *   - `adopted`  the bytes were ALREADY on disk, byte-for-byte identical to
 *                what a fresh render produces, and the reconciler finalized
 *                them so a write whose provenance commit was lost is not
 *                refused as a collision forever.
 *
 * The distinction exists because adoption CANNOT tell "Vex wrote this and the
 * record was lost" from "the user wrote exactly this before installing Vex":
 * the bytes are identical by construction. That is harmless while the record
 * only authorizes rewriting identical bytes with identical bytes, and harmful
 * the moment it authorizes a DELETION - which is what the B0 project teardown
 * does. So only `written` is authorship proof; `adopted` is a no-collision
 * marker, and the teardown keeps those bytes.
 */
export type ArtifactProvenanceOrigin = "written" | "adopted";

/** One artifact's durable record. */
export interface ArtifactProvenance {
  readonly artifactKey: string;
  readonly relativePath: string;
  /** Digest of the Vex-owned region, or null for a whole-file artifact. */
  readonly entryHash: string | null;
  /** Digest of the whole file as Vex left it. */
  readonly contentHash: string;
  /** Whether Vex WROTE these bytes or merely ADOPTED bytes already there. */
  readonly origin: ArtifactProvenanceOrigin;
}

/** What the durable record says about a project's last complete render. */
export interface ProjectRenderMarker {
  readonly lastRenderedScopeVersion: number | null;
  readonly generatorFingerprint: string | null;
}

interface ProvenanceRow {
  artifact_key: string;
  relative_path: string;
  entry_hash: string | null;
  content_hash: string;
  origin: string;
}

/** Every artifact record for one project, keyed by artifact key. */
export async function readArtifactProvenance(
  projectId: string,
): Promise<Result<ReadonlyMap<string, ArtifactProvenance>, VexError>> {
  return withClient(async (client) => {
    try {
      const rows = await client.query<ProvenanceRow>(
        `SELECT artifact_key, relative_path, entry_hash, content_hash, origin
           FROM project_file_provenance WHERE project_id = $1`,
        [projectId],
      );
      const map = new Map<string, ArtifactProvenance>();
      for (const row of rows.rows) {
        map.set(row.artifact_key, {
          artifactKey: row.artifact_key,
          relativePath: row.relative_path,
          entryHash: row.entry_hash,
          contentHash: row.content_hash,
          // UNKNOWN READS AS `adopted`. The column's CHECK admits only the two
          // members, so this is unreachable for a row this app wrote; it is the
          // conservative answer for a row from a database an older or newer
          // build touched, and conservative here means "Vex will not delete
          // these bytes".
          origin: row.origin === "written" ? "written" : "adopted",
        });
      }
      return ok<ReadonlyMap<string, ArtifactProvenance>>(map);
    } catch (cause) {
      return dbError("readArtifactProvenance failed", cause);
    }
  });
}

/**
 * Record one artifact's provenance. Its OWN statement, committed now.
 *
 * Called immediately after a successful replacement (`origin: "written"`), or
 * when the reconciler finalizes bytes that were already correct on disk
 * (`origin: "adopted"`). See the module header for why this is not deferred to
 * the end of the run, and `ArtifactProvenanceOrigin` for why the two are not
 * the same fact.
 *
 * ## `written` NEVER DOWNGRADES TO `adopted`, and the guarantee is in the SQL
 *
 * Adoption is a NO-COLLISION marker; `written` is AUTHORSHIP PROOF, and only
 * authorship proof authorizes the B0 teardown to DELETE an artifact's bytes. A
 * later `adopted` commit over a `written` row would silently revoke a deletion
 * right the project already holds, so the upsert KEEPS `written` when the
 * existing row says `written`, whatever the incoming value.
 *
 * The reconciler already declines to make that call, but that is a caller's
 * discipline and this is a durable invariant. Expressing it in the `DO UPDATE`
 * makes it hold for every future caller, including ones not written yet. The
 * reverse move (`adopted` -> `written`) is unrestricted: it is an UPGRADE, and
 * it is exactly what happens when Vex genuinely rewrites the artifact.
 */
export async function commitArtifactProvenance(
  projectId: string,
  record: ArtifactProvenance,
): Promise<Result<null, VexError>> {
  return withClient(async (client) => {
    try {
      await client.query(
        `INSERT INTO project_file_provenance
           (project_id, artifact_key, relative_path, entry_hash, content_hash,
            origin, written_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (project_id, artifact_key) DO UPDATE
           SET relative_path = EXCLUDED.relative_path,
               entry_hash = EXCLUDED.entry_hash,
               content_hash = EXCLUDED.content_hash,
               origin = CASE
                          WHEN project_file_provenance.origin = 'written'
                            THEN 'written'
                          ELSE EXCLUDED.origin
                        END,
               written_at = NOW()`,
        [
          projectId,
          record.artifactKey,
          record.relativePath,
          record.entryHash,
          record.contentHash,
          record.origin,
        ],
      );
      return ok(null);
    } catch (cause) {
      return dbError("commitArtifactProvenance failed", cause);
    }
  });
}

/**
 * Forget one artifact.
 *
 * Called after a DESELECT removed Vex's entry from a file. The file itself
 * stays (A5 never deletes files); what is dropped is Vex's claim on a region
 * that no longer exists, so a later re-select is a fresh install and not a
 * rewrite of something that is not there.
 */
export async function clearArtifactProvenance(
  projectId: string,
  artifactKey: string,
): Promise<Result<null, VexError>> {
  return withClient(async (client) => {
    try {
      await client.query(
        "DELETE FROM project_file_provenance WHERE project_id = $1 AND artifact_key = $2",
        [projectId, artifactKey],
      );
      return ok(null);
    } catch (cause) {
      return dbError("clearArtifactProvenance failed", cause);
    }
  });
}

/** Read the completion marker. */
export async function readRenderMarker(
  projectId: string,
): Promise<Result<ProjectRenderMarker, VexError>> {
  return withClient(async (client) => {
    try {
      const rows = await client.query<{
        last_rendered_scope_version: number | null;
        generator_version: string | null;
      }>(
        `SELECT last_rendered_scope_version, generator_version
           FROM projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const row = rows.rows[0];
      return ok<ProjectRenderMarker>({
        lastRenderedScopeVersion: row?.last_rendered_scope_version ?? null,
        generatorFingerprint: row?.generator_version ?? null,
      });
    } catch (cause) {
      return dbError("readRenderMarker failed", cause);
    }
  });
}

/**
 * Advance the completion marker.
 *
 * `WHERE scope_version = $2` is not decoration: between the moment the run
 * reloaded the scope and the moment it finishes writing files, a new scope edit
 * can have committed. Claiming that version as rendered would then mark a
 * project up to date whose newest authority never reached a file. The guarded
 * update simply matches nothing in that case, and the queued job for the newer
 * version does the work.
 */
export async function recordCompleteRender(
  projectId: string,
  scopeVersion: number,
  generatorFingerprint: string,
): Promise<Result<boolean, VexError>> {
  return withClient(async (client) => {
    try {
      const updated = await client.query(
        // A tombstoned project must never have its render marker advanced:
        // the artifacts are being taken back OUT, and recording them as
        // freshly rendered would tell the next reconciliation there is nothing
        // to remove.
        `UPDATE projects
            SET last_rendered_scope_version = $2, generator_version = $3
          WHERE id = $1 AND scope_version = $2 AND deleted_at IS NULL`,
        [projectId, scopeVersion, generatorFingerprint],
      );
      return ok(updated.rowCount === 1);
    } catch (cause) {
      return dbError("recordCompleteRender failed", cause);
    }
  });
}

interface ChangeNoteRow {
  version: string;
  note_date: string;
  summary: string;
}

/** The bounded change-note log, newest first. */
export async function readChangeNotes(
  projectId: string,
): Promise<Result<readonly StudioChangeNote[], VexError>> {
  return withClient(async (client) => {
    try {
      const rows = await client.query<ChangeNoteRow>(
        `SELECT version, note_date, summary
           FROM project_change_notes WHERE project_id = $1
          ORDER BY id DESC LIMIT $2`,
        [projectId, STUDIO_CHANGE_NOTE_LIMIT],
      );
      return ok<readonly StudioChangeNote[]>(
        rows.rows.map((row) => ({
          version: row.version,
          date: row.note_date,
          summary: row.summary,
        })),
      );
    } catch (cause) {
      return dbError("readChangeNotes failed", cause);
    }
  });
}

/**
 * Append one note and prune the log back to its bound.
 *
 * A BOUND, not a truncation: the block states how many entries it keeps and
 * that older ones are dropped, so a reader can tell exactly what is not shown.
 * Insert and prune are one transaction so a reader never sees the log over its
 * bound or, worse, pruned before the new entry landed.
 */
export async function appendChangeNote(
  projectId: string,
  note: StudioChangeNote,
): Promise<Result<null, VexError>> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO project_change_notes (project_id, version, note_date, summary)
         VALUES ($1, $2, $3, $4)`,
        [projectId, note.version, note.date, note.summary],
      );
      await client.query(
        `DELETE FROM project_change_notes
          WHERE project_id = $1
            AND id NOT IN (
              SELECT id FROM project_change_notes
               WHERE project_id = $1 ORDER BY id DESC LIMIT $2
            )`,
        [projectId, STUDIO_CHANGE_NOTE_LIMIT],
      );
      await client.query("COMMIT");
      return ok(null);
    } catch (cause) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The primary cause is what matters; a failed rollback on a connection
        // that is about to be discarded adds nothing the caller can act on.
      }
      return dbError("appendChangeNote failed", cause);
    }
  });
}
