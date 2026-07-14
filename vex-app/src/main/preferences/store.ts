/**
 * Preferences store — atomic read-modify-write to ${userData}/preferences.json.
 *
 * Validated by Zod against shared schema. Never contains secrets (those live
 * in keystore via safeStorage). Default: telemetry OFF, opt-in only.
 *
 * Concurrency: BOTH `update()` and `write()` are serialized through a chain
 * promise. Crucially, `update()` performs read+merge+write entirely INSIDE
 * the queue task — so two concurrent updates do not lose each other's
 * intermediate changes (the second update sees the first one's merged state).
 *
 * Each write uses a unique tmp suffix (process.pid + counter + random) so
 * leftover-file collisions cannot occur even across crashes.
 */

import { app } from "electron";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  defaultPreferences,
  preferencesSchema,
  type Preferences,
} from "@shared/schemas/preferences.js";

class PreferencesStore {
  private cache: Preferences | null = null;
  private readonly listeners = new Set<(preferences: Preferences) => void>();
  /** Serialises ALL operations (load + write + update) to remove read-modify-write races. */
  private chain: Promise<void> = Promise.resolve();
  private writeCounter = 0;

  private get filePath(): string {
    return path.join(app.getPath("userData"), "preferences.json");
  }

  /**
   * Schedule a unit of work behind the operation chain. The task receives no
   * arguments and may return any value; chain itself only tracks completion.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    let resolved!: (value: T) => void;
    let rejected!: (reason: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolved = res;
      rejected = rej;
    });
    const next = this.chain.then(
      async () => {
        try {
          resolved(await task());
        } catch (e) {
          rejected(e);
        }
      },
      async () => {
        try {
          resolved(await task());
        } catch (e) {
          rejected(e);
        }
      }
    );
    // Track only completion (errors do not poison the chain).
    this.chain = next.catch(() => undefined);
    return result;
  }

  load(): Promise<Preferences> {
    return this.enqueue(async () => this.loadInner());
  }

  private async loadInner(): Promise<Preferences> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        await this.writeInner(defaultPreferences);
        return defaultPreferences;
      }
      throw e;
    }
    // JSON parse + Zod validate share the same recovery path: if either step
    // fails, preferences.json is corrupt → write defaults and continue.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.writeInner(defaultPreferences);
      return defaultPreferences;
    }
    const result = preferencesSchema.safeParse(parsed);
    if (!result.success) {
      await this.writeInner(defaultPreferences);
      return defaultPreferences;
    }
    this.cache = result.data;
    return this.cache;
  }

  /**
   * Atomic update: queues a single task that reads the current state,
   * applies the patch, and writes the result. Concurrent updates queue
   * after each other, so each sees the previous one's merged state.
   */
  update(patch: Partial<Preferences>): Promise<Preferences> {
    return this.enqueue(async () => {
      const current = await this.loadInner();
      const next = preferencesSchema.parse({ ...current, ...patch });
      await this.writeInner(next);
      return next;
    });
  }

  /**
   * Main-process observers use this for live, fail-closed policy refreshes.
   * Preferences never cross this listener boundary into renderer code; IPC is
   * still the only renderer-facing path.
   */
  subscribe(listener: (preferences: Preferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(preferences: Preferences): void {
    for (const listener of this.listeners) {
      try {
        listener(preferences);
      } catch {
        // A policy observer must not make a successfully persisted preference
        // write look failed. Its own resolver remains fail-closed on refresh.
      }
    }
  }

  private async writeInner(prefs: Preferences): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.writeCounter += 1;
    const suffix = `${process.pid}.${this.writeCounter}.${crypto.randomBytes(4).toString("hex")}`;
    const tmp = `${this.filePath}.${suffix}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(prefs, null, 2), {
        mode: 0o600,
        encoding: "utf8",
      });
      await fs.rename(tmp, this.filePath);
      this.cache = prefs;
      this.notify(prefs);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }
}

export const preferencesStore = new PreferencesStore();
