/**
 * Fixtures the Studio shell suites share.
 *
 * A HELPER MODULE, deliberately not named `.test.` so the runner does not
 * collect it. It builds real `ProjectDto`s (every required field, so a schema
 * change breaks here once rather than in five suites) and the environment gaps
 * jsdom leaves that the Studio tree touches on import.
 */

import type { VexError } from "@shared/ipc/result.js";
import type { ProjectDto } from "@shared/schemas/projects.js";
import type { StudioArtifactStatus } from "@shared/schemas/studio-installer.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";

let idCounter = 0;

/** A project id with the shape the DTO schema requires (uuid). */
export function projectId(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `9c1b0e8e-0000-4000-8000-${hex}`;
}

export function makeProject(
  overrides: Partial<ProjectDto> = {},
): ProjectDto {
  idCounter += 1;
  const name = overrides.name ?? `project-${String(idCounter)}`;
  return {
    id: overrides.id ?? projectId(idCounter),
    name,
    slug: name,
    rootPath: name,
    displayPath: `~/Vex/projects/${name}`,
    permission: "restricted",
    agents: [],
    wallets: { evm: null, solana: null },
    scopeVersion: 1,
    backingSessionId: "44444444-4444-4444-8444-444444444444",
    files: {
      lastRenderedScopeVersion: 1,
      generatorFingerprint: "test",
      artifacts: [],
    },
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
    ...overrides,
  };
}

export function makeArtifact(
  state: StudioArtifactStatus["state"],
): StudioArtifactStatus {
  return {
    kind: "agents-md",
    agentId: null,
    path: "AGENTS.md",
    state,
    detail: null,
  };
}

/**
 * A complete, redacted `VexError`.
 *
 * Built in full rather than cast: the whole point of the shape is that a
 * renderer surface can read `retryable`, `userActionable` and the correlation
 * id, and a partial double would let a component that reads one of them pass a
 * test it should fail.
 */
export function makeError(message: string): VexError {
  return {
    code: "internal.unexpected",
    domain: "internal",
    message,
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId: "00000000-0000-4000-8000-000000000000",
  };
}

export function makeHostStatus(
  overrides: Partial<StudioHostStatus> = {},
): StudioHostStatus {
  return {
    state: "running",
    cause: null,
    connectionCount: 2,
    maxConnections: 16,
    atCapacity: false,
    ...overrides,
  };
}

/**
 * jsdom implements neither `matchMedia` (xterm calls it while constructing) nor
 * `ResizeObserver`. Both are needed merely to IMPORT the Studio tree, so this
 * runs in `beforeAll` and asserts nothing.
 */
export function installStudioDomStubs(): void {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
  // The two casts below are jsdom BOUNDARY escapes, and they are the same ones
  // `features/appShell/__tests__/AppShell/shell-sidebar.test.tsx` already makes
  // for the same two gaps. The invariant each guards: the stub is installed
  // ONLY when the API is absent, and it is a test-environment shim for a
  // browser API jsdom does not implement - never a stand-in for product code.
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
      ResizeObserverStub as unknown as typeof ResizeObserver;
  }
  // jsdom implements no scrolling, so `Element.prototype.scrollIntoView` is
  // absent. The project creator calls it when a refusal names a field
  // (`projects.slug_taken` names the name input) - real behaviour in a browser,
  // a missing method here.
  const element = Element.prototype as unknown as {
    scrollIntoView?: (arg?: unknown) => void;
  };
  if (typeof element.scrollIntoView !== "function") {
    element.scrollIntoView = function scrollIntoViewStub(): void {};
  }
  // The `<dialog>` modal methods are NOT stubbed here any more. This file's
  // stub set the `open` attribute and ran no focusing steps, so every
  // `document.activeElement` assertion in the Studio suites passed for dialogs
  // a browser opened somewhere else. `test/dialog-modal-polyfill.ts`, installed
  // for every renderer suite from `test/setup.ts`, runs the real focusing
  // steps and owns that gap now.
}
