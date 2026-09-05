-- 106_launch_image_public_asset.sql - where a locker image lives PUBLICLY, so a
-- launchpad's on-chain `image` field can point at bytes nobody can swap
--
-- WHY THIS EXISTS. A launchpad's on-chain `image` is a URL, and a URL is
-- mutable by whoever serves it. That is the whole problem: the picture the user
-- approved and the picture the world later sees could differ, and nothing on
-- chain would be able to tell them apart. So Vex publishes the locker picture to
-- a CONTENT-ADDRESSED public host and commits that address instead. The URL is
-- `<public base>/a/<cid>.<ext>`, where `cid` is the lowercase-hex sha256 of the
-- exact bytes. Given the URL, anyone (including our own pre-sign check) can
-- re-fetch the bytes and re-derive the cid; a substitution is therefore
-- detectable rather than invisible.
--
-- The public copy is made ONCE per locker image and reused by every later launch
-- that names that image. These three columns are the record of that one
-- publication.
--
-- WHAT CHANGES, and what deliberately does not.
--
-- 1. Three NULLABLE columns on `launch_images`, ALL-NULL or ALL-SET. NULL means
--    "not published"; it is not a placeholder for a value we failed to compute.
--
-- 2. NO BACKFILL, and that is a statement of truth rather than an omission. No
--    row has a public copy yet - the publishing path ships with this migration -
--    so NULL is exactly correct for every existing row. Inventing a value here
--    would be inventing a publication that never happened.
--
-- 3. `public_cid` IS DELIBERATELY NOT UNIQUE. The host is content-addressed, so
--    two locker rows holding byte-identical pictures legitimately resolve to the
--    SAME cid and the SAME public URL - that is the addressing scheme working,
--    not a duplicate. A UNIQUE constraint would refuse the second row for being
--    correct, and would do it at the worst moment: mid-launch, on a real-funds
--    path, over a picture the user already approved. The sharing is also why
--    withdrawal is an explicit user act (see 5): one locker row is not
--    necessarily the only claimant of a cid.
--
-- 4. COMPATIBILITY: readers before writers, expand-only. Every reader of this
--    table selects an explicit column list (`SELECT_COLUMNS` in
--    `src/vex-agent/db/repos/launch-images.ts`), so engine code from before this
--    migration never sees these columns and is unaffected. New code tolerates
--    NULL, which means "not published". No existing row is rewritten and no
--    existing constraint is touched.
--
-- 5. DELETION SEMANTICS - the important one. Deleting a locker image does NOT
--    delete the public asset, and MUST NOT. Two independent reasons:
--      - the URL may already be committed on chain in a launched token's
--        metadata, where nothing can change it. Pulling the bytes out from under
--        it would break a token that is live and traded, silently.
--      - the asset host's own contract makes a deleted cid permanently
--        unpublishable by anyone. A withdrawal is therefore irreversible not
--        just for this user but globally, which is far too much consequence to
--        attach to tidying up a locker.
--    The user withdraws the public copy EXPLICITLY, through the image card or a
--    tool, which calls the host's delete endpoint. This migration therefore adds
--    NO cascade, NO trigger, and NO foreign key: these columns are METADATA
--    ABOUT AN EXTERNAL RESOURCE THIS DATABASE DOES NOT OWN, and the database
--    must not be given the impression that it can reclaim it.
--
-- 6. ROLLBACK: drop the pairing constraint, the cid-format constraint and the
--    three columns; nothing else depends on them and no other table references
--    them. WHAT IS LOST is the record of which public URL a locker image already
--    has, so a later publish would upload the same bytes again. That is
--    harmless: the upload is idempotent by content and returns the SAME cid and
--    the SAME URL. What rollback does NOT do, and cannot, is un-publish anything
--    - the bytes stay on the host, reachable, and the user's only handle for
--    withdrawing them is the URL these columns held. So rollback is safe for
--    correctness and lossy for control.
--
-- Expand-only and re-runnable: every ALTER is `IF NOT EXISTS` or a
-- drop-then-add on an EXPLICITLY NAMED constraint, matching 083's style.

-- -- 1. The record of the one publication ------------------------------------

ALTER TABLE launch_images
  ADD COLUMN IF NOT EXISTS public_cid         TEXT,
  ADD COLUMN IF NOT EXISTS public_url         TEXT,
  ADD COLUMN IF NOT EXISTS public_uploaded_at TIMESTAMPTZ;

-- -- 2. The constraints --------------------------------------------------------

-- The cid is a sha256 in lowercase hex or it is not a cid. This is what lets the
-- pre-sign check re-derive an address from bytes and compare; a cid in any other
-- shape could not be compared against anything.
ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_public_cid_check;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_public_cid_check
  CHECK (public_cid IS NULL OR public_cid ~ '^[0-9a-f]{64}$');

-- Pairing: all three present or all three absent. Stated as a THREE-WAY equality
-- on purpose. Two pairwise checks (cid<->url, url<->timestamp) would each pass
-- on some three-way partials, and the whole point is that no partial exists.
--
-- WHY A PARTIAL ROW IS DANGEROUS, field by field:
--   - a URL with no cid is a publication that CANNOT BE VERIFIED before signing.
--     The pre-sign check re-fetches the URL and compares the sha256 of what came
--     back against the recorded cid; with no cid there is nothing to compare to,
--     and the substitution this whole design exists to detect becomes invisible
--     again.
--   - a cid with no URL is a publication NOBODY CAN REACH OR WITHDRAW. The bytes
--     are on the host and the user has lost the only handle to them; the host's
--     delete endpoint takes the address, and we no longer have it.
--   - a missing timestamp erases WHEN the bytes became public, which is the one
--     fact an incident review needs first.
ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_public_asset_paired;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_public_asset_paired
  CHECK ((public_cid IS NULL) = (public_url IS NULL)
         AND (public_cid IS NULL) = (public_uploaded_at IS NULL));
