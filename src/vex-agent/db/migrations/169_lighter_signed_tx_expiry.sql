-- The wire expiry (`ExpiredAt`, epoch ms) of a signed create-order or grouped
-- (OCO) transaction, read from the official signer's own tx info at signing.
--
-- Recovery needs it to release a lost send: once it has passed and Lighter's
-- next nonce still equals the reserved one, nothing carrying that nonce can
-- execute. Without it a send that left Vex and never landed held the account's
-- nonce forever. NULL on rows signed before this column existed; recovery
-- bounds those by the consent expiry instead (see order-repair.ts).

ALTER TABLE lighter_order_execution_intents
  ADD COLUMN IF NOT EXISTS signer_expiry_ms BIGINT;

ALTER TABLE lighter_oco_execution_intents
  ADD COLUMN IF NOT EXISTS signer_expiry_ms BIGINT;
