/**
 * Sentry beforeSend + beforeBreadcrumb hook factories (M11).
 *
 * Reuses the existing field-name + secret-pattern redactor at
 * `main/logger/redact.ts` (already running on every electron-log call,
 * production-tested) and adds two on-wire telemetry-specific rules:
 *
 *   1. The shared redactor keeps diagnostic URL origins and paths, strips
 *      query strings and fragments, and redacts credential-bearing URLs whole.
 *      Every event lane passes original values to that same policy.
 *   2. Breadcrumb category allowlist - only `navigation`, `vex.ipc`,
 *      and `vex.wizard` survive. Console, fetch/xhr, dom, history,
 *      sentry.event, ui.click, etc. are all dropped. Plan §L: "no
 *      message text, no payload, no PII".
 *
 * Types come from `@sentry/electron/main` via `import type` - no
 * runtime SDK reference, so this module can be loaded by tests
 * without pulling Sentry into memory.
 */

import type { Event, Breadcrumb, EventHint, BreadcrumbHint } from "@sentry/electron/main";
import { redact } from "../logger/redact.js";

const ALLOWED_BREADCRUMB_CATEGORIES = new Set([
  "navigation",
  "vex.ipc",
  "vex.wizard",
]);

function scrubBreadcrumbs(event: Event): void {
  if (!event.breadcrumbs) return;
  event.breadcrumbs = event.breadcrumbs
    .filter((bc) => {
      if (!bc.category) return false;
      return ALLOWED_BREADCRUMB_CATEGORIES.has(bc.category);
    })
    .map((bc) => ({
      type: bc.type,
      category: bc.category,
      level: bc.level,
      timestamp: bc.timestamp,
      // Drop message body + data: only the route/channel/step name lives in
      // the category hint we set at emit time.
    }));
}

export function makeBeforeSendHook(): (
  event: Event,
  hint: EventHint,
) => Event | null {
  return (event) => {
    if (event.request) {
      event.request.url = redact(event.request.url);
      event.request.query_string = undefined;
      event.request.cookies = undefined;
      event.request.headers = undefined;
      event.request.data = undefined;
    }
    if (event.exception) event.exception = redact(event.exception);
    scrubBreadcrumbs(event);
    if (event.message) event.message = redact(event.message);
    if (event.extra) event.extra = redact(event.extra);
    if (event.contexts) event.contexts = redact(event.contexts);
    if (event.tags) event.tags = redact(event.tags);
    if (event.user) event.user = { id: event.user.id ?? undefined };
    return event;
  };
}

export function makeBeforeBreadcrumbHook(): (
  bc: Breadcrumb,
  hint?: BreadcrumbHint,
) => Breadcrumb | null {
  return (bc) => {
    if (!bc.category || !ALLOWED_BREADCRUMB_CATEGORIES.has(bc.category)) {
      return null;
    }
    return {
      type: bc.type,
      category: bc.category,
      level: bc.level,
      timestamp: bc.timestamp,
    };
  };
}
