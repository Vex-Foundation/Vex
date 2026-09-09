import type { JSX } from "react";
import { IconWarning } from "../../../components/icons/index.js";
import { STUDIO_FULL_ACCESS_LABEL } from "./studio-copy.js";

/** Visual state only; the owning row exposes the complete permission description. */
export function ProjectPermissionState({
  permission,
  collapsed = false,
}: {
  readonly permission: "restricted" | "full";
  readonly collapsed?: boolean;
}): JSX.Element | null {
  if (permission !== "full") return null;
  return (
    <span
      aria-hidden="true"
      data-vex-project-permission="full"
      className="flex shrink-0 items-center gap-1 whitespace-nowrap"
    >
      <IconWarning size={13} className="text-warning" />
      {!collapsed ? (
        <span className="vex-micro-label leading-4 text-warning-label">
          {STUDIO_FULL_ACCESS_LABEL}
        </span>
      ) : null}
    </span>
  );
}
