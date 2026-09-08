-- Extend the shared durable EVM nonce allocator to Lighter's locally signed
-- settlement-chain actions that do not own an agent_activity row.

ALTER TABLE evm_nonce_reservations
  DROP CONSTRAINT IF EXISTS evm_nonce_reservations_purpose_check;

ALTER TABLE evm_nonce_reservations
  ADD CONSTRAINT evm_nonce_reservations_purpose_check CHECK (purpose IN (
    'pendle_allowance',
    'lighter_deposit_approve',
    'lighter_deposit',
    'lighter_withdrawal_claim'
  ));
