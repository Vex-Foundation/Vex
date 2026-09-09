import { useState, type JSX } from "react";
import { PROJECT_TRASH_REMEDIATION, type ProjectPendingCleanup } from "@shared/schemas/project-cleanup.js";
import { PROJECT_DELETE_OUTCOME_SENTENCES } from "./projects-copy.js";
import { Button } from "../../../../components/ui/button.js";
import { useDeleteProject, usePendingProjectCleanups } from "../../../../lib/api/projects.js";

/** Reads tombstones so closing a dialog or restarting cannot hide an unfinished delete. */
export function ProjectCleanupNotices(): JSX.Element | null {
  const [offset, setOffset] = useState(0);
  const query = usePendingProjectCleanups(offset);
  if (query.isPending) return null;
  if (query.isError || (query.data !== undefined && !query.data.ok)) {
    return <section role="status" className="m-3 rounded-lg border border-line-2 p-3 text-sm text-warning">
      Unfinished project cleanups could not be loaded.
      <Button variant="ghost" onClick={() => void query.refetch()}>Retry loading cleanups</Button>
    </section>;
  }
  if (!query.data?.ok) return null;
  const page = query.data.data;
  const nextOffset = page.nextOffset;
  if (page.items.length === 0 && offset === 0) return null;
  return <section aria-label="Unfinished project cleanups" className="m-3 max-h-64 shrink-0 overflow-y-auto flex flex-col gap-2 rounded-lg border border-line-2 p-3">
    <h3 className="text-sm text-ink-primary">Deleted projects with files still pending cleanup</h3>
    {page.items.map((item) => <CleanupNotice key={item.projectId} item={item} />)}
    <div className="flex gap-2">
      {offset > 0 ? <Button variant="ghost" onClick={() => setOffset(Math.max(0, offset - 50))}>Previous cleanups</Button> : null}
      {nextOffset !== null ? <Button variant="ghost" onClick={() => setOffset(nextOffset)}>More cleanups</Button> : null}
    </div>
  </section>;
}

function CleanupNotice({ item }: { readonly item: ProjectPendingCleanup }): JSX.Element {
  const mutation = useDeleteProject();
  const result = mutation.data;
  const failure = result?.ok && result.data.outcome === "cleanup_pending"
    ? result.data.trashFailure ?? item.trashFailure : item.trashFailure;
  return <article className="flex flex-col gap-1 text-xs text-ink-secondary">
    <p className="font-medium text-ink-primary">{item.name} - folder: {item.folder}</p>
    <p>{item.trashRequested
      ? "This project is deleted, but moving its folder to the trash is still pending."
      : "This project is deleted. Its folder will be kept, but removal of Vex's entries is still pending."}</p>
    <p>{failure ? PROJECT_TRASH_REMEDIATION[failure] : "The previous cleanup did not finish. Retry to check the folder and resume cleanup."}</p>
    <p>{item.attempts} cleanup attempts. Retrying honors the original folder choice.</p>
    {result?.ok ? <p role="status">{PROJECT_DELETE_OUTCOME_SENTENCES[result.data.outcome]}</p> : null}
    {mutation.isError ? <p role="alert">Cleanup could not be reached. Try again.</p> : null}
    {result !== undefined && !result.ok ? <p role="alert">{result.error.message}</p> : null}
    <Button variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate({
      projectId: item.projectId, expectedName: item.name, alsoTrashFolder: item.trashRequested,
    })}>{mutation.isPending ? "Retrying cleanup..." : `Retry cleanup for ${item.name}`}</Button>
  </article>;
}
