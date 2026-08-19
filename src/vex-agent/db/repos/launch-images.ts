/**
 * Launch-images repo — the image locker's METADATA (contract C2; migration
 * `062_trench_launch.sql`).
 *
 * METADATA ONLY. The BYTES live main-side under the Electron `userData`
 * directory and never cross to the renderer or into the agent's transcript. This
 * table exists precisely so the `trench.images` handler — which runs in
 * `src/vex-agent`, where no locker service seam exists — can read the metadata
 * through an ordinary DB repo like any other read tool, instead of inventing a
 * new `ProtocolExecutionContext` seam. The BYTE path is the separate C2b
 * resolver (`tools/protocols/shared/launch-image-byte-resolver.ts`).
 *
 * GLOBAL and PERSISTENT: an image belongs to the USER, not to an intent or a
 * session. Every read here is therefore unscoped — the deliberate asymmetry with
 * `./token-launch-intents.ts`, which is session-scoped in every predicate.
 *
 * ── The lifecycle rule, and why it lives here ──────────────────────────────
 *
 * C2: cancelling or expiring an intent NEVER deletes an image, and an explicit
 * deletion REFUSES while a live intent that CAN STILL SIGN references the image,
 * and says which. A non-terminal status is not enough on its own — see
 * {@link LIVE_INTENTS_SQL} for the lapsed-window half of that question.
 *
 * That refusal is enforced INSIDE {@link deleteLaunchImage}, in one transaction
 * with the delete, rather than being left to the caller. A caller that checked
 * first and deleted second would have a TOCTOU window in which a launch intent
 * is created referencing the image — and the bytes would then be deleted out
 * from under a live launch that is about to sign. On a real-funds path that
 * window is not acceptable, and the only place it can be closed is here.
 *
 * The same rule is why the table has NO foreign key from
 * `token_launch_intents.image_id`. The condition is on the referencing row's
 * STATUS, which a foreign key cannot express: `ON DELETE RESTRICT` would refuse
 * forever, including long after every referencing intent went terminal, and
 * `ON DELETE SET NULL` would silently erase the audit trail of which image a
 * completed launch actually committed on-chain.
 *
 * `digest` is the sha256 of the STORED ORIGINAL bytes. `onchain_digest` is the
 * sha256 of the derived Trench copy (migration 083), which is what a Trench
 * launch actually writes on-chain. The execute leg re-reads the bytes main-side
 * and verifies the digest of the variant IT consumes against the one bound in
 * the authorization record (C0) before signing, so an image swapped between
 * authorization and execution cannot slip through. For every image that
 * predates 083 the two digests are equal by backfill, so that binding is
 * byte-for-byte what it always was.
 */

import { query, queryOne, withTransaction } from "../client.js";
import { lockLaunchImageWith } from "./launch-image-lock.js";
import {
  EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES,
  LIVE_TOKEN_LAUNCH_INTENT_STATUSES,
} from "./token-launch-intents.js";
import type { TokenLaunchIntentStatus } from "./token-launch-intents.js";

/**
 * The MIME allowlist, mirroring the table's own CHECK. No other type is
 * accepted: there is no runtime codec packaged (`sharp` is devDependencies-only)
 * so Vex never decodes or transcodes an image, and the launchpad backend serves
 * these three itself.
 */
export type LaunchImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface LaunchImageRow {
  /** Opaque, main-generated. Never a filesystem path and never a renderer-chosen name. */
  imageId: string;
  label: string;
  byteLength: number;
  mime: LaunchImageMime;
  width: number;
  height: number;
  /** sha256 hex of the stored bytes. */
  digest: string;
  /**
   * The TRENCH on-chain copy (migration 083), NULLABLE TOGETHER with
   * {@link onchainDigest}.
   *
   * `byteLength`/`digest` above describe the ORIGINAL bytes the user picked,
   * which is what a pools.fun launch uploads. Trench writes the image inline in
   * `create()` calldata, so it needs a copy under the gas ceiling; the desktop
   * ladder derives one at ingest. Both fields NULL means no copy could be
   * derived: the image is pools-only, and the Trench handlers refuse it by name.
   *
   * When `onchainDigest === digest` the original IS its own on-chain copy and
   * there is no second byte file. That equality is the whole encoding of "no
   * second file", so callers compare it rather than storing a third flag.
   */
  onchainByteLength: number | null;
  /** sha256 hex of the on-chain copy. Bound into the C0 authorization. */
  onchainDigest: string | null;
  uploadedAt: string;
}

