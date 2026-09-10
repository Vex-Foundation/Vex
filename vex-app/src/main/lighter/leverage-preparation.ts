/**
 * Reads and PROPOSAL issuance for a user-originated Lighter leverage change.
 *
 * THE CONTRACT IS PREPARE/CONFIRM, and the reason is worth stating once here.
 * The renderer's input is a SELECTOR: wallet, market, leverage, mode. Main
 * resolves everything else against live state, freezes it into an immutable
 * `lighter_leverage_intents` row in state `proposed`, and returns that row as
 * the DTO the confirmation modal renders. Confirm then carries only the
 * proposal id. A renderer therefore cannot hand main the terms it wants signed,
 * and the terms the human read are the terms the executor revalidates.
 *
 * OWNERSHIP IS TWO CHECKS, NOT ONE, exactly as `fee-authorization-preparation.ts`
 * does it: the live account's `l1_address` must equal the requested wallet AND
 * the registered API key must equal the saved credential's public key. Matching
 * the key alone proves a key is ours; it does not prove the account belongs to
 * this wallet.
 *
 * The requested wallet is verified against the install's OWN resolved Lighter
 * accounts (`listLighterOnboardingResolvedAccounts`), never taken on the
 * renderer's word and never silently replaced by the primary wallet: this
 * section is per wallet, as the Points card is.
 */

import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { app } from "electron";
import {
  getLighterClient,
  type LighterClient,
} from "@tools/lighter/client.js";
import {
  initialMarginFractionToLeverageDisplay,
  leverageToInitialMarginFraction,
  LIGHTER_MARGIN_MODE_WIRE,
  marginModeFromWire,
  positionInitialMarginFractionToProviderScale,
  type LighterMarginMode,
} from "@tools/lighter/margin-fraction.js";
import { createLighterApiKeyGeneratorBinary } from "@tools/lighter/signer-binary-adapter.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { loadLighterTradingSecretMaterial } from "@tools/lighter/trading-secret.js";
import type {
  LighterAccount,
  LighterAccountPosition,
  LighterMarketDetail,
} from "@tools/lighter/types.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import * as intents from "@vex-agent/db/repos/lighter-leverage-intents.js";
import { ErrorCodes, VexError } from "../../../../src/errors.js";
import type {
  LighterLeverageOverview,
  LighterLeverageProposal,
  PrepareLighterLeverageInput,
} from "@shared/schemas/lighter-trading-limits.js";
import {
  createUnlockedVaultLighterTradingSecretReader,
  listUnlockedManagedLighterTradingCredentialScopes,
} from "../secrets/lighter-trading-credential.js";
import { isSecretSessionUnlocked } from "../secrets/session.js";

/** How long the human has to read the card and press Confirm. */
export const LIGHTER_LEVERAGE_CONSENT_WINDOW_MS = 2 * 60_000;

/**
 * The provider's own market-index space is 0..254, so the catalogue can never
 * exceed this many rows. A BOUND THAT REPORTS ITSELF: anything past it is
 * counted in `omitted` with its reason rather than silently dropped.
 */
const OVERVIEW_MARKET_LIMIT = 255;

/** How many unresolved intents the card can offer to reconcile at once. */
const OVERVIEW_UNRESOLVED_LIMIT = 50;

export interface LighterLeverageSelector {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly marketId: number;
  readonly leverage: number | "max";
  readonly marginMode: LighterMarginMode;
}

export interface LighterLeverageAccountSetup {
  readonly environment: LighterEnvironment;
  /** Lowercase, as stored. `getAddress` is applied where a human reads it. */
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly publicKey: string;
  readonly account: LighterAccount;
}

export interface LighterLeveragePreparationDeps {
  readonly client: Pick<
    LighterClient,
    "getAccount" | "getApiKeys" | "getMarketDetails" | "getAllMarketDetails"
  >;
  /** The durable owner of "which leverage changes still need reconciling". */
  readonly listUnresolvedIntents: typeof intents.listUnresolved;
  readonly listResolvedAccounts: () => Promise<
    readonly { environment: LighterEnvironment; walletAddress: string; accountIndex: number }[]
  >;
  readonly listCredentialScopes: typeof listUnlockedManagedLighterTradingCredentialScopes;
  readonly derivePublicKey: (
    reference: LighterTradingCredentialVaultReference,
  ) => Promise<string>;
  readonly vaultUnlocked: () => boolean;
  readonly now: () => number;
}

