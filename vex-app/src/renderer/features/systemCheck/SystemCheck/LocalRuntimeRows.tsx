/**
 * The native runtime's three System Check rows: the bundled runtime, the
 * disk that will hold it, and the machine's memory. Pure presentation over
 * `localRuntimeView` (`./localRuntime.ts`), rendered between the network and
 * configuration rows by `ProbeRows`. Like every probe row they carry no glyph
 * (`docs/design/R3-MINIMAL.md` section 10.3).
 */

import type { JSX } from "react";

import { StepRow } from "../StepRow.js";
import type { LocalRuntimeView, RowView } from "./localRuntime.js";

function Row({ label, row }: { readonly label: string; readonly row: RowView }): JSX.Element {
  return (
    <StepRow
      label={label}
      status={row.status}
      detail={row.detail}
      {...(row.badgeLabel !== undefined ? { badgeLabel: row.badgeLabel } : {})}
    />
  );
}

export function LocalRuntimeRows({ view }: { readonly view: LocalRuntimeView }): JSX.Element {
  return (
    <>
      <Row label="Local runtime" row={view.bundle} />
      <Row label="Disk space" row={view.disk} />
      <Row label="Memory" row={view.memory} />
    </>
  );
}