/** `uploadedAt` is DB-assigned (`DEFAULT NOW()`) — callers do not supply it. */
export type InsertLaunchImageInput = Omit<LaunchImageRow, "uploadedAt">;

/** A live intent blocking a deletion, named so the refusal message can say which. */
export interface LiveIntentReference {
  intentId: string;
  status: TokenLaunchIntentStatus;
  name: string;
}

export type DeleteLaunchImageResult =
  | { readonly deleted: true; readonly row: LaunchImageRow }
  | { readonly deleted: false; readonly reason: "not_found" }
  | {
      readonly deleted: false;
      readonly reason: "referenced_by_live_intent";
      readonly intents: readonly LiveIntentReference[];
    };

const SELECT_COLUMNS =
  "image_id, label, byte_length, mime, width, height, digest, "
  + "onchain_byte_length, onchain_digest, uploaded_at";

function mapRow(r: Record<string, unknown>): LaunchImageRow {
  return {
    imageId: r.image_id as string,
    label: r.label as string,
    byteLength: Number(r.byte_length),
    mime: r.mime as LaunchImageMime,
    width: Number(r.width),
    height: Number(r.height),
    digest: r.digest as string,
    onchainByteLength:
      r.onchain_byte_length === null || r.onchain_byte_length === undefined
        ? null
        : Number(r.onchain_byte_length),
    onchainDigest:
      r.onchain_digest === null || r.onchain_digest === undefined
        ? null
        : (r.onchain_digest as string),
    uploadedAt:
      r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : String(r.uploaded_at),
  };
}

function mapLiveIntent(r: Record<string, unknown>): LiveIntentReference {
  return {
    intentId: r.intent_id as string,
    status: r.status as TokenLaunchIntentStatus,
    name: r.name as string,
  };
}

/**
 * Insert a locker image's metadata row.
 *
 * The table's CHECKs (the 25 MiB resource bound, the 20 KB on-chain-copy cap,
 * the MIME allowlist, positive dimensions) are a BACKSTOP, not the validator: a
 * violation surfaces here as a raw Postgres error with no useful message for the
 * user. The main-side upload path validates first — magic-byte sniff, MIME
 * allowlist, header-read dimensions, size ceiling — and these constraints exist
 * so a row can never claim a shape the launch path would refuse.
 */
export async function insertLaunchImage(
  input: InsertLaunchImageInput,
): Promise<LaunchImageRow> {
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO launch_images
       (image_id, label, byte_length, mime, width, height, digest,
        onchain_byte_length, onchain_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.imageId,
      input.label,
      input.byteLength,
      input.mime,
      input.width,
      input.height,
      input.digest,
      input.onchainByteLength,
      input.onchainDigest,
    ],
  );
  if (!row) throw new Error("launch_images: insertLaunchImage returned no row");
  return mapRow(row);
}

/** The whole locker, most recent first. Unscoped by design — see the header. */
export async function listLaunchImages(): Promise<LaunchImageRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM launch_images
      ORDER BY uploaded_at DESC, image_id DESC`,
  );
  return rows.map(mapRow);
}

export async function getLaunchImage(imageId: string): Promise<LaunchImageRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM launch_images WHERE image_id = $1`,
    [imageId],
  );
  return row ? mapRow(row) : null;
}

