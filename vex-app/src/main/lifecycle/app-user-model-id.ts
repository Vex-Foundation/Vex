/**
 * Windows Application User Model ID (AUMID).
 *
 * Windows keys taskbar grouping, pinned-shortcut identity AND toast
 * notification identity off the AUMID of the calling process. Electron on
 * win32 defaults it to something derived from the running executable, which
 * for an unpackaged `electron.exe` is NOT the installed app's identity. Two
 * consequences, both user-visible:
 *
 *   - the running app and its pinned shortcut show as two taskbar icons;
 *   - `new Notification(...)` toasts are attributed to the wrong identity,
 *     and on some Windows builds are dropped entirely, because no installed
 *     shortcut matches the AUMID that raised them.
 *
 * `vex.system.notifyTurnComplete` (`ipc/system/notify-turn-complete.ts`) is
 * the notification this exists for, which is why the call site is in the
 * synchronous bootstrap, before any window or IPC handler exists.
 *
 * TIMING, per VS Code's `electron-main/app.ts` (`startup()`): the id is set
 * once, early, guarded by a platform check, and read from the same identity
 * the installer stamps into the shortcut. We adopt that shape.
 *
 * DRIFT GUARD: the value below MUST equal the `appId` key in BOTH
 * `vex-app/electron-builder.yml` and `vex-app/electron-builder.release.yml` -
 * electron-builder writes that exact string as the NSIS shortcut's AUMID, so
 * a mismatch silently reintroduces the split-icon and dropped-toast bugs. The
 * packaged app cannot read those YAML files at runtime (they are build inputs,
 * not shipped resources), so the constant is restated here and the equality is
 * enforced mechanically by `__tests__/app-user-model-id.test.ts`, which parses
 * both files. Changing `appId` is an identity/auto-update contract change; see
 * the locked-appId note in `electron-builder.release.yml`.
 */

/** Must equal `appId` in both electron-builder configs. See the drift guard. */
export const VEX_APP_USER_MODEL_ID = "ai.projectvex.app";

/**
 * The narrow slice of `Electron.App` this needs, injected so the decision is
 * testable without an Electron runtime.
 */
export interface AppUserModelIdHost {
  readonly platform: NodeJS.Platform;
  setAppUserModelId(id: string): void;
}

/**
 * Bind this process to Vex's Windows app identity.
 *
 * No-op off win32: `setAppUserModelId` is a Windows-only Electron API, and
 * calling it elsewhere is meaningless rather than harmful. Returns whether the
 * id was applied, so the caller can log the branch it took.
 */
export function applyAppUserModelId(host: AppUserModelIdHost): boolean {
  if (host.platform !== "win32") {
    return false;
  }
  host.setAppUserModelId(VEX_APP_USER_MODEL_ID);
  return true;
}
