import { describe, expect, it } from "vitest";
import { nativeRuntimeStatusSchema, type NativeRuntimeStatus } from "@shared/schemas/system.js";
import { ReplayBus } from "../../events/event-bus.js";
import {
  createNativeRuntimeProgress,
  PROGRESS_INTERVAL_MS,
  SPEED_WINDOW_MS,
} from "../native/native-runtime-progress.js";

const TOTAL = 333_590_944;

function tracker() {
  let clock = 0;
  const published: NativeRuntimeStatus[] = [];
  const progress = createNativeRuntimeProgress({
    publish: (status) => published.push(nativeRuntimeStatusSchema.parse(status)),
    now: () => clock,
  });
  const download = (receivedBytes: number, at: number): void => {
    clock = at;
    progress.model({ phase: "downloading", receivedBytes, totalBytes: TOTAL, sourceIndex: 0 });
  };
  return { progress, published, download, phases: () => published.map((s) => s.phase) };
}

describe("native runtime progress", () => {
  it("is idle until a start begins", () => {
    const { progress, published } = tracker();
    expect(progress.current()).toEqual({ seq: 0, phase: "idle" });
    expect(published).toEqual([]);
  });

  it("walks a first run through every step, with a growing seq", () => {
    const { progress, published, download } = tracker();
    progress.begin(true);
    progress.modelChecking();
    download(1_000, 10);
    download(TOTAL, 20);
    progress.embeddingsStarting();
    progress.ready();
    expect(published.map(({ seq: _seq, ...state }) => state)).toEqual([
      { phase: "postgres", initializing: true },
      { phase: "model", model: { state: "checking" } },
      { phase: "model", model: { state: "downloading", receivedBytes: 1_000, totalBytes: TOTAL, bytesPerSecond: null } },
      { phase: "model", model: { state: "downloading", receivedBytes: TOTAL, totalBytes: TOTAL, bytesPerSecond: null } },
      { phase: "embeddings" },
      { phase: "ready" },
    ]);
    expect(published.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.current()).toEqual(published.at(-1));
  });

  it("reports a model on disk that must be re-hashed as verifying", () => {
    const { progress, published } = tracker();
    progress.begin(false);
    progress.modelChecking();
    progress.model({ phase: "verifying", bytes: TOTAL });
    expect(published.at(-1)).toMatchObject({ phase: "model", model: { state: "verifying" } });
    expect(published[0]).toMatchObject({ phase: "postgres", initializing: false });
  });

  it("publishes download chunks at most every interval, and always the last byte", () => {
    const { progress, published, download } = tracker();
    progress.begin(false);
    progress.modelChecking();
    download(100, 1_000);
    for (let at = 1_001; at < 1_000 + PROGRESS_INTERVAL_MS; at += 10) download(at, at);
    expect(published).toHaveLength(3);
    download(5_000, 1_000 + PROGRESS_INTERVAL_MS);
    expect(published).toHaveLength(4);
    download(TOTAL, 1_000 + PROGRESS_INTERVAL_MS + 1);
    expect(published).toHaveLength(5);
  });

  it("measures speed over whole windows of this attempt, never counting resumed bytes", () => {
    const { progress, published, download } = tracker();
    progress.begin(false);
    progress.modelChecking();
    // A resumed download: 200 MB were already on disk.
    download(200_000_000, 0);
    download(204_000_000, SPEED_WINDOW_MS / 2);
    expect(published.at(-1)).toMatchObject({ model: { bytesPerSecond: null } });
    download(210_000_000, SPEED_WINDOW_MS);
    expect(published.at(-1)).toMatchObject({ model: { receivedBytes: 210_000_000, bytesPerSecond: 10_000_000 } });
    download(212_000_000, SPEED_WINDOW_MS * 2);
    expect(published.at(-1)).toMatchObject({ model: { bytesPerSecond: 2_000_000 } });
  });

  it("restarts the speed window when a source sends the file from the beginning", () => {
    const { progress, published, download } = tracker();
    progress.begin(false);
    progress.modelChecking();
    download(50_000_000, 0);
    download(1_000, 100);
    download(3_001_000, 100 + SPEED_WINDOW_MS);
    expect(published.at(-1)).toMatchObject({ model: { bytesPerSecond: 3_000_000 } });
  });

  it("names the step that failed, and keeps an attempt's first failure", () => {
    const { progress, published } = tracker();
    progress.begin(false);
    progress.modelChecking();
    progress.fail("disk_full", "Not enough disk space for the embeddings model (1 bytes free).");
    progress.fail("failed", "the outcome that followed");
    expect(published.at(-1)).toMatchObject({
      phase: "failed",
      step: "model",
      kind: "disk_full",
      message: "Not enough disk space for the embeddings model (1 bytes free).",
    });
    expect(published.filter((s) => s.phase === "failed")).toHaveLength(1);
  });

  it.each([
    ["postgres", () => {}],
    ["embeddings", (p: ReturnType<typeof tracker>["progress"]) => {
      p.modelChecking();
      p.embeddingsStarting();
    }],
  ] as const)("defaults the failed step to the current one (%s)", (step, advance) => {
    const { progress } = tracker();
    progress.begin(false);
    advance(progress);
    progress.fail("failed", "boom");
    expect(progress.current()).toMatchObject({ phase: "failed", step });
  });

  it("starts a retry from the database step again", () => {
    const { progress, phases } = tracker();
    progress.begin(true);
    progress.fail("foreign_listener", "Another database answers on this port.");
    progress.begin(true);
    expect(progress.current()).toMatchObject({ phase: "postgres", initializing: true });
    expect(phases()).toEqual(["postgres", "failed", "postgres"]);
  });

  it("re-checking a ready runtime publishes only how it ends", () => {
    const { progress, published } = tracker();
    progress.begin(false);
    progress.ready();
    const before = published.length;
    progress.begin(false);
    progress.modelChecking();
    progress.embeddingsStarting();
    progress.ready();
    expect(published).toHaveLength(before);
    expect(progress.current().phase).toBe("ready");

    progress.begin(false);
    progress.fail("unhealthy", "The local database stopped and did not recover: x", "postgres");
    expect(published.at(-1)).toMatchObject({ phase: "failed", step: "postgres", kind: "unhealthy" });
  });

  it("still shows a download that a re-check of a ready runtime needs", () => {
    const { progress, download, phases } = tracker();
    progress.begin(false);
    progress.ready();
    progress.begin(false);
    progress.modelChecking();
    download(1_000, 0);
    progress.embeddingsStarting();
    progress.ready();
    expect(phases()).toEqual(["postgres", "ready", "model", "ready"]);
  });

  it("replays the latest status to a late in-process subscriber through its bus", () => {
    const bus = new ReplayBus<NativeRuntimeStatus>();
    const progress = createNativeRuntimeProgress({ publish: (status) => bus.emit(status) });
    progress.begin(true);
    progress.modelChecking();
    const seen: NativeRuntimeStatus[] = [];
    const off = bus.subscribe((status) => seen.push(status));
    expect(seen).toEqual([progress.current()]);
    progress.embeddingsStarting();
    expect(seen.map((s) => s.phase)).toEqual(["model", "embeddings"]);
    off();
  });
});
