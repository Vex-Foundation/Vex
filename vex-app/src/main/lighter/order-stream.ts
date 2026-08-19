import { Buffer } from "node:buffer";

import { LIGHTER_ENDPOINTS, type LighterEnvironment } from "@tools/lighter/constants.js";
import type { LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import type {
  LighterAccountStreamMessage,
} from "@tools/lighter/types.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import {
  validateLighterAccountAllOrdersStreamMessage,
  validateLighterAccountAllPositionsStreamMessage,
  validateLighterAccountAllTradesStreamMessage,
} from "@tools/lighter/validation.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import * as lighterOrderLifecycleIntentsRepo from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import { reconcileLighterAccountStreamMessage } from "@vex-agent/tools/protocols/lighter/account-stream-reconciliation.js";
import { resnapshotLighterOrderAccount } from "@vex-agent/tools/protocols/lighter/order-stream-resnapshot.js";
import { log } from "../logger/index.js";
import {
  getSecretSessionStatus,
  onSecretSessionLifecycle,
} from "../secrets/session.js";

export const LIGHTER_ORDER_STREAM_DISCOVERY_INTERVAL_MS = 5_000;
export const LIGHTER_ORDER_STREAM_HANDSHAKE_TIMEOUT_MS = 15_000;
export const LIGHTER_ORDER_STREAM_KEEPALIVE_INTERVAL_MS = 60_000;
export const LIGHTER_ORDER_STREAM_STALE_AFTER_MS = 150_000;
export const LIGHTER_ORDER_STREAM_AUTH_ROTATION_MS = 8 * 60_000;
export const LIGHTER_ORDER_STREAM_RESNAPSHOT_MIN_INTERVAL_MS = 60_000;
export const LIGHTER_ORDER_STREAM_MAX_FRAME_BYTES = 1_048_576;
export const LIGHTER_ORDER_STREAM_MAX_QUEUED_FRAMES = 100;

const WS_OPEN = 1;

export interface LighterOrderStreamTarget {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly credential: LighterTradingCredentialVaultReference;
}

export interface LighterOrderStreamSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
}

