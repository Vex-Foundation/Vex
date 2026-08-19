import { getAddress } from "viem";

import type { LighterClient } from "../client.js";
import type { LighterEnvironment } from "../constants.js";
import type { LighterSubAccount } from "../types.js";

const MAX_ACCOUNT_PAGES = 50;

export type LighterAccountOwnershipReader = Pick<LighterClient, "getAccountsByL1Address">;

/**
 * Resolve the one environment-scoped master account owned by a wallet from every paginated
 * public account row. This is evidence only: it owns no signer and writes no
 * workflow state itself.
 */
export async function readUniqueLighterMasterAccount(
  client: LighterAccountOwnershipReader,
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<number> {
  const wallet = getAddress(walletAddress);
  const accounts: LighterSubAccount[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
    const response = await client.getAccountsByL1Address(environment, {
      l1Address: wallet,
      cursor,
    });
    if (response.code !== 200 || getAddress(response.l1_address) !== wallet) {
      throw new Error("The live Lighter account lookup is not bound to the selected wallet.");
    }
    if (response.sub_accounts.some((account) => getAddress(account.l1_address) !== wallet)) {
      throw new Error("The live Lighter account lookup included an account owned by another wallet.");
    }
    accounts.push(...response.sub_accounts);

    const next = response.next_cursor?.trim();
    if (!next) break;
    if (seenCursors.has(next)) {
      throw new Error("The Lighter account lookup cursor repeated.");
    }
    seenCursors.add(next);
    cursor = next;
    if (page === MAX_ACCOUNT_PAGES - 1) {
      throw new Error("The Lighter account lookup exceeded its page limit.");
    }
  }

  const masters = accounts.filter((account) => account.account_type === 0);
  if (
    masters.length !== 1
    || !Number.isSafeInteger(masters[0]!.index)
    || masters[0]!.index <= 0
  ) {
    throw new Error(
      `The selected wallet does not have one uniquely owned Lighter ${environment} master account.`,
    );
  }
  return masters[0]!.index;
}

/** Backward-compatible Core wrapper for existing callers outside onboarding. */
export async function readUniqueLighterCoreMasterAccount(
  client: LighterAccountOwnershipReader,
  walletAddress: string,
): Promise<number> {
  return readUniqueLighterMasterAccount(client, "core", walletAddress);
}
