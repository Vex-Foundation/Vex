/**
 * The native runtime's three System Check rows: the bundled runtime, the
 * disk that will hold it, and the machine's memory. Pure presentation over
 * `localRuntimeView` (`./localRuntime.ts`), rendered between the network and
 * configuration rows by `ProbeRows`.
 */

import type { JSX } from "react";
import { Postgresql } from "@thesvg/react";

import { IconArchive, IconCpu } from "../../../components/icons/index.js";
import { StepRow } from "../StepRow.js";
import type { LocalRuntimeView } from "./localRuntime.js";

export function LocalRuntimeRows({ view }: { readonly view: LocalRuntimeView }): JSX.Element {
  return (
    <>
      <StepRow
        label="Local runtime"
        status={view.bundle.status}
        icon={<Postgresql variant="mono" width={20} height={20} aria-hidden />}
        detail={view.bundle.detail}
        {...(view.bundle.badgeLabel !== undefined ? { badgeLabel: view.bundle.badgeLabel } : {})}
      />
      <StepRow
        label="Disk space"
        status={view.disk.status}
        icon={<IconArchive size={20} />}
        detail={view.disk.detail}
        {...(view.disk.badgeLabel !== undefined ? { badgeLabel: view.disk.badgeLabel } : {})}
      />
      <StepRow
        label="Memory"
        status={view.memory.status}
        icon={<IconCpu size={20} />}
        detail={view.memory.detail}
        {...(view.memory.badgeLabel !== undefined ? { badgeLabel: view.memory.badgeLabel } : {})}
      />
    </>
  );
}
