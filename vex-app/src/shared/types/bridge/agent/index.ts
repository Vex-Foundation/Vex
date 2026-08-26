/**
 * `VexAgentBridge` — vex-agent runtime integration surface.
 *
 * Aggregates the 9 agent-side domain bridges: sessions, chat,
 * messages, runtime control plane, mission contract/commands,
 * approvals queue, per-session wallet scope, model catalogue, and
 * usage meter. These flows belong to the `vex-agent/` runtime, even
 * though their handlers live inside Electron main with their own
 * decoupled DB clients.
 *
 * Re-exports each domain interface explicitly (no `export *`) so the
 * surface stays searchable and a stray declaration in a child module
 * cannot grow the public type by accident.
 */

import type { ApprovalsBridge } from "./approvals.js";
import type { ChatBridge } from "./chat.js";
import type { CompactionBridge } from "./compaction.js";
import type { EngineEventsBridge } from "./engine.js";
import type { LongMemoryBridge } from "./long-memory.js";
import type { MemoryBridge } from "./memory.js";
import type { MemoryInspectorBridge } from "./memory-inspector.js";
import type { MessagesBridge } from "./messages.js";
import type { MissionBridge } from "./mission.js";
import type { ModelsBridge } from "./models.js";
import type { BoardIconsBridge } from "./board-icons.js";
import type { BoardLiveBridge } from "./board-live.js";
import type { ImagesBridge } from "./images.js";
import type { PortfolioBridge } from "./portfolio.js";
import type { ProjectsBridge } from "./projects.js";
import type { RuntimeBridge } from "./runtime.js";
import type { SessionsBridge } from "./sessions.js";
import type { PoolsLaunchBridge } from "./pools-launch.js";
import type { TokenLaunchBridge } from "./token-launch.js";
import type { UsageBridge } from "./usage.js";
import type { WalletsBridge } from "./wallets.js";

export type { ApprovalsBridge } from "./approvals.js";
export type { ChatBridge } from "./chat.js";
export type { CompactionBridge } from "./compaction.js";
export type { EngineEventsBridge } from "./engine.js";
export type { LongMemoryBridge } from "./long-memory.js";
export type { MemoryBridge } from "./memory.js";
export type { MemoryInspectorBridge } from "./memory-inspector.js";
export type { MessagesBridge } from "./messages.js";
export type { MissionBridge } from "./mission.js";
export type { ModelsBridge } from "./models.js";
export type { BoardIconsBridge } from "./board-icons.js";
export type { BoardLiveBridge } from "./board-live.js";
export type { ImagesBridge } from "./images.js";
export type { PortfolioBridge } from "./portfolio.js";
export type { ProjectsBridge } from "./projects.js";
export type { RuntimeBridge } from "./runtime.js";
export type { SessionsBridge } from "./sessions.js";
export type { PoolsLaunchBridge } from "./pools-launch.js";
export type { TokenLaunchBridge } from "./token-launch.js";
export type { UsageBridge } from "./usage.js";
export type { WalletsBridge } from "./wallets.js";

export interface VexAgentBridge {
  readonly sessions: SessionsBridge;
  readonly chat: ChatBridge;
  readonly messages: MessagesBridge;
  readonly runtime: RuntimeBridge;
  readonly mission: MissionBridge;
  readonly approvals: ApprovalsBridge;
  readonly wallets: WalletsBridge;
  readonly models: ModelsBridge;
  readonly usage: UsageBridge;
  /** Read-only Track-2 compaction status for the runtime bar (stage 7-1). */
  readonly compaction: CompactionBridge;
  /** Read-only long-term memory + per-session memory lists (7-2a, S9 rewire). */
  readonly longMemory: LongMemoryBridge;
  readonly memory: MemoryBridge;
  /** Read-only memory-manager inspector: candidates / decisions / jobs (S10). */
  readonly memoryInspector: MemoryInspectorBridge;
  /** Read-only dual-scope POSITION portfolio: global inventory / session scope (stage 3). */
  readonly portfolio: PortfolioBridge;
  /**
   * Vex Studio projects (stage P): folder plus backing session. No filesystem
   * capability crosses this boundary - main owns the root and the folder name.
   */
  readonly projects: ProjectsBridge;
  /** Image locker (C2) — the GLOBAL library of pre-staged token-launch images. */
  readonly images: ImagesBridge;
  /**
   * Board token icons - one logo per card of an agent-composed board. Separate
   * from `images` on purpose: no durable state, no signing path, and an
   * absence is the ordinary answer rather than a failure.
   */
  readonly boardIcons: BoardIconsBridge;
  /**
   * Board LIVE - a user-held lease that refreshes an open board's card metrics
   * while the reader holds the toggle on. Owned by one window, never
   * persisted, ended on every exit path, and it never edits the persisted
   * board.
   */
  readonly boardLive: BoardLiveBridge;
  /**
   * Token launch (C5). `preview` and `myLaunches` are live; `submit` and
   * `cancel` are mounted but refuse in words, pending the C0 authorization
   * snapshot and the agent-wake machinery.
   */
  readonly tokenLaunch: TokenLaunchBridge;
  /**
   * pools.fun launches and creator-fee claims (P3). Two stages: `prepare`
   * verifies and returns an opaque fingerprint, `deploy` authorizes exactly
   * that fingerprint.
   */
  readonly poolsLaunch: PoolsLaunchBridge;
  /**
   * Engine -> renderer push events (transcript spine, future runtime
   * deltas, etc.). The namespace mirrors `EV.engine.<topic>` so the
   * channel-name <-> bridge-method mapping stays grep-friendly.
   */
  readonly engine: EngineEventsBridge;
}