/**
 * The blocking set: intents that reference this image AND can still reach a
 * signature.
 *
 * THE EXPIRY CLAUSE IS PART OF THE QUESTION, not an optimisation. A live status
 * alone is not evidence of live money state: `awaiting_user_form` and
 * `authorized` can only move forward through a CAS that requires
 * `expires_at > NOW()`, so once the window lapses the row is dead and nothing
 * can revive it. Only `awaiting_user_form` has a sweep to stamp it terminal, so
 * without this clause a single launch attempt that failed before it could be
 * consumed held the user's image hostage forever — the C2 refusal outliving the
 * launch it was protecting. The whole reason C2 refuses is a launch that is
 * about to sign; a launch that can never sign is not one.
 *
 * `consuming` and `broadcast_pending` are unaffected: they are excluded from
 * {@link EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES} precisely because a lapsed
 * window does not stop them, so they block regardless of `expires_at`.
 */
const LIVE_INTENTS_SQL = `SELECT intent_id, status, name
     FROM token_launch_intents
    WHERE image_id = $1
      AND status = ANY($2::text[])
      AND (NOT (status = ANY($3::text[])) OR expires_at > NOW())
    ORDER BY created_at ASC`;

function liveIntentsParams(imageId: string): unknown[] {
  return [
    imageId,
    LIVE_TOKEN_LAUNCH_INTENT_STATUSES,
    EXPIRY_BOUND_TOKEN_LAUNCH_INTENT_STATUSES,
  ];
}

/**
 * Which LIVE intents reference this image.
 *
 * PREFLIGHT ONLY — for showing the user why a delete will be refused before they
 * click it. It is NOT the gate: {@link deleteLaunchImage} re-checks inside its
 * own transaction, because anything else has a TOCTOU window (see the header).
 */
export async function findLiveIntentsReferencingImage(
  imageId: string,
): Promise<LiveIntentReference[]> {
  const rows = await query<Record<string, unknown>>(
    LIVE_INTENTS_SQL,
    liveIntentsParams(imageId),
  );
  return rows.map(mapLiveIntent);
}

/**
 * Delete a locker image's metadata, REFUSING while a live intent references it.
 *
 * The transaction takes the image's advisory lock FIRST, then checks, then
 * deletes. One shared transaction is NOT enough on its own: under READ COMMITTED
 * a concurrently inserted intent is invisible to the check and unblocked by any
 * constraint (there is no foreign key — see the header), so both would commit
 * and a live launch would lose its image. Because every intent write that
 * references an image takes the SAME lock, a concurrent intent either blocks
 * this deletion or arrives after it — never in between. See
 * `./launch-image-lock.ts`. The refusal names the blocking intents so the caller
 * can tell the user which launch is holding the image.
 *
 * CALLER CONTRACT: delete the metadata row FIRST (this call) and the BYTES only
 * on `deleted: true`. Bytes removed before a refusal would orphan a live
 * launch's image — a launch that then signs against nothing. Losing bytes while
 * a row survives is a recoverable inconsistency; the reverse is not.
 */
export async function deleteLaunchImage(
  imageId: string,
): Promise<DeleteLaunchImageResult> {
  return withTransaction(async (client) => {
    await lockLaunchImageWith(client, imageId);
    const blocking = await client.query<Record<string, unknown>>(
      LIVE_INTENTS_SQL,
      liveIntentsParams(imageId),
    );
    if (blocking.rows.length > 0) {
      return {
        deleted: false,
        reason: "referenced_by_live_intent",
        intents: blocking.rows.map(mapLiveIntent),
      };
    }
    const deleted = await client.query<Record<string, unknown>>(
      `DELETE FROM launch_images WHERE image_id = $1 RETURNING ${SELECT_COLUMNS}`,
      [imageId],
    );
    const row = deleted.rows[0];
    if (row === undefined) return { deleted: false, reason: "not_found" };
    return { deleted: true, row: mapRow(row) };
  });
}
