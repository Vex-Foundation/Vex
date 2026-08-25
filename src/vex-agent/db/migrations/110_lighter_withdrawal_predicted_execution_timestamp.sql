-- 110_lighter_withdrawal_predicted_execution_timestamp.sql
-- Lighter may return predicted_execution_time_ms as an absolute Unix
-- millisecond timestamp. Those values exceed PostgreSQL's 32-bit INTEGER
-- range, so withdrawal acceptance evidence must use BIGINT.

ALTER TABLE lighter_withdrawal_intents
  ALTER COLUMN predicted_execution_time_ms TYPE BIGINT
  USING predicted_execution_time_ms::BIGINT;
