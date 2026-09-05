ALTER TABLE lighter_order_execution_intents
  ADD COLUMN IF NOT EXISTS integrator_fees_json JSONB;