export function defaultLighterLeveragePreparationDeps(): LighterLeveragePreparationDeps {
  return {
    client: getLighterClient(),
    listUnresolvedIntents: intents.listUnresolved,
    listResolvedAccounts: async () => {
      const { listLighterOnboardingResolvedAccounts } = await import(
        "@vex-agent/db/repos/lighter-onboarding-workflows.js"
      );
      const listed = await listLighterOnboardingResolvedAccounts({});
      return listed.rows.map((row) => ({
        environment: row.environment,
        walletAddress: row.walletAddress,
        accountIndex: row.accountIndex,
      }));
    },
    listCredentialScopes: listUnlockedManagedLighterTradingCredentialScopes,
    derivePublicKey: async (reference) => {
      const secret = await loadLighterTradingSecretMaterial(
        reference,
        createUnlockedVaultLighterTradingSecretReader(),
      );
      return createLighterApiKeyGeneratorBinary({
        allowBinaryPathOverride: !app.isPackaged,
      }).derivePublicKey(secret);
    },
    vaultUnlocked: isSecretSessionUnlocked,
    now: Date.now,
  };
}

export function leverageRefusal(message: string, hint?: string): VexError {
  return new VexError(ErrorCodes.LIGHTER_LEVERAGE_REFUSED, message, hint);
}

/**
 * Resolve the account this wallet owns on this deployment and prove BOTH halves
 * of ownership. Every refusal names what did not match, because "unexpected
 * error" is not a thing a person can act on.
 */
export async function readLighterLeverageAccountSetup(
  input: { readonly environment: LighterEnvironment; readonly walletAddress: string },
  deps: LighterLeveragePreparationDeps = defaultLighterLeveragePreparationDeps(),
): Promise<LighterLeverageAccountSetup> {
  const walletAddress = normalizeWallet(input.walletAddress);
  const accountIndex = await resolveOwnAccountIndex(input.environment, walletAddress, deps);
  const scopes = deps
    .listCredentialScopes(input.environment)
    .filter((scope) => scope.accountIndex === accountIndex);
  if (scopes.length !== 1) {
    throw leverageRefusal(
      "This wallet has no single saved Lighter trading key on this machine.",
      "Complete Lighter trading-key setup for this wallet before changing leverage.",
    );
  }
  const apiKeyIndex = scopes[0]!.apiKeyIndex;
  const reference: LighterTradingCredentialVaultReference = {
    kind: "encrypted_vault_reference",
    environment: input.environment,
    accountIndex,
    apiKeyIndex,
    vaultCredentialId: defaultLighterTradingVaultCredentialId({
      environment: input.environment,
      accountIndex,
      apiKeyIndex,
    }),
  };
  const [keys, accountResponse, publicKey] = await Promise.all([
    deps.client.getApiKeys(input.environment, { accountIndex, apiKeyIndex }, { fresh: true }),
    deps.client.getAccount(
      input.environment,
      { by: "index", value: accountIndex, activeOnly: false },
      { fresh: true },
    ),
    deps.derivePublicKey(reference),
  ]);
  if (
    keys.code !== 200
    || keys.api_keys.length !== 1
    || keys.api_keys[0]!.account_index !== accountIndex
    || keys.api_keys[0]!.api_key_index !== apiKeyIndex
  ) {
    throw leverageRefusal("The active Lighter trading key could not be verified.");
  }
  if (publicKey !== keys.api_keys[0]!.public_key.toLowerCase().replace(/^0x/, "")) {
    throw leverageRefusal(
      "The local trading key does not match the key registered on this Lighter account.",
      "Re-register the Lighter trading key for this wallet before changing leverage.",
    );
  }
  const account = exactOwnedAccount(accountResponse, accountIndex, walletAddress);
  return {
    environment: input.environment,
    walletAddress,
    accountIndex,
    apiKeyIndex,
    publicKey,
    account,
  };
}

/** The account read whose `l1_address` must be this wallet. Ownership half two. */
export function exactOwnedAccount(
  response: Awaited<ReturnType<LighterClient["getAccount"]>>,
  accountIndex: number,
  walletAddress: string,
): LighterAccount {
  const matches = response.accounts.filter(
    (account) => (account.index ?? account.account_index) === accountIndex,
  );
  if (
    response.code !== 200
    || matches.length !== 1
    || getAddress(matches[0]!.l1_address ?? "0x") !== getAddress(walletAddress)
  ) {
    throw leverageRefusal(
      "The live Lighter account does not belong to this wallet.",
      "Reload Settings; the account this wallet owns may have changed on Lighter.",
    );
  }
  return matches[0]!;
}

