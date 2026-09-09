import { expect, it, vi } from "vitest";
import { probeAbortedTrash } from "../trash-failure.js";
const folder = "C:\\projects\\example";
const temporary = "C:\\projects\\.vex-trash-probe-test";
it("classifies a directory sharing violation as busy", async () => {
  const rename = vi.fn().mockRejectedValue({ code: "EBUSY" });
  expect(await probeAbortedTrash(folder, rename, temporary)).toEqual({ reason: "busy", folder });
  expect(rename).toHaveBeenCalledTimes(1);
});
it("restores a clean rename and retains the non-recyclable aborted classification", async () => {
  const rename = vi.fn().mockResolvedValue(undefined);
  expect(await probeAbortedTrash(folder, rename, temporary)).toEqual({ reason: "aborted", folder });
  expect(rename.mock.calls).toEqual([[folder, temporary], [temporary, folder]]);
});
it("names the recovery location when restore fails", async () => {
  const rename = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce({ code: "EPERM" });
  expect(await probeAbortedTrash(folder, rename, temporary)).toEqual({ reason: "restore_failed", folder, recoveryPath: temporary });
});
