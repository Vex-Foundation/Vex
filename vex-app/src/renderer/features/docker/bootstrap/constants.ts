/**
 * Constants for the Docker bootstrap surface - pulled out so the
 * orchestrator and per-branch bodies share a single source of truth.
 * (The NOTARY-era "Step X of N" counter is retired with the Chronos
 * rebrand - only the docs URLs remain.)
 */

// Canonical Docker install docs URLs verified via curl HEAD redirect:
// `/desktop/install/*` 301s to `/desktop/setup/install/*`. Use the
// final URLs so the user lands on the canonical page directly.
export const DOCKER_DESKTOP_MAC_URL =
  "https://docs.docker.com/desktop/setup/install/mac-install/";
export const DOCKER_DESKTOP_WIN_URL =
  "https://docs.docker.com/desktop/setup/install/windows-install/";
export const DOCKER_ENGINE_LINUX_URL = "https://docs.docker.com/engine/install/";
export const DOCKER_ROOTLESS_URL =
  "https://docs.docker.com/engine/security/rootless/";
