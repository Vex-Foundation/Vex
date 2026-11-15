/**
 * The vault screen's words to Kimm (owner decision 2026-11-15): `UnlockScreen` tells her panel what happens beside
 * her (typing, the password shown or hidden, a failed or a successful unlock) through `kimm-lock-signals.ts`, and
 * this spec proves that nothing of the password reaches her code.
 *
 * Asserted, with a SENTINEL password typed, shown, hidden, refused and then accepted:
 *   1. her panel hears only the five words, each call one argument, in the order the person acted;
 *   2. nothing she is handed (the words, her props) carries the password, any part of it, or its length;
 *   3. no module of hers imports the vault screen, the password field or the secrets bridge, and none reads an
 *      input's value.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { SecretsUnlockResult } from "@shared/schemas/secrets.js";
import type { KimmLockSignals } from "../../../components/vex/kimm/kimm-lock-signals.js";

const SENTINEL = "vex-sentinel-MASTER-PASSWORD-DO-NOT-LEAK-0xC0FFEE";

const heard = vi.hoisted(() => ({ calls: [] as unknown[][], props: [] as Record<string, unknown>[] }));

vi.mock("../../../components/vex/kimm/KimmPanel.js", async () => {
  const { useEffect } = await import("react");
  return {
    KimmPanel: (props: Record<string, unknown> & { readonly signals?: KimmLockSignals }) => {
      heard.props.push(props);
      const signals = props.signals;
      useEffect(() => {
        if (signals === undefined) return undefined;
        return signals.subscribe((...args: unknown[]) => {
          heard.calls.push(args);
        });
      }, [signals]);
      return <div data-vex-area="kimm-panel" />;
    },
  };
});

const mockUnlock = vi.fn<(input: { password: string }) => Promise<Result<SecretsUnlockResult>>>();

vi.mock("../../../stores/uiStore.js", () => ({
  useUiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      unlockReturnView: "appShell",
      setCurrentView: () => undefined,
      beginUnlockCurtain: () => undefined,
      vexOpenChat: true,
    }),
}));

const { UnlockScreen } = await import("../UnlockScreen.js");

beforeEach(() => {
  heard.calls = [];
  heard.props = [];
  mockUnlock.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      secrets: { unlock: mockUnlock, resetToFreshVault: vi.fn() },
      support: { openLogsFolder: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

afterEach(() => {
  cleanup();
});

/** Every string and number reachable from a value (functions skipped), for the leak scan. */
function scalars(value: unknown, seen = new Set<unknown>()): Array<string | number> {
  if (typeof value === "string" || typeof value === "number") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((item) => scalars(item, seen));
}

describe("UnlockScreen's words to Kimm", () => {
  it("tells her only the five words, never the password, any part of it or its length", async () => {
    mockUnlock
      .mockResolvedValueOnce({ ok: false, error: { code: "secrets.invalid_password", message: "Wrong password." } } as never)
      .mockResolvedValueOnce({ ok: true, value: {} } as never);
    const view = render(<UnlockScreen />);
    const field = view.getByLabelText(/Master password/i) as HTMLInputElement;
    for (let i = 1; i <= 6; i += 1) {
      field.value = SENTINEL.slice(0, i * 8);
      fireEvent.input(field);
    }
    fireEvent.click(view.getByRole("button", { name: /show password/i }));
    fireEvent.click(view.getByRole("button", { name: /hide password/i }));
    fireEvent.submit(field.form as HTMLFormElement);
    await waitFor(() => expect(mockUnlock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(heard.calls.flat()).toContain("failed"));
    field.value = SENTINEL;
    fireEvent.input(field);
    fireEvent.submit(field.form as HTMLFormElement);
    await waitFor(() => expect(heard.calls.flat()).toContain("unlocked"));

    const words = heard.calls.map((args) => {
      expect(args).toHaveLength(1);
      return args[0];
    });
    expect(words).toEqual([
      "typing",
      "typing",
      "typing",
      "typing",
      "typing",
      "typing",
      "shown",
      "hidden",
      "failed",
      "typing",
      "unlocked",
    ]);
    const handed = [...scalars(heard.calls), ...heard.props.flatMap((props) => scalars(props))];
    for (const item of handed) {
      if (typeof item === "string") {
        expect(item.includes("sentinel")).toBe(false);
        expect(SENTINEL.includes(item) && item.length > 3).toBe(false);
      } else {
        expect(item).not.toBe(SENTINEL.length);
      }
    }
  });

  it("keeps her modules away from the vault: no import of the screen, the field or the bridge, no input value read", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const kimmDir = path.join(here, "..", "..", "..", "components", "vex", "kimm");
    const sources = readdirSync(kimmDir).filter((name) => /\.tsx?$/.test(name));
    expect(sources.length).toBeGreaterThan(10);
    for (const name of sources) {
      const source = readFileSync(path.join(kimmDir, name), "utf8");
      expect(source, name).not.toMatch(/from\s+["'][^"']*(?:features\/secrets|PasswordField|secrets)[^"']*["']/);
      expect(source, name).not.toMatch(/window\.vex\b/);
      expect(source, name).not.toMatch(/HTMLInputElement|\.value\b(?!\s*:)/);
    }
  });
});