export async function getLighterLeverageOverview(
  input: { readonly environment: LighterEnvironment; readonly walletAddress: string },
  deps: LighterLeveragePreparationDeps = defaultLighterLeveragePreparationDeps(),
): Promise<LighterLeverageOverview> {
  const walletAddress = normalizeWallet(input.walletAddress);
  const accountIndex = await resolveOwnAccountIndex(input.environment, walletAddress, deps);
  // `activeOnly: false` on purpose: a market whose leverage was set but which
  // holds no position still has a row, and the active-only read hides exactly
  // those markets (the SDK's own parameter documentation says so).
  const accountResponse = await deps.client.getAccount(
    input.environment,
    { by: "index", value: accountIndex, activeOnly: false },
    { fresh: true },
  );
  const account = exactOwnedAccount(accountResponse, accountIndex, walletAddress);
  const positions = Array.isArray(account.positions) ? account.positions : [];
  const positionByMarket = new Map<number, LighterAccountPosition>();
  for (const row of positions) positionByMarket.set(row.market_id, row);

  // THE CATALOGUE, not the position list. A market the account has never traded
  // has no position row, and building the list from positions alone made those
  // markets unselectable: on a fresh account that is every market, and on the
  // owner's account it was BTC. One `orderBookDetails` call without a market id
  // returns every market, so the catalogue costs one request, not one per row.
  const catalogue = await deps.client.getAllMarketDetails(
    input.environment,
    { filter: "perp" },
    { fresh: true },
  );
  if (catalogue.code !== 200) {
    throw leverageRefusal("Lighter did not return its live market list.");
  }
  const perps = [...catalogue.order_book_details]
    .filter((row) => row.market_type === "perp" && row.status === "active")
    .sort((left, right) => left.market_id - right.market_id);
  const selected = perps.slice(0, OVERVIEW_MARKET_LIMIT);

  const markets: LighterLeverageOverview["markets"][number][] = [];
  let unreadable = 0;
  for (const detail of selected) {
    const position = positionByMarket.get(detail.market_id) ?? null;
    let row: LighterLeverageOverview["markets"][number];
    try {
      // `currentTerms` and `marketMinimum` refuse a market whose margin
      // fractions are missing or out of range. A row Vex cannot state honestly
      // is one row missing, reported in `omitted`, not a failed card.
      const minFraction = marketMinimum(detail);
      row = {
        marketId: detail.market_id,
        symbol: detail.symbol,
        current: currentTerms(position, detail),
        max: {
          initialMarginFraction: minFraction,
          leverageDisplay: initialMarginFractionToLeverageDisplay(minFraction),
        },
        openPosition: openPosition(position),
      };
    } catch {
      unreadable += 1;
      continue;
    }
    markets.push(row);
  }

  const omittedCount = Math.max(0, perps.length - selected.length) + unreadable;
  const unresolvedRows = await deps.listUnresolvedIntents({
    environment: input.environment,
    accountIndex,
    limit: OVERVIEW_UNRESOLVED_LIMIT,
  });
  return {
    environment: input.environment,
    walletAddress: getAddress(walletAddress),
    accountIndex,
    vaultState: deps.vaultUnlocked() ? "unlocked" : "locked",
    markets,
    omitted: {
      count: omittedCount,
      reason:
        omittedCount === 0
          ? "Every active perpetual market on Lighter is listed."
          : `${omittedCount} active perpetual market(s) are not listed: Lighter did not report leverage limits Vex can state for them, or the catalogue exceeded ${OVERVIEW_MARKET_LIMIT} markets. Their leverage is unchanged and can still be read on Lighter.`,
    },
    // Durable, so Reconcile survives closing Settings and restarting Vex.
    unresolved: unresolvedRows.flatMap((row) => {
      const executionState = unresolvedExecutionState(row.executionState);
      return executionState === null
        ? []
        : [{
            intentId: row.intentId,
            marketId: row.marketIndex,
            symbol: row.observedBefore.symbol,
            executionState,
            updatedAt: row.updatedAt.toISOString(),
          }];
    }),
  };
}

type UnresolvedExecutionState = LighterLeverageOverview["unresolved"][number]["executionState"];

