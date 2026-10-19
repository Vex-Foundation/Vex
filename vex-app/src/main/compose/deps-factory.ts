/**
 * Builds the production `RenderDeps` object for vex-app's main process.
 * Wraps Node's `crypto` for `randomBytes` / `randomUUID` / base64url
 * encoding, and uses Electron `safeStorage` for at-rest encryption.
 */

import { app } from "electron";
import path from "node:path";
import { productionPgPasswordDeps } from "../runtime/secrets/production-deps.js";
import type { RenderDeps } from "./render.js";

function getResourcesDir(): string {
  // The compiled main bundle lands at `vex-app/dist/main/index.js`, so
  // `import.meta.dirname` is `vex-app/dist/main`. Two levels up reaches
  // `vex-app/`, where `resources/compose/` lives. The previous
  // three-level path escaped vex-app entirely and tried to read
  // `/mnt/x/Vex/resources/compose/...` (M5 hotfix).
  return app.isPackaged
    ? path.join(process.resourcesPath, "compose")
    : path.resolve(import.meta.dirname, "../../resources/compose");
}

export function buildRenderDeps(): RenderDeps {
  return {
    ...productionPgPasswordDeps(),
    resourcesDir: getResourcesDir(),
  };
}
