import type { LighterClient, LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import { getLighterFeePolicy } from "@tools/lighter/fee-policy.js";
import type { LighterOrderPreview } from "@tools/lighter/order-preview.js";
import type {
  LighterAccountLimitsResponse,
  LighterAccountResponse,
  LighterEnvironment,
  LighterMarketDetailsResponse,
  LighterOrderBookOrdersResponse,
  LighterSystemConfigResponse,
} from "@tools/lighter/types.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import type { LighterCapitalShareExecuteSnapshot } from "./capital-share-policy.js";
import { lighterOrderMarginFitNeedsLiveReads, readLighterMarginFitDepthBook } from "./margin-fit-guard.js";
import type { LighterOrderFeeClient, LighterOrderFeeReadSnapshot } from "./order-fees.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";

/**
 * SWITCH `LIGHTER_PREVIEW_SINGLE_SNAPSHOT`.
 *
 * ON prepares an order preview and its approval from one snapshot of reads
 * instead of letting the fee, fee-tier, capital-share advisory, margin-fit and
 * capital-admission checks each read again:
 *
 * - the fee check's system config and collector account start beside the
 *   first batch (market details, order book, account), because they are public
 *   reads;
 * - the read-only account auth is minted at most ONCE per prepare, no earlier
 *   than today (after the first batch proved the market), and its
 *   account-limits read is shared by the fee check, the spot fee-tier check,
 *   the capital-share advisory, the margin-fit check and the capital admission;
 * - the capital admission's account and market details, and the margin-fit
 *   check's market details, are the first batch's reads of the same query;
 * - the margin-fit book depth read starts beside the auth, only for an order
 *   that check would read for, and only when an approval will be prepared.
 *
 * Every check still runs in today's order over those values, and each shared
 * read is awaited only where today's code issues it, so a read that fails
 * refuses exactly where, and with exactly what, it refuses today. The user's
 * capital-share row (`lighter_trading_limits`) is still read at each point
 * that reads it today, so the enforcement point reads the share as it stands
 * then. Nothing here signs: the read-only token never reaches `sendTx`, and
 * the post-approval revalidation still re-reads Lighter before any signing.
 * OFF (`false`) is today's path.
 */
export const LIGHTER_PREVIEW_SINGLE_SNAPSHOT = true;

export interface LighterOrderPreviewDeps {
  /** Overrides {@link LIGHTER_PREVIEW_SINGLE_SNAPSHOT}; absent uses the constant. */
  readonly previewSingleSnapshot?: boolean;
}

let configuredDeps: LighterOrderPreviewDeps | null = null;

/** Install preview overrides; the disposer removes only these. */
export function configureLighterOrderPreviewDeps(deps: LighterOrderPreviewDeps | null): () => void {
  configuredDeps = deps;
  return () => {
    if (configuredDeps === deps) configuredDeps = null;
  };
}

export function lighterPreviewSingleSnapshotEnabled(): boolean {
  return configuredDeps?.previewSingleSnapshot ?? LIGHTER_PREVIEW_SINGLE_SNAPSHOT;
}

export type LighterPreviewSnapshotClient =
  LighterOrderFeeClient & Pick<LighterClient, "getOrderBookOrders">;

/** The reads one prepare shares between the checks that need an account auth. */
export type LighterPreviewAccountReads = Pick<LighterOrderFeeReadSnapshot, "resolveAuth" | "accountLimits">;

/**
 * The admission's share of the snapshot, bound to the one preview it was read
 * for. Approval creation uses it only for that preview id and scope.
 */
export interface LighterPreviewAdmissionSnapshot {
  readonly previewId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly reads: LighterCapitalShareExecuteSnapshot;
}

/** Whether a durable preview row is the one this snapshot was read for. */
export function lighterPreviewAdmissionSnapshotFits(
  snapshot: LighterPreviewAdmissionSnapshot,
  preview: Pick<LighterOrderPreviewRow, "previewId" | "environment" | "accountIndex" | "marketIndex">,
): boolean {
  return snapshot.previewId === preview.previewId
    && snapshot.environment === preview.environment
    && snapshot.accountIndex === preview.accountIndex
    && snapshot.marketIndex === preview.marketIndex;
}

interface FeePublicReads {
  readonly systemConfig: () => Promise<LighterSystemConfigResponse>;
  readonly collectorAccount: () => Promise<LighterAccountResponse>;
}

interface SnapshotReads {
  readonly account: LighterAccountResponse;
  readonly marketDetails: LighterMarketDetailsResponse;
  readonly resolveAuth: () => Promise<LighterPrivilegedAccountAuth | null>;
  readonly accountLimits: () => Promise<LighterAccountLimitsResponse>;
  readonly depthBook: () => Promise<LighterOrderBookOrdersResponse>;
}

type SnapshotTimingField =
  | "feeConfigReadMs"
  | "readAuthMs"
  | "accountLimitsReadMs"
  | "marginDepthReadMs";

/**
 * The prepare's snapshot, started beside the first batch. Holds nothing that
 * signs: the only secret-derived value is the read-only auth, which the
 * resolver mints and which is used for account reads only.
 */
export class LighterPreviewSnapshot {
  private readonly startedAtMs = performance.now();
  private readonly durations = new Map<SnapshotTimingField, number>();
  private readonly feeReads: FeePublicReads | null;
  private reads: SnapshotReads | null = null;
  private earlyMarginDepth = false;

  private constructor(
    private readonly client: LighterPreviewSnapshotClient,
    private readonly environment: LighterEnvironment,
    private readonly accountIndex: number,
    private readonly marketIndex: number,
  ) {
    this.feeReads = this.startFeePublicReads();
  }

  /**
   * Called right after the first batch's reads were issued. Starts the fee
   * check's public reads, and nothing that needs an account auth.
   */
  static begin(input: {
    readonly client: LighterPreviewSnapshotClient;
    readonly environment: LighterEnvironment;
    readonly accountIndex: number;
    readonly marketIndex: number;
  }): LighterPreviewSnapshot {
    return new LighterPreviewSnapshot(input.client, input.environment, input.accountIndex, input.marketIndex);
  }

  /**
   * The rest of the snapshot, once the first batch proved the market: the
   * read-only auth is resolved no earlier than the fee check (or, with no fee
   * policy, the capital-share advisory) resolves it today.
   *
   * The auth and the account limits are shared and resolved at most once;
   * each consumer awaits the same promise at its own point, so a failure
   * reaches every consumer with that consumer's own handling. They start
   * eagerly only when the fee check will read them anyway (a fee policy
   * applies); otherwise the first consumer that reads them today starts them.
   */
  afterFirstBatch(input: {
    readonly marketDetails: LighterMarketDetailsResponse;
    readonly account: LighterAccountResponse;
  }): void {
    const { client, environment, accountIndex, marketIndex } = this;
    const resolveAuth = this.sharedRead("readAuthMs", () => resolveLighterReadOnlyAccountAuth(environment, accountIndex));
    const accountLimits = this.sharedRead("accountLimitsReadMs", async () => {
      const auth = await resolveAuth();
      // Unreachable through the checks, which each test both before reading.
      if (auth === null || !client.getAccountLimits) {
        throw new Error("Lighter account limits were requested without a read-only account auth.");
      }
      return client.getAccountLimits(environment, { accountIndex }, auth);
    });
    const depthBook = this.sharedRead("marginDepthReadMs", () => readLighterMarginFitDepthBook(client, environment, marketIndex));
    this.reads = { account: input.account, marketDetails: input.marketDetails, resolveAuth, accountLimits, depthBook };
    if (this.feeReads !== null) {
      // The fee check resolves the auth next and, when it is non-null, reads
      // the limits with it: both start now instead of one after the other.
      void resolveAuth().then((auth) => {
        if (auth !== null) void accountLimits();
      }, () => undefined);
    }
  }

  /** The fee check's reads; absent when the fee check reads nothing, so it runs exactly as today. */
  get fees(): LighterOrderFeeReadSnapshot | undefined {
    const reads = this.requireReads();
    if (this.feeReads === null) return undefined;
    return {
      traderAccount: reads.account,
      systemConfig: this.feeReads.systemConfig,
      collectorAccount: this.feeReads.collectorAccount,
      resolveAuth: reads.resolveAuth,
      accountLimits: reads.accountLimits,
    };
  }

  /** The auth and limits the fee-tier check and the capital-share advisory share. */
  get accountReads(): LighterPreviewAccountReads {
    const reads = this.requireReads();
    return { resolveAuth: reads.resolveAuth, accountLimits: reads.accountLimits };
  }

  /**
   * Start the margin-fit book depth read now when the margin-fit check inside
   * approval creation would read it. `provisional` builds the preview from the
   * same inputs (no fees yet); the fields the check decides on (size, price,
   * notional, reference price, side, type, reduce-only) do not depend on fees.
   * Whatever is decided here, the check decides again on the durable row and
   * starts the read itself if it was not started: this only ever moves a read
   * earlier, never adds or removes one the check makes.
   */
  startMarginFitDepthWhenNeeded(provisional: () => LighterOrderPreview): void {
    const reads = this.requireReads();
    const accountRow = reads.account.accounts.find(
      (row) => (row.index ?? row.account_index) === this.accountIndex,
    );
    if (accountRow === undefined) return;
    let preview: LighterOrderPreview;
    try {
      preview = provisional();
    } catch {
      return;
    }
    const needs = lighterOrderMarginFitNeedsLiveReads(accountRow, {
      marketIndex: Number(preview.identity.marketIndex),
      side: preview.identity.side,
      baseAmountInteger: preview.identity.baseAmountInteger,
      priceInteger: preview.identity.priceInteger,
      orderType: preview.identity.orderType,
      reduceOnly: preview.identity.reduceOnly === "1",
      integratorFees: null,
      previewJson: { ...preview.preview },
    });
    if (!needs) return;
    this.earlyMarginDepth = true;
    void reads.depthBook();
  }

  /** The capital admission's reads, bound to the preview they were read for. */
  admissionFor(previewId: string): LighterPreviewAdmissionSnapshot {
    const reads = this.requireReads();
    return {
      previewId,
      environment: this.environment,
      accountIndex: this.accountIndex,
      marketIndex: this.marketIndex,
      reads: {
        account: reads.account,
        marketDetails: reads.marketDetails,
        resolveAuth: reads.resolveAuth,
        accountLimits: reads.accountLimits,
        depthBook: reads.depthBook,
      },
    };
  }

  /**
   * Numbers only, for `lighter.desk.order_preview_timing`: each shared read's
   * duration from its own start, present only for reads that started.
   */
  timingFields(): Record<string, number> {
    return {
      ...Object.fromEntries(this.durations),
      earlyMarginDepth: this.earlyMarginDepth ? 1 : 0,
    };
  }

  /**
   * The fee check's public reads. Null (start nothing) exactly when the fee
   * check would read nothing: no fee policy for this environment, or a client
   * without the live fee reads, which the fee check refuses or skips before
   * any read. A fee policy that cannot even be resolved also starts nothing,
   * so the fee check throws it at the very point it throws today.
   */
  private startFeePublicReads(): FeePublicReads | null {
    let collectorAccountIndex: number;
    try {
      const policy = getLighterFeePolicy(this.environment);
      if (policy === null) return null;
      collectorAccountIndex = policy.collectorAccountIndex;
    } catch {
      return null;
    }
    const { client, environment } = this;
    if (!client.getAccount || !client.getSystemConfig || !client.getAccountLimits) return null;
    const systemConfig = settledLater(client.getSystemConfig(environment, { fresh: true }));
    const collectorAccount = settledLater(client.getAccount(environment, {
      by: "index",
      value: collectorAccountIndex,
    }, { fresh: true }));
    const startedAtMs = this.startedAtMs;
    void Promise.allSettled([systemConfig, collectorAccount]).then(() => {
      this.durations.set("feeConfigReadMs", Math.round(performance.now() - startedAtMs));
    });
    return { systemConfig: () => systemConfig, collectorAccount: () => collectorAccount };
  }

  /** Started on first use, then the same promise for every consumer. */
  private sharedRead<T>(field: SnapshotTimingField, start: () => Promise<T>): () => Promise<T> {
    let started: Promise<T> | null = null;
    return () => {
      if (started === null) {
        const startedAtMs = performance.now();
        started = settledLater(start());
        void started.then(
          () => this.durations.set(field, Math.round(performance.now() - startedAtMs)),
          () => this.durations.set(field, Math.round(performance.now() - startedAtMs)),
        );
      }
      return started;
    };
  }

  private requireReads(): SnapshotReads {
    if (this.reads === null) {
      throw new Error("The Lighter preview snapshot was used before its first batch completed.");
    }
    return this.reads;
  }
}

/**
 * A read started now and awaited later, maybe never: its rejection is marked
 * handled here so an unconsumed failure is not an unhandled rejection, while
 * every consumer that awaits it still receives that rejection.
 */
function settledLater<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}
