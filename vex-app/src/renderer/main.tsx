// Brand fonts (Archivo, Inter Tight, JetBrains Mono — the landing-page
// stack) are self-hosted via @font-face in globals.css (CSP font-src 'self').
import "./styles/globals.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import { queryClient } from "./app/queryClient.js";
import type { CreateBugReportInput } from "@shared/schemas/bug-reports.js";
import { registerZodLocale } from "@vex-lib/zod-locale.js";
import { rendererReportDedupe } from "./lib/report-dedupe.js";

/**
 * zod declares `sideEffects: false` and registers its English error map as a
 * module-level side effect, which Rollup drops from the renderer bundle. Form
 * and schema validation in the UI would then report "Invalid input" for every
 * field. Explicit call, because a bare side-effect import is dropped the same
 * way.
 */
registerZodLocale();

// Fire-and-forget helper: every renderer-auto-report path goes through here so
// a failed report (preload validation reject, IPC unavailable, main throws)
// can NEVER itself trigger another `unhandledrejection` and cause a loop.
function safeSupportReport(input: CreateBugReportInput): void {
  void window.vex?.support
    ?.createBugReport(input)
    .catch(() => undefined);
}

function safeSentryReport(input: {
  readonly kind: "caught" | "uncaught" | "boundary";
  readonly message: string;
  readonly componentStack?: string | null;
}): void {
  void window.vex?.telemetry
    ?.reportRendererError(input)
    .catch(() => undefined);
}

// Promise rejections bypass React's error boundary entirely — wire a top-level
// window listener so async failures still land in the local support sink.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const message = reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : String(reason);
  const dedupeKey = message.slice(0, 200);
  if (
    rendererReportDedupe.shouldDrop({
      category: "renderer_unhandled_rejection",
      key: dedupeKey,
    })
  ) {
    return;
  }
  safeSupportReport({
    reportKind: "automatic",
    source: "renderer",
    category: "renderer_unhandled_rejection",
    severity: "error",
    title: "Unhandled promise rejection",
    description: message.slice(0, 2000),
    context: {},
    refs: {},
  });
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root");

createRoot(rootEl, {
  onCaughtError(error, info) {
    const message = String(error);
    const dedupeKey = message.slice(0, 200);
    if (
      !rendererReportDedupe.shouldDrop({
        category: "renderer_caught_error",
        key: dedupeKey,
      })
    ) {
      safeSupportReport({
        reportKind: "automatic",
        source: "renderer",
        category: "renderer_caught_error",
        severity: "warning",
        title: "React caught error",
        description: message.slice(0, 2000),
        context: { componentStack: info.componentStack ?? null },
        refs: {},
      });
    }
    safeSentryReport({
      kind: "caught",
      message,
      componentStack: info.componentStack ?? null,
    });
  },
  onUncaughtError(error, info) {
    const message = String(error);
    const dedupeKey = message.slice(0, 200);
    if (
      !rendererReportDedupe.shouldDrop({
        category: "renderer_uncaught_error",
        key: dedupeKey,
      })
    ) {
      safeSupportReport({
        reportKind: "automatic",
        source: "renderer",
        category: "renderer_uncaught_error",
        severity: "error",
        title: "React uncaught error",
        description: message.slice(0, 2000),
        context: { componentStack: info.componentStack ?? null },
        refs: {},
      });
    }
    safeSentryReport({
      kind: "uncaught",
      message,
      componentStack: info.componentStack ?? null,
    });
  },
}).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
