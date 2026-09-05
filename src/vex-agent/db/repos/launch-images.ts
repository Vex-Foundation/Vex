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
 *
 * ── The public asset (migration 106) ───────────────────────────────────────
 *
 * `publicCid`/`publicUrl`/`publicUploadedAt` describe a copy of the bytes on an
 * EXTERNAL content-addressed host, which is what a launchpad's on-chain `image`
 * field points at. This database does not own that resource: deleting a locker
 * image does NOT withdraw it, and must not - the URL may already be committed on
 * chain, and the host makes a deleted cid permanently unpublishable by anyone.
 * Withdrawal is an explicit user act through the asset client, and
 * {@link clearPublicAsset} only forgets our record of it.
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
  /**
   * The PUBLIC, content-addressed copy (migration 106), NULLABLE TOGETHER with
   * {@link publicUrl} and {@link publicUploadedAt}. All three NULL means NOT
   * PUBLISHED - it is not a value we failed to compute.
   *
   * A launchpad's on-chain `image` field is a URL, and a URL is mutable by
   * whoever serves it. Vex therefore publishes the locker bytes to a
   * content-addressed host and commits `<public base>/a/<cid>.<ext>`, where the
   * cid is the lowercase-hex sha256 of the exact bytes. Given that URL the bytes
   * can be re-fetched and the cid re-derived, so a substitution between approval
   * and the world's later view is DETECTABLE rather than invisible.
   *
   * NOT UNIQUE, by design: the host is content-addressed, so two locker rows
   * holding byte-identical pictures share one cid and one URL. That is the
   * scheme working, not a duplicate.
   */
  publicCid: string | null;
  /** The public URL the launchpad's `image` field points at. */
  publicUrl: string | null;
  /** When the bytes became public. DB-assigned; see {@link recordPublicAsset}. */
  publicUploadedAt: string | null;
}

/**
 * `uploadedAt` is DB-assigned (`DEFAULT NOW()`) - callers do not supply it.
 *
 * The public-asset triple is omitted for a different reason: a NEWLY STAGED
 * locker image is never already published. Publication is a separate, later act
 * with its own writer ({@link recordPublicAsset}), which is where the cid
 * validation and the idempotence rule live. Letting an insert carry those fields
 * would create a second way to claim a publication happened, one that bypasses
 * every check the real writer performs.
 */
export type InsertLaunchImageInput = Omit<
  LaunchImageRow,
  "uploadedAt" | "publicCid" | "publicUrl" | "publicUploadedAt"
>;

/**
 * A publication already recorded for this image conflicts with the one being
 * recorded - a HARD REFUSAL, not a CAS miss.
 *
 * The bytes of a locker row never change (the row carries a `digest` of exactly
 * those bytes), so the same image can only ever have one cid. A second, DIFFERENT
 * cid arriving for the same image means something upstream is wrong - the wrong
 * bytes were uploaded, or the wrong image id was passed - and overwriting the
 * stored record would destroy the user's only handle for withdrawing the copy
 * that is actually on the host, possibly one already committed on chain.
 */
export class PublicAssetConflictError extends Error {
  readonly code = "public_asset_conflict" as const;
  readonly imageId: string;
  constructor(imageId: string, message: string) {
    super(message);
    this.name = "PublicAssetConflictError";
    this.imageId = imageId;
  }
}

/** The cid is the lowercase-hex sha256 of the published bytes, or it is not a cid. */
const PUBLIC_CID_PATTERN = /^[0-9a-f]{64}$/;

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
  + "onchain_byte_length, onchain_digest, uploaded_at, "
  + "public_cid, public_url, public_uploaded_at";

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
    publicCid:
      r.public_cid === null || r.public_cid === undefined ? null : (r.public_cid as string),
    publicUrl:
      r.public_url === null || r.public_url === undefined ? null : (r.public_url as string),
    publicUploadedAt: mapNullableTimestamp(r.public_uploaded_at),
  };
}

function mapNullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
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
 * Record that this locker image's bytes were published to the content-addressed
 * public host, and return the updated row. `null` means NO SUCH IMAGE.
 *
 * `public_uploaded_at` is set by the DATABASE (`NOW()`). A caller-supplied
 * timestamp would be a second source of truth for when bytes became public,
 * which is the first fact an incident review needs and the last one that should
 * come from a clock we do not control.
 *
 * The cid is validated HERE, before the statement, and refused BY NAME. The
 * table's CHECK is a backstop: it would surface as a raw Postgres constraint
 * violation with nothing the caller could act on.
 *
 * ── Re-recording, and the two cases it splits into ────────────────────────
 *
 * SAME cid (and same URL): IDEMPOTENT, and deliberately runs NO write. The
 * publication happened ONCE; `public_uploaded_at` records that moment and must
 * not slide forward every time the upload path re-confirms an asset the host
 * already has. The upload itself is idempotent by content, so this call is the
 * ordinary outcome of publishing an image a second time, not an anomaly.
 *
 * DIFFERENT cid, or the same cid at a different URL: REFUSED with
 * {@link PublicAssetConflictError}. The bytes of a locker row never change (the
 * row carries a `digest` of exactly those bytes), so a second, different cid for
 * the same image means something upstream is wrong rather than a legitimate
 * re-publication. Overwriting would destroy the only handle the user has for
 * withdrawing the copy that is actually on the host - a copy whose URL may
 * already be committed on chain, where nothing can change it. Failing closed
 * leaves both records intact and makes the upstream defect visible; a silent
 * overwrite would leave orphaned public bytes nobody can name.
 *
 * SERIALIZED under the image's advisory lock, inside one transaction, for the
 * same reason {@link deleteLaunchImage} is: a read-then-write across two
 * statements is a TOCTOU window in which a concurrent delete or a concurrent
 * record can land between the check and the write.
 *
 * @throws {PublicAssetConflictError} when a DIFFERENT publication is already recorded.
 */
export async function recordPublicAsset(
  imageId: string,
  asset: { cid: string; url: string },
): Promise<LaunchImageRow | null> {
  if (!PUBLIC_CID_PATTERN.test(asset.cid)) {
    throw new Error(
      `launch_images: recordPublicAsset was given an invalid cid "${asset.cid}" - `
      + "a public asset cid is the lowercase-hex sha256 of the published bytes "
      + "(64 hex characters). Nothing was written.",
    );
  }
  return withTransaction(async (client) => {
    await lockLaunchImageWith(client, imageId);
    const existing = await client.query<Record<string, unknown>>(
      `SELECT ${SELECT_COLUMNS} FROM launch_images WHERE image_id = $1`,
      [imageId],
    );
    const current = existing.rows[0];
    if (current === undefined) return null;

    const row = mapRow(current);
    if (row.publicCid !== null) {
      if (row.publicCid === asset.cid && row.publicUrl === asset.url) return row;
      throw new PublicAssetConflictError(
        imageId,
        `launch_images: image "${imageId}" is already published as `
        + `${row.publicCid} at ${row.publicUrl}; refusing to overwrite that record `
        + `with ${asset.cid} at ${asset.url}. The stored URL is the only handle for `
        + "withdrawing the bytes already on the host, and it may already be committed "
        + "on chain. Nothing was written.",
      );
    }

    const updated = await client.query<Record<string, unknown>>(
      `UPDATE launch_images
          SET public_cid = $2, public_url = $3, public_uploaded_at = NOW()
        WHERE image_id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [imageId, asset.cid, asset.url],
    );
    const written = updated.rows[0];
    if (written === undefined) {
      throw new Error("launch_images: recordPublicAsset returned no row");
    }
    return mapRow(written);
  });
}

/**
 * Forget VEX'S RECORD of the publication: all three public-asset columns back to
 * NULL. Returns whether a row actually changed - `false` for an unknown image
 * AND for an image that had no publication recorded.
 *
 * THIS DOES NOT WITHDRAW THE BYTES FROM THE HOST. It only erases what we know
 * about them. Withdrawing is the asset client's `deleteAsset` call against the
 * host's delete endpoint, and that endpoint takes the URL.
 *
 * REQUIRED CALL ORDER: delete at the HOST first, then clear locally. In that
 * order a failure leaves the record intact and the operation retryable - the
 * user still has the handle. The reverse order strands the bytes public and
 * unreachable: the URL was the only name we had for them, and the host's
 * contract makes a cid deleted by nobody permanently unpublishable by nobody.
 * Losing bytes while the record survives is recoverable; losing the record while
 * the bytes survive is not.
 */
export async function clearPublicAsset(imageId: string): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE launch_images
        SET public_cid = NULL, public_url = NULL, public_uploaded_at = NULL
      WHERE image_id = $1
        AND public_cid IS NOT NULL
      RETURNING image_id`,
    [imageId],
  );
  return row !== null;
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
