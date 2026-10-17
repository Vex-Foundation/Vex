/**
 * Static option catalogues for the new-session form's mode and permission
 * radio grids (extracted from `SessionCreator.tsx`). Each option mirrors a
 * value from the IPC session schema discriminated union and carries the
 * presentational copy the {@link RadioCard} renders
 * (docs/design/R3-MINIMAL.md section 12).
 */

import type {
  SessionMode,
  SessionPermission,
} from "@shared/schemas/sessions.js";

export interface ModeOption {
  readonly value: SessionMode;
  readonly title: string;
  readonly description: string;
}

export const MODE_OPTIONS: ReadonlyArray<ModeOption> = [
  {
    value: "agent",
    title: "Agent",
    description: "One-shot conversation. Vex stays in chat, no loop.",
  },
  {
    value: "mission",
    title: "Mission",
    description:
      "Goal-driven loop. Vex pursues a target and can self-schedule wakes.",
  },
];

export interface PermissionOption {
  readonly value: SessionPermission;
  readonly title: string;
  readonly description: string;
  /**
   * A short tag at the right of the title. Restricted says what the grant
   * means in the composer's own words: funds require approval.
   */
  readonly tag?: string;
  /**
   * Caution register: when selected, the consequence line steps up to the
   * primary ink. Only the "Full access" grant carries it. A definite boolean
   * (not optional) so the catalogue satisfies exactOptionalPropertyTypes at
   * the RadioCard prop.
   */
  readonly caution: boolean;
}

export const PERMISSION_OPTIONS: ReadonlyArray<PermissionOption> = [
  {
    value: "restricted",
    title: "Restricted",
    description: "Every mutating transaction requires your approval.",
    tag: "Funds require approval",
    caution: false,
  },
  {
    value: "full",
    title: "Full access",
    description: "Auto-execute approved tools without prompting per call.",
    caution: true,
  },
];
