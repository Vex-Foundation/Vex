-- Expand the existing single-order Lighter intent path to the native triggered
-- limit variants. Existing approved/submitted intents are also given the
-- public market precision already stored on their FK-linked preview so the
-- stricter provider-evidence matcher remains upgrade-safe. No credential,
-- signing artifact, signed payload, or other secret material is added.

ALTER TABLE lighter_order_previews
  DROP CONSTRAINT IF EXISTS lighter_order_previews_order_type_check;

ALTER TABLE lighter_order_previews
  ADD CONSTRAINT lighter_order_previews_order_type_check
  CHECK (order_type IN (
    'limit', 'market', 'stop-loss', 'stop-loss-limit',
    'take-profit', 'take-profit-limit'
  ));

ALTER TABLE lighter_order_execution_intents
  DROP CONSTRAINT IF EXISTS lighter_order_execution_intents_order_type_check;

ALTER TABLE lighter_order_execution_intents
  ADD CONSTRAINT lighter_order_execution_intents_order_type_check
  CHECK (order_type IN (
    'limit', 'market', 'stop-loss', 'stop-loss-limit',
    'take-profit', 'take-profit-limit'
  ));

UPDATE lighter_order_execution_intents AS intent
SET pre_submit_revalidation_json = jsonb_set(
  jsonb_set(
    intent.pre_submit_revalidation_json,
    '{baseDecimals}',
    preview.preview_json #> '{baseAmount,decimals}',
    true
  ),
  '{priceDecimals}',
  preview.preview_json #> '{price,decimals}',
  true
)
FROM lighter_order_previews AS preview
WHERE intent.preview_id = preview.preview_id
  AND intent.pre_submit_revalidation_json IS NOT NULL
  AND (
    NOT (intent.pre_submit_revalidation_json ? 'baseDecimals')
    OR NOT (intent.pre_submit_revalidation_json ? 'priceDecimals')
  )
  AND jsonb_typeof(preview.preview_json #> '{baseAmount,decimals}') = 'number'
  AND jsonb_typeof(preview.preview_json #> '{price,decimals}') = 'number';
