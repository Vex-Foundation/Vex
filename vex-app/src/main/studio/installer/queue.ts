/**
 * PER-PROJECT SERIALIZATION for render jobs.
 *
 * Two facts make this necessary rather than decorative:
 *
 *   1. TWO RUNS OVER THE SAME FILES WOULD RACE. Both read `.mcp.json`, both
 *      render, both replace. The optimistic source check would turn one of them
 *      into a `source_changed` refusal, so nothing would be corrupted - but the
 *      user would see a spurious failure for an edit that was perfectly valid.
 *      One project, one render at a time.
 *   2. TWO UPDATES COMMITTING IN ORDER MUST NOT RENDER IN REVERSE ORDER. The
 *      scope is committed to the database first and the files are rendered
 *      after, so without serialization the older scope's render could land
 *      last and leave a project's files describing authority the user already
 *      replaced.
 *
 * SUPERSEDING is the other half of that guarantee. A job that is still waiting
 * when a NEWER scope-update job is enqueued has nothing useful left to do: the
 * newer job reloads the latest committed scope and reconciles every artifact,
 * which is a superset of what the older one would have done. So the older job
 * reports `superseded` and does no filesystem work at all. That is why a burst
 * of edits produces one render rather than five.
 *
 * A REPAIR IS NEVER SUPERSEDED. It carries authority an update does not - it is
 * the only trigger that overwrites a drifted artifact - so letting a routine
 * scope edit cancel it would silently drop the one thing the user asked for.
 *
 * The queue is process-local, which is the correct scope: it protects against
 * this app's own concurrent work. Two Vex instances editing one project's files
 * are handled by the optimistic source check in `confined-fs.ts`, not here.
 */

/** Per project: the promise chain, and the sequence number of the newest update. */
interface ProjectQueue {
  tail: Promise<void>;
  latestUpdateSeq: number;
  /** Live jobs, so an empty queue can be dropped instead of leaking a map entry. */
  depth: number;
}

const queues = new Map<string, ProjectQueue>();

export interface EnqueueOptions<T> {
  readonly projectId: string;
  /**
   * `update` jobs supersede each other; `repair` jobs always run. See the
   * module header for why the two are not the same.
   */
  readonly kind: "update" | "repair";
  readonly run: () => Promise<T>;
  /** The result an update returns when a newer update overtook it while waiting. */
  readonly whenSuperseded: () => T;
}

/**
 * Run `run` after every job already queued for this project has settled.
 *
 * Never rejects because of another job: a failure is contained to its own
 * caller and the chain continues, so one project's broken render cannot wedge
 * the queue for every later edit.
 */
export async function enqueueStudioRender<T>(options: EnqueueOptions<T>): Promise<T> {
  const queue = queues.get(options.projectId) ?? {
    tail: Promise.resolve(),
    latestUpdateSeq: 0,
    depth: 0,
  };
  queues.set(options.projectId, queue);

  const seq = options.kind === "update" ? ++queue.latestUpdateSeq : queue.latestUpdateSeq;
  queue.depth += 1;

  const previous = queue.tail;
  const job = previous.then(async (): Promise<T> => {
    // Checked HERE, at execution, not at enqueue: the point is to notice the
    // updates that arrived while this one was waiting.
    if (options.kind === "update" && seq !== queue.latestUpdateSeq) {
      return options.whenSuperseded();
    }
    return options.run();
  });

  // The chain continues on a settled promise, never on `job` itself, so a
  // rejected job does not reject every job queued behind it.
  queue.tail = job.then(
    () => undefined,
    () => undefined,
  );

  try {
    return await job;
  } finally {
    queue.depth -= 1;
    if (queue.depth === 0 && queues.get(options.projectId) === queue) {
      queues.delete(options.projectId);
    }
  }
}

/** Test seam: drop every queue. Never called by production code. */
export function __resetStudioRenderQueuesForTests(): void {
  queues.clear();
}