/**
 * The repo's unresolved listing is already scoped to these states by its own
 * SQL; this narrows the wide row type through a real membership check rather
 * than asserting it, so a state added to one list and not the other is dropped
 * from the card instead of reaching the renderer unvalidated.
 */
function unresolvedExecutionState(
  value: intents.LighterLeverageExecutionState,
): UnresolvedExecutionState | null {
  const allowed: readonly string[] = intents.LIGHTER_LEVERAGE_UNRESOLVED_STATES;
  return allowed.includes(value) ? (value as UnresolvedExecutionState) : null;
}

/**
 * Resolve, freeze and persist the proposal the human will confirm.
 *
 * Returns `already_configured` WITHOUT a row when the live terms already equal
 * the target: nothing is signed, so nothing is audited.
 */
export async function prepareLighterLeverage(
  selector: PrepareLighterLeverageInput,
  deps: LighterLeveragePreparationDeps = defaultLighterLeveragePreparationDeps(),
): Promise<LighterLeverageProposal> {
  const setup = await readLighterLeverageAccountSetup(selector, deps);
  const detail = await readPerpMarketDetail(selector.environment, selector.marketId, deps);
  const minFraction = marketMinimum(detail);
  const targetFraction =
    selector.leverage === "max" ? minFraction : leverageToInitialMarginFraction(selector.leverage);
  if (targetFraction < minFraction) {
    throw leverageRefusal(
      `${detail.symbol} allows at most ${initialMarginFractionToLeverageDisplay(minFraction)}x leverage on Lighter.`,
      "Choose a leverage at or below that maximum.",
    );
  }
  const targetMode = LIGHTER_MARGIN_MODE_WIRE[selector.marginMode];
  const position =
    (Array.isArray(setup.account.positions) ? setup.account.positions : []).find(
      (row) => row.market_id === selector.marketId,
    ) ?? null;
  const current = currentTerms(position, detail);

  if (
    current.initialMarginFraction === targetFraction
    && LIGHTER_MARGIN_MODE_WIRE[current.marginMode] === targetMode
  ) {
    return { kind: "already_configured", current };
  }

  // A stale proposal for this market would otherwise hold the live-market
  // uniqueness index and refuse a fresh Apply the user is entitled to.
  await intents.expireStaleProposals(selector.environment, setup.accountIndex);
  const live = await intents.findLive(
    selector.environment,
    setup.accountIndex,
    selector.marketId,
  );
  if (live !== null) {
    throw leverageRefusal(
      live.executionState === "proposed"
        ? `A leverage change for ${detail.symbol} is already waiting for your confirmation.`
        : `A leverage change for ${detail.symbol} is still unresolved on this account.`,
      live.executionState === "proposed"
        ? "Confirm or cancel it, or wait for it to expire."
        : "Reconcile it from Settings before starting another change.",
    );
  }

  const expiresAt = new Date(deps.now() + LIGHTER_LEVERAGE_CONSENT_WINDOW_MS);
  const row = await intents.create({
    intentId: `lighter-leverage-${randomUUID()}`,
    environment: selector.environment,
    walletAddress: setup.walletAddress,
    accountIndex: setup.accountIndex,
    apiKeyIndex: setup.apiKeyIndex,
    marketIndex: selector.marketId,
    requestedInitialMarginFraction: targetFraction,
    requestedMarginMode: targetMode,
    observedBefore: {
      symbol: detail.symbol,
      currentInitialMarginFraction: current.initialMarginFraction,
      currentMarginMode: LIGHTER_MARGIN_MODE_WIRE[current.marginMode],
      currentSource: current.source,
      marketMinInitialMarginFraction: minFraction,
      openPositionSize: position?.position ?? "0",
      openPositionSide: positionSide(position),
      publicKey: setup.publicKey,
      liquidationPrice: position?.liquidation_price ?? null,
      openOrderCount: position?.open_order_count ?? 0,
    },
    expiresAt,
  });

  return {
    kind: "proposal",
    proposalId: row.intentId,
    environment: row.environment,
    walletAddress: getAddress(row.walletAddress),
    accountIndex: row.accountIndex,
    apiKeyIndex: row.apiKeyIndex,
    marketId: row.marketIndex,
    symbol: detail.symbol,
    current,
    target: {
      initialMarginFraction: targetFraction,
      leverageDisplay: initialMarginFractionToLeverageDisplay(targetFraction),
      marginMode: selector.marginMode,
    },
    marketMinInitialMarginFraction: minFraction,
    openPosition: openPosition(position),
    observations: {
      liquidationPrice: normalizeDecimal(position?.liquidation_price ?? null),
      openOrders: { count: position?.open_order_count ?? 0 },
    },
    expiresAt: expiresAt.toISOString(),
  };
}

