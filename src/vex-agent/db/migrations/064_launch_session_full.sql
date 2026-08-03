-- 064: admit the `session_full` C0 authorization variant on
-- `token_launch_intents.authorization_kind`.
--
-- ── NUMBERING ──────────────────────────────────────────────────────────────
--
-- 063 is the highest sibling file at the time of writing. `db/migrate.ts`
-- applies only migrations whose version is GREATER than `MAX(schema_version)`,
-- so 064 is forward-only for every history that has run 062 or 063. Verified
-- 2026-08-02: no sibling file claims 064.
--
-- ── WHY A FOURTH VARIANT ───────────────────────────────────────────────────
--
-- 062 declared three: `user_submit` (the human clicked Deploy), `approval_card`
-- (a RESTRICTED session's proposal that a human resolved) and `full_autonomy`
-- (a mission contract whose host-authored ceilings covered the spend).
--
-- That vocabulary had no name for the case a live session proved is real: the
-- user set the session to FULL permission in ordinary chat and asked for a
-- launch. `trench.launch_execute` refused it — the handler treated a missing
-- approval id as proof that the call had to be a mission dispatch — while
-- `swap_execute` and every other mutating tool executes on exactly that basis
-- in full mode. Owner decree 2026-08-02: the launch FORM is an optional path,
-- not a gate, and full session permission is the consent basis in chat.
--
-- It could not reuse a kind honestly. `approval_card` would claim an approval
-- id that does not exist; `full_autonomy` would claim mission provenance and
-- frozen ceilings that do not exist — and the ceilings are mission-scoped, so
-- an audit reading `full_autonomy` with no run would be reading a lie about
-- what bounded the spend. A CHECK constraint is the cheapest place to keep the
-- audit vocabulary truthful, so the constraint moves instead of the meaning.
--
-- Ceilings: NONE apply on this path, by design. §C6/§C6b bound UNATTENDED
-- spending against a contract the host authored; a chat launch is attended and
-- is bounded the way every other full-mode spend is — by the user asking for
-- it, and by the plan's own refusals (image required, balance gate, exact
-- msg.value recomposition, re-derive-and-compare before signing).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'token_launch_intents'::regclass
      AND conname = 'token_launch_intents_authorization_kind_check'
  ) THEN
    ALTER TABLE token_launch_intents
      DROP CONSTRAINT token_launch_intents_authorization_kind_check;
  END IF;
END$$;

ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_authorization_kind_check
  CHECK (authorization_kind IN (
    'user_submit',
    'approval_card',
    'full_autonomy',
    'session_full'
  ));

COMMENT ON COLUMN token_launch_intents.authorization_kind IS
  'Which C0 authorization variant authorized this launch: user_submit (the human clicked Deploy), approval_card (a restricted session''s proposal a human resolved), full_autonomy (a mission contract whose host-authored ceilings covered it — NOT consent, no human acted), session_full (the user put this chat session in full permission and asked for the launch). See handlers/launch/authorization.ts.';
