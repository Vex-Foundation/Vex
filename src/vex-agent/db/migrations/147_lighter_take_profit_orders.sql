-- Add native standalone perpetual take-profit orders after the independently
-- released stop-loss slice. Grouped/bracket orders remain unavailable.

ALTER TABLE lighter_order_previews
  DROP CONSTRAINT IF EXISTS lighter_order_previews_order_type_check;

ALTER TABLE lighter_order_previews
  ADD CONSTRAINT lighter_order_previews_order_type_check
  CHECK (order_type IN ('limit', 'market', 'stop-loss', 'take-profit'));

ALTER TABLE lighter_order_execution_intents
  DROP CONSTRAINT IF EXISTS lighter_order_execution_intents_order_type_check;

ALTER TABLE lighter_order_execution_intents
  ADD CONSTRAINT lighter_order_execution_intents_order_type_check
  CHECK (order_type IN ('limit', 'market', 'stop-loss', 'take-profit'));
