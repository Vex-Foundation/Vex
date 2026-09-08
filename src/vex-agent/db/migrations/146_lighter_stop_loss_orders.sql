-- Expand the existing single-order Lighter intent path to native perpetual
-- stop-loss market-trigger orders. Take-profit and grouped/bracket orders stay
-- outside this migration and remain release-gated.

ALTER TABLE lighter_order_previews
  DROP CONSTRAINT IF EXISTS lighter_order_previews_order_type_check;

ALTER TABLE lighter_order_previews
  ADD CONSTRAINT lighter_order_previews_order_type_check
  CHECK (order_type IN ('limit', 'market', 'stop-loss'));

ALTER TABLE lighter_order_execution_intents
  DROP CONSTRAINT IF EXISTS lighter_order_execution_intents_order_type_check;

ALTER TABLE lighter_order_execution_intents
  ADD CONSTRAINT lighter_order_execution_intents_order_type_check
  CHECK (order_type IN ('limit', 'market', 'stop-loss'));
