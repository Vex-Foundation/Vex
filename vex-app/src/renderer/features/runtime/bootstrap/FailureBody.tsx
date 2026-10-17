/**
 * Branch: failed - the native runtime's start stopped at one step. One status
 * stanza per failure kind, carrying the runtime's own message, then the
 * remediation copy for that kind, Try again (which asks main for a fresh
 * start; a model download resumes where it stopped) and the logs folder.
 *
 * `data-runtime-failure={kind}` is the test contract.
 */

import type { JSX } from "react";
import type { NativeRuntimeFailureKind, NativeRuntimeStep } from "@shared/schemas/system.js";

import { Button } from "../../../components/ui/button.js";
import { SetupStatusCard, type SetupStatusTone } from "../../../components/onboarding/SetupStatusCard.js";
import { OpenLogsLink } from "../../../components/common/OpenLogsLink.js";

interface FailureCopy {
  readonly tone: SetupStatusTone;
  readonly word: string;
  readonly title: string;
  readonly advice: string | null;
}

const FAILED_TITLE: Record<NativeRuntimeStep, string> = {
  postgres: "The local database could not start",
  model: "The embeddings model could not be prepared",
  embeddings: "The embeddings server could not start",
};

function copyFor(kind: NativeRuntimeFailureKind, step: NativeRuntimeStep): FailureCopy {
  switch (kind) {
    case "disk_full":
      return {
        tone: "error",
        word: "Disk full",
        title: "Not enough disk space",
        advice:
          step === "model"
            ? "The embeddings model needs about 400 MB free. Free up space on this disk, then try again: whatever already downloaded is kept, and the download resumes where it stopped."
            : "The local database could not write to the disk. Free up space on this disk, then try again.",
      };
    case "offline":
      return {
        tone: "error",
        word: "Offline",
        title: "Could not download the embeddings model",
        advice:
          "Vex downloads its embeddings model once, on the first run, and works offline after that. Check the internet connection, or a proxy or firewall that blocks huggingface.co, then try again: the download resumes where it stopped.",
      };
    case "foreign_listener":
      return {
        tone: "error",
        word: "Blocked",
        title: "Another database answered for this install",
        advice:
          "The database Vex reached is not the one this install created, so Vex stopped before reading or writing it. Quit any other copy of Vex or local Postgres server, then try again.",
      };
    case "port_collision":
      return {
        tone: "error",
        word: "Port in use",
        title: "No free port for the local database",
        advice: "Every port Vex tried for its local database was taken. Close the program holding them, then try again.",
      };
    case "unhealthy":
      return {
        tone: "warn",
        word: "Unhealthy",
        title: step === "postgres" ? "The local database keeps stopping" : "The embeddings server keeps stopping",
        advice: "It stopped repeatedly and Vex stopped restarting it. Try again to start it fresh; the logs say why it stopped.",
      };
    case "unavailable":
      return {
        tone: "error",
        word: "Missing",
        title: "Part of the local runtime is missing",
        advice: "This copy of Vex is missing a program it ships with. Reinstalling Vex restores it.",
      };
    case "failed":
      return { tone: "error", word: "Failed", title: FAILED_TITLE[step], advice: null };
  }
}

interface FailureBodyProps {
  readonly kind: NativeRuntimeFailureKind;
  readonly step: NativeRuntimeStep;
  readonly message: string;
  readonly onRetry: () => void;
}

export function FailureBody({ kind, step, message, onRetry }: FailureBodyProps): JSX.Element {
  const copy = copyFor(kind, step);
  return (
    <div className="flex flex-col gap-4" data-runtime-failure={kind}>
      <SetupStatusCard tone={copy.tone} word={copy.word} title={copy.title} detail={message} />
      {copy.advice !== null ? (
        <p className="text-xs leading-relaxed text-ink-secondary">{copy.advice}</p>
      ) : null}
      <Button size="lg" className="w-full" onClick={onRetry}>
        Try again
      </Button>
      <OpenLogsLink />
    </div>
  );
}
