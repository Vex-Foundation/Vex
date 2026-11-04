/**
 * The real local runtime and data move screens on the stage, which the
 * approved plates do not draw but which reuse the system check's rows
 * (docs/design/H3-DESKTOP.md section 4.9): the runtime's start stopped on an
 * offline model download (its status rows, Try again and the logs), and a
 * previous release's data waiting to be moved (Move my data, Start fresh).
 */

import type { NativeRuntimeStatus } from "@shared/schemas/system.js";
import type { RuntimeMigrationStatus } from "@shared/schemas/runtime-migration.js";
import { RuntimeBootstrap } from "../../../features/runtime/RuntimeBootstrap.js";
import { RuntimeMigration } from "../../../features/runtime/RuntimeMigration.js";
import { stageVexEnd } from "../../../components/onboarding/stage-vex.js";
import { ok } from "../bridge.js";
import { fixture } from "../mark.js";
import type { HarnessStage } from "./types.js";

const OFFLINE: NativeRuntimeStatus = fixture("stage.runtimeStatus", {
  seq: 3,
  phase: "failed",
  step: "model",
  kind: "offline",
  message: "getaddrinfo ENOTFOUND huggingface.co",
});

const PENDING: RuntimeMigrationStatus = fixture("stage.runtimeMigrationStatus", {
  kind: "pending",
  resumeStep: null,
  lastFailure: null,
});

export const runtimeOffline: HarnessStage = {
  id: "runtime-offline",
  title: "Local runtime: the model download stopped offline",
  view: "runtimeBootstrap",
  Screen: RuntimeBootstrap,
  answers: () => ({ system: { runtimeStatus: () => ok(OFFLINE) } }),
  setup: stageVexEnd,
  ready: '[data-vex-screen="runtimeBootstrap"] [data-runtime-failure]',
};

export const runtimeMovePending: HarnessStage = {
  id: "runtime-move",
  title: "Move your data: the previous release's data waits to be moved",
  view: "runtimeMigration",
  Screen: RuntimeMigration,
  answers: () => ({ system: { runtimeMigrationStatus: () => ok(PENDING) } }),
  setup: stageVexEnd,
  ready: '[data-vex-screen="runtimeMigration"] [data-migration-state="pending"]',
};
