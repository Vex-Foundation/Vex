/**
 * WHAT A TERMINAL TAB IS CALLED AND WHAT STATE IT IS IN.
 *
 * Two pure decisions, kept out of the components that render them because both
 * are rules rather than markup: which number a new terminal gets, and which of
 * four states its tab shows. Both are read in three places (the strip, the
 * panel header, the controller that mutates the workspace), and a rule copied
 * into three components is a rule that will disagree with itself.
 *
 * ## The number is derived from the model, not counted in a ref
 *
 * A counter held beside the workspace would be a second source of truth: it
 * would survive a tab the model dropped, miss a tab a RESTORE brought back, and
 * reset on a remount the model does not see. The titles the model already holds
 * are the only durable record of which numbers are in use, so the allocator
 * reads them. That gives the property the owner asked for - a number is never
 * reused WHILE its terminal is open - without inventing storage for it.
 *
 * VS Code numbers terminals the same way and for the same reason
 * (`terminalTabsList.ts` derives its label from the instance's own identity,
 * not from a list index), which is also why the number does not renumber when
 * a neighbour closes: the strip is a list of names, and names that shuffle
 * under the user are not names.
 *
 * ## The state is derived from what the renderer already knows
 *
 * `running | exited | error | restoring` are not new state. `lostTerminalIds`
 * is the host-loss set the workspace already tracks, exits arrive as the
 * `onPaneExit` the panes already report, and the restore is the controller's
 * own in-flight flag. This module only says how the four combine for a tab that
 * may hold several panes, and the answer is deliberately conservative: a group
 * is only `exited` when EVERY shell in it has gone, because a tab with one live
 * shell in it is a live tab.
 */

import type { TerminalWorkspaceRestore } from "@shared/schemas/terminal.js";
import type {
  WorkspaceState,
  WorkspaceTab,
  WorkspaceTerminalGroup,
} from "../workspace/types.js";
import {
  TERMINAL_TITLE_PATTERN,
  shellProcessName,
  terminalTabTitle,
} from "./terminal-copy.js";

/** How a terminal ended, as the pane reported it. */
export interface TerminalExit {
  readonly exitCode: number;
  readonly signal: number | null;
}

/** The four states a terminal tab's dot can show. */
export type TerminalTabRunState = "running" | "exited" | "error" | "restoring";

/** Everything outside the workspace model that a tab's state depends on. */
export interface TerminalRunFacts {
  /** Terminals whose pty died with the host. */
  readonly lostTerminalIds: ReadonlySet<string>;
  /** Terminals that reported an exit, with the status they reported. */
  readonly exits: ReadonlyMap<string, TerminalExit>;
  /** A restore of the lost terminals is in flight. */
  readonly restoring: boolean;
}

/**
 * The title for the NEXT terminal tab in this workspace.
 *
 * The smallest positive number no OPEN tab is already using, so a workspace
 * holding `Terminal 1` and `Terminal 3` opens `Terminal 2` and never a second
 * `Terminal 1`. Closing a terminal frees its number, which is the honest
 * reading of "never reused while open": nothing on screen carries that name any
 * more, so nothing is ambiguous.
 *
 * A tab the user renamed holds no number and frees the one it had. That is the
 * intended behaviour: they gave it a name, and Vex does not keep a hidden claim
 * on a number the user's own label no longer shows.
 */
export function nextTerminalTitle(tabs: readonly WorkspaceTab[]): string {
  const taken = new Set<number>();
  for (const tab of tabs) {
    const match = TERMINAL_TITLE_PATTERN.exec(tab.title);
    if (match?.[1] !== undefined) taken.add(Number(match[1]));
  }
  let candidate = 1;
  while (taken.has(candidate)) candidate += 1;
  return terminalTabTitle(candidate);
}

/**
 * Number the terminal tabs of a RESTORED workspace.
 *
 * `fromSnapshot` names each restored group after the shell that was running in
 * it, because that is the only name the host's own snapshot carries. Those
 * names are what this stage replaced: a strip that reads `bash | bash | bash`
 * after a restart is the same strip with the same defect. Renumbering here,
 * once, at the point the restored state is adopted, keeps the naming rule in
 * one place instead of teaching the persistence layer about display copy.
 *
 * Nothing is lost by it. A user's rename does not reach the snapshot (the
 * persisted layout carries topology, not names), so there is no user-chosen
 * title here to overwrite, and the shell each tab was running is still shown -
 * in the tooltip and the panel header, seeded from the same snapshot rows.
 */
export function renumberTerminalTabs(state: WorkspaceState): WorkspaceState {
  let next = 0;
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.kind !== "terminalGroup") return tab;
      next += 1;
      return { ...tab, title: terminalTabTitle(next) };
    }),
  };
}

/**
 * What each restored terminal is RUNNING, keyed by terminal id.
 *
 * The host's own title when it has one, the shell's name when it does not -
 * the same preference `fromSnapshot` used to build the tab's name from, kept
 * here because the fact is still worth showing, just not as the tab's name.
 * The title WINS where there is one because it is the live foreground process:
 * a restored terminal sitting in `vim` says `vim`, and the shell it was
 * launched with would be the wrong answer for it.
 *
 * AS A PROCESS NAME. The title arrives as node-pty reports it, which for the
 * shell itself is the launch path (`/bin/bash`), so it is reduced here for the
 * same reason and by the same rule the created terminal's label follows - see
 * `shellProcessName`. Normalised on the way IN rather than at each of the two
 * places that render it, so the map holds one spelling and a third consumer
 * cannot reintroduce the path.
 */
export function shellLabelsOf(
  restore: TerminalWorkspaceRestore,
): ReadonlyMap<string, string> {
  return new Map(
    restore.terminals.map((entry) => [
      entry.terminalId,
      shellProcessName(entry.title === "" ? entry.shellName : entry.title),
    ]),
  );
}

/**
 * Which state one terminal group is in.
 *
 * Order matters and is not arbitrary:
 *
 *  - HOST LOSS wins over an exit, because a shell that died with the service
 *    did not exit, it was taken, and the notice above the strip offers a repair
 *    for exactly that case;
 *  - a lost tab reads RESTORING while that repair is in flight, since the
 *    error is being acted on and a red dot over a running repair says the
 *    opposite of what is happening. The restore only ever concerns lost
 *    terminals, so it never masks a live tab;
 *  - a group counts as ENDED only when every pane has reported an exit; a
 *    non-zero code or a signal in any of them makes the whole tab an error,
 *    since the tab's dot is the only place a user sees that a background pane
 *    fell over.
 */
export function terminalGroupRunState(
  group: WorkspaceTerminalGroup,
  facts: TerminalRunFacts,
): TerminalTabRunState {
  const lost = group.panes.some((pane) => facts.lostTerminalIds.has(pane.terminalId));
  if (lost) return facts.restoring ? "restoring" : "error";
  const exits = group.panes.map((pane) => facts.exits.get(pane.terminalId));
  if (exits.some((exit) => exit === undefined)) return "running";
  const failed = exits.some(
    (exit) => exit !== undefined && (exit.signal !== null || exit.exitCode !== 0),
  );
  return failed ? "error" : "exited";
}

/** Whether a tab still holds a shell that closing it would end. */
export function terminalGroupIsLive(
  group: WorkspaceTerminalGroup,
  facts: TerminalRunFacts,
): boolean {
  return group.panes.some(
    (pane) =>
      !facts.lostTerminalIds.has(pane.terminalId) && !facts.exits.has(pane.terminalId),
  );
}
