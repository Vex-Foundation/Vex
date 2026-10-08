import type { LighterAccountLimitsResponse, LighterAccountResponse, LighterEnvironment } from "@tools/lighter/types.js";
import type { LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import logger from "@utils/logger.js";
import type { LighterIntegratorFees } from "@tools/lighter/fee-policy.js";
import { getLighterFeePolicy } from "@tools/lighter/fee-policy.js";
import type { LighterOrderFeeClient, LighterOrderFeeReadSnapshot } from "./order-fees.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";
import { lighterDeskPrewarmEnabled } from "./preview-snapshot.js";
import { lifecycleRead } from "./lifecycle-parallel-reads.js";
import {
  recordLighterDeskPrewarmAccountLimits,
  recordLighterDeskPrewarmFeeConfig,
  takeLighterDeskPrewarmAccountLimits,
  takeLighterDeskPrewarmFeeConfig,
} from "./desk-prewarm.js";

/** Desk close/OCO preparation only. Execution never consumes this snapshot. */
export const LIGHTER_DESK_PREPARATION_FEE_SNAPSHOT = true;

export interface LighterDeskPreparationFeeDeps {
  readonly deskPreparationFeeSnapshot?: boolean;
}

let configuredDeps: LighterDeskPreparationFeeDeps | null = null;

export function configureLighterDeskPreparationFeeDeps(deps: LighterDeskPreparationFeeDeps | null): () => void {
  configuredDeps = deps;
  return () => { if (configuredDeps === deps) configuredDeps = null; };
}

export function beginLighterDeskPreparationFees(input: {
  readonly deskPreparation: boolean | undefined;
  readonly client: LighterOrderFeeClient;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}): LighterDeskPreparationFees | undefined {
  if (input.deskPreparation !== true
    || !(configuredDeps?.deskPreparationFeeSnapshot ?? LIGHTER_DESK_PREPARATION_FEE_SNAPSHOT)) return undefined;
  return new LighterDeskPreparationFees(input.client, input.environment, input.accountIndex, lighterDeskPrewarmEnabled());
}

/** Only public fee reads start early. Auth still starts at the existing fee check. */
export class LighterDeskPreparationFees {
  private readonly reads: {
    readonly collectorAccountIndex: number;
    readonly systemConfig: LighterOrderFeeReadSnapshot["systemConfig"];
    readonly collectorAccount: LighterOrderFeeReadSnapshot["collectorAccount"];
    readonly readAtMs: number | null;
  } | null;
  private readonly startedAtMs = performance.now();
  private readonly hits: Record<string, number> = {};
  private limits: { readonly response: LighterAccountLimitsResponse; readonly atMs: number } | null = null;

  constructor(
    private readonly client: LighterOrderFeeClient,
    private readonly environment: LighterEnvironment,
    private readonly accountIndex: number,
    private readonly prewarm: boolean,
  ) {
    this.reads = this.startPublicReads();
  }

  /** The caller's own fresh batch account is the fee trader account. */
  feesFor(account: LighterAccountResponse): LighterOrderFeeReadSnapshot | undefined {
    const reads = this.reads;
    if (reads === null) return undefined;
    const { client, environment, accountIndex } = this;
    // No token survives this prepare, and the old fee check starts it first.
    let auth: Promise<LighterPrivilegedAccountAuth | null> | null = null;
    const resolveAuth = () => {
      auth ??= lifecycleRead(true, () => resolveLighterReadOnlyAccountAuth(environment, accountIndex))();
      return auth;
    };
    return {
      traderAccount: account,
      systemConfig: reads.systemConfig,
      collectorAccount: reads.collectorAccount,
      resolveAuth,
      accountLimits: async () => {
        const resolvedAuth = await resolveAuth();
        if (resolvedAuth === null || !client.getAccountLimits) {
          throw new Error("Account limits require the preparation's resolved read-only auth.");
        }
        const warm = this.prewarm ? takeLighterDeskPrewarmAccountLimits(environment, accountIndex, Date.now()) : null;
        this.hits.prewarmAccountLimitsHit = warm === null ? 0 : 1;
        if (warm !== null) return warm;
        const atMs = Date.now();
        const response = await client.getAccountLimits(environment, { accountIndex }, resolvedAuth);
        this.limits = { response, atMs };
        return response;
      },
    };
  }

  /** Cache only the bounded fee inputs whose full fee check passed. */
  async keepAfterPassingFeeCheck(fees: LighterIntegratorFees | null): Promise<void> {
    const reads = this.reads;
    if (!this.prewarm || fees === null || reads === null) return;
    try {
      if (reads.readAtMs !== null) {
        const [systemConfig, collectorAccount] = await Promise.all([reads.systemConfig(), reads.collectorAccount()]);
        recordLighterDeskPrewarmFeeConfig({
          environment: this.environment, collectorAccountIndex: reads.collectorAccountIndex,
          systemConfig, collectorAccount, atMs: reads.readAtMs,
        });
      }
      if (this.limits !== null) {
        recordLighterDeskPrewarmAccountLimits({
          environment: this.environment, accountIndex: this.accountIndex,
          response: this.limits.response, atMs: this.limits.atMs,
        });
      }
    } catch {
      // Cache recording is best effort after the fee check already passed.
    }
  }

  timingFields(): Record<string, number> {
    return { feeSnapshotMs: Math.round(performance.now() - this.startedAtMs), deskPrewarm: this.prewarm ? 1 : 0, ...this.hits };
  }

  log(action: "close_position" | "oco"): void {
    try {
      logger.info("lighter.desk.preparation_fee_timing", { action, ...this.timingFields() });
    } catch {
      // Diagnostics cannot change preparation.
    }
  }

  private startPublicReads(): LighterDeskPreparationFees["reads"] {
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
    const warm = this.prewarm ? takeLighterDeskPrewarmFeeConfig(environment, collectorAccountIndex, Date.now()) : null;
    this.hits.prewarmFeeConfigHit = 0;
    const getSystemConfig = client.getSystemConfig.bind(client);
    const getAccount = client.getAccount.bind(client);
    const startFresh = (): NonNullable<LighterDeskPreparationFees["reads"]> => ({
      collectorAccountIndex, readAtMs: Date.now(),
      systemConfig: lifecycleRead(true, () => getSystemConfig(environment, { fresh: true })),
      collectorAccount: lifecycleRead(true, () => getAccount(environment, { by: "index", value: collectorAccountIndex }, { fresh: true })),
    });
    if (warm === null) return startFresh();
    let selected: NonNullable<LighterDeskPreparationFees["reads"]> | null = null;
    const select = () => {
      if (selected === null) {
        const current = takeLighterDeskPrewarmFeeConfig(environment, collectorAccountIndex, Date.now());
        this.hits.prewarmFeeConfigHit = current === null ? 0 : 1;
        selected = current === null ? startFresh() : {
          collectorAccountIndex, readAtMs: null,
          systemConfig: () => Promise.resolve(current.systemConfig),
          collectorAccount: () => Promise.resolve(current.collectorAccount),
        };
      }
      return selected;
    };
    return {
      collectorAccountIndex,
      get readAtMs() { return selected?.readAtMs ?? null; },
      systemConfig: () => select().systemConfig(),
      collectorAccount: () => select().collectorAccount(),
    };
  }
}
