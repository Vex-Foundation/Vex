#!/usr/bin/env bash
# Remove Docker from a GitHub Ubuntu runner for the clean-machine gate
# (.github/workflows/clean-machine.yml). The images ship docker-ce, its CLI and
# containerd.io as systemd units; vex-app/scripts/assert-no-docker-host.mjs
# then proves nothing is left.
set -euo pipefail

echo "Before:"
systemctl list-units --all --no-pager 'docker*' 'containerd*' || true
type -ap docker dockerd docker-compose containerd || true

units="docker.socket docker.service containerd.service"
# shellcheck disable=SC2086
sudo systemctl stop $units || true
# shellcheck disable=SC2086
sudo systemctl disable $units || true
# Masked, so nothing (socket activation included) can start them again.
# shellcheck disable=SC2086
sudo systemctl mask $units

packages=$(dpkg-query -W -f='${Package}\n' | grep -E '^(docker|moby|containerd)' || true)
echo "Purging: ${packages:-nothing}"
if [ -n "$packages" ]; then
  # shellcheck disable=SC2086
  sudo DEBIAN_FRONTEND=noninteractive apt-get purge -yq $packages
fi

for program in docker dockerd docker-compose containerd; do
  for found in $(type -ap "$program" || true); do
    echo "removing $found"
    sudo rm -f "$found"
  done
done
sudo rm -rf /var/run/docker.sock /run/docker.sock /run/containerd /var/lib/docker /var/lib/containerd
