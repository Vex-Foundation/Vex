import { queryOne } from "../../client.js";

/** A confirmed sibling is conclusive nonce consumption, not a missing-receipt guess. */
export async function hasConfirmedEvmNonceSibling(input: {
  chainId: number; fromAddress: string | null; nonce: number | null; txHash: string;
}): Promise<boolean> {
  if (input.fromAddress === null || input.nonce === null) return false;
  const row = await queryOne<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM agent_activity
      WHERE chain_family = 'eip155' AND chain_id = $1 AND lower(from_address) = lower($2)
        AND nonce = $3 AND status = 'confirmed' AND tx_hash IS NOT NULL
        AND lower(tx_hash) <> lower($4)) AS found`,
    [input.chainId, input.fromAddress, input.nonce, input.txHash],
  );
  return row?.found === true;
}
