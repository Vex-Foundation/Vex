/**
 * Indexify manifest — the Solana social-index ("stacks") platform.
 *
 * A CUSTODIAL API venue: the linked Indexify account holds the funds in an
 * Indexify-embedded wallet, and every mutation is an authenticated server-side
 * API call, never a locally signed transaction. Public reads need no key;
 * account reads and all three mutations are gated on INDEXIFY_API_KEY via
 * `requiresEnv`.
 *
 * DELIBERATELY NOT HERE, and never to be added without its own design pass:
 * key export, USDC withdrawal, account deletion (the provider's own docs show
 * its response leaking the private key), profile/social/notification writes,
 * stack close / allocation edits, rebalance, and limit orders. The provider
 * client (`src/tools/indexify/client.ts`) wraps none of them, so a handler
 * cannot be miswired into one.
 */

import type { ProtocolToolManifest } from "../types.js";
import { INDEXIFY_DISCOVER_TOOLS } from "./manifests/discover.js";
import { INDEXIFY_CREATORS_TOOLS } from "./manifests/creators.js";
import { INDEXIFY_ACCOUNT_TOOLS } from "./manifests/account.js";
import { INDEXIFY_TRADE_TOOLS } from "./manifests/trade.js";
import { INDEXIFY_CREATE_TOOLS } from "./manifests/create.js";

export const INDEXIFY_TOOLS: readonly ProtocolToolManifest[] = [
  ...INDEXIFY_DISCOVER_TOOLS,
  ...INDEXIFY_CREATORS_TOOLS,
  ...INDEXIFY_ACCOUNT_TOOLS,
  ...INDEXIFY_TRADE_TOOLS,
  ...INDEXIFY_CREATE_TOOLS,
];