/** Live perpetual market detail, or a named refusal. Spot has no leverage. */
export async function readPerpMarketDetail(
  environment: LighterEnvironment,
  marketId: number,
  deps: LighterLeveragePreparationDeps,
): Promise<LighterMarketDetail> {
  const response = await deps.client.getMarketDetails(
    environment,
    { marketId, filter: "all" },
    { fresh: true },
  );
  if (response.code !== 200) {
    throw leverageRefusal("Lighter did not return this market's live details.");
  }
  const spot = response.spot_order_book_details.filter((row) => row.market_id === marketId);
  if (spot.length > 0) {
    throw leverageRefusal(
      "Leverage applies to perpetual markets only; this is a spot market.",
    );
  }
  const perp = response.order_book_details.filter((row) => row.market_id === marketId);
  if (perp.length !== 1) {
    throw leverageRefusal(`Lighter returned no single perpetual market ${marketId}.`);
  }
  const detail = perp[0]!;
  if (detail.market_type !== "perp") {
    throw leverageRefusal("Leverage applies to perpetual markets only.");
  }
  if (detail.status !== "active") {
    throw leverageRefusal(`${detail.symbol} is not active on Lighter right now.`);
  }
  return detail;
}

/** The market's minimum initial margin fraction, which is its MAXIMUM leverage. */
export function marketMinimum(detail: LighterMarketDetail): number {
  const value = detail.min_initial_margin_fraction;
  if (!Number.isInteger(value) || value === undefined || value < 1 || value > 10_000) {
    throw leverageRefusal(
      `Lighter did not report a usable leverage limit for ${detail.symbol}.`,
    );
  }
  return value;
}

/**
 * The "from" terms. A market with no position row has never had leverage set on
 * this account, so its own default applies; the source travels with the number
 * so the card can say which it is.
 */
export function currentTerms(
  position: LighterAccountPosition | null,
  detail: LighterMarketDetail,
): LighterLeverageOverview["markets"][number]["current"] {
  if (position !== null) {
    const fraction = positionInitialMarginFractionToProviderScale(
      position.initial_margin_fraction,
    );
    return {
      initialMarginFraction: fraction,
      leverageDisplay: initialMarginFractionToLeverageDisplay(fraction),
      marginMode: marginModeFromWire(position.margin_mode),
      source: "position_row",
    };
  }
  const fallback = detail.default_initial_margin_fraction;
  if (!Number.isInteger(fallback) || fallback === undefined || fallback < 1 || fallback > 10_000) {
    throw leverageRefusal(
      `Lighter did not report a default margin fraction for ${detail.symbol}.`,
    );
  }
  return {
    initialMarginFraction: fallback,
    leverageDisplay: initialMarginFractionToLeverageDisplay(fallback),
    marginMode: "cross",
    source: "market_default",
  };
}

export function positionSide(position: LighterAccountPosition | null): "long" | "short" | "none" {
  if (position === null) return "none";
  const size = position.position.trim();
  if (!/^-?\d+(\.\d+)?$/.test(size) || Number.parseFloat(size) === 0) return "none";
  return position.sign < 0 ? "short" : "long";
}

function openPosition(
  position: LighterAccountPosition | null,
): { readonly size: string; readonly side: "long" | "short" } | null {
  const side = positionSide(position);
  if (position === null || side === "none") return null;
  return { size: position.position.trim(), side };
}

function normalizeDecimal(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : null;
}

async function resolveOwnAccountIndex(
  environment: LighterEnvironment,
  walletAddress: string,
  deps: LighterLeveragePreparationDeps,
): Promise<number> {
  const rows = (await deps.listResolvedAccounts()).filter(
    (row) =>
      row.environment === environment
      && row.walletAddress.toLowerCase() === walletAddress,
  );
  if (rows.length !== 1) {
    throw leverageRefusal(
      "This wallet has no single Lighter account registered through Vex on this deployment.",
      "Complete Lighter onboarding for this wallet first.",
    );
  }
  return rows[0]!.accountIndex;
}

function normalizeWallet(walletAddress: string): string {
  const lowered = walletAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lowered)) {
    throw leverageRefusal("A Lighter leverage change requires an EVM wallet address.");
  }
  return lowered;
}
