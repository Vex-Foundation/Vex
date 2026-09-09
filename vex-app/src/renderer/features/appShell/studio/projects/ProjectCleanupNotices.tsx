import { DisclosureRow } from "../../../../components/ui/disclosure-row.js";
import { StateDot } from "../../../../components/ui/state-dot.js";
import { useState, type JSX } from "react";
import { trashRemediation, type ProjectPendingCleanup } from "@shared/schemas/project-cleanup.js";
import { PROJECT_DELETE_OUTCOME_SENTENCES } from "./projects-copy.js";
import { Button } from "../../../../components/ui/button.js";
import { useDeleteProject, usePendingProjectCleanups } from "../../../../lib/api/projects.js";

/** Reads tombstones so closing a dialog or restarting cannot hide an unfinished delete. */
export function ProjectCleanupNotices({ collapsed = false, onExpand }: { readonly collapsed?: boolean; readonly onExpand?: () => void }): JSX.Element | null {
  const [offset, setOffset] = useState(0);
  const query = usePendingProjectCleanups(offset);
  if (query.isPending) return null;
  if (query.isError || (query.data !== undefined && !query.data.ok)) {
    if (collapsed) return <section role="status" aria-label="Unfinished project cleanups could not be loaded.">
      <button type="button" aria-label="Show unfinished project cleanup error" onClick={onExpand} className="flex h-6 w-full items-center justify-center">
        <StateDot state="warning" size={8} />
      </button>
    </section>;
    return <section role="status" className="p-2 text-xs text-warning">
      Unfinished project cleanups could not be loaded.
      <Button variant="ghost" onClick={() => void query.refetch()}>Retry loading cleanups</Button>
    </section>;
  }
  if (!query.data?.ok) return null;
  const page = query.data.data;
  const nextOffset = page.nextOffset;
  if (page.items.length === 0 && offset === 0) return null;
  return <section aria-label="Unfinished project cleanups" className="min-w-0 py-2">
    {page.items.map((item) => <CleanupNotice key={item.projectId} item={item} collapsed={collapsed} onExpand={onExpand} />)}
    <div className="flex gap-2">
      {offset > 0 ? <Button variant="ghost" onClick={() => setOffset(Math.max(0, offset - 50))}>Previous cleanups</Button> : null}
      {nextOffset !== null ? <Button variant="ghost" onClick={() => setOffset(nextOffset)}>More cleanups</Button> : null}
    </div>
  </section>;
}

function CleanupNotice({ item, collapsed, onExpand }: { readonly item: ProjectPendingCleanup; readonly collapsed: boolean; readonly onExpand: (() => void) | undefined }): JSX.Element {
  const [open, setOpen] = useState(false);
  const mutation = useDeleteProject(true);
  const result = mutation.data;
  const failure = result?.ok && result.data.outcome === "cleanup_pending"
    ? result.data.trashFailure ?? item.trashFailure : item.trashFailure;
  const ownHolder = typeof failure === "object" && failure !== null
    && failure.holders?.some((holder) => holder.kind !== "external");
  if (collapsed) return <article role="status" aria-label={`Pending cleanup for ${item.name}`}>
    <button type="button" aria-label={`Show pending cleanup for ${item.name}`} onClick={onExpand}
      className="flex h-6 w-full items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-accent-primary">
      <StateDot state="warning" size={8} />
    </button>
  </article>;
  return <article role="status" aria-label={`Pending cleanup for ${item.name}`} className="min-w-0 text-xs text-ink-secondary">
    <DisclosureRow icon={<StateDot state="warning" size={8} />} title={item.name}
      collapsedContent={<span className="ml-2 whitespace-nowrap text-ink-tertiary">Pending cleanup</span>}
      className="[&>.vex-disclosure-row]:overflow-x-auto" titleClassName="shrink-0 whitespace-nowrap" open={open} expandable expandOnRowClick
      onToggle={() => setOpen((value) => !value)} bodyClassName="flex min-w-0 flex-col gap-2 p-2 break-words">

    <p className="font-medium text-ink-primary">{item.name} - folder: {item.folder}</p>
    <p>{item.trashRequested
      ? "This project is deleted, but moving its folder to the trash is still pending."
      : "This project is deleted. Its folder will be kept, but removal of Vex's entries is still pending."}</p>
    <p>{failure ? trashRemediation(failure) : "The previous cleanup did not finish. Retry to check the folder and resume cleanup."}</p>
    {typeof failure === "object" && failure !== null ? <>
      <p className="break-all">Folder: {failure.folder}</p>
      {failure.holders?.map((holder, index) => holder.kind === "external" ? null :
        <p key={index}>PID {holder.pid}{holder.project ? ` - project: ${holder.project}` : ""}</p>)}
    </> : null}
    <p>{item.attempts} cleanup attempts. Retrying honors the original folder choice.</p>
    {result?.ok ? <p role="status">{PROJECT_DELETE_OUTCOME_SENTENCES[result.data.outcome]}</p> : null}
    {mutation.isError ? <p role="alert">Cleanup could not be reached. Try again.</p> : null}
    {result !== undefined && !result.ok ? <p role="alert">{result.error.message}</p> : null}
    <Button variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate({
      projectId: item.projectId, expectedName: item.name, alsoTrashFolder: item.trashRequested,
      ...(ownHolder ? { closeHolders: true } : {}),
    })}>{mutation.isPending ? "Retrying cleanup" : ownHolder ? "Close it and retry" : `Retry cleanup for ${item.name}`}</Button>
    {mutation.isPending ? <Button variant="ghost" onClick={mutation.cancel}>Cancel cleanup</Button> : null}
    </DisclosureRow>
  </article>;
}