export interface LighterOrderStreamSupervisorDeps {
  readonly listTargets: () => Promise<readonly LighterOrderStreamTarget[]>;
  readonly resolveAuth: (
    credential: LighterTradingCredentialVaultReference,
  ) => Promise<LighterPrivilegedAccountAuth | null>;
  readonly createSocket: (url: string) => LighterOrderStreamSocket;
  readonly reconcile: (
    environment: LighterEnvironment,
    accountIndex: number,
    message: LighterAccountStreamMessage,
  ) => Promise<unknown>;
  readonly resnapshot: (
    environment: LighterEnvironment,
    accountIndex: number,
    auth: LighterPrivilegedAccountAuth,
  ) => Promise<unknown>;
  readonly isVaultUnlocked: () => boolean;
  readonly onVaultLifecycle: (listener: (state: "unlocked" | "locked") => void) => () => void;
  readonly now: () => number;
  readonly random: () => number;
  readonly diagnostic: (
    event: string,
    detail: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

interface AccountWatcher {
  readonly key: string;
  target: LighterOrderStreamTarget;
  active: boolean;
  socket: LighterOrderStreamSocket | null;
  pendingAuthToken: string | null;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  keepaliveTimer: ReturnType<typeof setTimeout> | null;
  rotationTimer: ReturnType<typeof setTimeout> | null;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  lastReceivedAt: number;
  lastSnapshotAt: number;
  queuedFrames: number;
  processing: Promise<void>;
}

export function defaultLighterOrderStreamSupervisorDeps(
  resolveAuth: LighterOrderStreamSupervisorDeps["resolveAuth"],
): LighterOrderStreamSupervisorDeps {
  return {
    listTargets: listLighterOrderStreamTargets,
    resolveAuth,
    createSocket: (url) => new WebSocket(url) as unknown as LighterOrderStreamSocket,
    reconcile: (environment, accountIndex, message) =>
      reconcileLighterAccountStreamMessage(environment, accountIndex, message),
    resnapshot: (environment, accountIndex, auth) =>
      resnapshotLighterOrderAccount(environment, accountIndex, auth),
    isVaultUnlocked: () => getSecretSessionStatus().unlocked,
    onVaultLifecycle: onSecretSessionLifecycle,
    now: Date.now,
    random: Math.random,
    diagnostic: (event, detail) => {
      if (event.endsWith("failed") || event.endsWith("invalid") || event.endsWith("closed")) {
        log.warn(event, detail);
      } else {
        log.info(event, detail);
      }
    },
  };
}

export function installLighterOrderStreamSupervisor(
  options: {
    readonly resolveAuth: LighterOrderStreamSupervisorDeps["resolveAuth"];
    readonly deps?: LighterOrderStreamSupervisorDeps;
  },
): () => void {
  const supervisor = new LighterOrderStreamSupervisor(
    options.deps ?? defaultLighterOrderStreamSupervisorDeps(options.resolveAuth),
  );
  return supervisor.start();
}

export class LighterOrderStreamSupervisor {
  private readonly watchers = new Map<string, AccountWatcher>();
  private stopped = false;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryRunning = false;
  private unsubscribeVaultLifecycle: (() => void) | null = null;

  constructor(private readonly deps: LighterOrderStreamSupervisorDeps) {}

  start(): () => void {
    this.unsubscribeVaultLifecycle = this.deps.onVaultLifecycle((state) => {
      if (state === "locked") {
        if (this.discoveryTimer !== null) clearTimeout(this.discoveryTimer);
        this.discoveryTimer = null;
        this.closeAll("vault_locked");
      } else {
        this.scheduleDiscovery(0);
      }
    });
    this.scheduleDiscovery(0);
    return () => this.stop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.discoveryTimer !== null) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
    this.unsubscribeVaultLifecycle?.();
    this.unsubscribeVaultLifecycle = null;
    this.closeAll("runtime_stopped");
  }

  private scheduleDiscovery(delayMs: number): void {
    if (this.stopped || this.discoveryTimer !== null) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      void this.discoverTargets();
    }, delayMs);
  }

  private async discoverTargets(): Promise<void> {
    if (this.stopped || this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      if (!this.deps.isVaultUnlocked()) {
        this.closeAll("vault_locked");
        return;
      }
      const targets = await this.deps.listTargets();
      if (this.stopped || !this.deps.isVaultUnlocked()) {
        this.closeAll("vault_locked");
        return;
      }
      const desired = new Map(targets.map((target) => [targetKey(target), target]));
      for (const [key, watcher] of this.watchers) {
        const target = desired.get(key);
        if (target === undefined) {
          this.deactivateWatcher(watcher, "no_watchable_orders");
          this.watchers.delete(key);
        } else {
          const credentialChanged = !sameCredential(watcher.target.credential, target.credential);
          watcher.target = target;
          if (credentialChanged) {
            this.restartWatcher(watcher, "credential_changed");
          } else {
            this.scheduleConnect(watcher, 0);
          }
        }
      }
      for (const [key, target] of desired) {
        if (this.watchers.has(key)) continue;
        const watcher = createWatcher(key, target);
        this.watchers.set(key, watcher);
        this.scheduleConnect(watcher, 0);
      }
    } catch {
      this.deps.diagnostic("lighter.order_stream.discovery_failed", {
        watcherCount: this.watchers.size,
      });
    } finally {
      this.discoveryRunning = false;
      if (this.deps.isVaultUnlocked()) {
        this.scheduleDiscovery(LIGHTER_ORDER_STREAM_DISCOVERY_INTERVAL_MS);
      }
    }
  }

  private scheduleConnect(watcher: AccountWatcher, delayMs?: number): void {
    if (
      this.stopped
      || !watcher.active
      || watcher.socket !== null
      || watcher.reconnectTimer !== null
      || !this.deps.isVaultUnlocked()
    ) {
      return;
    }
    const delay = delayMs ?? reconnectDelayMs(watcher.reconnectAttempt, this.deps.random());
    watcher.reconnectAttempt += 1;
    watcher.reconnectTimer = setTimeout(() => {
      watcher.reconnectTimer = null;
      void this.connect(watcher);
    }, delay);
  }

  private async connect(watcher: AccountWatcher): Promise<void> {
    if (this.stopped || !watcher.active || !this.deps.isVaultUnlocked()) return;
    let auth: LighterPrivilegedAccountAuth | null = null;
    try {
      auth = await this.deps.resolveAuth(watcher.target.credential);
      if (
        auth === null
        || auth.accountIndex !== watcher.target.accountIndex
        || auth.token.trim().length === 0
      ) {
        this.deps.diagnostic("lighter.order_stream.auth_failed", scopeDetail(watcher.target));
        this.scheduleConnect(watcher);
        return;
      }
      if (this.stopped || !watcher.active || !this.deps.isVaultUnlocked()) return;
      const socket = this.deps.createSocket(
        LIGHTER_ENDPOINTS[watcher.target.environment].readonlyWsUrl,
      );
      watcher.socket = socket;
      watcher.pendingAuthToken = auth.token;
      watcher.lastReceivedAt = this.deps.now();
      watcher.handshakeTimer = setTimeout(() => {
        watcher.handshakeTimer = null;
        this.deps.diagnostic("lighter.order_stream.handshake_failed", scopeDetail(watcher.target));
        this.restartWatcher(watcher, "handshake_timeout");
      }, LIGHTER_ORDER_STREAM_HANDSHAKE_TIMEOUT_MS);
      socket.addEventListener("message", (event) => this.handleMessage(watcher, socket, event));
      socket.addEventListener("close", () => this.handleClose(watcher, socket));
      socket.addEventListener("error", () => this.handleSocketError(watcher, socket));
    } catch {
      watcher.pendingAuthToken = null;
      disconnectWatcherSocket(watcher, "connect_failed");
      this.deps.diagnostic("lighter.order_stream.connect_failed", scopeDetail(watcher.target));
      this.scheduleConnect(watcher);
    }
  }

  private handleMessage(
    watcher: AccountWatcher,
    socket: LighterOrderStreamSocket,
    event: unknown,
  ): void {
    if (watcher.socket !== socket || !watcher.active) return;
    const data = readStringMessageData(event);
    if (data === null || Buffer.byteLength(data, "utf8") > LIGHTER_ORDER_STREAM_MAX_FRAME_BYTES) {
      this.deps.diagnostic("lighter.order_stream.frame_invalid", scopeDetail(watcher.target));
      this.restartWatcher(watcher, "invalid_frame");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data) as unknown;
    } catch {
      this.deps.diagnostic("lighter.order_stream.frame_invalid", scopeDetail(watcher.target));
      this.restartWatcher(watcher, "invalid_json");
      return;
    }
    const type = readMessageType(raw);
    watcher.lastReceivedAt = this.deps.now();
    if (type === "connected") {
      if (watcher.handshakeTimer !== null) clearTimeout(watcher.handshakeTimer);
      watcher.handshakeTimer = null;
      this.subscribe(watcher, socket);
      return;
    }
    if (type === "ping") {
      this.sendIfOpen(socket, JSON.stringify({ type: "pong" }));
      return;
    }
    if (type === "pong") return;
    if (!isAccountEvidenceMessageType(type)) return;

    let message: LighterAccountStreamMessage;
    try {
      message = validateAccountEvidenceMessage(raw, type, watcher.target.accountIndex);
    } catch {
      this.deps.diagnostic("lighter.order_stream.frame_invalid", scopeDetail(watcher.target));
      this.restartWatcher(watcher, "invalid_account_evidence");
      return;
    }
    watcher.reconnectAttempt = 0;
    watcher.queuedFrames += 1;
    if (watcher.queuedFrames > LIGHTER_ORDER_STREAM_MAX_QUEUED_FRAMES) {
      this.deps.diagnostic("lighter.order_stream.backlog_closed", scopeDetail(watcher.target));
      this.restartWatcher(watcher, "consumer_backlog");
      return;
    }
    watcher.processing = watcher.processing
      .then(async () => {
        await this.deps.reconcile(
          watcher.target.environment,
          watcher.target.accountIndex,
          message,
        );
      })
      .catch(() => {
        this.deps.diagnostic("lighter.order_stream.reconcile_failed", scopeDetail(watcher.target));
      })
      .finally(() => {
        watcher.queuedFrames = Math.max(0, watcher.queuedFrames - 1);
      });
  }

  private subscribe(watcher: AccountWatcher, socket: LighterOrderStreamSocket): void {
    const token = watcher.pendingAuthToken;
    watcher.pendingAuthToken = null;
    const subscriptions = token === null ? [] : [
      {
        type: "subscribe",
        channel: `account_all_orders/${watcher.target.accountIndex}`,
        auth: token,
      },
      {
        type: "subscribe",
        channel: `account_all_trades/${watcher.target.accountIndex}`,
      },
      {
        type: "subscribe",
        channel: `account_all_positions/${watcher.target.accountIndex}`,
      },
    ];
    if (
      subscriptions.length !== 3
      || subscriptions.some((subscription) =>
        !this.sendIfOpen(socket, JSON.stringify(subscription)))
    ) {
      this.restartWatcher(watcher, "subscribe_failed");
      return;
    }
    this.deps.diagnostic("lighter.order_stream.subscribed", scopeDetail(watcher.target));
    this.scheduleKeepalive(watcher);
    watcher.rotationTimer = setTimeout(() => {
      watcher.rotationTimer = null;
      this.restartWatcher(watcher, "auth_rotation");
    }, LIGHTER_ORDER_STREAM_AUTH_ROTATION_MS);
    void this.maybeResnapshot(watcher, { token, accountIndex: watcher.target.accountIndex });
  }

  private scheduleKeepalive(watcher: AccountWatcher): void {
    if (!watcher.active || watcher.socket === null || watcher.keepaliveTimer !== null) return;
    watcher.keepaliveTimer = setTimeout(() => {
      watcher.keepaliveTimer = null;
      const socket = watcher.socket;
      if (socket === null) return;
      if (this.deps.now() - watcher.lastReceivedAt > LIGHTER_ORDER_STREAM_STALE_AFTER_MS) {
        this.deps.diagnostic("lighter.order_stream.stale_closed", scopeDetail(watcher.target));
        this.restartWatcher(watcher, "stale_connection");
        return;
      }
      if (!this.sendIfOpen(socket, JSON.stringify({ type: "ping" }))) {
        this.restartWatcher(watcher, "keepalive_failed");
        return;
      }
      this.scheduleKeepalive(watcher);
    }, LIGHTER_ORDER_STREAM_KEEPALIVE_INTERVAL_MS);
  }

  private async maybeResnapshot(
    watcher: AccountWatcher,
    auth?: LighterPrivilegedAccountAuth,
  ): Promise<void> {
    if (!watcher.active || watcher.socket === null || !this.deps.isVaultUnlocked()) return;
    const elapsed = this.deps.now() - watcher.lastSnapshotAt;
    if (elapsed < LIGHTER_ORDER_STREAM_RESNAPSHOT_MIN_INTERVAL_MS) {
      if (watcher.snapshotTimer === null) {
        watcher.snapshotTimer = setTimeout(() => {
          watcher.snapshotTimer = null;
          void this.maybeResnapshot(watcher);
        }, LIGHTER_ORDER_STREAM_RESNAPSHOT_MIN_INTERVAL_MS - elapsed);
      }
      return;
    }
    watcher.lastSnapshotAt = this.deps.now();
    try {
      const snapshotAuth = auth ?? await this.deps.resolveAuth(watcher.target.credential);
      if (
        snapshotAuth === null
        || snapshotAuth.accountIndex !== watcher.target.accountIndex
        || !watcher.active
        || watcher.socket === null
        || !this.deps.isVaultUnlocked()
      ) {
        return;
      }
      await this.deps.resnapshot(
        watcher.target.environment,
        watcher.target.accountIndex,
        snapshotAuth,
      );
      this.deps.diagnostic("lighter.order_stream.resnapshot_complete", scopeDetail(watcher.target));
    } catch {
      this.deps.diagnostic("lighter.order_stream.resnapshot_failed", scopeDetail(watcher.target));
    }
  }

  private handleClose(watcher: AccountWatcher, socket: LighterOrderStreamSocket): void {
    if (watcher.socket !== socket) return;
    watcher.socket = null;
    watcher.pendingAuthToken = null;
    clearWatcherSocketTimers(watcher);
    if (!this.stopped && watcher.active && this.deps.isVaultUnlocked()) {
      this.deps.diagnostic("lighter.order_stream.closed", scopeDetail(watcher.target));
      this.scheduleConnect(watcher);
    }
  }

  private handleSocketError(watcher: AccountWatcher, socket: LighterOrderStreamSocket): void {
    if (watcher.socket !== socket) return;
    this.deps.diagnostic("lighter.order_stream.socket_failed", scopeDetail(watcher.target));
    this.restartWatcher(watcher, "socket_error");
  }

  private restartWatcher(watcher: AccountWatcher, reason: string): void {
    disconnectWatcherSocket(watcher, reason);
    if (!this.stopped && watcher.active && this.deps.isVaultUnlocked()) {
      this.scheduleConnect(watcher);
    }
  }

  private sendIfOpen(socket: LighterOrderStreamSocket, data: string): boolean {
    if (socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private deactivateWatcher(watcher: AccountWatcher, reason: string): void {
    watcher.active = false;
    if (watcher.reconnectTimer !== null) clearTimeout(watcher.reconnectTimer);
    watcher.reconnectTimer = null;
    if (watcher.snapshotTimer !== null) clearTimeout(watcher.snapshotTimer);
    watcher.snapshotTimer = null;
    disconnectWatcherSocket(watcher, reason);
  }

  private closeAll(reason: string): void {
    for (const watcher of this.watchers.values()) this.deactivateWatcher(watcher, reason);
    this.watchers.clear();
  }
}

export async function listLighterOrderStreamTargets(): Promise<readonly LighterOrderStreamTarget[]> {
  const [orderRows, lifecycleRows] = await Promise.all([
    lighterOrderExecutionIntentsRepo.listStreamWatchable(undefined, undefined, 500),
    lighterOrderLifecycleIntentsRepo.listStreamWatchable(undefined, undefined, 500),
  ]);
  const targets = new Map<string, LighterOrderStreamTarget>();
  for (const row of [...orderRows, ...lifecycleRows]) {
    const credential = row.credentialRefJson;
    if (
      credential.environment !== row.environment
      || credential.accountIndex !== row.accountIndex
      || credential.apiKeyIndex !== row.apiKeyIndex
    ) {
      continue;
    }
    const target: LighterOrderStreamTarget = {
      environment: row.environment,
      accountIndex: row.accountIndex,
      credential,
    };
    targets.set(targetKey(target), target);
  }
  return [...targets.values()];
}

function createWatcher(key: string, target: LighterOrderStreamTarget): AccountWatcher {
  return {
    key,
    target,
    active: true,
    socket: null,
    pendingAuthToken: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    handshakeTimer: null,
    keepaliveTimer: null,
    rotationTimer: null,
    snapshotTimer: null,
    lastReceivedAt: 0,
    lastSnapshotAt: 0,
    queuedFrames: 0,
    processing: Promise.resolve(),
  };
}

function targetKey(target: Pick<LighterOrderStreamTarget, "environment" | "accountIndex">): string {
  return `${target.environment}:${target.accountIndex}`;
}

function sameCredential(
  left: LighterTradingCredentialVaultReference,
  right: LighterTradingCredentialVaultReference,
): boolean {
  return (
    left.environment === right.environment
    && left.accountIndex === right.accountIndex
    && left.apiKeyIndex === right.apiKeyIndex
    && left.vaultCredentialId === right.vaultCredentialId
  );
}

function scopeDetail(target: LighterOrderStreamTarget): Readonly<Record<string, string | number>> {
  return {
    environment: target.environment,
    accountIndex: target.accountIndex,
  };
}

function reconnectDelayMs(attempt: number, random: number): number {
  const base = Math.min(60_000, 1_000 * (2 ** Math.min(attempt, 6)));
  const jitter = 0.8 + Math.max(0, Math.min(1, random)) * 0.4;
  return Math.floor(base * jitter);
}

function readMessageType(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = (raw as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

function isAccountEvidenceMessageType(type: string | null): type is LighterAccountStreamMessage["type"] {
  return type === "update/account_all_orders"
    || type === "subscribed/account_all_trades"
    || type === "update/account_all_trades"
    || type === "subscribed/account_all_positions"
    || type === "update/account_all_positions";
}

function validateAccountEvidenceMessage(
  raw: unknown,
  type: LighterAccountStreamMessage["type"],
  accountIndex: number,
): LighterAccountStreamMessage {
  if (type === "update/account_all_orders") {
    return validateLighterAccountAllOrdersStreamMessage(raw, accountIndex);
  }
  if (type === "subscribed/account_all_trades" || type === "update/account_all_trades") {
    return validateLighterAccountAllTradesStreamMessage(raw, accountIndex);
  }
  return validateLighterAccountAllPositionsStreamMessage(raw, accountIndex);
}

function readStringMessageData(event: unknown): string | null {
  if (event === null || typeof event !== "object") return null;
  const data = (event as { readonly data?: unknown }).data;
  return typeof data === "string" ? data : null;
}

function clearWatcherSocketTimers(watcher: AccountWatcher): void {
  if (watcher.handshakeTimer !== null) clearTimeout(watcher.handshakeTimer);
  if (watcher.keepaliveTimer !== null) clearTimeout(watcher.keepaliveTimer);
  if (watcher.rotationTimer !== null) clearTimeout(watcher.rotationTimer);
  watcher.handshakeTimer = null;
  watcher.keepaliveTimer = null;
  watcher.rotationTimer = null;
}

function disconnectWatcherSocket(watcher: AccountWatcher, reason: string): void {
  const socket = watcher.socket;
  watcher.socket = null;
  watcher.pendingAuthToken = null;
  clearWatcherSocketTimers(watcher);
  if (socket !== null) {
    try {
      socket.close(1000, reason.slice(0, 120));
    } catch {
      // The capability reference is already dropped; close is best-effort.
    }
  }
}
