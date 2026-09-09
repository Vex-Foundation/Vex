import { trashReason, type ProjectPendingCleanups } from "@shared/schemas/project-cleanup.js";
import { resolveTrashHolders } from "./project-trash-holders.js";
import { resolveProjectDirectory, resolveProjectsRoot } from "./projects-root.js";

/** Holder observations expire between attempts. Refresh from process owners, never from saved PIDs. */
export async function refreshCleanupHolders(page: ProjectPendingCleanups, signal: AbortSignal): Promise<ProjectPendingCleanups> {
  if (!page.items.some((item) => item.trashFailure !== null && ["busy", "aborted"].includes(trashReason(item.trashFailure)))) return page;
  const root = await resolveProjectsRoot("pending-cleanup-holders");
  if (!root.ok) return { ...page, items: page.items.map((item) => ({ ...item,
    trashFailure: typeof item.trashFailure === "object" && item.trashFailure !== null
      ? { ...item.trashFailure, holders: [] } : item.trashFailure,
  })) };
  const items = [];
  for (const item of page.items) {
    signal.throwIfAborted();
    const failure = item.trashFailure;
    const directory = resolveProjectDirectory(root.data, item.folder);
    if (!item.trashRequested || failure === null || directory === null || !["busy", "aborted"].includes(trashReason(failure))) {
      items.push(item); continue;
    }
    try {
      const holders = await resolveTrashHolders(directory, false, signal);
      const reason = holders.some((holder) => holder.kind !== "external") ? "busy" : trashReason(failure);
      items.push({ ...item, trashFailure: { reason, folder: directory, holders } });
    } catch {
      signal.throwIfAborted();
      items.push({ ...item, trashFailure: { reason: trashReason(failure), folder: directory } });
    }
  }
  return { ...page, items };
}
