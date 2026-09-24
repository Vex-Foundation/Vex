-- A settled setup interaction keeps the result message id as its durable
-- idempotency marker. Compaction moves that message from messages into
-- messages_archive, so a foreign key to only the live table blocks the move.
-- The settlement writer stamps the id in the same transaction as the message
-- insert; retaining the id after archival preserves the resume guard.
ALTER TABLE lighter_setup_interactions
  DROP CONSTRAINT IF EXISTS lighter_setup_interactions_result_message_id_fkey;
