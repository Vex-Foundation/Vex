import { mkdtemp, mkdir, rm, access, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTrashFailure } from "../trash-failure.js";
import { trashProjectFolder } from "../trash-project-folder.js";

const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger/index.js", () => ({ log: logger }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe("OS trash refusal", () => {
  it.each([
    ["busy", { code: "EBUSY" }, "C:\\projects\\example"],
    ["permission_denied", { code: "EACCES" }, "C:\\projects\\example"],
    ["aborted", new Error("Operation was aborted"), "C:\\projects\\example"],
    ["aborted", new Error("Operation was aborted"), "\\\\?\\C:\\projects\\example"],
    ["nonlocal_volume", new Error("Operation was aborted"), "\\\\wsl.localhost\\Ubuntu\\example"],
    ["nonlocal_volume", new Error("Operation was aborted"), "\\\\?\\UNC\\server\\share\\example"],
    ["invalid_path", new Error("Failed to parse path"), "C:\\projects\\example"],
    ["io_error", new Error("secret diagnostic payload"), "C:\\projects\\example"],
  ] as const)("classifies %s without exposing the path or native payload", (reason, cause, directory) => {
    expect(classifyTrashFailure(cause, directory, "win32")).toBe(reason);
  });

  it("keeps a real folder, reports the owner's aborted cause, and succeeds on explicit retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-trash-test-"));
    roots.push(root);
    const folder = path.join(root, "example");
    await mkdir(folder);
    const trash = vi.fn().mockRejectedValueOnce(new Error("Operation was aborted"))
      .mockImplementationOnce(async (target: string) => { await rm(target, { recursive: true }); });
    const first = await trashProjectFolder(root, folder, "test-correlation", trash);
    expect(first).toEqual({ trash: "failed", trashFailure: process.platform === "win32" ? { reason: "aborted", folder } : "aborted" });
    await expect(access(folder)).resolves.toBeUndefined();
    expect(trash).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(root);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("test-correlation"),
      expect.objectContaining({ reason: "aborted" }));
    expect(await trashProjectFolder(root, folder, "retry-correlation", trash)).toEqual({ trash: "trashed" });
    await expect(access(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlink outside the root without calling the trash capability", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-trash-guard-"));
    roots.push(root);
    const projects = path.join(root, "projects");
    const outside = path.join(root, "outside");
    await mkdir(projects); await mkdir(outside);
    const folder = path.join(projects, "example");
    await symlink(outside, folder, "junction");
    const trash = vi.fn();
    expect(await trashProjectFolder(projects, folder, "test-correlation", trash)).toEqual({
      trash: "failed", trashFailure: "outside_root",
    });
    expect(trash).not.toHaveBeenCalled();
    await expect(access(outside)).resolves.toBeUndefined();
  });
});

it("keeps the obligation pending when a failed restore left only the recovery folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vex-trash-restore-"));
  roots.push(root);
  const original = path.join(root, "example");
  const recovery = path.join(root, "example.vex-trash-probe-test");
  await mkdir(recovery);
  const trash = vi.fn();
  expect(await trashProjectFolder(root, original, "restore", trash)).toEqual({
    trash: "failed", trashFailure: { reason: "restore_failed", folder: original, recoveryPath: recovery },
  });
  expect(trash).not.toHaveBeenCalled();
  await expect(access(recovery)).resolves.toBeUndefined();
});
