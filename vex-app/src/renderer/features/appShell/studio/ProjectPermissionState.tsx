/**
 * A project's standing FULL ACCESS, as the outlined tag
 * (docs/design/R3-MINIMAL.md sections 1.3 and 4): ink outline, caps, the only
 * caps in the row. Restricted is the default and draws nothing; the owning row
 * carries the complete permission sentence as its accessible description.
 *
 * On the 56px rail there is no room for a word, so the tag folds to a 14px
 * line warning mark over the folder key; the row's description still says it.
 */

import type { JSX } from "react";
import { LineWarning } from "../../../components/icons/line/index.js";
import { Tag } from "../../../components/ui/stamp.js";
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
  if (collapsed) {
    return (
      <span
        aria-hidden="true"
        data-vex-project-permission="full"
        className="vex-st-perm-mark"
      >
        <LineWarning size={14} />
      </span>
    );
  }
  return (
    <Tag
      aria-hidden="true"
      data-vex-project-permission="full"
      className="vex-st-tag"
    >
      {STUDIO_FULL_ACCESS_LABEL}
    </Tag>
  );
}
