/**
 * Pure detail-line formatters for the System Check probe rows.
 *
 * Each takes a validated Result payload (already narrowed by the caller)
 * and returns the human-readable `detail` string surfaced under the row
 * label. No IO, no React — deterministic string assembly only.
 */

export function formatPlatform(
  platform: string,
  distro: string | null | undefined,
): string {
  const labelByPlatform: Record<string, string> = {
    win32: "Windows",
    darwin: "macOS",
    linux: "Linux",
  };
  const base = labelByPlatform[platform] ?? platform;
  return distro ? `${base} · ${distro}` : base;
}

export function formatDockerDetail(
  status: import("@shared/schemas/docker.js").DockerStatus,
): string {
  if (!status.endpoint.accepted) {
    return status.endpoint.message ?? "Docker endpoint rejected.";
  }
  const engine = status.engine.present
    ? `Docker ${status.engine.version ?? "?"}`
    : "Docker not found";
  const daemon = status.daemon.running ? "daemon running" : "daemon stopped";
  const compose = status.compose.present
    ? `Compose ${status.compose.version ?? "?"}`
    : "Compose missing";
  return `${engine} · ${daemon} · ${compose}`;
}

export function formatEnvDetail(
  state: import("@shared/schemas/onboarding.js").EnvState,
): string {
  if (state.setupCompleteFlag) return "Setup previously completed.";
  const parts: string[] = [];
  if (state.walletStatus.evm === "present") parts.push("EVM keystore present");
  if (state.walletStatus.solana === "present")
    parts.push("Solana keystore present");
  if (state.embeddings.configured) parts.push("Embeddings configured");
  return parts.length > 0
    ? `Partial config: ${parts.join(", ")}.`
    : "First run - guided setup required.";
}
