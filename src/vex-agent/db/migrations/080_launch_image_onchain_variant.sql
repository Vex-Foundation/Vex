-- 080_launch_image_onchain_variant.sql - the locker stores the ORIGINAL,
-- Trench gets a derived on-chain copy
--
-- WHY THIS EXISTS. Migration 062 gave `launch_images` a `byte_length <= 20480`
-- CHECK. That number is a TRENCH constraint and only a Trench constraint: the
-- launchpad writes the image bytes INLINE in the `create()` calldata, so every
-- byte is gas the user pays forever on an irreversible transaction. pools.fun
-- hosts its images off-chain on its own backend and has no comparable limit -
-- measured on 2026-08-19, its `launches/upload-image` endpoint accepted a
-- 2,104,822-byte PNG with a byte-identical round trip.
--
-- With ONE locker serving both launchpads, the 062 CHECK meant every pools.fun
-- launch silently committed a downscaled, square-cropped picture. The owner's
-- decision (2026-08-19) is per-lane: store what the user picked, and DERIVE the
-- Trench copy.
--
-- WHAT CHANGES, and what deliberately does not.
--
-- 1. `byte_length` is now bounded by 26214400 (25 MiB). THIS IS A RESOURCE
--    BOUND, NOT A PRODUCT LIMIT (owner decree 2026-08-19). It exists so a
--    multi-gigabyte pick cannot be read into memory or into a row, and it is
--    the same number as `DOWNSCALE_MAX_SOURCE_BYTES` in
--    `vex-app/src/main/images/downscale.ts`, which refuses from `stat` before a
--    byte is read. Nothing about the product says an image must be under 25 MiB.
--
-- 2. `onchain_byte_length` / `onchain_digest` describe the TRENCH copy, and are
--    NULLABLE TOGETHER. Both NULL means the ladder could not bring this image
--    under the on-chain budget: the image is still a perfectly good pools.fun
--    launch image, and the Trench handlers refuse it BY NAME rather than the
--    upload being refused. The pairing CHECK is what makes "half a variant"
--    impossible - a digest with no length, or a length with no digest, would be
--    a row the signing path could not verify.
--
-- 3. THE 20480 CEILING MOVES ONTO `onchain_byte_length`, unchanged in value. It
--    is still enforced in the database as a BACKSTOP; the app-side assertion in
--    `trench/handlers/launch/plan.ts` is the gate that actually refuses, since
--    the DB no longer bounds what the locker can hold.
--
-- 4. THE BACKFILL IS NOT A DEFAULT, IT IS THE TRUTH. Every pre-080 row already
--    satisfies `byte_length <= 20480` by the 062 CHECK, and the bytes on disk
--    ARE the bytes a Trench launch would commit. So for those rows the original
--    IS its own on-chain variant, and copying `byte_length`/`digest` across
--    states exactly that. This is what keeps the C0 digest binding
--    byte-for-byte identical to its pre-080 behaviour for every image that
--    already exists.
--
-- Expand-only and re-runnable: every ALTER is `IF NOT EXISTS` or a
-- drop-then-add on an EXPLICITLY NAMED constraint, matching 079's style.

-- ── 1. The byte-length bound becomes a resource bound ──────────────────────
--
-- 062 declared this CHECK inline, so Postgres named it
-- `launch_images_byte_length_check`. Dropping by that name and restating it is
-- the re-runnable form; the `> 0` arm is carried over deliberately, because a
-- zero-length image is a broken row, not a small one.

ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_byte_length_check;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_byte_length_check
  CHECK (byte_length > 0 AND byte_length <= 26214400);

-- ── 2. The derived Trench copy ─────────────────────────────────────────────

ALTER TABLE launch_images
  ADD COLUMN IF NOT EXISTS onchain_byte_length INTEGER,
  ADD COLUMN IF NOT EXISTS onchain_digest      TEXT;

-- ── 3. Backfill BEFORE the constraints, so the pairing CHECK can be trusted ─

-- The `digest ~ ...` guard is not paranoia about our own writer: 062 never
-- constrained `digest`, so a row that somehow carries a non-sha256 value would
-- make the new digest CHECK fail the whole migration. Such a row is already
-- unusable (the byte resolver re-derives the digest and refuses on a mismatch),
-- so leaving it variant-less is the outcome that states the truth instead of
-- blocking every other user's upgrade.
-- The `byte_length <= 20480` guard is what makes this statement RE-RUNNABLE and
-- what makes it TRUE. Its premise is "every pre-080 row fits the on-chain
-- budget", and the 062 CHECK is the proof of that premise - so stating it here
-- rather than relying on it is the difference between a backfill and a guess.
-- On a second apply the table also holds rows written AFTER 080, including
-- legitimately copy-less multi-megabyte originals; without this guard those
-- would be backfilled into a column that must never exceed 20480, and the
-- migration would fail on its own new constraint. Proved by check (7) of
-- `agents_dm/pools-fun-live/migration-080-apply-proof.ts`, which caught exactly
-- that on the first draft.
UPDATE launch_images
   SET onchain_byte_length = byte_length,
       onchain_digest      = digest
 WHERE onchain_byte_length IS NULL
   AND byte_length <= 20480
   AND digest ~ '^[0-9a-f]{64}$';

-- ── 4. The constraints ─────────────────────────────────────────────────────
--
-- Pairing: both present or both absent. A length without a digest cannot be
-- verified before signing; a digest without a length loses the second, cheap
-- check that catches a truncated file.

ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_onchain_paired;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_onchain_paired
  CHECK ((onchain_byte_length IS NULL) = (onchain_digest IS NULL));

-- The gas ceiling, now attached to the copy it actually describes.
ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_onchain_byte_length_check;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_onchain_byte_length_check
  CHECK (onchain_byte_length IS NULL
         OR (onchain_byte_length > 0 AND onchain_byte_length <= 20480));

-- The digest is a sha256 in lowercase hex or it is not a digest. `digest`
-- itself is left unconstrained here: 062 shipped it that way and tightening a
-- column this migration does not otherwise touch would be an unrelated change
-- that could fail on a row nobody has inspected.
ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_onchain_digest_check;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_onchain_digest_check
  CHECK (onchain_digest IS NULL OR onchain_digest ~ '^[0-9a-f]{64}$');
