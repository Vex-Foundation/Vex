/**
 * Shared per-command Zod primitives. Extracted so command-group
 * files (`contract.ts`, `run-lifecycle.ts`, `transcript.ts`) share
 * a single field definition for sessionId / missionId / missionRunId.
 *
 * WHY `missionId` AND `missionRunId` ARE NOT UUIDs. Only `sessions.id` is a
 * database-generated UUID. Mission ids and mission-run ids are minted by the
 * engine as readable, sortable tokens:
 *   - renewal: `mission-<epochMillis>-<8 hex>` (`engine/mission/renew.ts`)
 *   - run start: `run-<epochMillis>-<8 hex>` (`core/runner/mission-prepare.ts`)
 * A `.uuid()` on either is a validate-then-DROP bug, not a tightening: the
 * value is well-formed, the boundary rejects it, and whatever depended on the
 * message silently falls back to polling (or to nothing). Every schema that
 * carries one of these ids must import the field from here rather than
 * restating a guess about its shape.
 */

import { z } from "zod";

export const sessionIdField = z.string().uuid();
export const missionIdField = z.string().min(1);
export const missionRunIdField = z.string().min(1);
