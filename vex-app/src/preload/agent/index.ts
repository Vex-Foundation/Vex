/**
 * `agentBridge` — preload-side composer for vex-agent runtime integration.
 *
 * Imports each agent-domain bridge as a named export, builds a single
 * object that `satisfies VexAgentBridge`, and re-exports it for the
 * root composer (`preload/index.ts`) to fold into `window.vex`.
 *
 * Explicit named imports + `satisfies` keep the surface tight:
 *
 *   - the type guard catches missing namespaces (compile error if a
 *     domain is added to `VexAgentBridge` but not wired here),
 *   - a stray module-level value from any child file cannot become a
 *     bridge namespace by accident,
 *   - call-sites stay grep-friendly (no `export *` in the tree).
 */

import type { VexAgentBridge } from "../../shared/types/bridge/agent/index.js";
import { approvals } from "./approvals.js";
import { chat } from "./chat.js";
import { compaction } from "./compaction.js";
import { engine } from "./engine.js";
import { longMemory } from "./long-memory.js";
import { memory } from "./memory.js";
import { memoryInspector } from "./memory-inspector.js";
import { messages } from "./messages.js";
import { mission } from "./mission.js";
import { models } from "./models.js";
import { images } from "./images.js";
import { portfolio } from "./portfolio.js";
import { projects } from "./projects.js";
import { runtime } from "./runtime.js";
import { sessions } from "./sessions.js";
import { poolsLaunch } from "./pools-launch.js";
import { tokenLaunch } from "./token-launch.js";
import { usage } from "./usage.js";
import { wallets } from "./wallets.js";

export const agentBridge = {
  sessions,
  chat,
  messages,
  runtime,
  mission,
  approvals,
  wallets,
  models,
  usage,
  compaction,
  longMemory,
  memory,
  memoryInspector,
  portfolio,
  projects,
  images,
  poolsLaunch,
  tokenLaunch,
  engine,
} satisfies VexAgentBridge;
